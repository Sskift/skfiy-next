import { redactSecrets } from "../../shared/redaction.js";
import type { RiskDecision } from "../../shared/types.js";
import type { TerminalContextObservation } from "./terminal-context.js";

/**
 * In-task command preview for the Ghostty terminal adapter.
 *
 * The preview is the approval surface shown before typing: it carries the
 * redacted command, the observed working directory, the risk classification,
 * whether the command mutates local state, and a class-based expected result.
 * Every field is bounded and redacted; the command itself is the planned
 * command (trusted), while the working directory comes from OCR-derived
 * terminal context (untrusted data, never instructions).
 */

export const GHOSTTY_EXPECTED_VERIFICATION =
  "Confirm the owned Ghostty session remains active and observe the command completion marker.";

const PREVIEW_COMMAND_MAX_CHARACTERS = 160;

export interface TerminalCommandPreview {
  /** The planned command, bounded and redacted. */
  command: string;
  /** Observed working directory, or `"unknown"` when context is unobservable. */
  workingDirectory: string;
  /** The risk decision from `readGhosttyTaskRisk`. */
  risk: RiskDecision;
  /**
   * Whether the command may mutate local state. Matches `readRouteMutation`
   * for the ghostty route: read-only (low) and blocked commands are
   * non-mutating; medium/high commands are mutating.
   */
  mutating: boolean;
  /**
   * A bounded, class-based description of the expected result. This is NOT a
   * prediction of actual output — it states the verification class.
   */
  expectedResult: string;
  /** How the command outcome is verified after completion. */
  expectedVerification: string;
}

export function createTerminalCommandPreview(input: {
  command: string;
  context: TerminalContextObservation;
  risk: RiskDecision;
}): TerminalCommandPreview {
  const { command, context, risk } = input;

  return {
    command: boundedSensitiveLabel(command, "command"),
    workingDirectory: context.workingDirectory,
    risk,
    mutating: readMutation(risk),
    expectedResult: readExpectedResult(risk),
    expectedVerification: GHOSTTY_EXPECTED_VERIFICATION
  };
}

function readMutation(risk: RiskDecision): boolean {
  return risk.level !== "low" && risk.level !== "blocked";
}

function readExpectedResult(risk: RiskDecision): string {
  switch (risk.level) {
    case "low":
      return "Prints output without modifying local state";
    case "blocked":
      return "Refused before execution";
    case "medium":
    case "high":
      return "May modify local state; outcome is verified after completion";
  }
}

function boundedSensitiveLabel(value: string, fallback: string): string {
  const normalized = redactSecrets(value)
    .replace(/[\x00-\x1f\x7f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, PREVIEW_COMMAND_MAX_CHARACTERS);

  return normalized || fallback;
}
