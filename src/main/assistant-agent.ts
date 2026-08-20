import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  ASSISTANT_AGENT_PROVIDERS,
  ASSISTANT_AGENT_IDENTITY_PROMPT,
  buildAssistantAgentInvocationForMode,
  readAssistantAgentMode,
  readAssistantAgentProviderBinary,
  readAssistantAgentRuntime,
  resolveAssistantAgentExecutable,
  type AssistantAgentCliBinarySource,
  type AssistantAgentInvocation,
  type AssistantAgentMode,
  type AssistantAgentProviderId,
  type AssistantAgentProviderLabel,
  type AssistantAgentSettings
} from "./assistant-agent-provider-registry.js";
import {
  createSessionMemoryPromptBlock,
  type SessionMemoryRecord
} from "./session-memory.js";
import { selectCommandRoute, type CommandRoute, type ExecutableCommandRoute } from "./task-routing.js";
import {
  createWorkingProfile,
  createWorkingProfilePromptBlock
} from "./working-profile.js";

export type {
  AssistantAgentCliBinarySource,
  AssistantAgentExecutableSource,
  AssistantAgentInvocation,
  AssistantAgentMode,
  AssistantAgentProviderDescriptor,
  AssistantAgentProviderId,
  AssistantAgentProviderLabel,
  AssistantAgentProviderRuntime,
  AssistantAgentSettings
} from "./assistant-agent-provider-registry.js";
export {
  ASSISTANT_AGENT_PROVIDERS,
  ASSISTANT_AGENT_PROVIDER_LABELS,
  buildAssistantAgentInvocationForMode,
  isAssistantAgentMode,
  readAssistantAgentMode,
  readAssistantAgentProviderBinary,
  readAssistantAgentRuntime,
  readAssistantAgentSandboxFlags,
  resolveAssistantAgentExecutable
} from "./assistant-agent-provider-registry.js";

export type AssistantAgentProviderReadiness =
  | "chat-ready"
  | "version-ok"
  | "binary-found"
  | "binary-configured"
  | "auth-or-permission-blocked"
  | "unconfigured"
  | "unavailable";
export type AssistantAgentTurnStatus = "completed" | "failed" | "cancelled";

export interface AssistantAgentProviderState {
  provider: "assistant";
  id: AssistantAgentProviderId;
  label: AssistantAgentProviderLabel;
  selected: boolean;
  configured: boolean;
  executablePath?: string;
  executableSource: AssistantAgentCliBinarySource;
  resolvedExecutablePath?: string;
  readiness: AssistantAgentProviderReadiness;
  readinessDetail?: string;
  version?: string;
  lastError?: string;
}

export interface AssistantAgentProcessResult {
  stdout: string;
  stderr: string;
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
  providerLabel: AssistantAgentProviderLabel;
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
const ASSISTANT_CHAT_ROUTE_REASON = "Background Agent answered without requesting Computer Use.";
const COMPUTER_USE_INTENT_START_TAG = "<skfiy-computer-use-intent>";
const COMPUTER_USE_INTENT_END_TAG = "</skfiy-computer-use-intent>";
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

  return Promise.all(ASSISTANT_AGENT_PROVIDERS.map((descriptor) =>
    readCliAssistantAgentProviderState({
      id: descriptor.id,
      label: descriptor.label,
      selected: settings.mode === descriptor.id,
      ...readAssistantAgentProviderBinary(settings, descriptor.id),
      settings,
      resolveExecutable,
      runReadinessProbe,
      proveChatReadiness: options.proveChatReadiness === true
    })
  ));
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

  return buildAssistantAgentInvocationForMode(settings, settings.mode, prompt);
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
  const runtime = readAssistantAgentRuntime(settings, settings.mode);

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
      cwd: runtime.cwd,
      timeoutMs: runtime.timeoutMs,
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

export function readAssistantAgentResponse(stdout: string): ParsedAssistantAgentResponse {
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
  binary,
  source,
  settings,
  resolveExecutable,
  runReadinessProbe,
  proveChatReadiness
}: {
  settings: AssistantAgentSettings;
  id: AssistantAgentProviderId;
  label: AssistantAgentProviderLabel;
  selected: boolean;
  binary: string;
  source: AssistantAgentCliBinarySource;
  resolveExecutable: AssistantAgentExecutableResolver;
  runReadinessProbe: AssistantAgentReadinessProbeRunner;
  proveChatReadiness: boolean;
}): Promise<AssistantAgentProviderState> {
  const configuredExecutable = readOptionalString(binary);
  if (!configuredExecutable) {
    return {
      provider: "assistant",
      id,
      label,
      selected,
      configured: false,
      executableSource: source,
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
      executableSource: source,
      resolvedExecutablePath,
      readiness: "binary-found",
      readinessDetail: `${label} executable was found; chat readiness has not been proven by a dry-run.`
    };

    const versionResult = await readAssistantAgentVersionState({
      baseState,
      runReadinessProbe,
      resolvedExecutablePath,
      settings,
      mode: id
    });

    if (!proveChatReadiness || versionResult.readiness !== "version-ok") {
      return versionResult;
    }

    return readAssistantAgentChatReadyState({
      baseState: versionResult,
      runReadinessProbe,
      resolvedExecutablePath,
      settings,
      mode: id
    });
  } catch (error) {
    return {
      provider: "assistant",
      id,
      label,
      selected,
      configured: true,
      executablePath: configuredExecutable,
      executableSource: source,
      readiness: "unavailable",
      lastError: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readAssistantAgentVersionState({
  baseState,
  resolvedExecutablePath,
  runReadinessProbe,
  settings,
  mode
}: {
  baseState: AssistantAgentProviderState;
  resolvedExecutablePath: string;
  runReadinessProbe: AssistantAgentReadinessProbeRunner;
  settings: AssistantAgentSettings;
  mode: AssistantAgentProviderId;
}): Promise<AssistantAgentProviderState> {
  const runtime = readAssistantAgentRuntime(settings, mode);
  try {
    const result = await runReadinessProbe(resolvedExecutablePath, ["--version"], {
      cwd: runtime.cwd,
      timeoutMs: Math.min(runtime.timeoutMs, READINESS_PROBE_TIMEOUT_MS)
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
  settings,
  mode
}: {
  baseState: AssistantAgentProviderState;
  resolvedExecutablePath: string;
  runReadinessProbe: AssistantAgentReadinessProbeRunner;
  settings: AssistantAgentSettings;
  mode: AssistantAgentProviderId;
}): Promise<AssistantAgentProviderState> {
  const probeSettings = createAssistantAgentProbeSettings(settings, mode, resolvedExecutablePath);
  const runtime = readAssistantAgentRuntime(settings, mode);
  const prompt = createAssistantAgentPrompt("Reply exactly with skfiy-ready.", undefined, undefined, undefined, undefined, {
    includeIdentityPrompt: mode !== "claude-code"
  });
  const invocation = buildAssistantAgentInvocationForMode(probeSettings, mode, prompt);

  try {
    const result = await runReadinessProbe(invocation.command, invocation.args, {
      cwd: runtime.cwd,
      timeoutMs: Math.min(runtime.timeoutMs, READINESS_PROBE_TIMEOUT_MS)
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
