import { describe, expect, it } from "vitest";
import {
  createChromeVerifySelectorExpression,
  formatChromeVerifyExpected,
  readChromeDomVerificationResult
} from "./chrome-dom-verification";

const GUARD_EXPRESSION = 'if (window.location.href !== "bound") { throw new Error("SKFIY_PAGE_TARGET_CHANGED"); }';

describe("createChromeVerifySelectorExpression", () => {
  it("builds a text assertion that returns evidence without throwing", () => {
    const expression = createChromeVerifySelectorExpression(
      "#status",
      { kind: "text", value: "Submitted" },
      GUARD_EXPRESSION
    );

    expect(expression).toContain('document.querySelector("#status")');
    expect(expression).toContain("innerText");
    expect(expression).toContain("Submitted");
    expect(expression).toContain("return { passed, actual };");
    expect(expression).toContain("SKFIY_PAGE_TARGET_CHANGED");
  });

  it("builds a value assertion that compares element values", () => {
    const expression = createChromeVerifySelectorExpression(
      "#name",
      { kind: "value", value: "skfiy" },
      ""
    );

    expect(expression).toContain('"value" in element');
    expect(expression).toContain("skfiy");
  });

  it("builds a visible assertion that measures geometry and style", () => {
    const expression = createChromeVerifySelectorExpression(
      "#dialog",
      { kind: "visible" },
      ""
    );

    expect(expression).toContain("getBoundingClientRect");
    expect(expression).toContain("getComputedStyle");
    expect(expression).toContain('actual: visible ? "visible" : "hidden"');
  });

  it("builds a hidden assertion that passes when the element is absent", () => {
    const expression = createChromeVerifySelectorExpression(
      "#spinner",
      { kind: "hidden" },
      ""
    );

    expect(expression).toContain("if (!element)");
    expect(expression).toContain('passed: true, actual: "absent"');
  });

  it("embeds the guard before the assertion", () => {
    const expression = createChromeVerifySelectorExpression(
      "#status",
      { kind: "text", value: "ok" },
      GUARD_EXPRESSION
    );

    expect(expression.indexOf("SKFIY_PAGE_TARGET_CHANGED")).toBeLessThan(
      expression.indexOf("document.querySelector")
    );
  });
});

describe("readChromeDomVerificationResult", () => {
  it("parses a passed verification result", () => {
    expect(readChromeDomVerificationResult({
      result: {
        type: "object",
        value: { passed: true, actual: "Submitted" }
      }
    })).toEqual({ passed: true, actual: "Submitted" });
  });

  it("parses a failed verification result with a reason", () => {
    expect(readChromeDomVerificationResult({
      result: {
        type: "object",
        value: { passed: false, actual: "Pending" }
      }
    })).toEqual({
      passed: false,
      actual: "Pending",
      reason: "DOM verification could not prove the expected page state."
    });
  });

  it("throws when the evidence shape is missing", () => {
    expect(() => readChromeDomVerificationResult({
      result: { type: "string", value: "unexpected" }
    })).toThrow("Chrome CDP verification did not return bounded evidence.");
  });

  it("throws when the result is not an object", () => {
    expect(() => readChromeDomVerificationResult(undefined)).toThrow(
      "Chrome CDP verification did not return bounded evidence."
    );
  });
});

describe("formatChromeVerifyExpected", () => {
  it("formats a text expectation", () => {
    expect(formatChromeVerifyExpected({ kind: "text", value: "Done" })).toBe('text matching "Done"');
  });

  it("formats a value expectation", () => {
    expect(formatChromeVerifyExpected({ kind: "value", value: "skfiy" })).toBe('value equal to "skfiy"');
  });

  it("formats a visible expectation", () => {
    expect(formatChromeVerifyExpected({ kind: "visible" })).toBe("element visible");
  });

  it("formats a hidden expectation", () => {
    expect(formatChromeVerifyExpected({ kind: "hidden" })).toBe("element hidden or absent");
  });
});
