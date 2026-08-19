import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createBrowserPageContextPromptBlock,
  type BrowserPageContext
} from "./browser-page-context.js";
import {
  createPersonalMemoryPromptBlock,
  type PersonalMemorySnapshot
} from "./personal-memory.js";
import {
  createPersonalSkillCards,
  createPersonalSkillsPromptBlock,
  type PersonalSkillSettings
} from "./personal-skills.js";
import {
  createSessionMemoryPromptBlock,
  type SessionMemoryRecord
} from "./session-memory.js";
import { selectCommandRoute, type CommandRoute, type ExecutableCommandRoute } from "./task-routing.js";
import {
  createWorkingProfile,
  createWorkingProfilePromptBlock
} from "./working-profile.js";

export type AssistantAgentMode = "codex" | "claude-code" | "hermes";
export type AssistantAgentProviderId = AssistantAgentMode;
export type AssistantAgentCliBinarySource = "default" | "env";
export type AssistantAgentExecutableSource = AssistantAgentCliBinarySource;
export type AssistantAgentProviderReadiness =
  | "chat-ready"
  | "version-ok"
  | "binary-found"
  | "binary-configured"
  | "auth-or-permission-blocked"
  | "unconfigured"
  | "unavailable";
export type AssistantAgentTurnStatus = "completed" | "failed" | "cancelled";

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
}

export interface AssistantAgentInvocation {
  command: string;
  args: string[];
  label: "Codex" | "Claude Code" | "Hermes";
}

export interface AssistantAgentProcessResult {
  stdout: string;
  stderr: string;
}

export interface AssistantAgentProviderState {
  provider: "assistant";
  id: AssistantAgentProviderId;
  label: "Codex" | "Claude Code" | "Hermes";
  selected: boolean;
  configured: boolean;
  executablePath?: string;
  executableSource: AssistantAgentExecutableSource;
  resolvedExecutablePath?: string;
  readiness: AssistantAgentProviderReadiness;
  readinessDetail?: string;
  version?: string;
  lastError?: string;
}

export type AssistantAgentProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal | undefined }
) => Promise<AssistantAgentProcessResult>;

export type AssistantAgentExecutableResolver = (command: string) => Promise<string>;
export type AssistantAgentReadinessProbeRunner = AssistantAgentProcessRunner;

export interface RunAssistantAgentTurnInput {
  settings: AssistantAgentSettings;
  browserPageContext?: BrowserPageContext;
  personalMemory?: PersonalMemorySnapshot;
  recalledSessions?: SessionMemoryRecord[];
  personalSkillSettings?: PersonalSkillSettings;
  runProcess?: AssistantAgentProcessRunner;
  now?: () => Date;
  createTurnId?: () => string;
  signal?: AbortSignal;
}

export interface AssistantAgentTurnCancellation {
  requested: boolean;
  reason?: string;
}

export interface AssistantAgentTurnError {
  message: string;
}

export interface AssistantAgentPlannedToolCall {
  id: string;
  type: "computer-use";
  name: "desktop-control";
  status: "planned";
  createdAt: string;
  input: {
    command: string;
    route: ExecutableCommandRoute;
  };
}

export interface AssistantAgentTurnResult {
  id: string;
  createdAt: string;
  status: AssistantAgentTurnStatus;
  providerLabel: "Codex" | "Claude Code" | "Hermes";
  message: string;
  error?: AssistantAgentTurnError | undefined;
  route: CommandRoute;
  toolCalls: AssistantAgentPlannedToolCall[];
  cancellation: AssistantAgentTurnCancellation;
}

export class AssistantAgentTurnRuntimeError extends Error {
  readonly turn: AssistantAgentTurnResult;

  constructor(turn: AssistantAgentTurnResult) {
    super(turn.error?.message ?? "Assistant agent turn failed.");
    this.name = "AssistantAgentTurnRuntimeError";
    this.turn = turn;
  }
}

const DEFAULT_ASSISTANT_AGENT_TIMEOUT_MS = 45_000;
const READINESS_PROBE_TIMEOUT_MS = 5_000;
const CODEX_PET_CHAT_MODEL = "gpt-5.5";
const CODEX_PET_CHAT_REASONING_EFFORT = "low";
const CLAUDE_CODE_DISALLOWED_TOOLS = "Bash,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Task";
const ASSISTANT_CHAT_ROUTE_REASON = "Background Agent answered without requesting Computer Use.";
const COMPUTER_USE_INTENT_START_TAG = "<skfiy-computer-use-intent>";
const COMPUTER_USE_INTENT_END_TAG = "</skfiy-computer-use-intent>";
const ASSISTANT_AGENT_IDENTITY_PROMPT = [
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
const ASSISTANT_AGENT_COMPUTER_USE_INTENT_PROMPT = [
  "Computer Use tool request contract:",
  "For ordinary questions, answer normally and do not emit any tool intent.",
  "Only when you determine that the user is explicitly asking skfiy to control a desktop app, append exactly one bounded JSON intent block.",
  "The only supported tool intent shape is:",
  `${COMPUTER_USE_INTENT_START_TAG}{"tool":"computer-use","action":"desktop-control","command":"<plain user-approved desktop action for skfiy to validate>"}${COMPUTER_USE_INTENT_END_TAG}`,
  "If the user already named the app, action, URL, selector, file path, or target, copy the user's desktop-control request into command as literally as possible.",
  "The command must describe the app-control action for skfiy's own Computer Use layer to validate against app policy, permissions, risk, and approval.",
  "Do not claim that the desktop action already happened. Do not execute local mutations directly from the backend provider."
].join("\n");
const execFileAsync = promisify(execFile);

export function readInitialAssistantAgentSettings(
  env: {
    SKFIY_ASSISTANT_AGENT?: string;
    SKFIY_CODEX_BIN?: string;
    SKFIY_CLAUDE_CODE_BIN?: string;
    SKFIY_HERMES_BIN?: string;
    SKFIY_ASSISTANT_AGENT_CWD?: string;
    SKFIY_ASSISTANT_AGENT_TIMEOUT_MS?: string;
  },
  defaults: { cwd?: string } = {}
): AssistantAgentSettings {
  const configuredCodexBinary = readOptionalString(env.SKFIY_CODEX_BIN);
  const configuredClaudeCodeBinary = readOptionalString(env.SKFIY_CLAUDE_CODE_BIN);
  const configuredHermesBinary = readOptionalString(env.SKFIY_HERMES_BIN);

  return {
    mode: readAssistantAgentMode(env.SKFIY_ASSISTANT_AGENT),
    codexBinary: configuredCodexBinary ?? "codex",
    codexBinarySource: configuredCodexBinary ? "env" : "default",
    claudeCodeBinary: configuredClaudeCodeBinary ?? "claude",
    claudeCodeBinarySource: configuredClaudeCodeBinary ? "env" : "default",
    hermesBinary: configuredHermesBinary ?? "hermes",
    hermesBinarySource: configuredHermesBinary ? "env" : "default",
    cwd: readOptionalString(env.SKFIY_ASSISTANT_AGENT_CWD) ?? defaults.cwd ?? process.cwd(),
    timeoutMs: readPositiveInteger(env.SKFIY_ASSISTANT_AGENT_TIMEOUT_MS)
      ?? DEFAULT_ASSISTANT_AGENT_TIMEOUT_MS
  };
}

/**
 * Integration note: dashboard/main can expose this structured state once those
 * surfaces are in scope; until then this owned module is the source of truth.
 */
export async function readAssistantAgentProviderStates(
  settings: AssistantAgentSettings,
  options: {
    resolveExecutable?: AssistantAgentExecutableResolver;
    runReadinessProbe?: AssistantAgentReadinessProbeRunner;
    proveChatReadiness?: boolean;
  } = {}
): Promise<AssistantAgentProviderState[]> {
  const resolveExecutable = options.resolveExecutable ?? resolveAssistantAgentExecutable;
  const runReadinessProbe = options.runReadinessProbe ?? runAssistantAgentProcess;

  return [
    await readCliAssistantAgentProviderState({
      id: "codex",
      label: "Codex",
      selected: settings.mode === "codex",
      executablePath: settings.codexBinary,
      executableSource: settings.codexBinarySource,
      settings,
      resolveExecutable,
      runReadinessProbe,
      proveChatReadiness: options.proveChatReadiness === true
    }),
    await readCliAssistantAgentProviderState({
      id: "claude-code",
      label: "Claude Code",
      selected: settings.mode === "claude-code",
      executablePath: settings.claudeCodeBinary,
      executableSource: settings.claudeCodeBinarySource,
      settings,
      resolveExecutable,
      runReadinessProbe,
      proveChatReadiness: options.proveChatReadiness === true
    }),
    await readCliAssistantAgentProviderState({
      id: "hermes",
      label: "Hermes",
      selected: settings.mode === "hermes",
      executablePath: settings.hermesBinary,
      executableSource: settings.hermesBinarySource,
      settings,
      resolveExecutable,
      runReadinessProbe,
      proveChatReadiness: options.proveChatReadiness === true
    })
  ];
}

export function buildAssistantAgentInvocation(
  settings: AssistantAgentSettings,
  userInput: string,
  browserPageContext?: BrowserPageContext,
  personalMemory?: PersonalMemorySnapshot,
  recalledSessions?: SessionMemoryRecord[],
  personalSkillSettings?: PersonalSkillSettings
): AssistantAgentInvocation {
  const prompt = createAssistantAgentPrompt(
    userInput,
    browserPageContext,
    personalMemory,
    recalledSessions,
    personalSkillSettings,
    {
      includeIdentityPrompt: settings.mode !== "claude-code"
    }
  );

  if (settings.mode === "codex") {
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
        settings.cwd,
        "--skip-git-repo-check",
        "--ephemeral",
        "--color",
        "never",
        prompt
      ],
      label: "Codex"
    };
  }

  if (settings.mode === "hermes") {
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

export async function runAssistantAgentTurn(
  userInput: string,
  {
    settings,
    runProcess = runAssistantAgentProcess,
    now = () => new Date(),
    createTurnId = createAssistantAgentTurnId,
    signal,
    browserPageContext,
    personalMemory,
    recalledSessions,
    personalSkillSettings
  }: RunAssistantAgentTurnInput
): Promise<AssistantAgentTurnResult> {
  const id = createTurnId();
  const createdAt = now().toISOString();
  const invocation = buildAssistantAgentInvocation(
    settings,
    userInput,
    browserPageContext,
    personalMemory,
    recalledSessions,
    personalSkillSettings
  );
  const providerLabel = invocation.label;

  if (signal?.aborted) {
    throw new AssistantAgentTurnRuntimeError({
      id,
      createdAt,
      status: "cancelled",
      providerLabel,
      message: "",
      error: { message: "Assistant agent turn was cancelled." },
      route: createAssistantChatRoute(),
      toolCalls: [],
      cancellation: readAssistantAgentCancellation(signal)
    });
  }

  let result: AssistantAgentProcessResult;
  try {
    result = await runProcess(invocation.command, invocation.args, {
      cwd: settings.cwd,
      timeoutMs: settings.timeoutMs,
      signal
    });
  } catch (error) {
    throw new AssistantAgentTurnRuntimeError({
      id,
      createdAt,
      status: signal?.aborted ? "cancelled" : "failed",
      providerLabel,
      message: "",
      error: { message: readErrorMessage(error) },
      route: createAssistantChatRoute(),
      toolCalls: [],
      cancellation: readAssistantAgentCancellation(signal)
    });
  }

  if (signal?.aborted) {
    throw new AssistantAgentTurnRuntimeError({
      id,
      createdAt,
      status: "cancelled",
      providerLabel,
      message: "",
      error: { message: "Assistant agent turn was cancelled." },
      route: createAssistantChatRoute(),
      toolCalls: [],
      cancellation: readAssistantAgentCancellation(signal)
    });
  }

  const response = readAssistantAgentResponse(result.stdout);
  const route = response.computerUseIntent
    ? selectCommandRoute(response.computerUseIntent.command)
    : createAssistantChatRoute();
  const toolCalls = response.computerUseIntent
    ? createAssistantAgentPlannedToolCalls({
      turnId: id,
      createdAt,
      command: response.computerUseIntent.command,
      route
    })
    : [];
  const message = response.message || (
    response.computerUseIntent
      ? "我会通过 skfiy 请求受控的 Computer Use。"
      : ""
  );

  if (!message) {
    throw new AssistantAgentTurnRuntimeError({
      id,
      createdAt,
      status: "failed",
      providerLabel,
      message: "",
      error: { message: `${invocation.label} returned an empty assistant response.` },
      route: createAssistantChatRoute(),
      toolCalls: [],
      cancellation: { requested: false }
    });
  }

  return {
    id,
    createdAt,
    status: "completed",
    providerLabel,
    message,
    route,
    toolCalls,
    cancellation: { requested: false }
  };
}

export async function runAssistantAgentProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal | undefined }
): Promise<AssistantAgentProcessResult> {
  const resolvedCommand = await resolveAssistantAgentExecutable(command).catch(() => command);
  return spawnAssistantAgentProcess(resolvedCommand, args, options);
}

function spawnAssistantAgentProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal | undefined }
): Promise<AssistantAgentProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(readAbortError(options.signal));
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const succeed = (result: AssistantAgentProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      child.kill();
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      fail(readAbortError(options.signal));
    };
    const timeout = setTimeout(() => {
      fail(new Error(`Command timed out after ${options.timeoutMs}ms: ${formatCommand(command, args)}`));
    }, options.timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024 * 1024) {
        fail(new Error("Assistant agent stdout exceeded 1048576 bytes."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 1024 * 1024) {
        fail(new Error("Assistant agent stderr exceeded 1048576 bytes."));
      }
    });
    child.on("error", (error) => {
      fail(error);
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      if (code === 0) {
        succeed({ stdout, stderr });
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      const stderrSummary = stderr.trim() ? `\n${stderr.trim()}` : "";
      fail(new Error(`Command failed with ${reason}: ${formatCommand(command, args)}${stderrSummary}`));
    });
  });
}

function createAssistantAgentTurnId(): string {
  return `assistant-turn-${randomUUID()}`;
}

interface AssistantAgentComputerUseIntent {
  command: string;
}

interface ParsedAssistantAgentResponse {
  message: string;
  computerUseIntent?: AssistantAgentComputerUseIntent;
}

function readAssistantAgentResponse(stdout: string): ParsedAssistantAgentResponse {
  const raw = stdout.trim();
  const intentPattern = new RegExp(
    `${escapeRegExp(COMPUTER_USE_INTENT_START_TAG)}([\\s\\S]*?)${escapeRegExp(COMPUTER_USE_INTENT_END_TAG)}`,
    "u"
  );
  const match = raw.match(intentPattern);
  const message = raw.replace(intentPattern, "").trim();

  if (!match) {
    return { message };
  }

  const parsedIntent = parseAssistantAgentComputerUseIntent(match[1]);
  return parsedIntent
    ? { message, computerUseIntent: parsedIntent }
    : { message };
}

function parseAssistantAgentComputerUseIntent(value: string | undefined): AssistantAgentComputerUseIntent | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value.trim()) as Record<string, unknown>;
    if (
      parsed.tool !== "computer-use"
      || parsed.action !== "desktop-control"
      || typeof parsed.command !== "string"
      || parsed.command.trim().length === 0
    ) {
      return undefined;
    }

    return { command: parsed.command.trim() };
  } catch {
    return undefined;
  }
}

function createAssistantChatRoute(): CommandRoute {
  return {
    kind: "chat",
    reason: ASSISTANT_CHAT_ROUTE_REASON
  };
}

function createAssistantAgentPlannedToolCalls({
  turnId,
  createdAt,
  command,
  route
}: {
  turnId: string;
  createdAt: string;
  command: string;
  route: CommandRoute;
}): AssistantAgentPlannedToolCall[] {
  if (
    route.kind === "chat"
    || route.kind === "needs_clarification"
    || route.kind === "denied"
    || route.kind === "blocked"
  ) {
    return [];
  }
  const toolRoute = route.kind === "needs_confirmation" ? route.targetRoute : route;

  return [
    {
      id: `${turnId}-tool-1`,
      type: "computer-use",
      name: "desktop-control",
      status: "planned",
      createdAt,
      input: {
        command,
        route: toolRoute
      }
    }
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readAssistantAgentCancellation(
  signal: AbortSignal | undefined
): AssistantAgentTurnCancellation {
  if (!signal?.aborted) {
    return { requested: false };
  }

  return {
    requested: true,
    reason: signal.reason instanceof Error
      ? signal.reason.message
      : typeof signal.reason === "string" ? signal.reason : undefined
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readAbortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new Error(typeof signal?.reason === "string" ? signal.reason : "Assistant agent process was aborted.");
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function readCliAssistantAgentProviderState({
  id,
  label,
  selected,
  executablePath,
  executableSource,
  settings,
  resolveExecutable,
  runReadinessProbe,
  proveChatReadiness
}: {
  settings: AssistantAgentSettings;
  id: AssistantAgentProviderId;
  label: "Codex" | "Claude Code" | "Hermes";
  selected: boolean;
  executablePath: string;
  executableSource: AssistantAgentCliBinarySource;
  resolveExecutable: AssistantAgentExecutableResolver;
  runReadinessProbe: AssistantAgentReadinessProbeRunner;
  proveChatReadiness: boolean;
}): Promise<AssistantAgentProviderState> {
  const configuredExecutable = readOptionalString(executablePath);
  if (!configuredExecutable) {
    return {
      provider: "assistant",
      id,
      label,
      selected,
      configured: false,
      executableSource,
      readiness: "unconfigured",
      lastError: `${label} executable is not configured.`
    };
  }

  try {
    const resolvedExecutablePath = await resolveExecutable(configuredExecutable);
    const baseState: AssistantAgentProviderState = {
      provider: "assistant",
      id,
      label,
      selected,
      configured: true,
      executablePath: configuredExecutable,
      executableSource,
      resolvedExecutablePath,
      readiness: "binary-found",
      readinessDetail: `${label} executable was found; chat readiness has not been proven by a dry-run.`
    };

    const versionResult = await readAssistantAgentVersionState({
      baseState,
      runReadinessProbe,
      resolvedExecutablePath,
      settings
    });

    if (!proveChatReadiness || versionResult.readiness !== "version-ok") {
      return versionResult;
    }

    return readAssistantAgentChatReadyState({
      baseState: versionResult,
      runReadinessProbe,
      resolvedExecutablePath,
      settings
    });
  } catch (error) {
    return {
      provider: "assistant",
      id,
      label,
      selected,
      configured: true,
      executablePath: configuredExecutable,
      executableSource,
      readiness: "unavailable",
      lastError: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readAssistantAgentVersionState({
  baseState,
  resolvedExecutablePath,
  runReadinessProbe,
  settings
}: {
  baseState: AssistantAgentProviderState;
  resolvedExecutablePath: string;
  runReadinessProbe: AssistantAgentReadinessProbeRunner;
  settings: AssistantAgentSettings;
}): Promise<AssistantAgentProviderState> {
  try {
    const result = await runReadinessProbe(resolvedExecutablePath, ["--version"], {
      cwd: settings.cwd,
      timeoutMs: Math.min(settings.timeoutMs, READINESS_PROBE_TIMEOUT_MS)
    });
    const version = readProbeSummary(result) ?? "version check passed";

    return {
      ...baseState,
      readiness: "version-ok",
      readinessDetail: `${baseState.label} version check passed; chat readiness has not been proven by a dry-run.`,
      version
    };
  } catch (error) {
    const message = readErrorMessage(error);
    if (isAuthOrPermissionError(message)) {
      return {
        ...baseState,
        readiness: "auth-or-permission-blocked",
        readinessDetail: `${baseState.label} version check was blocked by authentication or permissions.`,
        lastError: message
      };
    }

    return {
      ...baseState,
      lastError: message
    };
  }
}

async function readAssistantAgentChatReadyState({
  baseState,
  resolvedExecutablePath,
  runReadinessProbe,
  settings
}: {
  baseState: AssistantAgentProviderState;
  resolvedExecutablePath: string;
  runReadinessProbe: AssistantAgentReadinessProbeRunner;
  settings: AssistantAgentSettings;
}): Promise<AssistantAgentProviderState> {
  const probeSettings = createAssistantAgentProbeSettings(settings, baseState.id, resolvedExecutablePath);
  const invocation = buildAssistantAgentInvocation(
    probeSettings,
    "Reply exactly with skfiy-ready."
  );

  try {
    const result = await runReadinessProbe(invocation.command, invocation.args, {
      cwd: settings.cwd,
      timeoutMs: Math.min(settings.timeoutMs, READINESS_PROBE_TIMEOUT_MS)
    });
    const response = readAssistantAgentResponse(result.stdout);
    if (!response.message.trim()) {
      return {
        ...baseState,
        lastError: `${baseState.label} dry-run returned an empty response.`
      };
    }

    return {
      ...baseState,
      readiness: "chat-ready",
      readinessDetail: `${baseState.label} answered a bounded dry-run prompt.`
    };
  } catch (error) {
    const message = readErrorMessage(error);
    if (isAuthOrPermissionError(message)) {
      return {
        ...baseState,
        readiness: "auth-or-permission-blocked",
        readinessDetail: `${baseState.label} dry-run was blocked by authentication or permissions.`,
        lastError: message
      };
    }

    return {
      ...baseState,
      lastError: message
    };
  }
}

function createAssistantAgentProbeSettings(
  settings: AssistantAgentSettings,
  mode: AssistantAgentProviderId,
  resolvedExecutablePath: string
): AssistantAgentSettings {
  return {
    ...settings,
    mode,
    ...(mode === "codex" ? { codexBinary: resolvedExecutablePath } : {}),
    ...(mode === "claude-code" ? { claudeCodeBinary: resolvedExecutablePath } : {}),
    ...(mode === "hermes" ? { hermesBinary: resolvedExecutablePath } : {})
  };
}

function readProbeSummary(result: AssistantAgentProcessResult): string | undefined {
  const summary = (result.stdout || result.stderr).trim().split(/\r?\n/u)[0]?.trim();
  return summary && summary.length > 0 ? summary.slice(0, 200) : undefined;
}

function isAuthOrPermissionError(message: string): boolean {
  return /auth|login|permission|unauthori[sz]ed|forbidden|consent|not authenticated/i.test(message);
}

async function resolveAssistantAgentExecutable(command: string): Promise<string> {
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

function createAssistantAgentPrompt(
  userInput: string,
  browserPageContext?: BrowserPageContext,
  personalMemory?: PersonalMemorySnapshot,
  recalledSessions?: SessionMemoryRecord[],
  personalSkillSettings?: PersonalSkillSettings,
  options: {
    includeIdentityPrompt?: boolean;
  } = {}
): string {
  const includeIdentityPrompt = options.includeIdentityPrompt ?? true;
  const personalMemoryBlock = personalMemory
    ? createPersonalMemoryPromptBlock(personalMemory)
    : "";
  const recalledSessionsBlock = recalledSessions
    ? createSessionMemoryPromptBlock(recalledSessions)
    : "";
  const personalSkillCards = personalMemory
    ? createPersonalSkillCards({
      memory: personalMemory,
      sessions: recalledSessions ?? [],
      settings: personalSkillSettings
    })
    : [];
  const personalSkillsBlock = personalSkillCards.length > 0
    ? createPersonalSkillsPromptBlock(personalSkillCards)
    : "";
  const workingProfile = personalMemory
    ? createWorkingProfile({
      memory: personalMemory,
      sessions: recalledSessions ?? [],
      personalSkills: personalSkillCards
    })
    : undefined;
  const workingProfileBlock = workingProfile
    ? createWorkingProfilePromptBlock(workingProfile)
    : "";

  return [
    ...(includeIdentityPrompt ? [ASSISTANT_AGENT_IDENTITY_PROMPT, ""] : []),
    ASSISTANT_AGENT_COMPUTER_USE_INTENT_PROMPT,
    "",
    ...(personalMemoryBlock ? [personalMemoryBlock, ""] : []),
    ...(recalledSessionsBlock ? [recalledSessionsBlock, ""] : []),
    ...(personalSkillsBlock ? [personalSkillsBlock, ""] : []),
    ...(workingProfileBlock ? [workingProfileBlock, ""] : []),
    ...(browserPageContext ? [createBrowserPageContextPromptBlock(browserPageContext), ""] : []),
    `User: ${userInput.trim()}`
  ].join("\n");
}

function readAssistantAgentMode(value: unknown): AssistantAgentMode {
  if (value === "hermes") {
    return "hermes";
  }

  if (value === "claude-code" || value === "claudecode" || value === "claude") {
    return "claude-code";
  }

  return "codex";
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
