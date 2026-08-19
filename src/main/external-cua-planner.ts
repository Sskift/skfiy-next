export interface ExternalCuaTerminalPlannerConfig {
  endpoint: string;
  apiKey: string;
  label: string;
  fetchImpl?: typeof fetch;
}

export interface ExternalCuaTerminalPlanInput {
  input: string;
  signal?: AbortSignal;
}

export interface ExternalCuaTerminalPlan {
  command: string;
  rationale?: string;
}

export interface ExternalCuaTerminalPlanner {
  planTerminalCommand(input: ExternalCuaTerminalPlanInput): Promise<ExternalCuaTerminalPlan>;
}

export function createExternalCuaTerminalPlanner({
  endpoint,
  apiKey,
  label,
  fetchImpl = fetch
}: ExternalCuaTerminalPlannerConfig): ExternalCuaTerminalPlanner {
  return {
    async planTerminalCommand({ input, signal }) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          task: input,
          targetApp: "Ghostty",
          capability: "terminal-command"
        }),
        signal
      });

      if (!response.ok) {
        throw new Error(`${label} request failed with HTTP ${response.status}.`);
      }

      const payload = await response.json();
      const command = readTerminalCommand(payload);
      const rationale = readOptionalString(payload, "rationale");

      if (!isSafeSingleLineCommand(command)) {
        throw new Error(`${label} returned an invalid terminal command.`);
      }

      return {
        command,
        ...(rationale ? { rationale } : {})
      };
    }
  };
}

export function createExternalCuaTerminalPlannerFromEnv(
  env: {
    SKFIY_EXTERNAL_CUA_ENDPOINT?: string;
    SKFIY_EXTERNAL_CUA_API_KEY?: string;
  },
  fetchImpl: typeof fetch = fetch
): ExternalCuaTerminalPlanner {
  const endpoint = env.SKFIY_EXTERNAL_CUA_ENDPOINT?.trim();
  const apiKey = env.SKFIY_EXTERNAL_CUA_API_KEY?.trim();

  if (!endpoint) {
    throw new Error("External CUA endpoint is not configured. Set SKFIY_EXTERNAL_CUA_ENDPOINT.");
  }

  if (!apiKey) {
    throw new Error("External CUA API key is not configured. Set SKFIY_EXTERNAL_CUA_API_KEY.");
  }

  return createExternalCuaTerminalPlanner({
    endpoint,
    apiKey,
    label: "External CUA",
    fetchImpl
  });
}

function readTerminalCommand(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if ("command" in payload && typeof payload.command === "string") {
    return payload.command.trim();
  }

  if ("terminalCommand" in payload && typeof payload.terminalCommand === "string") {
    return payload.terminalCommand.trim();
  }

  return "";
}

function readOptionalString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object" || !(key in payload)) {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isSafeSingleLineCommand(command: string): boolean {
  return command.length > 0 && !/[\u0000-\u001F\u007F]/.test(command);
}
