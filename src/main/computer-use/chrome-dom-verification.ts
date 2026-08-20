/**
 * DOM-first verification for Chrome Computer Use.
 *
 * A verify action evaluates a bounded DOM assertion in the page and returns
 * `{ passed, actual }` evidence. Verification is distinct from interaction:
 * the action may have executed while the page still does not show the
 * expected state. When the assertion fails the orchestrator falls back to a
 * screenshot observation where permitted.
 */

export type ChromeVerifySelectorKind = "text" | "value" | "visible" | "hidden";

export interface ChromeVerifySelectorExpected {
  kind: ChromeVerifySelectorKind;
  value?: string;
}

export type ChromeDomVerificationResult =
  | { passed: true; actual: string }
  | { passed: false; actual: string; reason: string };

/**
 * Builds the in-page expression for a verify assertion. The expression never
 * throws on a failed assertion — it returns `{ passed, actual }` so the
 * orchestrator can emit typed evidence. It only throws when the guard rejects
 * a stale page/tab/request binding.
 */
export function createChromeVerifySelectorExpression(
  selector: string,
  expected: ChromeVerifySelectorExpected,
  guardExpression: string
): string {
  const assertion = createVerifyAssertionExpression(expected);
  return `(() => {
    ${guardExpression}
    const element = document.querySelector(${JSON.stringify(selector)});
    ${assertion}
  })()`;
}

function createVerifyAssertionExpression(expected: ChromeVerifySelectorExpected): string {
  switch (expected.kind) {
    case "text": {
      const expectedText = JSON.stringify(expected.value ?? "");
      return `if (!element) {
        return { passed: false, actual: "" };
      }
      const actual = (element.innerText ?? element.textContent ?? "").trim();
      const passed = actual.includes(${expectedText});
      return { passed, actual };`;
    }
    case "value": {
      const expectedValue = JSON.stringify(expected.value ?? "");
      return `if (!element) {
        return { passed: false, actual: "" };
      }
      const actual = "value" in element ? String(element.value ?? "") : "";
      return { passed: actual === ${expectedValue}, actual };`;
    }
    case "visible": {
      return `if (!element) {
        return { passed: false, actual: "absent" };
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible = rect.width > 0
        && rect.height > 0
        && style.visibility !== "hidden"
        && style.display !== "none";
      return { passed: visible, actual: visible ? "visible" : "hidden" };`;
    }
    case "hidden": {
      return `if (!element) {
        return { passed: true, actual: "absent" };
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const hidden = rect.width === 0
        || rect.height === 0
        || style.visibility === "hidden"
        || style.display === "none";
      return { passed: hidden, actual: hidden ? "hidden" : "visible" };`;
    }
  }
}

/** Formats the expected state for value-free event evidence. */
export function formatChromeVerifyExpected(expected: ChromeVerifySelectorExpected): string {
  switch (expected.kind) {
    case "text":
      return `text matching "${expected.value ?? ""}"`;
    case "value":
      return `value equal to "${expected.value ?? ""}"`;
    case "visible":
      return "element visible";
    case "hidden":
      return "element hidden or absent";
  }
}

/**
 * Parses a CDP Runtime.evaluate result into a typed verification result.
 * Throws when the page did not return the bounded evidence shape.
 */
export function readChromeDomVerificationResult(value: unknown): ChromeDomVerificationResult {
  if (
    value
    && typeof value === "object"
    && "result" in value
    && value.result
    && typeof value.result === "object"
    && "value" in value.result
    && value.result.value
    && typeof value.result.value === "object"
    && "passed" in value.result.value
    && typeof value.result.value.passed === "boolean"
    && "actual" in value.result.value
    && typeof value.result.value.actual === "string"
  ) {
    const evidence = value.result.value as { passed: boolean; actual: string };
    if (evidence.passed) {
      return { passed: true, actual: evidence.actual };
    }
    return {
      passed: false,
      actual: evidence.actual,
      reason: "DOM verification could not prove the expected page state."
    };
  }

  throw new Error("Chrome CDP verification did not return bounded evidence.");
}
