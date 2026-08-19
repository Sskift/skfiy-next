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
});
