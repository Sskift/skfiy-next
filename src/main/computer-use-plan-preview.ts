import { createHash } from "node:crypto";
import path from "node:path";

import type { ComputerUsePlanPreview } from "../shared/task-control.js";
import type { AppPolicy } from "./app-policy-settings.js";
import {
  parseChromePageIntent,
  readChromeTaskRisk
} from "./orchestrator/chrome-task.js";
import {
  parseFinderOrganizationIntent,
  readFinderTaskRisk
} from "./orchestrator/finder-task.js";
import { readGhosttyTaskRisk } from "./orchestrator/ghostty-task.js";
import { readTmuxSupervisionTaskRisk } from "./orchestrator/tmux-supervision-task.js";
import {
  readExecutableRoutePolicyBlockReason,
  type ExecutableCommandRoute
} from "./task-routing.js";

export interface CreateComputerUsePlanPreviewInput {
  command: string;
  route: ExecutableCommandRoute;
  forceApproval?: boolean;
}

export interface CreateAppPolicyBoundComputerUsePlanPreviewInput
  extends CreateComputerUsePlanPreviewInput {
  appPolicy: AppPolicy;
}

const EXPECTED_VERIFICATION = {
  ghostty: "Confirm the owned Ghostty session remains active and observe the command completion marker.",
  chrome: "Confirm the approved page action and inspect the resulting page snapshot.",
  finder: "Confirm the approved plan still matches the target and verify each file operation.",
  tmux_supervision: "Confirm a fresh read-only pane snapshot and supervision recommendation."
} as const;

export function createComputerUsePlanPreview({
  command,
  route,
  forceApproval = false
}: CreateComputerUsePlanPreviewInput): ComputerUsePlanPreview {
  const risk = readRouteRisk(command, route);
  const target = readRouteTarget(command, route);
  const approvalRequired = risk.level !== "blocked"
    && (forceApproval || risk.requiresApproval);
  const mutating = readRouteMutation(command, route, risk.level);
  const planBody = {
    route: route.kind,
    appName: readRouteAppName(route),
    target,
    risk: { ...risk },
    approvalRequired,
    expectedVerification: EXPECTED_VERIFICATION[route.kind],
    mutating
  };

  return {
    planId: createPlanId({ command, ...planBody }),
    ...planBody
  };
}

export function createAppPolicyBoundComputerUsePlanPreview({
  appPolicy,
  command,
  forceApproval = false,
  route
}: CreateAppPolicyBoundComputerUsePlanPreviewInput): ComputerUsePlanPreview {
  return createComputerUsePlanPreview({
    command,
    route,
    forceApproval: forceApproval || appPolicy === "ask"
  });
}

export function createDerivedComputerUsePlanId(parentPlanId: string, value: unknown): string {
  return `${parentPlanId}:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16)}`;
}

function readRouteRisk(command: string, route: ExecutableCommandRoute) {
  const routePolicyBlock = readExecutableRoutePolicyBlockReason(command, route);
  if (routePolicyBlock) {
    return {
      level: "blocked" as const,
      reason: routePolicyBlock,
      requiresApproval: true
    };
  }

  switch (route.kind) {
    case "ghostty":
      return readGhosttyTaskRisk(command);
    case "chrome":
      return readChromeTaskRisk(command);
    case "finder":
      return readFinderTaskRisk(command);
    case "tmux_supervision":
      return readTmuxSupervisionTaskRisk();
  }
}

function readRouteAppName(route: ExecutableCommandRoute): string {
  switch (route.kind) {
    case "ghostty":
      return "Ghostty";
    case "chrome":
      return "Chrome";
    case "finder":
      return "Finder";
    case "tmux_supervision":
      return "tmux";
  }
}

function readRouteTarget(command: string, route: ExecutableCommandRoute): string {
  switch (route.kind) {
    case "ghostty":
      return `skfiy-shell · ${boundedSensitiveLabel(command, "command")}`;
    case "chrome":
      return readChromeTarget(command);
    case "finder":
      return readFinderTarget(command);
    case "tmux_supervision":
      return `Session ${boundedLabel(route.sessionName, "money-run")}`;
  }
}

function readChromeTarget(command: string): string {
  const intent = parseChromePageIntent(command);
  if (!intent.ok) {
    return "Unsupported Chrome target";
  }
  if ("kind" in intent && intent.kind === "current_page") {
    return "Current approved tab";
  }

  try {
    const url = new URL(intent.url);
    if (url.protocol === "file:") {
      return `Local file ${boundedLabel(path.basename(decodeURIComponent(url.pathname)), "page")}`;
    }
    return boundedLabel(url.host, "approved host");
  } catch {
    return "Approved Chrome target";
  }
}

function readFinderTarget(command: string): string {
  const intent = parseFinderOrganizationIntent(command);
  if (!intent.ok) {
    return "Unsupported Finder target";
  }

  switch (intent.target.kind) {
    case "current_finder_folder":
      return "Current Finder folder";
    case "selected_finder_folder":
      return "Selected Finder folder";
    case "absolute_path":
    case "drag_probe":
    case "item_drag_drop":
      return `Folder ${boundedLabel(path.basename(intent.target.rootPath), "selected folder")}`;
  }
}

function readRouteMutation(
  command: string,
  route: ExecutableCommandRoute,
  riskLevel: ComputerUsePlanPreview["risk"]["level"]
): boolean {
  if (riskLevel === "blocked" || route.kind === "tmux_supervision") {
    return false;
  }
  if (route.kind === "ghostty") {
    return riskLevel !== "low";
  }
  if (route.kind === "finder") {
    return true;
  }

  const intent = parseChromePageIntent(command);
  return intent.ok && !("kind" in intent && intent.kind === "current_page");
}

function createPlanId(value: unknown): string {
  return `task-plan-${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 20)}`;
}

function boundedLabel(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
  return normalized || fallback;
}

function boundedSensitiveLabel(value: string, fallback: string): string {
  return boundedLabel(value, fallback)
    .replace(/\b(token|password|secret|api[_-]?key)=([^\s&]+)/giu, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]");
}
