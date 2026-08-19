import os from "node:os";
import path from "node:path";
import { buildCdpCommand, type CdpCommand } from "../computer-use/browser-control.js";
import { createSensitiveTextPatterns } from "../computer-use/sensitive-ui-policy.js";
import type {
  DesktopActionResult,
  DesktopAppState,
  DesktopExecutableAction
} from "../computer-use/types.js";
import type { RiskDecision } from "../../shared/types.js";

const CHROME_APP_NAME = "Chrome";
const CHROME_BUNDLE_ID = "com.google.Chrome";
const CHROME_PAGE_PREFIX = "打开 Chrome 测试页面 ";
const CHROME_PAGE_SUFFIX = " 并提取正文";
const CHROME_CURRENT_PAGE_COMMAND = "观察 Chrome 当前页面并提取正文";
const CHROME_FORM_PREFIX = "填写 Chrome 测试表单 ";
const CHROME_FORM_SUFFIX = " 并提取正文";
const CHROME_FORM_FIELD_MARKER = " 字段 ";
const CHROME_FORM_CLICK_MARKER = " 点击 ";

const CHROME_PAGE_RISK: RiskDecision = {
  level: "medium",
  reason: "Chrome test-page control navigates the browser and reads page text.",
  requiresApproval: true
};
const SENSITIVE_CHROME_TEXT_PATTERNS = createSensitiveTextPatterns();

export interface ChromeTaskClient {
  sendCdpCommand(command: CdpCommand): Promise<unknown>;
  waitForPageReady?: () => Promise<void>;
}

export interface ChromeDesktopClient {
  executeAction(action: DesktopExecutableAction): Promise<DesktopActionResult>;
}

export interface ChromeFormField {
  selector: string;
  value: string;
}

export interface ChromeCurrentPageSnapshot {
  url: string;
  title: string;
  text: string;
}

type ChromePageIntent =
  | { ok: true; kind: "current_page" }
  | { ok: true; url: string }
  | {
      ok: true;
      kind: "form";
      url: string;
      fields: ChromeFormField[];
      submitSelector: string;
    }
  | { ok: false; reason: string };

export type ChromeTaskEvent =
  | {
      type: "started";
      command: string;
      risk: RiskDecision;
    }
  | {
      type: "approval_required";
      command: string;
      risk: RiskDecision;
    }
  | {
      type: "locating_app";
      appName: string;
    }
  | {
      type: "app_activated";
      appName: string;
      bundleId: string;
    }
  | {
      type: "fallback_switch";
      from: "cdp";
      to: "screenshot_fallback";
      stage: "connection" | "navigation" | "extraction";
      reason: string;
    }
  | {
      type: "screenshot_before";
      path: string;
      observation: DesktopAppState;
    }
  | {
      type: "action_verified";
      actionType:
        | "navigate"
        | "fill_selector"
        | "click_selector"
        | "extract_text"
        | "current_page_snapshot";
      status: "passed";
      message: string;
    }
  | {
      type: "verification_failed";
      stage: "input" | "connection" | "navigation" | "interaction" | "extraction" | "sensitive";
      reason: string;
    }
  | {
      type: "completed";
      command: string;
      summary: string;
    };

export interface ChromeTaskOptions {
  approved?: boolean;
  desktopClient?: ChromeDesktopClient;
  createScreenshotPath?: (stage: "fallback") => string;
}

export async function* runChromePageTask(
  input: string,
  client: ChromeTaskClient | undefined,
  options: ChromeTaskOptions = {}
): AsyncGenerator<ChromeTaskEvent> {
  const parsed = parseChromePageIntent(input);
  const command = parsed.ok ? readChromeIntentCommand(parsed) : input.trim();

  yield {
    type: "started",
    command,
    risk: parsed.ok ? CHROME_PAGE_RISK : blockedDecision(parsed.reason)
  };

  if (!parsed.ok) {
    yield {
      type: "verification_failed",
      stage: "input",
      reason: parsed.reason
    };
    return;
  }

  yield {
    type: "approval_required",
    command,
    risk: CHROME_PAGE_RISK
  };

  if (!options.approved) {
    return;
  }

  if (isChromeFormIntent(parsed) && hasSensitiveFormInput(parsed.fields)) {
    yield {
      type: "verification_failed",
      stage: "sensitive",
      reason: "Sensitive form input is not allowed for Chrome Computer Use."
    };
    return;
  }

  yield {
    type: "locating_app",
    appName: CHROME_APP_NAME
  };

  if (!client) {
    yield* captureChromeScreenshotFallback(options);
    return;
  }

  if (isChromeCurrentPageIntent(parsed)) {
    try {
      const result = await client.sendCdpCommand(buildCdpCommand({ type: "extract_page_snapshot" }));
      const snapshot = readCurrentPageSnapshotResult(result);

      if (hasSensitiveText(snapshot.text)) {
        yield {
          type: "verification_failed",
          stage: "sensitive",
          reason: "Sensitive UI text is visible."
        };
        return;
      }

      yield {
        type: "action_verified",
        actionType: "current_page_snapshot",
        status: "passed",
        message: `Observed current page: ${snapshot.title || "untitled"} (${snapshot.url})`
      };
      yield {
        type: "completed",
        command: snapshot.url,
        summary: `Chrome current page extracted: ${snapshot.text}`
      };
    } catch (error) {
      yield* captureChromeScreenshotFallback(options, {
        stage: "extraction",
        reason: `Chrome CDP current page snapshot failed: ${readErrorMessage(error, "Chrome current page snapshot failed.")}`
      });
    }
    return;
  }

  try {
    await client.sendCdpCommand(buildCdpCommand({ type: "navigate", url: parsed.url }));
  } catch (error) {
    yield* captureChromeScreenshotFallback(options, {
      stage: "navigation",
      reason: `Chrome CDP navigation failed: ${readErrorMessage(error, "Chrome navigation failed.")}`
    });
    return;
  }

  yield {
    type: "action_verified",
    actionType: "navigate",
    status: "passed",
    message: `Navigated to: ${parsed.url}`
  };

  try {
    await client.waitForPageReady?.();

    if (isChromeFormIntent(parsed)) {
      try {
        for (const field of parsed.fields) {
          await client.sendCdpCommand(buildCdpCommand({
            type: "fill_selector",
            selector: field.selector,
            value: field.value
          }));
          yield {
            type: "action_verified",
            actionType: "fill_selector",
            status: "passed",
            message: `Filled ${field.selector}.`
          };
        }

        await client.sendCdpCommand(buildCdpCommand({
          type: "click_selector",
          selector: parsed.submitSelector
        }));
        yield {
          type: "action_verified",
          actionType: "click_selector",
          status: "passed",
          message: `Clicked ${parsed.submitSelector}.`
        };
      } catch (error) {
        yield {
          type: "verification_failed",
          stage: "interaction",
          reason: readErrorMessage(error, "Chrome form interaction failed.")
        };
        return;
      }

      await client.waitForPageReady?.();
    }

    const result = await client.sendCdpCommand(buildCdpCommand({ type: "extract_text" }));
    const extractedText = readRuntimeStringResult(result);

    if (hasSensitiveText(extractedText)) {
      yield {
        type: "verification_failed",
        stage: "sensitive",
        reason: "Sensitive UI text is visible."
      };
      return;
    }

    yield {
      type: "action_verified",
      actionType: "extract_text",
      status: "passed",
      message: `Extracted text: ${extractedText}`
    };
    yield {
      type: "completed",
      command: parsed.url,
      summary: `Chrome test page extracted: ${extractedText}`
    };
  } catch (error) {
    yield* captureChromeScreenshotFallback(options, {
      stage: "extraction",
      reason: `Chrome CDP extraction failed: ${readErrorMessage(error, "Chrome text extraction failed.")}`
    });
  }
}

function hasSensitiveText(value: string): boolean {
  return SENSITIVE_CHROME_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function hasSensitiveFormInput(fields: readonly ChromeFormField[]): boolean {
  return fields.some((field) =>
    hasSensitiveText(field.selector) || hasSensitiveText(field.value)
  );
}

async function* captureChromeScreenshotFallback(
  options: ChromeTaskOptions,
  failure: {
    stage: "connection" | "navigation" | "extraction";
    reason: string;
  } = {
    stage: "connection",
    reason: "Chrome CDP endpoint is not configured."
  }
): AsyncGenerator<ChromeTaskEvent> {
  yield {
    type: "fallback_switch",
    from: "cdp",
    to: "screenshot_fallback",
    stage: failure.stage,
    reason: failure.reason
  };

  if (!options.desktopClient) {
    yield {
      type: "verification_failed",
      stage: failure.stage,
      reason: `${failure.reason} screenshot fallback is unavailable.`
    };
    return;
  }

  const activation = await executeChromeDesktopAction(
    options.desktopClient,
    { type: "activate_app", bundleId: CHROME_BUNDLE_ID }
  );
  if (!activation.ok) {
    yield {
      type: "verification_failed",
      stage: failure.stage,
      reason: `${failure.reason} screenshot fallback activation failed: ${activation.reason}`
    };
    return;
  }

  yield {
    type: "app_activated",
    appName: CHROME_APP_NAME,
    bundleId: CHROME_BUNDLE_ID
  };

  const screenshotOutputPath = options.createScreenshotPath?.("fallback")
    ?? defaultChromeFallbackScreenshotPath();
  const observation = await executeChromeDesktopAction(
    options.desktopClient,
    {
      type: "observe_app",
      bundleId: CHROME_BUNDLE_ID,
      screenshotOutputPath
    }
  );

  if (!observation.ok) {
    yield {
      type: "verification_failed",
      stage: failure.stage,
      reason: `${failure.reason} screenshot fallback failed: ${observation.reason}`
    };
    return;
  }

  if (!isDesktopAppState(observation.result)) {
    yield {
      type: "verification_failed",
      stage: failure.stage,
      reason: `${failure.reason} screenshot fallback did not return app state.`
    };
    return;
  }

  yield {
    type: "screenshot_before",
    path: observation.result.screenshotPath,
    observation: observation.result
  };

  yield {
    type: "verification_failed",
    stage: failure.stage,
    reason: `${failure.reason} screenshot fallback observation captured: ${observation.result.screenshotPath}`
  };
}

async function executeChromeDesktopAction(
  desktopClient: ChromeDesktopClient,
  action: DesktopExecutableAction
): Promise<{ ok: true; result: DesktopActionResult } | { ok: false; reason: string }> {
  try {
    const result = await desktopClient.executeAction(action);
    if (isActionResult(result) && !result.ok) {
      return {
        ok: false,
        reason: result.message ?? `Desktop helper could not ${action.type}.`
      };
    }

    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      reason: readErrorMessage(error, `Desktop helper could not ${action.type}.`)
    };
  }
}

function isActionResult(value: DesktopActionResult): value is { ok: boolean; message?: string } {
  return typeof value === "object" && value !== null && "ok" in value;
}

function isDesktopAppState(value: DesktopActionResult): value is DesktopAppState {
  return Boolean(value)
    && typeof value === "object"
    && "bundleId" in value
    && "isRunning" in value
    && "isActive" in value
    && "screenshotPath" in value;
}

function defaultChromeFallbackScreenshotPath(): string {
  return path.join(os.tmpdir(), "skfiy", `chrome-fallback-${Date.now()}.png`);
}

export function parseChromePageIntent(input: string): ChromePageIntent {
  const trimmed = input.trim();

  if (isChromeCurrentPageRequest(trimmed)) {
    return {
      ok: true,
      kind: "current_page"
    };
  }

  const formIntent = parseChromeFormIntent(trimmed);
  if (formIntent.ok) {
    return formIntent;
  }

  const exactTestPageUrl = readExactChromeTestPageUrl(trimmed);
  const flexiblePageUrl = exactTestPageUrl ?? readFlexibleChromePageUrl(trimmed);

  if (!flexiblePageUrl) {
    return {
      ok: false,
      reason: "Chrome page control requires: 打开 Chrome 测试页面 <url> 并提取正文"
    };
  }

  if (!isSupportedUrl(flexiblePageUrl)) {
    return {
      ok: false,
      reason: "Chrome page control requires a file:, http:, or https: URL."
    };
  }

  return {
    ok: true,
    url: flexiblePageUrl
  };
}

function isChromeCurrentPageRequest(input: string): boolean {
  const normalized = input.trim().toLowerCase();

  return normalized === CHROME_CURRENT_PAGE_COMMAND.toLowerCase()
    || (
      /\b(chrome|chromium)\b/u.test(normalized)
      && /当前页面|current\s+page/u.test(normalized)
      && /提取|读取|观察|查看|extract|read|observe/u.test(normalized)
    );
}

function readExactChromeTestPageUrl(input: string): string | undefined {
  if (!input.startsWith(CHROME_PAGE_PREFIX) || !input.endsWith(CHROME_PAGE_SUFFIX)) {
    return undefined;
  }

  return input
    .slice(CHROME_PAGE_PREFIX.length, input.length - CHROME_PAGE_SUFFIX.length)
    .trim();
}

function readFlexibleChromePageUrl(input: string): string | undefined {
  const normalized = input.trim().toLowerCase();

  if (
    !/\b(chrome|chromium)\b/u.test(normalized)
    || !/(打开|访问|导航|加载|open|visit|navigate)/u.test(normalized)
    || !/(提取|读取|正文|内容|extract|read|text|content)/u.test(normalized)
  ) {
    return undefined;
  }

  return input.match(/\b(?:file|https?):\/\/[^\s,，;；)）]+/iu)?.[0];
}

function readChromeIntentCommand(intent: Extract<ChromePageIntent, { ok: true }>): string {
  return isChromeCurrentPageIntent(intent) ? "Chrome current page" : intent.url;
}

function isChromeCurrentPageIntent(intent: Extract<ChromePageIntent, { ok: true }>): intent is {
  ok: true;
  kind: "current_page";
} {
  return "kind" in intent && intent.kind === "current_page";
}

function parseChromeFormIntent(input: string):
  | {
      ok: true;
      kind: "form";
      url: string;
      fields: ChromeFormField[];
      submitSelector: string;
    }
  | { ok: false } {
  if (!input.startsWith(CHROME_FORM_PREFIX) || !input.endsWith(CHROME_FORM_SUFFIX)) {
    return { ok: false };
  }

  const body = input
    .slice(CHROME_FORM_PREFIX.length, input.length - CHROME_FORM_SUFFIX.length)
    .trim();
  const fieldIndex = body.indexOf(CHROME_FORM_FIELD_MARKER);
  const clickIndex = body.indexOf(CHROME_FORM_CLICK_MARKER);

  if (fieldIndex <= 0 || clickIndex <= fieldIndex) {
    return { ok: false };
  }

  const url = body.slice(0, fieldIndex).trim();
  const assignment = body
    .slice(fieldIndex + CHROME_FORM_FIELD_MARKER.length, clickIndex)
    .trim();
  const submitSelector = body
    .slice(clickIndex + CHROME_FORM_CLICK_MARKER.length)
    .trim();
  const fields = parseChromeFormFields(assignment);

  if (!submitSelector || fields.length === 0) {
    return { ok: false };
  }

  if (!isSupportedUrl(url)) {
    return { ok: false };
  }

  return {
    ok: true,
    kind: "form",
    url,
    fields,
    submitSelector
  };
}

function parseChromeFormFields(assignment: string): ChromeFormField[] {
  const chunks = assignment.split(";").map((chunk) => chunk.trim()).filter(Boolean);
  const fields: ChromeFormField[] = [];

  for (const chunk of chunks) {
    const equalsIndex = chunk.indexOf("=");
    if (equalsIndex <= 0) {
      return [];
    }

    const selector = chunk.slice(0, equalsIndex).trim();
    const value = chunk.slice(equalsIndex + 1).trim();

    if (!selector || !value) {
      return [];
    }

    fields.push({ selector, value });
  }

  return fields;
}

function isChromeFormIntent(intent: Extract<ChromePageIntent, { ok: true }>): intent is {
  ok: true;
  kind: "form";
  url: string;
  fields: ChromeFormField[];
  submitSelector: string;
} {
  return "kind" in intent && intent.kind === "form";
}

function blockedDecision(reason: string): RiskDecision {
  return {
    level: "blocked",
    reason,
    requiresApproval: true
  };
}

function isSupportedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "file:" || url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readRuntimeStringResult(value: unknown): string {
  if (
    value
    && typeof value === "object"
    && "result" in value
    && value.result
    && typeof value.result === "object"
    && "value" in value.result
    && typeof value.result.value === "string"
  ) {
    return value.result.value;
  }

  throw new Error("Chrome CDP extraction did not return a string value.");
}

function readCurrentPageSnapshotResult(value: unknown): ChromeCurrentPageSnapshot {
  if (
    value
    && typeof value === "object"
    && "result" in value
    && value.result
    && typeof value.result === "object"
    && "value" in value.result
    && value.result.value
    && typeof value.result.value === "object"
    && "url" in value.result.value
    && typeof value.result.value.url === "string"
    && "title" in value.result.value
    && typeof value.result.value.title === "string"
    && "text" in value.result.value
    && typeof value.result.value.text === "string"
  ) {
    return {
      url: value.result.value.url,
      title: value.result.value.title,
      text: value.result.value.text
    };
  }

  throw new Error("Chrome CDP current page snapshot did not return url, title, and text.");
}

function readErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
