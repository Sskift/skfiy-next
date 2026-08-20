import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("preload Background Agent readiness contract", () => {
  it("accepts every readiness value emitted by the main process", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");
    const validator = source.slice(
      source.indexOf("function isAssistantAgentProviderReadiness"),
      source.indexOf("function isFirstRunReadinessSnapshot")
    );

    for (const readiness of [
      "chat-ready",
      "version-ok",
      "binary-found",
      "binary-configured",
      "auth-or-permission-blocked",
      "unconfigured",
      "unavailable"
    ]) {
      expect(validator).toContain(`value === "${readiness}"`);
    }
    expect(validator).not.toContain('value === "ready"');
  });

  it("accepts every assistant agent mode emitted by the main process", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");
    const validator = source.slice(
      source.indexOf("function isAssistantAgentMode"),
      source.indexOf("function isAssistantAgentCliBinarySource")
    );

    for (const mode of ["codex", "claude-code", "hermes"]) {
      expect(validator).toContain(`value === "${mode}"`);
    }
    expect(validator).not.toContain('value === "remote-agent"');
  });

  it("accepts every assistant agent provider label emitted by the main process", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");
    const validator = source.slice(
      source.indexOf("function isAssistantAgentProviderLabel"),
      source.indexOf("function isAssistantAgentMode")
    );

    for (const label of ["Codex", "Claude Code", "Hermes"]) {
      expect(validator).toContain(`value === "${label}"`);
    }
  });

  it("validates the fallback field when present in the settings response", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");
    expect(source).toContain("isAssistantAgentProviderFallback");
    expect(source).toContain("response.fallback === undefined");
    expect(source).toContain('fallback.kind === "fallback"');
    expect(source).toContain('fallback.kind === "offline"');
  });

  it("exposes the testAssistantAgentProvider API through the desktop bridge", () => {
    const source = readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");
    expect(source).toContain("testAssistantAgentProvider");
    expect(source).toContain("skfiy:test-assistant-agent-provider");
  });
});
