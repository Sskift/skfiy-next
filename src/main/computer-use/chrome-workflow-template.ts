/**
 * Bounded, local, value-free workflow templates for Chrome multi-step tasks.
 *
 * A template declares the step structure (kinds, selectors, URLs, risks) but
 * never fill values — fill steps reference named placeholders that are
 * supplied at instantiation time. Templates are bounded (max steps), local
 * (no network fetch), and validated for sensitive selectors before use.
 *
 * These are executable task templates, distinct from the personal-skills
 * "workflow" kind, which is a prompt hint.
 */

import { createSensitiveTextPatterns } from "./sensitive-ui-policy.js";
import type { ChromeVerifySelectorExpected } from "./chrome-dom-verification.js";

export const CHROME_WORKFLOW_MAX_STEPS = 12;

export type ChromeWorkflowStepKind =
  | "observe"
  | "click"
  | "fill"
  | "submit"
  | "scroll"
  | "verify";

/** One executable workflow step. `value` is only present on fill steps at runtime. */
export interface ChromeWorkflowStep {
  kind: ChromeWorkflowStepKind;
  selector?: string;
  url?: string;
  value?: string;
  deltaY?: number;
  expected?: ChromeVerifySelectorExpected;
  timeoutMs?: number;
}

export interface ChromeWorkflowPlan {
  command: string;
  steps: ChromeWorkflowStep[];
}

/** Value-free template step: fill steps name a placeholder instead of carrying a value. */
export interface ChromeWorkflowTemplateStep {
  kind: ChromeWorkflowStepKind;
  selector?: string;
  url?: string;
  deltaY?: number;
  expected?: ChromeVerifySelectorExpected;
  timeoutMs?: number;
  valuePlaceholder?: string;
}

export interface ChromeWorkflowTemplateDefinition {
  templateId: string;
  description: string;
  maxSteps: number;
  steps: ChromeWorkflowTemplateStep[];
}

export type ChromeWorkflowTemplateDefinitionResult =
  | { ok: true; template: ChromeWorkflowTemplateDefinition }
  | { ok: false; reason: string };

const PLACEHOLDER_PATTERN = /^[a-z][a-z0-9_]*$/u;
const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]*$/u;
const SENSITIVE_TEMPLATE_TEXT_PATTERNS = createSensitiveTextPatterns();

/**
 * Validates and freezes a template definition. Rejects unbounded, value-bearing,
 * or unsafe templates.
 */
export function defineChromeWorkflowTemplate(
  definition: ChromeWorkflowTemplateDefinition
): ChromeWorkflowTemplateDefinitionResult {
  if (!TEMPLATE_ID_PATTERN.test(definition.templateId)) {
    return {
      ok: false,
      reason: "Chrome workflow template id must be a kebab-case identifier."
    };
  }

  if (!definition.description.trim()) {
    return {
      ok: false,
      reason: "Chrome workflow template requires a description."
    };
  }

  if (
    !Number.isSafeInteger(definition.maxSteps)
    || definition.maxSteps <= 0
    || definition.maxSteps > CHROME_WORKFLOW_MAX_STEPS
  ) {
    return {
      ok: false,
      reason: `Chrome workflow template maxSteps must be between 1 and ${CHROME_WORKFLOW_MAX_STEPS}.`
    };
  }

  if (definition.steps.length === 0) {
    return {
      ok: false,
      reason: "Chrome workflow template requires at least one step."
    };
  }

  if (definition.steps.length > definition.maxSteps) {
    return {
      ok: false,
      reason: "Chrome workflow template step count exceeds its declared maxSteps."
    };
  }

  const placeholders = new Set<string>();
  for (const step of definition.steps) {
    const stepValidation = validateTemplateStep(step);
    if (!stepValidation.ok) {
      return stepValidation;
    }
    if (step.valuePlaceholder) {
      placeholders.add(step.valuePlaceholder);
    }
  }
  if (placeholders.size > CHROME_WORKFLOW_MAX_STEPS) {
    return {
      ok: false,
      reason: "Chrome workflow template declares too many fill placeholders."
    };
  }

  return {
    ok: true,
    template: Object.freeze({
      ...definition,
      steps: definition.steps.map((step) => Object.freeze({ ...step }))
    })
  };
}

function validateTemplateStep(
  step: ChromeWorkflowTemplateStep
): { ok: true } | { ok: false; reason: string } {
  if ("value" in step) {
    return {
      ok: false,
      reason: "Chrome workflow template steps must be value-free; use valuePlaceholder for fill steps."
    };
  }

  if (step.selector !== undefined && hasSensitiveTemplateText(step.selector)) {
    return {
      ok: false,
      reason: `Chrome workflow template selector is not allowed: ${step.selector}`
    };
  }

  switch (step.kind) {
    case "observe":
      if (step.selector !== undefined || step.valuePlaceholder !== undefined) {
        return {
          ok: false,
          reason: "Chrome workflow observe steps must not carry selectors or placeholders."
        };
      }
      return { ok: true };
    case "click":
    case "submit":
      if (!step.selector || step.valuePlaceholder !== undefined) {
        return {
          ok: false,
          reason: `Chrome workflow ${step.kind} steps require a selector and no placeholder.`
        };
      }
      return { ok: true };
    case "fill":
      if (
        !step.selector
        || !step.valuePlaceholder
        || !PLACEHOLDER_PATTERN.test(step.valuePlaceholder)
      ) {
        return {
          ok: false,
          reason: "Chrome workflow fill steps require a selector and a snake_case valuePlaceholder."
        };
      }
      return { ok: true };
    case "scroll":
      if (
        !step.selector
        || step.valuePlaceholder !== undefined
        || step.deltaY === undefined
        || !Number.isFinite(step.deltaY)
      ) {
        return {
          ok: false,
          reason: "Chrome workflow scroll steps require a selector and a finite deltaY."
        };
      }
      return { ok: true };
    case "verify":
      if (!step.selector || !step.expected || step.valuePlaceholder !== undefined) {
        return {
          ok: false,
          reason: "Chrome workflow verify steps require a selector and an expected assertion."
        };
      }
      return { ok: true };
  }
}

export type ChromeWorkflowInstantiationResult =
  | { ok: true; plan: ChromeWorkflowPlan }
  | { ok: false; reason: string };

/**
 * Instantiates a value-free template with concrete fill values. The resulting
 * plan is bounded and every fill value is checked against the sensitive-text
 * policy before it is bound.
 */
export function instantiateChromeWorkflowTemplate(
  template: ChromeWorkflowTemplateDefinition,
  values: Record<string, string>
): ChromeWorkflowInstantiationResult {
  const definition = defineChromeWorkflowTemplate(template);
  if (!definition.ok) {
    return definition;
  }

  const requiredPlaceholders = definition.template.steps
    .map((step) => step.valuePlaceholder)
    .filter((placeholder): placeholder is string => Boolean(placeholder));
  const uniquePlaceholders = [...new Set(requiredPlaceholders)];

  for (const placeholder of uniquePlaceholders) {
    if (!(placeholder in values)) {
      return {
        ok: false,
        reason: `Chrome workflow template is missing fill value: ${placeholder}`
      };
    }
    const value = values[placeholder];
    if (typeof value !== "string" || !value) {
      return {
        ok: false,
        reason: `Chrome workflow template fill value must be a non-empty string: ${placeholder}`
      };
    }
    if (hasSensitiveTemplateText(value)) {
      return {
        ok: false,
        reason: `Chrome workflow template fill value is not allowed for placeholder: ${placeholder}`
      };
    }
  }

  const steps: ChromeWorkflowStep[] = definition.template.steps.map((step) => {
    if (step.kind === "fill" && step.valuePlaceholder) {
      const { valuePlaceholder: _placeholder, ...rest } = step;
      return { ...rest, value: values[step.valuePlaceholder] };
    }
    const { valuePlaceholder: _placeholder, ...rest } = step;
    return { ...rest };
  });

  return {
    ok: true,
    plan: {
      command: definition.template.description,
      steps
    }
  };
}

/** Serializes a template definition to a bounded JSON string. */
export function serializeChromeWorkflowTemplate(
  template: ChromeWorkflowTemplateDefinition
): string {
  return JSON.stringify(template);
}

/** Parses and validates a serialized template definition. */
export function deserializeChromeWorkflowTemplate(
  serialized: string
): ChromeWorkflowTemplateDefinitionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return {
      ok: false,
      reason: "Chrome workflow template serialization is not valid JSON."
    };
  }

  if (!isTemplateDefinitionShape(parsed)) {
    return {
      ok: false,
      reason: "Chrome workflow template serialization does not match the template shape."
    };
  }

  return defineChromeWorkflowTemplate(parsed);
}

function isTemplateDefinitionShape(value: unknown): value is ChromeWorkflowTemplateDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.templateId === "string"
    && typeof record.description === "string"
    && typeof record.maxSteps === "number"
    && Array.isArray(record.steps);
}

function hasSensitiveTemplateText(value: string): boolean {
  return SENSITIVE_TEMPLATE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

// ---------------------------------------------------------------------------
// Built-in local template library
// ---------------------------------------------------------------------------

const SEARCH_FORM_TEMPLATE = defineChromeWorkflowTemplate({
  templateId: "search-form",
  description: "Fill the search form, submit it, and verify the results region appears.",
  maxSteps: 4,
  steps: [
    { kind: "observe" },
    { kind: "fill", selector: "#search-input", valuePlaceholder: "query" },
    { kind: "submit", selector: "#search-button" },
    { kind: "verify", selector: "#results", expected: { kind: "visible" } }
  ]
});

const PAGINATION_TEMPLATE = defineChromeWorkflowTemplate({
  templateId: "pagination-sequence",
  description: "Click through two pagination steps and verify each page indicator.",
  maxSteps: 5,
  steps: [
    { kind: "observe" },
    { kind: "click", selector: "#next-page" },
    { kind: "verify", selector: "#page-2", expected: { kind: "visible" } },
    { kind: "click", selector: "#next-page" },
    { kind: "verify", selector: "#page-3", expected: { kind: "visible" } }
  ]
});

const SCROLL_VERIFY_TEMPLATE = defineChromeWorkflowTemplate({
  templateId: "scroll-and-verify",
  description: "Scroll the content region and verify the footer becomes visible.",
  maxSteps: 3,
  steps: [
    { kind: "observe" },
    { kind: "scroll", selector: "#content", deltaY: 600 },
    { kind: "verify", selector: "#footer", expected: { kind: "visible" } }
  ]
});

/** Built-in templates, all validated at module load. */
export const CHROME_WORKFLOW_TEMPLATE_LIBRARY: readonly ChromeWorkflowTemplateDefinition[] = [
  SEARCH_FORM_TEMPLATE,
  PAGINATION_TEMPLATE,
  SCROLL_VERIFY_TEMPLATE
].map(requireBuiltInTemplate);

function requireBuiltInTemplate(
  result: ChromeWorkflowTemplateDefinitionResult
): ChromeWorkflowTemplateDefinition {
  if (!result.ok) {
    throw new Error(`Built-in Chrome workflow template is invalid: ${result.reason}`);
  }
  return result.template;
}
