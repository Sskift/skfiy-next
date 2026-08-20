import {
  createChromeVerifySelectorExpression,
  type ChromeVerifySelectorExpected
} from "./chrome-dom-verification.js";

export type BrowserControlMode =
  | "structured_cdp"
  | "screenshot_fallback"
  | "unavailable";

export interface BrowserControlCapability {
  cdpEndpoint?: string;
  screenshotFallbackAvailable: boolean;
}

export interface BrowserControlModeDecision {
  mode: BrowserControlMode;
  reason: string;
}

export interface BrowserPageIdentity {
  url: string;
  documentId: string;
  /** Binds actions to one selected tab. In-page guard backstop; the CDP client selects the target. */
  tabId?: number;
  /** Binds actions to the current workflow request. Throws SKFIY_STALE_REQUEST when mismatched. */
  requestId?: string;
}

export type BrowserStructuredAction =
  | { type: "navigate"; url: string }
  | {
      type: "fill_selector";
      selector: string;
      value: string;
      expectedPageIdentity?: BrowserPageIdentity;
    }
  | {
      type: "click_selector";
      selector: string;
      expectedPageIdentity?: BrowserPageIdentity;
    }
  | { type: "extract_text"; selector?: string }
  | { type: "extract_page_snapshot" }
  | {
      type: "scroll_selector";
      selector: string;
      deltaY: number;
      expectedPageIdentity?: BrowserPageIdentity;
    }
  | {
      type: "verify_selector";
      selector: string;
      expected: ChromeVerifySelectorExpected;
      expectedPageIdentity?: BrowserPageIdentity;
    }
  | { type: "wait_for_navigation"; timeoutMs?: number };

export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
}

export function selectBrowserControlMode(
  capability: BrowserControlCapability
): BrowserControlModeDecision {
  if (capability.cdpEndpoint) {
    return {
      mode: "structured_cdp",
      reason: "Chrome DevTools Protocol endpoint is available."
    };
  }

  if (capability.screenshotFallbackAvailable) {
    return {
      mode: "screenshot_fallback",
      reason: "Structured browser control is unavailable; use screenshot Computer Use."
    };
  }

  return {
    mode: "unavailable",
    reason: "No browser control channel is available."
  };
}

export function buildCdpCommand(action: BrowserStructuredAction): CdpCommand {
  switch (action.type) {
    case "navigate":
      return {
        method: "Page.navigate",
        params: { url: action.url }
      };
    case "fill_selector":
      return createRuntimeEvaluateCommand(
        createFillSelectorExpression(
          action.selector,
          action.value,
          action.expectedPageIdentity
        )
      );
    case "click_selector":
      return createRuntimeEvaluateCommand(createClickSelectorExpression(
        action.selector,
        action.expectedPageIdentity
      ));
    case "extract_text":
      return createRuntimeEvaluateCommand(createExtractTextExpression(action.selector));
    case "extract_page_snapshot":
      return createRuntimeEvaluateCommand(createExtractPageSnapshotExpression());
    case "scroll_selector":
      return createRuntimeEvaluateCommand(createScrollSelectorExpression(
        action.selector,
        action.deltaY,
        action.expectedPageIdentity
      ));
    case "verify_selector":
      return createRuntimeEvaluateCommand(createChromeVerifySelectorExpression(
        action.selector,
        action.expected,
        createPageIdentityGuardExpression(action.expectedPageIdentity)
      ));
    case "wait_for_navigation":
      return createRuntimeEvaluateCommand(createWaitForNavigationExpression(action.timeoutMs));
  }
}

function createRuntimeEvaluateCommand(expression: string): CdpCommand {
  return {
    method: "Runtime.evaluate",
    params: {
      expression,
      awaitPromise: true,
      returnByValue: true
    }
  };
}

function createFillSelectorExpression(
  selector: string,
  value: string,
  expectedPageIdentity?: BrowserPageIdentity
): string {
  return `(() => {
    ${createPageIdentityGuardExpression(expectedPageIdentity)}
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) {
      throw new Error("Selector not found: ${escapeForTemplate(selector)}");
    }
    if (!("value" in element)) {
      throw new Error("Element is not fillable: ${escapeForTemplate(selector)}");
    }
    element.focus();
    element.value = ${JSON.stringify(value)};
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: ${JSON.stringify(value)}
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`;
}

function createClickSelectorExpression(
  selector: string,
  expectedPageIdentity?: BrowserPageIdentity
): string {
  return `(() => {
    ${createPageIdentityGuardExpression(expectedPageIdentity)}
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) {
      throw new Error("Selector not found: ${escapeForTemplate(selector)}");
    }
    element.click();
    return true;
  })()`;
}

function createScrollSelectorExpression(
  selector: string,
  deltaY: number,
  expectedPageIdentity?: BrowserPageIdentity
): string {
  const safeDeltaY = Number.isFinite(deltaY) ? Math.trunc(deltaY) : 0;
  return `(() => {
    ${createPageIdentityGuardExpression(expectedPageIdentity)}
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) {
      throw new Error("Selector not found: ${escapeForTemplate(selector)}");
    }
    element.scrollIntoView({ block: "nearest" });
    if (typeof element.scrollBy === "function") {
      element.scrollBy({ top: ${safeDeltaY}, behavior: "instant" });
    } else {
      window.scrollBy(0, ${safeDeltaY});
    }
    return true;
  })()`;
}

function createExtractTextExpression(selector: string | undefined): string {
  const target = selector
    ? `document.querySelector(${JSON.stringify(selector)})`
    : "document.body";

  return `(() => {
    const element = ${target};
    if (!element) {
      throw new Error("Selector not found: ${escapeForTemplate(selector ?? "body")}");
    }
    return element.innerText ?? element.textContent ?? "";
  })()`;
}

function createExtractPageSnapshotExpression(): string {
  return `(() => ({
    url: window.location.href,
    documentId: String(performance.timeOrigin),
    title: document.title,
    text: document.body?.innerText ?? document.body?.textContent ?? ""
  }))()`;
}

function createWaitForNavigationExpression(timeoutMs: number | undefined): string {
  const safeTimeout = Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
    ? Math.min(Math.trunc(timeoutMs as number), 30_000)
    : 10_000;
  return `new Promise((resolve) => {
    const timeoutMs = ${safeTimeout};
    if (document.readyState === "complete") {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    window.addEventListener("load", () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  })`;
}

export function createPageIdentityGuardExpression(
  expectedPageIdentity: BrowserPageIdentity | undefined
): string {
  if (!expectedPageIdentity) {
    return "";
  }

  const requestGuard = expectedPageIdentity.requestId === undefined
    ? ""
    : `if (
      window.__SKFIY_BOUND_REQUEST_ID__ !== undefined
      && window.__SKFIY_BOUND_REQUEST_ID__ !== ${JSON.stringify(expectedPageIdentity.requestId)}
    ) {
      throw new Error("SKFIY_STALE_REQUEST");
    }`;
  const tabGuard = expectedPageIdentity.tabId === undefined
    ? ""
    : `if (
      window.__SKFIY_BOUND_TAB_ID__ !== undefined
      && window.__SKFIY_BOUND_TAB_ID__ !== ${expectedPageIdentity.tabId}
    ) {
      throw new Error("SKFIY_TAB_NOT_FOUND");
    }`;

  return `${requestGuard}
    ${tabGuard}
    if (
      window.location.href !== ${JSON.stringify(expectedPageIdentity.url)}
      || String(performance.timeOrigin) !== ${JSON.stringify(expectedPageIdentity.documentId)}
    ) {
      throw new Error("SKFIY_PAGE_TARGET_CHANGED");
    }`;
}

function escapeForTemplate(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("$", "\\$");
}
