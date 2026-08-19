import type { RiskDecision, RiskLevel } from "./types.js";

const LOW_RISK_COMMANDS = new Set(["pwd", "ls", "date", "whoami"]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const CLIPBOARD_COMMAND_PATTERN = /\bpb(copy|paste)\b/i;

const HIGH_RISK_PATTERNS: RegExp[] = [
  /\brm\s+-[^\n;|&]*r/i,
  /\bsudo\b/i,
  /\bspctl\b/i,
  /\|\s*(sh|bash|zsh)\b/i,
  /\bosascript\b/i,
  /\bgit\s+push\b/i,
  /\bgh\s+(pr\s+merge|release\s+create)\b/i,
  /\b(curl|wget)\b(?=.*\s(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b)/i,
  /\b(curl|wget)\b(?=.*\s(-d|--data(?:-[a-z-]+)?|--form|-F)\b)/i,
  /\b(ssh|scp|sftp|rsync)\b/i,
  /\b(brew|npm|pnpm|yarn|pip3?|cargo|gem)\s+(install|add|update|upgrade)\b/i,
  /\bsecurity\s+find-(generic|internet)-password\b/i,
  /(^|[\/\s])\.env(\b|$)/i,
  /(~\/)?\.(ssh|aws|gnupg)(\/|\b)/i,
  /\b(id_rsa|id_ed25519|\.pem|\.p12|\.key|\.npmrc|\.netrc)\b/i,
  /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\b/,
  /\bchmod\s+[-+]?R?\s*777\b/i,
  /\bchown\b/i,
  /\bmv\b.+\s+(\/System|\/Library|~\/Library)/i
];

const MEDIUM_RISK_PATTERNS: RegExp[] = [
  /\b(curl|wget)\b/i,
  /\bopen\s+https?:\/\//i,
  /\bgit\s+(pull|fetch|clone)\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bcp\b/i,
  /\bmv\b/i,
  />{1,2}/
];

export function classifyTerminalCommand(command: string): RiskDecision {
  const normalized = command.trim();

  if (!normalized) {
    return decision("blocked", "Empty commands are not executable.", true);
  }

  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    return decision("blocked", "Control characters are not allowed in terminal commands.", true);
  }

  if (CLIPBOARD_COMMAND_PATTERN.test(normalized)) {
    return decision("high", "Command can read or overwrite clipboard contents.", true);
  }

  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return decision("high", "Command may modify security, credentials, or data destructively.", true);
  }

  const executable = normalized.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (LOW_RISK_COMMANDS.has(executable) && !/[;&|`$()<>]/.test(normalized)) {
    return decision("low", "Read-only terminal command.", false);
  }

  if (MEDIUM_RISK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return decision("medium", "Command can create or modify local state.", true);
  }

  return decision("medium", "Unrecognized commands require approval in the MVP.", true);
}

function decision(level: RiskLevel, reason: string, requiresApproval: boolean): RiskDecision {
  return { level, reason, requiresApproval };
}
