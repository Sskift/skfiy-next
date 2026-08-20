import { describe, expect, it } from "vitest";
import {
  readAssistantAgentIdentityValid,
  readAssistantAgentSandboxValid,
  testAssistantAgentProvider
} from "./assistant-agent-provider-test";
import type { AssistantAgentSettings } from "./assistant-agent-provider-registry";

function createSettings(
  overrides: Partial<AssistantAgentSettings> = {}
): AssistantAgentSettings {
  return {
    mode: "codex",
    codexBinary: "codex",
    codexBinarySource: "default",
    claudeCodeBinary: "claude",
    claudeCodeBinarySource: "default",
    hermesBinary: "hermes",
    hermesBinarySource: "default",
    cwd: "/tmp/skfiy",
    timeoutMs: 45_000,
    ...overrides
  };
}

describe("assistant agent provider bounded test", () => {
  describe("identity validation", () => {
    it("accepts a response that claims the skfiy identity", () => {
      expect(readAssistantAgentIdentityValid("skfiy-ready")).toBe(true);
      expect(readAssistantAgentIdentityValid("我是 skfiy。")).toBe(true);
    });

    it("rejects a response that claims to be Claude", () => {
      expect(readAssistantAgentIdentityValid("I am Claude")).toBe(false);
      expect(readAssistantAgentIdentityValid("I'm Claude, an AI assistant")).toBe(false);
    });

    it("rejects a response that claims to be Codex", () => {
      expect(readAssistantAgentIdentityValid("I am Codex")).toBe(false);
      expect(readAssistantAgentIdentityValid("I'm Codex")).toBe(false);
    });

    it("rejects a response that claims to be Hermes", () => {
      expect(readAssistantAgentIdentityValid("I am Hermes")).toBe(false);
      expect(readAssistantAgentIdentityValid("I'm Hermes")).toBe(false);
    });

    it("rejects a response that claims to be a generic AI assistant", () => {
      expect(readAssistantAgentIdentityValid("I am an AI language model")).toBe(false);
      expect(readAssistantAgentIdentityValid("I'm an AI assistant")).toBe(false);
    });

    it("rejects an empty response", () => {
      expect(readAssistantAgentIdentityValid("")).toBe(false);
      expect(readAssistantAgentIdentityValid("   ")).toBe(false);
    });
  });

  describe("sandbox validation", () => {
    it("validates Codex read-only sandbox flags", () => {
      expect(readAssistantAgentSandboxValid("codex", [
        "exec", "--sandbox", "read-only", "--cd", "/tmp"
      ])).toBe(true);
      expect(readAssistantAgentSandboxValid("codex", [
        "exec", "--cd", "/tmp"
      ])).toBe(false);
    });

    it("validates Claude Code safety flags", () => {
      expect(readAssistantAgentSandboxValid("claude-code", [
        "--print", "--permission-mode", "dontAsk",
        "--disallowedTools", "Bash,Edit", "--safe-mode"
      ])).toBe(true);
      expect(readAssistantAgentSandboxValid("claude-code", [
        "--print", "--permission-mode", "dontAsk"
      ])).toBe(false);
    });

    it("validates Hermes safe toolset flags", () => {
      expect(readAssistantAgentSandboxValid("hermes", [
        "chat", "--toolsets", "safe", "--max-turns", "1"
      ])).toBe(true);
      expect(readAssistantAgentSandboxValid("hermes", [
        "chat", "--toolsets", "safe"
      ])).toBe(false);
    });
  });

  describe("testAssistantAgentProvider", () => {
    it("returns chat-ready when the provider answers with valid identity and sandbox", async () => {
      const result = await testAssistantAgentProvider({
        settings: createSettings(),
        mode: "codex",
        resolveExecutable: async (command) => `/resolved/${command}`,
        runReadinessProbe: async (_command, _args) => ({
          stdout: "skfiy-ready",
          stderr: ""
        })
      });

      expect(result.state).toMatchObject({
        id: "codex",
        label: "Codex",
        readiness: "chat-ready"
      });
      expect(result.checks).toEqual({
        identity: true,
        sandbox: true,
        responseParsing: true
      });
    });

    it("returns auth-or-permission-blocked when the response claims a backend identity", async () => {
      const result = await testAssistantAgentProvider({
        settings: createSettings(),
        mode: "codex",
        resolveExecutable: async (command) => `/resolved/${command}`,
        runReadinessProbe: async () => ({
          stdout: "I am Claude, an AI assistant made by Anthropic.",
          stderr: ""
        })
      });

      expect(result.state.readiness).toBe("auth-or-permission-blocked");
      expect(result.checks.identity).toBe(false);
      expect(result.checks.responseParsing).toBe(true);
      expect(result.checks.sandbox).toBe(true);
    });

    it("returns binary-found when the response is empty", async () => {
      const result = await testAssistantAgentProvider({
        settings: createSettings(),
        mode: "codex",
        resolveExecutable: async (command) => `/resolved/${command}`,
        runReadinessProbe: async () => ({
          stdout: "   ",
          stderr: ""
        })
      });

      expect(result.state.readiness).toBe("binary-found");
      expect(result.state.lastError).toContain("empty response");
      expect(result.checks.responseParsing).toBe(false);
    });

    it("returns unavailable when the probe process fails", async () => {
      const result = await testAssistantAgentProvider({
        settings: createSettings(),
        mode: "codex",
        resolveExecutable: async (command) => `/resolved/${command}`,
        runReadinessProbe: async () => {
          throw new Error("connection refused");
        }
      });

      expect(result.state.readiness).toBe("unavailable");
      expect(result.state.lastError).toBe("connection refused");
      expect(result.checks.sandbox).toBe(true);
    });

    it("returns auth-or-permission-blocked when the probe fails on auth", async () => {
      const result = await testAssistantAgentProvider({
        settings: createSettings(),
        mode: "codex",
        resolveExecutable: async (command) => `/resolved/${command}`,
        runReadinessProbe: async () => {
          throw new Error("Not authenticated. Run codex login.");
        }
      });

      expect(result.state.readiness).toBe("auth-or-permission-blocked");
    });

    it("returns unconfigured when the binary is not set", async () => {
      const result = await testAssistantAgentProvider({
        settings: createSettings({ codexBinary: "  " }),
        mode: "codex",
        resolveExecutable: async (command) => `/resolved/${command}`,
        runReadinessProbe: async () => ({ stdout: "skfiy-ready", stderr: "" })
      });

      expect(result.state).toMatchObject({
        configured: false,
        readiness: "unconfigured",
        lastError: "Codex executable is not configured."
      });
      expect(result.checks).toEqual({
        identity: false,
        sandbox: false,
        responseParsing: false
      });
    });

    it("returns unavailable when the executable cannot be resolved", async () => {
      const result = await testAssistantAgentProvider({
        settings: createSettings({ codexBinary: "missing-codex" }),
        mode: "codex",
        resolveExecutable: async () => {
          throw new Error("missing-codex not found");
        },
        runReadinessProbe: async () => ({ stdout: "skfiy-ready", stderr: "" })
      });

      expect(result.state).toMatchObject({
        configured: true,
        readiness: "unavailable",
        lastError: "missing-codex not found"
      });
    });

    it("tests Claude Code with the system-prompt identity and safety flags", async () => {
      const probeCalls: Array<{ command: string; args: string[] }> = [];
      const result = await testAssistantAgentProvider({
        settings: createSettings({ mode: "claude-code" }),
        mode: "claude-code",
        resolveExecutable: async (command) => `/resolved/${command}`,
        runReadinessProbe: async (command, args) => {
          probeCalls.push({ command, args });
          return { stdout: "skfiy-ready", stderr: "" };
        }
      });

      expect(result.state.readiness).toBe("chat-ready");
      const call = probeCalls[0];
      expect(call?.command).toBe("/resolved/claude");
      expect(call?.args).toContain("--system-prompt");
      expect(call?.args).toContain("--permission-mode");
      expect(call?.args).toContain("dontAsk");
      expect(call?.args).toContain("--safe-mode");
    });

    it("tests Hermes with the safe toolset flags", async () => {
      const probeCalls: Array<{ command: string; args: string[] }> = [];
      const result = await testAssistantAgentProvider({
        settings: createSettings({ mode: "hermes" }),
        mode: "hermes",
        resolveExecutable: async (command) => `/resolved/${command}`,
        runReadinessProbe: async (command, args) => {
          probeCalls.push({ command, args });
          return { stdout: "skfiy-ready", stderr: "" };
        }
      });

      expect(result.state.readiness).toBe("chat-ready");
      const call = probeCalls[0];
      expect(call?.command).toBe("/resolved/hermes");
      expect(call?.args).toContain("--toolsets");
      expect(call?.args).toContain("safe");
      expect(call?.args).toContain("--max-turns");
      expect(call?.args).toContain("1");
    });
  });
});
