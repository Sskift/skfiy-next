import type { DesktopAppState } from "../computer-use/types.js";
import { normalizeTerminalText } from "./terminal-context.js";

/**
 * Bounded exit-status capture for the Ghostty terminal adapter.
 *
 * The completion marker prints the command's exit status twice for OCR
 * redundancy: `SKFIY DONE <SERIAL> STATUS <code>`. This module parses that
 * status from the after-screenshot OCR labels.
 *
 * SECURITY/BOUNDING MODEL:
 * - Only the marker line is parsed; every other terminal label is discarded,
 *   so command output is never stored.
 * - OCR ambiguity is tolerated narrowly: a lone letter `O` in the status
 *   position reads as `0`. Anything else that is not a clean integer 0..255
 *   (fused digits, letters, values > 255) degrades to `"unknown"` — a wrong
 *   exit code is worse than no exit code.
 * - A non-zero exit code is NOT a task failure: the command executed and was
 *   observed. The code is surfaced for the caller to interpret.
 */

export type TerminalExitStatus = { code: number } | { code: "unknown" };

const MARKER_PREFIX = "SKFIYDONE";
const STATUS_MARKER = "STATUS";

/**
 * Reads the command exit status from the completion-marker OCR labels.
 *
 * @param observation The after-screenshot desktop observation.
 * @param markerSerial The completion-marker serial (e.g. `"A"` from
 *   `SKFIY_DONE_A`). A stale marker with a different serial is ignored.
 */
export function readTerminalExitStatus(
  observation: DesktopAppState,
  markerSerial: string
): TerminalExitStatus {
  const statusPrefix = `${MARKER_PREFIX}${normalizeTerminalText(markerSerial)}${STATUS_MARKER}`;

  for (const label of observation.ocrLabels ?? []) {
    const normalized = normalizeTerminalText(label.text);
    if (!normalized.startsWith(statusPrefix)) {
      continue;
    }

    const code = parseExitStatusCode(normalized.slice(statusPrefix.length));
    if (code !== undefined) {
      return { code };
    }
  }

  return { code: "unknown" };
}

/**
 * Parses the normalized status portion. Returns `undefined` (→ `"unknown"`)
 * for anything that is not a clean integer 0..255, tolerating only a lone
 * letter `O` (OCR misread of zero).
 */
function parseExitStatusCode(statusPart: string): number | undefined {
  if (statusPart === "O") {
    return 0;
  }

  if (/^\d{1,3}$/.test(statusPart)) {
    const code = Number.parseInt(statusPart, 10);
    if (code <= 255) {
      return code;
    }
  }

  return undefined;
}
