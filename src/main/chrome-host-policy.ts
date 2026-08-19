import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readRecord } from "./record-utils.js";

export type ChromeHostPolicyDefaultMode = "ask";
export type ChromeHostPolicyAction =
  | "allow_current_turn"
  | "always_allow"
  | "block_host"
  | "ask_host";
export type ChromeBrowserDataExposure = "browser_history" | "download_filename";

export interface ChromeHostPolicy {
  defaultMode: ChromeHostPolicyDefaultMode;
  allowedHosts: string[];
  currentTurnAllowedHosts: string[];
  blockedHosts: string[];
}

export interface ChromeHostPolicyIo {
  exists: (targetPath: string) => boolean | Promise<boolean>;
  mkdir: (targetPath: string) => Promise<void>;
  readFile: (targetPath: string) => Promise<string>;
  writeFile: (targetPath: string, content: string) => Promise<void>;
}

export interface ChromeHostPolicyResetIo extends ChromeHostPolicyIo {
  rm: (targetPath: string) => Promise<void>;
}

export interface ChromeHostPolicyState {
  schemaVersion: 1;
  state: "default" | "configured" | "invalid";
  path: string;
  policy: ChromeHostPolicy;
  reason?: string;
}

export interface ChromeHostPolicyActionInput {
  action: ChromeHostPolicyAction;
  host: unknown;
}

export type ChromeHostPolicyDecision =
  | {
      decision: "allow";
      host: string;
      reason: "always_allowed_host" | "current_turn_allowed_host";
      scope: "always" | "current_turn";
    }
  | {
      decision: "ask";
      host: string;
      reason: "default_ask";
    }
  | {
      decision: "block";
      host: string;
      reason: "blocked_host" | "missing_host";
    };

export type ChromeBrowserDataExposureDecision =
  | {
      decision: "allow";
      reason: "explicitly_confirmed";
    }
  | {
      decision: "block";
      reason:
        | "browser_history_exposure_requires_confirmation"
        | "download_filename_exposure_requires_confirmation";
    };

export function createDefaultChromeHostPolicy(): ChromeHostPolicy {
  return {
    defaultMode: "ask",
    allowedHosts: [],
    currentTurnAllowedHosts: [],
    blockedHosts: []
  };
}

export function createChromeHostPolicyStatePath(homeDir: string): string {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "skfiy",
    "chrome-host-policy.json"
  );
}

export async function readChromeHostPolicyState({
  homeDir,
  io = createDefaultChromeHostPolicyIo()
}: {
  homeDir: string;
  io?: ChromeHostPolicyIo;
}): Promise<ChromeHostPolicyState> {
  const statePath = createChromeHostPolicyStatePath(homeDir);

  if (!(await io.exists(statePath))) {
    return {
      schemaVersion: 1,
      state: "default",
      path: statePath,
      policy: createDefaultChromeHostPolicy(),
      reason: "Chrome host policy has not been configured yet."
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await io.readFile(statePath)) as unknown;
  } catch {
    return {
      schemaVersion: 1,
      state: "invalid",
      path: statePath,
      policy: createDefaultChromeHostPolicy(),
      reason: "Chrome host policy file is not valid JSON."
    };
  }

  const record = readRecord(parsed);
  if (!record) {
    return {
      schemaVersion: 1,
      state: "invalid",
      path: statePath,
      policy: createDefaultChromeHostPolicy(),
      reason: "Chrome host policy file is not an object."
    };
  }

  return {
    schemaVersion: 1,
    state: "configured",
    path: statePath,
    policy: normalizeChromeHostPolicy(record.policy)
  };
}

export async function writeChromeHostPolicyState({
  homeDir,
  policy,
  io = createDefaultChromeHostPolicyIo()
}: {
  homeDir: string;
  policy: ChromeHostPolicy;
  io?: ChromeHostPolicyIo;
}): Promise<ChromeHostPolicyState> {
  const statePath = createChromeHostPolicyStatePath(homeDir);
  const state: ChromeHostPolicyState = {
    schemaVersion: 1,
    state: "configured",
    path: statePath,
    policy: normalizeChromeHostPolicy(policy)
  };

  await io.mkdir(path.dirname(statePath));
  await io.writeFile(statePath, `${JSON.stringify({
    schemaVersion: state.schemaVersion,
    policy: state.policy
  }, null, 2)}\n`);

  return state;
}

export async function resetChromeHostPolicyState({
  homeDir,
  io = createDefaultChromeHostPolicyIo()
}: {
  homeDir: string;
  io?: ChromeHostPolicyResetIo;
}): Promise<ChromeHostPolicyState> {
  const statePath = createChromeHostPolicyStatePath(homeDir);

  if (await io.exists(statePath)) {
    await io.rm(statePath);
  }

  return {
    schemaVersion: 1,
    state: "default",
    path: statePath,
    policy: createDefaultChromeHostPolicy(),
    reason: "Chrome host policy has been reset to the default ask mode."
  };
}

export function normalizeChromeHostPolicy(value: unknown): ChromeHostPolicy {
  const record = readRecord(value);
  const defaultPolicy = createDefaultChromeHostPolicy();

  if (!record) {
    return defaultPolicy;
  }

  const blockedHosts = normalizeHostList(record.blockedHosts);
  const blockedSet = new Set(blockedHosts);
  const allowedHosts = normalizeHostList(record.allowedHosts)
    .filter((host) => !blockedSet.has(host));
  const allowedSet = new Set(allowedHosts);
  const currentTurnAllowedHosts = normalizeHostList(record.currentTurnAllowedHosts)
    .filter((host) => !blockedSet.has(host) && !allowedSet.has(host));

  return {
    defaultMode: "ask",
    allowedHosts,
    currentTurnAllowedHosts,
    blockedHosts
  };
}

export function decideChromeHostPolicy(
  policy: ChromeHostPolicy,
  hostOrUrl: unknown
): ChromeHostPolicyDecision {
  const host = normalizeChromeHost(hostOrUrl);
  if (!host) {
    return {
      decision: "block",
      host: "",
      reason: "missing_host"
    };
  }

  const normalizedPolicy = normalizeChromeHostPolicy(policy);
  if (normalizedPolicy.blockedHosts.includes(host)) {
    return {
      decision: "block",
      host,
      reason: "blocked_host"
    };
  }

  if (normalizedPolicy.allowedHosts.includes(host)) {
    return {
      decision: "allow",
      host,
      reason: "always_allowed_host",
      scope: "always"
    };
  }

  if (normalizedPolicy.currentTurnAllowedHosts.includes(host)) {
    return {
      decision: "allow",
      host,
      reason: "current_turn_allowed_host",
      scope: "current_turn"
    };
  }

  return {
    decision: "ask",
    host,
    reason: "default_ask"
  };
}

export function applyChromeHostPolicyAction(
  policy: ChromeHostPolicy,
  input: ChromeHostPolicyActionInput
): ChromeHostPolicy {
  const host = normalizeChromeHost(input.host);
  const nextPolicy = normalizeChromeHostPolicy(policy);

  if (!host) {
    return nextPolicy;
  }

  const allowedHosts = removeHost(nextPolicy.allowedHosts, host);
  const currentTurnAllowedHosts = removeHost(nextPolicy.currentTurnAllowedHosts, host);
  const blockedHosts = removeHost(nextPolicy.blockedHosts, host);

  if (input.action === "always_allow") {
    return {
      ...nextPolicy,
      allowedHosts: [...allowedHosts, host],
      currentTurnAllowedHosts,
      blockedHosts
    };
  }

  if (input.action === "allow_current_turn") {
    return {
      ...nextPolicy,
      allowedHosts,
      currentTurnAllowedHosts: [...currentTurnAllowedHosts, host],
      blockedHosts
    };
  }

  if (input.action === "block_host") {
    return {
      ...nextPolicy,
      allowedHosts,
      currentTurnAllowedHosts,
      blockedHosts: [...blockedHosts, host]
    };
  }

  return {
    ...nextPolicy,
    allowedHosts,
    currentTurnAllowedHosts,
    blockedHosts
  };
}

export function decideChromeBrowserDataExposure({
  exposure,
  confirmed
}: {
  exposure: ChromeBrowserDataExposure;
  confirmed?: unknown;
}): ChromeBrowserDataExposureDecision {
  if (confirmed === true) {
    return {
      decision: "allow",
      reason: "explicitly_confirmed"
    };
  }

  return {
    decision: "block",
    reason: exposure === "browser_history"
      ? "browser_history_exposure_requires_confirmation"
      : "download_filename_exposure_requires_confirmation"
  };
}

function normalizeHostList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const hosts: string[] = [];
  for (const entry of value) {
    const host = normalizeChromeHost(entry);
    if (host && !hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return hosts;
}

function normalizeChromeHost(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const input = value.trim();
  if (!input) {
    return "";
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    try {
      return new URL(input).host.toLowerCase();
    } catch {
      return "";
    }
  }

  if (/[/?#\s]/.test(input)) {
    return "";
  }

  try {
    return new URL(`https://${input}`).host.toLowerCase();
  } catch {
    return "";
  }
}

function removeHost(hosts: string[], host: string): string[] {
  return hosts.filter((candidate) => candidate !== host);
}

function createDefaultChromeHostPolicyIo(): ChromeHostPolicyResetIo {
  return {
    exists: (targetPath) => existsSync(targetPath),
    mkdir: async (targetPath) => {
      await mkdir(targetPath, { recursive: true });
    },
    readFile: async (targetPath) => readFile(targetPath, "utf8"),
    writeFile,
    rm: async (targetPath) => {
      await rm(targetPath, { force: true });
    }
  };
}
