export const COMMON_SENSITIVE_TITLE_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passcode/i,
  /passkey/i,
  /keychain/i,
  /authentication/i,
  /security/i,
  /private\s+key/i,
  /payment/i,
  /billing/i,
  /checkout/i
];

export const COMMON_SENSITIVE_TEXT_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passphrase/i,
  /passcode/i,
  /api\s+token/i,
  /access\s+token/i,
  /private\s+key/i,
  /secret/i,
  /credential/i,
  /recovery\s+key/i,
  /seed\s+phrase/i,
  /verification\s+code/i,
  /one[-\s]?time\s+code/i,
  /\b2fa\b/i,
  /credit\s+card/i,
  /card\s+number/i,
  /\bcvv\b/i,
  /social\s+security/i
];

export function createSensitiveTitlePatterns(
  appSpecificPatterns: readonly RegExp[] = []
): readonly RegExp[] {
  return [...COMMON_SENSITIVE_TITLE_PATTERNS, ...appSpecificPatterns];
}

export function createSensitiveTextPatterns(
  appSpecificPatterns: readonly RegExp[] = []
): readonly RegExp[] {
  return [...COMMON_SENSITIVE_TEXT_PATTERNS, ...appSpecificPatterns];
}
