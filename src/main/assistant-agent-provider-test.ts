import {
  buildAssistantAgentInvocationForMode,
  readAssistantAgentRuntime,
  readAssistantAgentSandboxFlags,
  resolveAssistantAgentExecutable,
  type AssistantAgentMode,
  type AssistantAgentProviderLabel,
  type AssistantAgentSettings
} from "./assistant-agent-provider-registry.js";
import {
  readAssistantAgentResponse,
  type AssistantAgentExecutableResolver,
  type AssistantAgentProviderState,
  type AssistantAgentReadinessProbeRunner
} from "./assistant-agent.js";

const READINESS_PROBE_TIMEOUT_MS = 5_000;
const BOUNDED_TEST_PROMPT = "Reply exactly with skfiy-ready.";

export interface AssistantAgentProviderTestChecks {
  identity: boolean;
  sandbox: boolean;
  responseParsing: boolean;
}

export interface AssistantAgentProviderTestResult {
  state: AssistantAgentProviderState;
  checks: AssistantAgentProviderTestChecks;
}

export interface TestAssistantAgentProviderInput {
  settings: AssistantAgentSettings;
  mode: AssistantAgentMode;
  resolveExecutable?: AssistantAgentExecutableResolver;
  runReadinessProbe?: AssistantAgentReadinessProbeRunner;
}

const BACKEND_IDENTITY_CLAIM_PATTERNS: readonly RegExp[] = [
  /\bi am claude\b/i,
  /\bi'?m claude\b/i,
  /\bi am codex\b/i,
  /\bi'?m codex\b/i,
  /\bi am hermes\b/i,
  /\bi'?m hermes\b/i,
  /\bi am an ai (language model|assistant)\b/i,
  /\bi'?m an ai (language model|assistant)\b/i,
  /\bi am an ai language model\b/i,
  /\bi'?m an ai language model\b/i,
  /\bmade by (openai|anthropic)\b/i,
  /\bpowered by (openai|anthropic|claude|gpt)\b/i
];

export function readAssistantAgentIdentityValid(responseText: string): boolean {
  const trimmed = responseText.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return !BACKEND_IDENTITY_CLAIM_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function readAssistantAgentSandboxValid(
  mode: AssistantAgentMode,
  args: string[]
): boolean {
  const requiredFlags = readAssistantAgentSandboxFlags(mode);
  return requiredFlags.every((flag) => args.includes(flag));
}

export async function testAssistantAgentProvider(
  input: TestAssistantAgentProviderInput
): Promise<AssistantAgentProviderTestResult> {
  const { settings, mode } = input;
  const resolveExecutable = input.resolveExecutable ?? resolveAssistantAgentExecutable;
  const runReadinessProbe = input.runReadinessProbe ?? runDefaultProbe;
  const runtime = readAssistantAgentRuntime(settings, mode);
  const label = readProviderLabel(mode);

  const binary = readProviderBinary(settings, mode);
  const configuredExecutable = readOptionalString(binary);
  if (!configuredExecutable) {
    return {
      state: {
        provider: "assistant",
        id: mode,
        label,
        selected: settings.mode === mode,
        configured: false,
        executableSource: readProviderBinarySource(settings, mode),
        readiness: "unconfigured",
        lastError: `${label} executable is not configured.`
      },
      checks: { identity: false, sandbox: false, responseParsing: false }
    };
  }

  let resolvedExecutablePath: string;
  try {
    resolvedExecutablePath = await resolveExecutable(configuredExecutable);
  } catch (error) {
    return {
      state: {
        provider: "assistant",
        id: mode,
        label,
        selected: settings.mode === mode,
        configured: true,
        executablePath: configuredExecutable,
        executableSource: readProviderBinarySource(settings, mode),
        readiness: "unavailable",
        lastError: error instanceof Error ? error.message : String(error)
      },
      checks: { identity: false, sandbox: false, responseParsing: false }
    };
  }

  const probeSettings = {
    ...settings,
    mode,
    ...(mode === "codex" ? { codexBinary: resolvedExecutablePath } : {}),
    ...(mode === "claude-code" ? { claudeCodeBinary: resolvedExecutablePath } : {}),
    ...(mode === "hermes" ? { hermesBinary: resolvedExecutablePath } : {})
  };
  const invocation = buildAssistantAgentInvocationForMode(
    probeSettings,
    mode,
    BOUNDED_TEST_PROMPT
  );
  const sandboxValid = readAssistantAgentSandboxValid(mode, invocation.args);

  try {
    const result = await runReadinessProbe(invocation.command, invocation.args, {
      cwd: runtime.cwd,
      timeoutMs: Math.min(runtime.timeoutMs, READINESS_PROBE_TIMEOUT_MS)
    });
    const response = readAssistantAgentResponse(result.stdout);
    const responseText = response.message.trim();
    const responseParsing = responseText.length > 0;
    const identity = responseParsing && readAssistantAgentIdentityValid(responseText);

    if (!responseParsing) {
      return {
        state: {
          provider: "assistant",
          id: mode,
          label,
          selected: settings.mode === mode,
          configured: true,
          executablePath: configuredExecutable,
          executableSource: readProviderBinarySource(settings, mode),
          resolvedExecutablePath,
          readiness: "binary-found",
          readinessDetail: `${label} answered a bounded test but the response could not be parsed.`,
          lastError: `${label} bounded test returned an empty response.`
        },
        checks: { identity: false, sandbox: sandboxValid, responseParsing: false }
      };
    }

    if (!identity) {
      return {
        state: {
          provider: "assistant",
          id: mode,
          label,
          selected: settings.mode === mode,
          configured: true,
          executablePath: configuredExecutable,
          executableSource: readProviderBinarySource(settings, mode),
          resolvedExecutablePath,
          readiness: "auth-or-permission-blocked",
          readinessDetail: `${label} answered but claimed a backend identity instead of skfiy.`,
          lastError: `${label} bounded test response did not accept the skfiy identity.`
        },
        checks: { identity: false, sandbox: sandboxValid, responseParsing: true }
      };
    }

    if (!sandboxValid) {
      return {
        state: {
          provider: "assistant",
          id: mode,
          label,
          selected: settings.mode === mode,
          configured: true,
          executablePath: configuredExecutable,
          executableSource: readProviderBinarySource(settings, mode),
          resolvedExecutablePath,
          readiness: "binary-found",
          readinessDetail: `${label} answered but the invocation is missing sandbox safety flags.`,
          lastError: `${label} bounded test invocation is missing required sandbox flags.`
        },
        checks: { identity: true, sandbox: false, responseParsing: true }
      };
    }

    return {
      state: {
        provider: "assistant",
        id: mode,
        label,
        selected: settings.mode === mode,
        configured: true,
        executablePath: configuredExecutable,
        executableSource: readProviderBinarySource(settings, mode),
        resolvedExecutablePath,
        readiness: "chat-ready",
        readinessDetail: `${label} answered a bounded test with a valid skfiy identity and sandbox flags.`
      },
      checks: { identity: true, sandbox: true, responseParsing: true }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAuthError = /auth|login|permission|unauthori[sz]ed|forbidden|consent|not authenticated/i.test(message);
    return {
      state: {
        provider: "assistant",
        id: mode,
        label,
        selected: settings.mode === mode,
        configured: true,
        executablePath: configuredExecutable,
        executableSource: readProviderBinarySource(settings, mode),
        resolvedExecutablePath,
        readiness: isAuthError ? "auth-or-permission-blocked" : "unavailable",
        readinessDetail: isAuthError
          ? `${label} bounded test was blocked by authentication or permissions.`
          : `${label} bounded test failed.`,
        lastError: message
      },
      checks: { identity: false, sandbox: sandboxValid, responseParsing: false }
    };
  }
}

async function runDefaultProbe(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number }
): Promise<{ stdout: string; stderr: string }> {
  const { runAssistantAgentProcess } = await import("./assistant-agent.js");
  return runAssistantAgentProcess(command, args, options);
}

function readProviderLabel(mode: AssistantAgentMode): AssistantAgentProviderLabel {
  if (mode === "claude-code") {
    return "Claude Code";
  }
  if (mode === "hermes") {
    return "Hermes";
  }
  return "Codex";
}

function readProviderBinary(settings: AssistantAgentSettings, mode: AssistantAgentMode): string {
  if (mode === "claude-code") {
    return settings.claudeCodeBinary;
  }
  if (mode === "hermes") {
    return settings.hermesBinary;
  }
  return settings.codexBinary;
}

function readProviderBinarySource(
  settings: AssistantAgentSettings,
  mode: AssistantAgentMode
): "default" | "env" {
  if (mode === "claude-code") {
    return settings.claudeCodeBinarySource;
  }
  if (mode === "hermes") {
    return settings.hermesBinarySource;
  }
  return settings.codexBinarySource;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
