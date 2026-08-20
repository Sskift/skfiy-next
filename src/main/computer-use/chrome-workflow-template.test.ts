import { describe, expect, it } from "vitest";
import {
  CHROME_WORKFLOW_MAX_STEPS,
  CHROME_WORKFLOW_TEMPLATE_LIBRARY,
  defineChromeWorkflowTemplate,
  deserializeChromeWorkflowTemplate,
  instantiateChromeWorkflowTemplate,
  serializeChromeWorkflowTemplate,
  type ChromeWorkflowTemplateDefinition
} from "./chrome-workflow-template";

const VALID_TEMPLATE: ChromeWorkflowTemplateDefinition = {
  templateId: "search-form",
  description: "Fill and submit the search form.",
  maxSteps: 4,
  steps: [
    { kind: "observe" },
    { kind: "fill", selector: "#search-input", valuePlaceholder: "query" },
    { kind: "submit", selector: "#search-button" },
    { kind: "verify", selector: "#results", expected: { kind: "visible" } }
  ]
};

describe("defineChromeWorkflowTemplate", () => {
  it("accepts a bounded value-free template", () => {
    const result = defineChromeWorkflowTemplate(VALID_TEMPLATE);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.template.steps).toHaveLength(4);
      expect(Object.isFrozen(result.template)).toBe(true);
    }
  });

  it("rejects a template with too many steps", () => {
    const result = defineChromeWorkflowTemplate({
      ...VALID_TEMPLATE,
      maxSteps: CHROME_WORKFLOW_MAX_STEPS + 1
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("maxSteps")
    });
  });

  it("rejects a template whose steps exceed its declared maxSteps", () => {
    const result = defineChromeWorkflowTemplate({
      ...VALID_TEMPLATE,
      maxSteps: 2
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("exceeds its declared maxSteps")
    });
  });

  it("rejects a template with no steps", () => {
    const result = defineChromeWorkflowTemplate({
      ...VALID_TEMPLATE,
      steps: []
    });

    expect(result).toMatchObject({ ok: false });
  });

  it("rejects a template that carries fill values", () => {
    const result = defineChromeWorkflowTemplate({
      ...VALID_TEMPLATE,
      steps: [
        { kind: "fill", selector: "#search-input", valuePlaceholder: "query", value: "secret" }
      ]
    } as unknown as ChromeWorkflowTemplateDefinition);

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("value-free")
    });
  });

  it("rejects a template with sensitive selectors", () => {
    const result = defineChromeWorkflowTemplate({
      ...VALID_TEMPLATE,
      steps: [
        { kind: "fill", selector: "#password", valuePlaceholder: "credential" }
      ]
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("selector is not allowed")
    });
  });

  it("rejects a fill step without a placeholder", () => {
    const result = defineChromeWorkflowTemplate({
      ...VALID_TEMPLATE,
      steps: [{ kind: "fill", selector: "#search-input" }]
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("valuePlaceholder")
    });
  });

  it("rejects a scroll step without a finite deltaY", () => {
    const result = defineChromeWorkflowTemplate({
      ...VALID_TEMPLATE,
      steps: [{ kind: "scroll", selector: "#content" }]
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("deltaY")
    });
  });

  it("rejects a verify step without an expected assertion", () => {
    const result = defineChromeWorkflowTemplate({
      ...VALID_TEMPLATE,
      steps: [{ kind: "verify", selector: "#results" }]
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("expected assertion")
    });
  });

  it("rejects an invalid template id", () => {
    const result = defineChromeWorkflowTemplate({
      ...VALID_TEMPLATE,
      templateId: "not valid!"
    });

    expect(result).toMatchObject({ ok: false });
  });
});

describe("instantiateChromeWorkflowTemplate", () => {
  it("produces a bounded workflow plan with substituted values", () => {
    const result = instantiateChromeWorkflowTemplate(VALID_TEMPLATE, { query: "skfiy" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.command).toBe("Fill and submit the search form.");
      expect(result.plan.steps).toHaveLength(4);
      const fillStep = result.plan.steps[1];
      expect(fillStep).toMatchObject({ kind: "fill", selector: "#search-input", value: "skfiy" });
      expect("valuePlaceholder" in fillStep).toBe(false);
    }
  });

  it("rejects a missing fill value", () => {
    const result = instantiateChromeWorkflowTemplate(VALID_TEMPLATE, {});

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("missing fill value: query")
    });
  });

  it("rejects a sensitive fill value", () => {
    const result = instantiateChromeWorkflowTemplate(VALID_TEMPLATE, {
      query: "hunter2 password"
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("fill value is not allowed")
    });
  });

  it("rejects an invalid template definition", () => {
    const result = instantiateChromeWorkflowTemplate(
      { ...VALID_TEMPLATE, steps: [] },
      { query: "skfiy" }
    );

    expect(result.ok).toBe(false);
  });
});

describe("template serialization", () => {
  it("round-trips a template definition", () => {
    const serialized = serializeChromeWorkflowTemplate(VALID_TEMPLATE);
    const restored = deserializeChromeWorkflowTemplate(serialized);

    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.template.templateId).toBe("search-form");
      expect(restored.template.steps).toHaveLength(4);
    }
  });

  it("rejects malformed JSON", () => {
    expect(deserializeChromeWorkflowTemplate("{not json")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not valid JSON")
    });
  });

  it("rejects a JSON payload with the wrong shape", () => {
    expect(deserializeChromeWorkflowTemplate(JSON.stringify({ templateId: "x" }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("template shape")
    });
  });

  it("revalidates the deserialized template", () => {
    const serialized = serializeChromeWorkflowTemplate({
      ...VALID_TEMPLATE,
      steps: [{ kind: "fill", selector: "#password", valuePlaceholder: "credential" }]
    });

    expect(deserializeChromeWorkflowTemplate(serialized)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("selector is not allowed")
    });
  });
});

describe("CHROME_WORKFLOW_TEMPLATE_LIBRARY", () => {
  it("ships only valid value-free templates", () => {
    expect(CHROME_WORKFLOW_TEMPLATE_LIBRARY.length).toBeGreaterThan(0);
    for (const template of CHROME_WORKFLOW_TEMPLATE_LIBRARY) {
      const result = defineChromeWorkflowTemplate(template);
      expect(result.ok).toBe(true);
      expect(JSON.stringify(template)).not.toMatch(/"value"\s*:/);
    }
  });

  it("instantiates every built-in template with safe placeholder values", () => {
    for (const template of CHROME_WORKFLOW_TEMPLATE_LIBRARY) {
      const placeholders = [...new Set(
        template.steps
          .map((step) => step.valuePlaceholder)
          .filter((placeholder): placeholder is string => Boolean(placeholder))
      )];
      const values = Object.fromEntries(placeholders.map((name) => [name, "skfiy"]));
      const result = instantiateChromeWorkflowTemplate(template, values);
      expect(result.ok).toBe(true);
    }
  });
});
