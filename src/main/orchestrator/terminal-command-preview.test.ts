import { describe, expect, it } from "vitest";

import type { RiskDecision } from "../../shared/types";
import {
  GHOSTTY_EXPECTED_VERIFICATION,
  createTerminalCommandPreview
} from "./terminal-command-preview";
import type { TerminalContextObservation } from "./terminal-context";

function createContext(
  overrides: Partial<TerminalContextObservation> = {}
): TerminalContextObservation {
  return {
    workingDirectory: "/Users/foo",
    promptReady: true,
    lastCommandEcho: "",
    recentOutputTail: "",
    sensitiveContentDetected: false,
    ...overrides
  };
}

function risk(
  level: RiskDecision["level"],
  overrides: Partial<RiskDecision> = {}
): RiskDecision {
  return {
    level,
    reason: `risk-${level}`,
    requiresApproval: level !== "low",
    ...overrides
  };
}

describe("createTerminalCommandPreview", () => {
  it("builds a read-only preview for a low-risk command", () => {
    const preview = createTerminalCommandPreview({
      command: "pwd",
      context: createContext(),
      risk: risk("low")
    });

    expect(preview).toMatchObject({
      command: "pwd",
      workingDirectory: "/Users/foo",
      mutating: false,
      expectedResult: "Prints output without modifying local state",
      expectedVerification: GHOSTTY_EXPECTED_VERIFICATION
    });
    expect(preview.risk.level).toBe("low");
  });

  it("builds a mutating preview for a medium-risk command", () => {
    const preview = createTerminalCommandPreview({
      command: "mkdir skfiy-test",
      context: createContext(),
      risk: risk("medium")
    });

    expect(preview.mutating).toBe(true);
    expect(preview.expectedResult).toBe("May modify local state; outcome is verified after completion");
  });

  it("builds a mutating preview for a high-risk command", () => {
    const preview = createTerminalCommandPreview({
      command: "sudo spctl --master-disable",
      context: createContext(),
      risk: risk("high")
    });

    expect(preview.mutating).toBe(true);
    expect(preview.expectedResult).toBe("May modify local state; outcome is verified after completion");
  });

  it("build a non-mutating preview with a refused expected result for a blocked command", () => {
    const preview = createTerminalCommandPreview({
      command: "rm -rf ~/Desktop",
      context: createContext(),
      risk: risk("blocked")
    });

    expect(preview.mutating).toBe(false);
    expect(preview.expectedResult).toBe("Refused before execution");
  });

  it("redacts secret assignments from the command", () => {
    const preview = createTerminalCommandPreview({
      command: "curl -H 'Authorization: Bearer abc123' https://example.test?token=supersecret",
      context: createContext(),
      risk: risk("medium")
    });

    expect(preview.command).not.toContain("abc123");
    expect(preview.command).not.toContain("supersecret");
    expect(preview.command).toContain("Bearer [redacted]");
    expect(preview.command).toContain("token=[redacted]");
  });

  it("passes through an unknown working directory when context is unobservable", () => {
    const preview = createTerminalCommandPreview({
      command: "pwd",
      context: createContext({ workingDirectory: "unknown" }),
      risk: risk("low")
    });

    expect(preview.workingDirectory).toBe("unknown");
  });

  it("uses the normative ghostty expected-verification string", () => {
    const preview = createTerminalCommandPreview({
      command: "pwd",
      context: createContext(),
      risk: risk("low")
    });

    expect(preview.expectedVerification).toBe(
      "Confirm the owned Ghostty session remains active and observe the command completion marker."
    );
  });

  it("bounds the command to 160 characters", () => {
    const preview = createTerminalCommandPreview({
      command: `echo ${"x".repeat(300)}`,
      context: createContext(),
      risk: risk("low")
    });

    expect(preview.command.length).toBeLessThanOrEqual(160);
  });
});
