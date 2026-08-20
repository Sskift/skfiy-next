import { redactSecrets } from "../../shared/redaction.js";
import type { DesktopAppState } from "../computer-use/types.js";

/**
 * Terminal context observation for the Ghostty terminal adapter.
 *
 * SECURITY MODEL — READ BEFORE MODIFYING:
 * Every field produced by this module is OCR-derived UNTRUSTED DATA. Terminal
 * text is collected for preview and verification surfaces only. It is never
 * executed, never appended to model prompts, and never treated as
 * instructions. Every field is redacted (shared/redaction.ts) and bounded
 * before it leaves this module, so nothing unbounded or secret-like is ever
 * persisted in events, transcripts, or summaries.
 *
 * The reader is designed to run AFTER the sensitive-UI pause gate in
 * recovery-policy.ts has passed, so credential-like terminal text never
 * reaches it in the live task flow. `sensitiveContentDetected` mirrors that
 * gate decision (same patterns) so the transcript can record it.
 */

/**
 * Sensitive terminal-text patterns for the Ghostty adapter. These are the
 * same patterns the task passes to the recovery-policy pause gate; keeping
 * them here lets the context reader mirror the gate decision exactly.
 */
export const GHOSTTY_SENSITIVE_TEXT_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passphrase/i,
  /api\s+token/i,
  /access\s+token/i,
  /private\s+key/i,
  /secret/i,
  /credential/i,
  /recovery\s+key/i
];

export const TERMINAL_CONTEXT_MAX_TAIL_LABELS = 8;
export const TERMINAL_CONTEXT_MAX_TAIL_CHARACTERS = 4000;
export const TERMINAL_CONTEXT_MAX_FIELD_CHARACTERS = 256;

export interface TerminalContextObservation {
  /**
   * Best-effort working directory parsed from the `[skfiy] <path> $` prompt
   * line. Bounded and redacted. `"unknown"` when no prompt line is
   * observable — never a guess presented as fact.
   */
  workingDirectory: string;
  /**
   * Whether the `[skfiy]` prompt marker is visible. Distinct from the
   * SKFIY_READY init marker, which reports that the shell initialized.
   */
  promptReady: boolean;
  /**
   * The typed command as echoed by the terminal on the prompt line, bounded
   * and redacted. Used post-submission to confirm what was actually typed
   * matches what was planned (detects focus loss / IME corruption). Empty
   * when no echo is observable.
   */
  lastCommandEcho: string;
  /**
   * The last few OCR labels of terminal text, bounded and redacted. CONTEXT
   * ONLY: untrusted OCR data, never instructions, never fed back to any
   * model prompt.
   */
  recentOutputTail: string;
  /**
   * Mirror of the recovery-policy sensitive-text pause decision, surfaced
   * for the transcript. The live task flow pauses before this reader runs,
   * so this is `false` in practice; the field keeps the reader honest and
   * safe to call from any surface.
   */
  sensitiveContentDetected: boolean;
}

/**
 * Normalizes terminal text for marker/status matching: uppercase with every
 * non-alphanumeric character stripped. `STATUS 0` becomes `STATUS0`.
 */
export function normalizeTerminalText(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Reads bounded, redacted terminal context from a desktop observation's OCR
 * labels. Pure and total: degrades gracefully (never throws) when no labels
 * or no parseable prompt are present.
 */
export function readTerminalContext(observation: DesktopAppState): TerminalContextObservation {
  const texts = (observation.ocrLabels ?? []).map((label) => label.text);
  const promptLabel = readPromptLabel(texts);

  return {
    workingDirectory: boundWorkingDirectory(redactSecrets(promptLabel?.workingDirectory ?? "")),
    promptReady: promptLabel !== undefined,
    lastCommandEcho: boundEcho(redactSecrets(promptLabel?.lastCommandEcho ?? "")),
    recentOutputTail: boundTail(redactSecrets(readRecentOutputTail(texts))),
    sensitiveContentDetected: detectSensitiveTerminalText(texts)
  };
}

interface PromptLabel {
  workingDirectory: string;
  lastCommandEcho: string;
}

/**
 * Matches the `[skfiy] <path> $ <echo>` prompt shape rendered by
 * `PS1='[skfiy] \w \$ '`. Tolerates OCR bracket noise and a missing `$`.
 */
const PROMPT_LABEL_PATTERN = /\[?skfiy\]?\s+((?:\/|~)[^\s$]*)\s*\$?\s*(.*)$/iu;

function readPromptLabel(texts: readonly string[]): PromptLabel | undefined {
  for (const text of texts) {
    const match = PROMPT_LABEL_PATTERN.exec(text);
    if (match) {
      return {
        workingDirectory: match[1] ?? "",
        lastCommandEcho: (match[2] ?? "").trim()
      };
    }
  }

  return undefined;
}

function readRecentOutputTail(texts: readonly string[]): string {
  return texts.slice(-TERMINAL_CONTEXT_MAX_TAIL_LABELS).join("\n");
}

function boundTail(text: string): string {
  if (text.length <= TERMINAL_CONTEXT_MAX_TAIL_CHARACTERS) {
    return text;
  }

  return text.slice(text.length - TERMINAL_CONTEXT_MAX_TAIL_CHARACTERS);
}

function boundWorkingDirectory(value: string): string {
  const normalized = boundTerminalField(value);
  return normalized || "unknown";
}

function boundEcho(value: string): string {
  return boundTerminalField(value);
}

function boundTerminalField(value: string): string {
  return value
    .replace(/[\x00-\x1f\x7f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, TERMINAL_CONTEXT_MAX_FIELD_CHARACTERS);
}

function detectSensitiveTerminalText(texts: readonly string[]): boolean {
  return texts.some((text) =>
    GHOSTTY_SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(text))
  );
}
