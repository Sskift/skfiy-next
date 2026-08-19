export type TerminalIntentSource = "direct-command" | "agent-intent";

export type TerminalIntentResult =
  | {
      ok: true;
      command: string;
      source: TerminalIntentSource;
    }
  | {
      ok: false;
      reason: string;
    };

const DIRECT_COMMAND_PATTERN = /^[a-z][a-z0-9_-]*(\s+.+)?$/i;
const AGENT_COMMAND_PATTERNS: RegExp[] = [
  /(?:执行|运行|输入)(?:一下)?(?:命令)?\s*([^\n\r]+)/i,
  /(?:run|execute)\s+([^\n\r]+)/i
];
const SAFE_FOLDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function parseTerminalIntent(input: string): TerminalIntentResult {
  const text = input.trim();

  if (!text) {
    return {
      ok: false,
      reason: "Could not identify a terminal command in the agent request."
    };
  }

  if (isDirectTerminalCommand(text)) {
    return {
      ok: true,
      command: text,
      source: "direct-command"
    };
  }

  const extracted = extractAgentCommand(text);
  if (extracted) {
    return {
      ok: true,
      command: extracted,
      source: "agent-intent"
    };
  }

  const mkdirCommand = parseFolderCreationIntent(text);
  if (mkdirCommand) {
    return {
      ok: true,
      command: mkdirCommand,
      source: "agent-intent"
    };
  }

  return {
    ok: false,
    reason: "Could not identify a terminal command in the agent request."
  };
}

function isDirectTerminalCommand(text: string): boolean {
  return DIRECT_COMMAND_PATTERN.test(text) && !containsCjk(text);
}

function extractAgentCommand(text: string): string | undefined {
  for (const pattern of AGENT_COMMAND_PATTERNS) {
    const match = text.match(pattern);
    const command = cleanAgentCommandCandidate(match?.[1]);

    if (command && isDirectTerminalCommand(command)) {
      return command;
    }
  }

  return undefined;
}

function cleanAgentCommandCandidate(candidate: string | undefined): string | undefined {
  const cleaned = candidate
    ?.trim()
    .replace(/^[`"“”']+|[`"“”']+$/g, "")
    .split(/并且|并|然后|再|，|。|；|;/)[0]
    ?.trim()
    .replace(/^[`"“”']+|[`"“”']+$/g, "");

  return cleaned || undefined;
}

function parseFolderCreationIntent(text: string): string | undefined {
  const match = text.match(/(?:创建|新建)\s+([A-Za-z0-9._-]+)\s*(?:文件夹|目录)/);
  const folderName = match?.[1]?.trim();

  if (!folderName || !SAFE_FOLDER_NAME_PATTERN.test(folderName)) {
    return undefined;
  }

  return `mkdir ${folderName}`;
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9FFF]/.test(text);
}
