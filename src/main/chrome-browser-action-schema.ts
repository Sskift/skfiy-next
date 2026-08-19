import { decideChromeBrowserDataExposure } from "./chrome-host-policy.js";
import { readRecord } from "./record-utils.js";

export const CHROME_BROWSER_OBSERVE_TYPE = "skfiy.page.observe";
export const CHROME_BROWSER_ACTION_TYPE = "skfiy.page.action";
export const CHROME_BROWSER_SCREENSHOT_TYPE = "skfiy.page.screenshot";
export const CHROME_BROWSER_DOWNLOADS_STATUS_TYPE = "skfiy.downloads.status";
export const CHROME_BROWSER_HISTORY_QUERY_TYPE = "skfiy.history.query";

export interface ChromeBrowserMessage {
  schemaVersion: 1;
  type: string;
  requestId: string;
  payload?: unknown;
}

export type ChromeBrowserMessageNormalization =
  | {
      ok: true;
      message: ChromeBrowserMessage;
    }
  | {
      ok: false;
      result: "invalid" | "blocked";
      reason: string;
    };

const DEFAULT_OBSERVE_PAYLOAD = {
  mode: "current_page",
  include: ["title", "url", "visible_text", "forms", "interactive_elements"]
};

const SENSITIVE_FIELD_PATTERNS = [
  /password/i,
  /passcode/i,
  /otp/i,
  /two[-_\s]?factor/i,
  /credit[-_\s]?card/i,
  /card[-_\s]?number/i,
  /security[-_\s]?code/i,
  /\bcvv\b/i,
  /token/i,
  /secret/i,
  /api[-_\s]?key/i
];

export function normalizeChromeBrowserMessage(
  message: ChromeBrowserMessage
): ChromeBrowserMessageNormalization {
  if (message.type === CHROME_BROWSER_OBSERVE_TYPE) {
    return {
      ok: true,
      message: {
        schemaVersion: 1,
        type: CHROME_BROWSER_OBSERVE_TYPE,
        requestId: message.requestId,
        payload: normalizeObservePayload(message.payload)
      }
    };
  }

  if (message.type === CHROME_BROWSER_ACTION_TYPE) {
    return normalizePageActionMessage(message);
  }

  if (message.type === CHROME_BROWSER_SCREENSHOT_TYPE) {
    return {
      ok: true,
      message: {
        schemaVersion: 1,
        type: CHROME_BROWSER_SCREENSHOT_TYPE,
        requestId: message.requestId,
        payload: normalizeScreenshotPayload(message.payload)
      }
    };
  }

  if (message.type === CHROME_BROWSER_DOWNLOADS_STATUS_TYPE) {
    return normalizeDownloadsStatusMessage(message);
  }

  if (message.type === CHROME_BROWSER_HISTORY_QUERY_TYPE) {
    return normalizeHistoryQueryMessage(message);
  }

  return {
    ok: true,
    message
  };
}

function normalizeScreenshotPayload(payload: unknown): Record<string, unknown> {
  const record = readRecord(payload);
  const format = record?.format === "jpeg" ? "jpeg" : "png";

  return {
    format,
    ...(format === "jpeg" && typeof record?.quality === "number"
      ? { quality: clampInteger(record.quality, 1, 100) }
      : {})
  };
}

function normalizeDownloadsStatusMessage(
  message: ChromeBrowserMessage
): ChromeBrowserMessageNormalization {
  const payload = readRecord(message.payload) ?? {};
  const includeFilePaths = payload.includeFilePaths === true;

  const filenameExposure = decideChromeBrowserDataExposure({
    exposure: "download_filename",
    confirmed: payload.confirmed
  });
  if (includeFilePaths && filenameExposure.decision === "block") {
    return {
      ok: false,
      result: "blocked",
      reason: "download_path_exposure_requires_confirmation"
    };
  }

  return {
    ok: true,
    message: {
      schemaVersion: 1,
      type: CHROME_BROWSER_DOWNLOADS_STATUS_TYPE,
      requestId: message.requestId,
      payload: {
        limit: typeof payload.limit === "number" ? clampInteger(payload.limit, 1, 50) : 20,
        includeFilePaths,
        ...(includeFilePaths ? { confirmed: true } : {})
      }
    }
  };
}

function normalizeHistoryQueryMessage(
  message: ChromeBrowserMessage
): ChromeBrowserMessageNormalization {
  const payload = readRecord(message.payload) ?? {};
  const historyExposure = decideChromeBrowserDataExposure({
    exposure: "browser_history",
    confirmed: payload.confirmed
  });

  if (historyExposure.decision === "block") {
    return {
      ok: false,
      result: "blocked",
      reason: historyExposure.reason
    };
  }

  return {
    ok: true,
    message: {
      schemaVersion: 1,
      type: CHROME_BROWSER_HISTORY_QUERY_TYPE,
      requestId: message.requestId,
      payload: {
        limit: typeof payload.limit === "number" ? clampInteger(payload.limit, 1, 50) : 20,
        ...(typeof payload.text === "string" && payload.text.trim()
          ? { text: payload.text.trim() }
          : {}),
        confirmed: true
      }
    }
  };
}

function normalizeObservePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ...DEFAULT_OBSERVE_PAYLOAD,
      include: [...DEFAULT_OBSERVE_PAYLOAD.include]
    };
  }

  return {
    ...DEFAULT_OBSERVE_PAYLOAD,
    ...payload,
    include: Array.isArray((payload as Record<string, unknown>).include)
      ? [...(payload as Record<string, unknown>).include as unknown[]]
      : [...DEFAULT_OBSERVE_PAYLOAD.include]
  };
}

function normalizePageActionMessage(
  message: ChromeBrowserMessage
): ChromeBrowserMessageNormalization {
  const payload = readRecord(message.payload);
  const action = readRecord(payload?.action);

  if (!action) {
    return {
      ok: false,
      result: "invalid",
      reason: "missing_action"
    };
  }

  const kind = typeof action.kind === "string" ? action.kind : "";

  if (kind === "navigate") {
    if (typeof action.url !== "string" || action.url.length === 0) {
      return { ok: false, result: "invalid", reason: "missing_navigation_url" };
    }
    if (!isSafeNavigationUrl(action.url)) {
      return { ok: false, result: "blocked", reason: "unsafe_navigation_url" };
    }
  } else if (kind === "click") {
    if (!hasActionTarget(action)) {
      return { ok: false, result: "invalid", reason: "missing_action_target" };
    }
  } else if (kind === "fill") {
    if (!hasActionTarget(action)) {
      return { ok: false, result: "invalid", reason: "missing_action_target" };
    }
    if (looksSensitive(action)) {
      return { ok: false, result: "blocked", reason: "sensitive_form_action" };
    }
  } else if (kind === "scroll") {
    if (typeof action.deltaX !== "number" && typeof action.deltaY !== "number") {
      return { ok: false, result: "invalid", reason: "missing_scroll_delta" };
    }
  } else if (kind === "submit") {
    if (action.confirmed !== true) {
      return {
        ok: false,
        result: "blocked",
        reason: "form_submission_requires_confirmation"
      };
    }
    if (!hasActionTarget(action)) {
      return { ok: false, result: "invalid", reason: "missing_action_target" };
    }
  } else {
    return {
      ok: false,
      result: "invalid",
      reason: "unsupported_action_kind"
    };
  }

  return {
    ok: true,
    message: {
      schemaVersion: 1,
      type: CHROME_BROWSER_ACTION_TYPE,
      requestId: message.requestId,
      payload: {
        action: { ...action }
      }
    }
  };
}

function hasActionTarget(action: Record<string, unknown>): boolean {
  return ["selector", "text", "role"].some((key) =>
    typeof action[key] === "string" && (action[key] as string).trim().length > 0
  );
}

function isSafeNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:";
  } catch {
    return false;
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function looksSensitive(action: Record<string, unknown>): boolean {
  const haystack = [
    action.selector,
    action.text,
    action.role,
    action.name,
    action.value
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(haystack));
}
