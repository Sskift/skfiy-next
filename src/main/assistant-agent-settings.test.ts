import { describe, expect, it } from "vitest";
import {
  createAssistantAgentSettingsStore,
  readInitialAssistantAgentSettingsFromConfig
} from "./assistant-agent-settings";

describe("assistant agent settings store", () => {
  it("defaults to codex and keeps codex as the only mode", () => {
    const store = createAssistantAgentSettingsStore(
      readInitialAssistantAgentSettingsFromConfig({}, { cwd: "/repo" })
    );

    expect(store.get().mode).toBe("codex");
    expect(store.set({ mode: "codex" }).mode).toBe("codex");
    expect(store.set({ mode: "claude-code" }).mode).toBe("codex");
    expect(store.set({ mode: "hermes" }).mode).toBe("codex");
  });

  it("ignores invalid modes", () => {
    const store = createAssistantAgentSettingsStore(
      readInitialAssistantAgentSettingsFromConfig({}, { cwd: "/repo" })
    );

    expect(store.set({ mode: "remote-agent" }).mode).toBe("codex");
    expect(store.set({ mode: "local" }).mode).toBe("codex");
  });

  it("keeps env-provided binary paths, cwd, and timeout while switching modes", () => {
    const store = createAssistantAgentSettingsStore(
      readInitialAssistantAgentSettingsFromConfig({
        SKFIY_CODEX_BIN: "/opt/bin/codex",
        SKFIY_ASSISTANT_AGENT_CWD: "/workspace",
        SKFIY_ASSISTANT_AGENT_TIMEOUT_MS: "120000"
      }, { cwd: "/repo" })
    );

    expect(store.set({ mode: "codex" })).toMatchObject({
      mode: "codex",
      codexBinary: "/opt/bin/codex",
      codexBinarySource: "env",
      cwd: "/workspace",
      timeoutMs: 120_000
    });
  });
});
