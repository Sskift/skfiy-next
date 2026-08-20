/**
 * Shared secret redaction for every surface that persists or exports
 * user-derived text: session memory prompts, runtime snapshots, turn replay
 * outcomes, and the unified data export bundle.
 *
 * The patterns are the union of the regexes that previously lived in
 * session-memory.ts, runtime-snapshot.ts, and turn-replay-store.ts. Keeping
 * them here means an export bundle can never leak a token that the live
 * surfaces already redact, and the export's `redaction` block can report
 * exactly which patterns were applied.
 */

export interface SecretRedactionPattern {
  readonly pattern: RegExp;
  readonly replacement: string;
}

export const SECRET_REDACTION_PATTERNS: readonly SecretRedactionPattern[] = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, replacement: "Bearer [redacted]" },
  { pattern: /\b(token|password|secret|api[_-]?key)=([^\s&]+)/giu, replacement: "$1=[redacted]" },
  { pattern: /\btoken\s+[A-Za-z0-9._~+/=-]{10,}/giu, replacement: "token [redacted]" },
  { pattern: /\bsk-[A-Za-z0-9._~+/=-]{10,}/gu, replacement: "[redacted]" }
];

export const SECRET_REDACTION_PATTERN_SOURCES: readonly string[] = SECRET_REDACTION_PATTERNS.map(
  (entry) => entry.pattern.source
);

export interface SecretRedactionResult {
  text: string;
  count: number;
}

export function redactSecrets(value: string): string {
  return redactSecretsWithCount(value).text;
}

export function redactSecretsWithCount(value: string): SecretRedactionResult {
  let text = value;
  let count = 0;
  for (const { pattern, replacement } of SECRET_REDACTION_PATTERNS) {
    const before = text;
    text = text.replace(pattern, replacement);
    if (text !== before) {
      count += before.match(pattern)?.length ?? 0;
    }
  }
  return { text, count };
}
