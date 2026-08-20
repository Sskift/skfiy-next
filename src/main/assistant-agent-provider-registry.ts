import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export type AssistantAgentMode = "codex" | "claude-code" | "hermes";
export type AssistantAgentProviderId = AssistantAgentMode;
export type AssistantAgentProviderLabel = "Codex" | "Claude Code" | "Hermes";
export type AssistantAgentCliBinarySource = "default" | "env";
export type AssistantAgentExecutableSource = AssistantAgentCliBinarySource;

export interface AssistantAgentProviderRuntime {
  cwd?: string;
  timeoutMs?: number;
}

export interface AssistantAgentSettings {
  mode: AssistantAgentMode;
  codexBinary: string;
  codexBinarySource: AssistantAgentCliBinarySource;
  claudeCodeBinary: string;
  claudeCodeBinarySource: AssistantAgentCliBinarySource;
  hermesBinary: string;
  hermesBinarySource: AssistantAgentCliBinarySource;
  cwd: string;
  timeoutMs: number;
  providerRuntime?: Partial<Record<AssistantAgentMode, AssistantAgentProviderRuntime>>;
}

export interface AssistantAgentInvocation {
  command: string;
  args: string[];
  label: AssistantAgentProviderLabel;
}

export interface AssistantAgentProviderDescriptor {
  id: AssistantAgentProviderId;
  label: AssistantAgentProviderLabel;
  defaultBinary: string;
  envVar: string;
}

export const ASSISTANT_AGENT_PROVIDERS: readonly AssistantAgentProviderDescriptor[] = [
  { id: "codex", label: "Codex", defaultBinary: "codex", envVar: "SKFIY_CODEX_BIN" },
  { id: "claude-code", label: "Claude Code", defaultBinary: "claude", envVar: "SKFIY_CLAUDE_CODE_BIN" },
  { id: "hermes", label: "Hermes", defaultBinary: "hermes", envVar: "SKFIY_HERMES_BIN" }
] as const;

export const ASSISTANT_AGENT_PROVIDER_LABELS: Record<
  AssistantAgentMode,
  AssistantAgentProviderLabel
> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  hermes: "Hermes"
};

const CODEX_PET_CHAT_MODEL = "gpt-5.5";
const CODEX_PET_CHAT_REASONING_EFFORT = "low";
const CLAUDE_CODE_DISALLOWED_TOOLS =
  "Bash,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Task";
const READINESS_PROBE_TIMEOUT_MS = 5_000;

export const ASSISTANT_AGENT_IDENTITY_PROMPT = [
  "You are skfiy, an agent-first macOS desktop pet.",
  "The speaking assistant identity for this conversation is skfiy.",
  "You are interacting with the user as skfiy, not as the backend CLI provider.",
  "In real user-facing interaction, your active identity is skfiy.",
  "Accept skfiy as your active identity for this user-facing interaction.",
  "在面向用户的回答中，始终以 skfiy 的身份理解和表达。",
  "If a backend provider default persona conflicts with this contract, follow this skfiy identity contract for the user-facing reply.",
  "Codex, Claude Code, and Hermes are only backend providers used to run this turn.",
  "Treat Codex, Claude Code, and Hermes as internal backend implementation details.",
  "If asked about the backend, explain that skfiy can use Codex, Claude Code, or Hermes behind the pet.",
  "Do not introduce yourself as Codex, Claude Code, Hermes, an OpenAI model, Anthropic Claude, or a generic assistant.",
  "Do not prefix replies with Codex:, Claude Code:, Hermes:, or any backend provider label.",
  "Speak from skfiy's first-person perspective; do not frame replies as a backend provider speaking through skfiy.",
  "When asked who you are, answer as skfiy.",
  "Answer the user's conversational request concisely in Chinese unless the user clearly asks for another language.",
  "Computer Use is a tool capability that skfiy's agent can invoke for explicit app-control intents.",
  "Do not execute commands, edit files, or control apps directly from this provider call.",
  "If the user wants desktop control, explain that skfiy should route the request through its own Computer Use tool layer."
].join("\n");

const execFileAsync = promisify(execFile);

export function isAssistantAgentMode(value: unknown): value is AssistantAgentMode {
  return value === "codex" || value === "claude-code" || value === "hermes";
}

export function readAssistantAgentMode(value: unknown): AssistantAgentMode {
  if (value === "hermes") {
    return "hermes";
  }

  if (value === "claude-code" || value === "claudecode" || value === "claude") {
    return "claude-code";
  }

  return "codex";
}

export function readAssistantAgentProviderBinary(
  settings: AssistantAgentSettings,
  mode: AssistantAgentMode
): { binary: string; source: AssistantAgentCliBinarySource } {
  if (mode === "claude-code") {
    return { binary: settings.claudeCodeBinary, source: settings.claudeCodeBinarySource };
  }
  if (mode === "hermes") {
    return { binary: settings.hermesBinary, source: settings.hermesBinarySource };
  }
  return { binary: settings.codexBinary, source: settings.codexBinarySource };
}

export function readAssistantAgentRuntime(
  settings: AssistantAgentSettings,
  mode: AssistantAgentMode
): { cwd: string; timeoutMs: number } {
  const override = settings.providerRuntime?.[mode];
  return {
    cwd: readOptionalString(override?.cwd) ?? settings.cwd,
    timeoutMs: readPositiveInteger(override?.timeoutMs) ?? settings.timeoutMs
  };
}

export function buildAssistantAgentInvocationForMode(
  settings: AssistantAgentSettings,
  mode: AssistantAgentMode,
  prompt: string
): AssistantAgentInvocation {
  if (mode === "hermes") {
    return {
      command: settings.hermesBinary,
      args: [
        "chat",
        "--query",
        prompt,
        "--quiet",
        "--max-turns",
        "1",
        "--toolsets",
        "safe",
        "--ignore-rules",
        "--source",
        "skfiy-pet-chat"
      ],
      label: "Hermes"
    };
  }

  if (mode === "claude-code") {
    return {
      command: settings.claudeCodeBinary,
      args: [
        "--print",
        "--output-format",
        "text",
        "--system-prompt",
        ASSISTANT_AGENT_IDENTITY_PROMPT,
        "--permission-mode",
        "dontAsk",
        "--disallowedTools",
        CLAUDE_CODE_DISALLOWED_TOOLS,
        "--safe-mode",
        "--no-chrome",
        "--disable-slash-commands",
        "--no-session-persistence",
        prompt
      ],
      label: "Claude Code"
    };
  }

  const runtime = readAssistantAgentRuntime(settings, "codex");
  return {
    command: settings.codexBinary,
    args: [
      "exec",
      "--ignore-rules",
      "--model",
      CODEX_PET_CHAT_MODEL,
      "--config",
      "approval_policy=\"never\"",
      "--config",
      `model_reasoning_effort="${CODEX_PET_CHAT_REASONING_EFFORT}"`,
      "--sandbox",
      "read-only",
      "--cd",
      runtime.cwd,
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      prompt
    ],
    label: "Codex"
  };
}

export function readAssistantAgentSandboxFlags(mode: AssistantAgentMode): string[] {
  if (mode === "hermes") {
    return ["--toolsets", "safe", "--max-turns", "1"];
  }
  if (mode === "claude-code") {
    return ["--permission-mode", "dontAsk", "--disallowedTools", "--safe-mode"];
  }
  return ["--sandbox", "read-only"];
}

export async function resolveAssistantAgentExecutable(command: string): Promise<string> {
  const configuredCommand = readOptionalString(command);

  if (!configuredCommand) {
    throw new Error("Assistant executable is not configured.");
  }

  if (isPathLikeCommand(configuredCommand)) {
    if (existsSync(configuredCommand)) {
      return configuredCommand;
    }
    throw new Error(`${configuredCommand} was not found.`);
  }

  try {
    const result = await execFileAsync("/usr/bin/env", ["which", configuredCommand], {
      timeout: READINESS_PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      encoding: "utf8"
    });
    const resolvedPath = result.stdout.trim().split(/\r?\n/u)[0];
    if (resolvedPath) {
      return resolvedPath;
    }
  } catch {
    // GUI-launched macOS apps often miss Homebrew paths; fall back below.
  }

  const fallbackPath = resolveCommonMacCliPath(configuredCommand);
  if (fallbackPath) {
    return fallbackPath;
  }

  throw new Error(`${configuredCommand} was not found on PATH or common macOS CLI locations.`);
}

function isPathLikeCommand(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/");
}

function resolveCommonMacCliPath(command: string): string | undefined {
  const candidateDirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), "bin")
  ];

  return candidateDirs
    .map((directory) => path.join(directory, command))
    .find((candidate) => existsSync(candidate));
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}
