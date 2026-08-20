import { describe, expect, it } from "vitest";
import {
  createAssistantAgentSettingsStore,
  readInitialAssistantAgentSettingsFromConfig
} from "./assistant-agent-settings";

describe("assistant agent settings store", () => {
  it("defaults to codex and accepts Codex, Claude Code, or Hermes", () => {
    const store = createAssistantAgentSettingsStore(
      readInitialAssistantAgentSettingsFromConfig({}, { cwd: "/repo" })
    );

    expect(store.get().mode).toBe("codex");
    expect(store.set({ mode: "codex" }).mode).toBe("codex");
    expect(store.set({ mode: "claude-code" }).mode).toBe("claude-code");
    expect(store.set({ mode: "hermes" }).mode).toBe("hermes");
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
        SKFIY_CLAUDE_CODE_BIN: "/opt/bin/claude",
        SKFIY_HERMES_BIN: "/opt/bin/hermes",
        SKFIY_ASSISTANT_AGENT_CWD: "/workspace",
        SKFIY_ASSISTANT_AGENT_TIMEOUT_MS: "120000"
      }, { cwd: "/repo" })
    );

    expect(store.set({ mode: "codex" })).toMatchObject({
      mode: "codex",
      codexBinary: "/opt/bin/codex",
      codexBinarySource: "env",
      claudeCodeBinary: "/opt/bin/claude",
      claudeCodeBinarySource: "env",
      hermesBinary: "/opt/bin/hermes",
      hermesBinarySource: "env",
      cwd: "/workspace",
      timeoutMs: 120_000
    });
  });

  it("stores per-provider runtime overrides without touching other providers", () => {
    const store = createAssistantAgentSettingsStore(
      readInitialAssistantAgentSettingsFromConfig({}, { cwd: "/repo" })
    );

    const updated = store.set({
      mode: "codex",
      providerRuntime: {
        codex: { cwd: "/workspace/codex", timeoutMs: 30_000 },
        "claude-code": { cwd: "/workspace/claude" }
      }
    });

    expect(updated.providerRuntime).toEqual({
      codex: { cwd: "/workspace/codex", timeoutMs: 30_000 },
      "claude-code": { cwd: "/workspace/claude" }
    });
    expect(updated.cwd).toBe("/repo");
    expect(updated.timeoutMs).toBe(45_000);
  });

  it("merges per-provider runtime overrides across updates", () => {
    const store = createAssistantAgentSettingsStore(
      readInitialAssistantAgentSettingsFromConfig({}, { cwd: "/repo" })
    );

    store.set({
      providerRuntime: { codex: { cwd: "/workspace/codex" } }
    });
    const merged = store.set({
      providerRuntime: { codex: { timeoutMs: 60_000 } }
    });

    expect(merged.providerRuntime).toEqual({
      codex: { cwd: "/workspace/codex", timeoutMs: 60_000 }
    });
  });

  it("ignores invalid per-provider runtime values", () => {
    const store = createAssistantAgentSettingsStore(
      readInitialAssistantAgentSettingsFromConfig({}, { cwd: "/repo" })
    );

    const updated = store.set({
      providerRuntime: {
        codex: { cwd: "  ", timeoutMs: -5 },
        "invalid-mode": { cwd: "/tmp" }
      }
    });

    expect(updated.providerRuntime).toBeUndefined();
  });
});
