import { describe, expect, it } from "vitest";

import type { DesktopAppState, OcrLabelObservation } from "../computer-use/types";
import {
  GHOSTTY_SENSITIVE_TEXT_PATTERNS,
  TERMINAL_CONTEXT_MAX_TAIL_CHARACTERS,
  TERMINAL_CONTEXT_MAX_TAIL_LABELS,
  readTerminalContext
} from "./terminal-context";

function createObservation(labels: readonly string[]): DesktopAppState {
  return {
    bundleId: "com.mitchellh.ghostty",
    pid: 54502,
    isRunning: true,
    isActive: true,
    screenshotPath: "/tmp/before.png",
    ocrLabels: labels.map((text, index): OcrLabelObservation => ({
      text,
      confidence: 0.9,
      bounds: { x: 36, y: 80 + index * 20, width: 200, height: 18 }
    }))
  };
}

describe("readTerminalContext", () => {
  it("parses the working directory from the [skfiy] prompt label", () => {
    const context = readTerminalContext(
      createObservation(["[skfiy] /Users/foo $"])
    );

    expect(context.workingDirectory).toBe("/Users/foo");
    expect(context.promptReady).toBe(true);
  });

  it("parses a home-relative prompt path", () => {
    const context = readTerminalContext(
      createObservation(["[skfiy] ~/Documents $"])
    );

    expect(context.workingDirectory).toBe("~/Documents");
  });

  it("returns unknown working directory when no prompt label matches", () => {
    const context = readTerminalContext(
      createObservation(["SKFIY_READY", "some output line"])
    );

    expect(context.workingDirectory).toBe("unknown");
    expect(context.promptReady).toBe(false);
  });

  it("extracts the last command echo from the prompt line", () => {
    const context = readTerminalContext(
      createObservation(["[skfiy] /Users/foo $ pwd"])
    );

    expect(context.workingDirectory).toBe("/Users/foo");
    expect(context.lastCommandEcho).toBe("pwd");
  });

  it("leaves the command echo empty when the prompt has no typed command", () => {
    const context = readTerminalContext(
      createObservation(["[skfiy] /Users/foo $"])
    );

    expect(context.lastCommandEcho).toBe("");
  });

  it("marks promptReady from the [skfiy] prompt but not the SKFIY_READY marker", () => {
    expect(readTerminalContext(createObservation(["[skfiy] /Users/foo $"])).promptReady).toBe(true);
    expect(readTerminalContext(createObservation(["SKFIY_READY"])).promptReady).toBe(false);
  });

  it("bounds the recent output tail to the last 8 labels", () => {
    const labels = Array.from(
      { length: 12 },
      (_, index) => `line-${index}`
    );

    const context = readTerminalContext(createObservation(labels));

    const tailLines = context.recentOutputTail.split("\n");
    expect(tailLines).toHaveLength(TERMINAL_CONTEXT_MAX_TAIL_LABELS);
    expect(tailLines[0]).toBe("line-4");
    expect(tailLines[7]).toBe("line-11");
  });

  it("bounds the recent output tail to 4000 characters from the end", () => {
    const longLine = "x".repeat(5000);

    const context = readTerminalContext(createObservation([longLine]));

    expect(context.recentOutputTail).toHaveLength(TERMINAL_CONTEXT_MAX_TAIL_CHARACTERS);
    expect(context.recentOutputTail).toBe(longLine.slice(longLine.length - TERMINAL_CONTEXT_MAX_TAIL_CHARACTERS));
  });

  it("redacts Bearer tokens and token= assignments from every context field", () => {
    const context = readTerminalContext(
      createObservation([
        "[skfiy] /Users/foo $ curl -H 'Authorization: Bearer abc123secret'",
        "export TOKEN_VALUE=token=supersecretvalue"
      ])
    );

    expect(context.lastCommandEcho).not.toContain("abc123secret");
    expect(context.lastCommandEcho).toContain("Bearer [redacted]");
    expect(context.recentOutputTail).not.toContain("supersecretvalue");
    expect(context.recentOutputTail).toContain("token=[redacted]");
  });

  it("redacts secret= assignments from the working directory field", () => {
    const context = readTerminalContext(
      createObservation(["[skfiy] /Users/foo?secret=leaked $"])
    );

    expect(context.workingDirectory).not.toContain("leaked");
    expect(context.workingDirectory).toContain("secret=[redacted]");
  });

  it("mirrors the recovery-policy sensitive text decision", () => {
    const sensitive = readTerminalContext(
      createObservation(["Enter API token", "[skfiy] /Users/foo $"])
    );
    const clean = readTerminalContext(
      createObservation(["[skfiy] /Users/foo $"])
    );

    expect(sensitive.sensitiveContentDetected).toBe(true);
    expect(clean.sensitiveContentDetected).toBe(false);
  });

  it("uses the same sensitive patterns as the recovery pause gate", () => {
    expect(GHOSTTY_SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test("Enter API token"))).toBe(true);
    expect(GHOSTTY_SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test("Private key passphrase"))).toBe(true);
    expect(GHOSTTY_SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test("ordinary output"))).toBe(false);
  });

  it("degrades gracefully when OCR labels are missing", () => {
    const context = readTerminalContext({
      bundleId: "com.mitchellh.ghostty",
      isRunning: true,
      isActive: true,
      screenshotPath: "/tmp/before.png"
    });

    expect(context).toEqual({
      workingDirectory: "unknown",
      promptReady: false,
      lastCommandEcho: "",
      recentOutputTail: "",
      sensitiveContentDetected: false
    });
  });

  it("degrades gracefully when OCR labels are empty", () => {
    const context = readTerminalContext(createObservation([]));

    expect(context.workingDirectory).toBe("unknown");
    expect(context.promptReady).toBe(false);
    expect(context.lastCommandEcho).toBe("");
    expect(context.recentOutputTail).toBe("");
  });

  it("bounds the working directory to 256 characters", () => {
    const longPath = `/${"a".repeat(300)}`;

    const context = readTerminalContext(
      createObservation([`[skfiy] ${longPath} $`])
    );

    expect(context.workingDirectory.length).toBeLessThanOrEqual(256);
  });
});
