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

export type BrowserStructuredAction =
  | { type: "navigate"; url: string }
  | { type: "fill_selector"; selector: string; value: string }
  | { type: "click_selector"; selector: string }
  | { type: "extract_text"; selector?: string }
  | { type: "extract_page_snapshot" };

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
        createFillSelectorExpression(action.selector, action.value)
      );
    case "click_selector":
      return createRuntimeEvaluateCommand(createClickSelectorExpression(action.selector));
    case "extract_text":
      return createRuntimeEvaluateCommand(createExtractTextExpression(action.selector));
    case "extract_page_snapshot":
      return createRuntimeEvaluateCommand(createExtractPageSnapshotExpression());
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

function createFillSelectorExpression(selector: string, value: string): string {
  return `(() => {
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

function createClickSelectorExpression(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) {
      throw new Error("Selector not found: ${escapeForTemplate(selector)}");
    }
    element.click();
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
    title: document.title,
    text: document.body?.innerText ?? document.body?.textContent ?? ""
  }))()`;
}

function escapeForTemplate(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("$", "\\$");
}
