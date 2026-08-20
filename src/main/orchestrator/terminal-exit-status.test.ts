import { describe, expect, it } from "vitest";

import type { DesktopAppState, OcrLabelObservation } from "../computer-use/types";
import { readTerminalExitStatus } from "./terminal-exit-status";

function createObservation(labels: readonly string[]): DesktopAppState {
  return {
    bundleId: "com.mitchellh.ghostty",
    pid: 54502,
    isRunning: true,
    isActive: true,
    screenshotPath: "/tmp/after.png",
    ocrLabels: labels.map((text, index): OcrLabelObservation => ({
      text,
      confidence: 0.9,
      bounds: { x: 36, y: 400 + index * 20, width: 220, height: 18 }
    }))
  };
}

describe("readTerminalExitStatus", () => {
  it("parses STATUS 0 from the completion marker", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS 0"]), "A")).toEqual({ code: 0 });
  });

  it("parses STATUS 1 from the completion marker", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS 1"]), "A")).toEqual({ code: 1 });
  });

  it("parses a multi-digit STATUS 127 from the completion marker", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS 127"]), "A")).toEqual({ code: 127 });
  });

  it("parses STATUS 255 as the upper bound", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS 255"]), "A")).toEqual({ code: 255 });
  });

  it("tolerates a lone letter O read as zero", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS O"]), "A")).toEqual({ code: 0 });
  });

  it("rejects a status above 255 as unknown", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS 256"]), "A")).toEqual({ code: "unknown" });
  });

  it("rejects fused multi-digit strings longer than three digits as unknown", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS 1234"]), "A")).toEqual({ code: "unknown" });
  });

  it("rejects letters in a multi-character status as unknown", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS 1O"]), "A")).toEqual({ code: "unknown" });
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS OK"]), "A")).toEqual({ code: "unknown" });
  });

  it("requires the correct marker serial", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE B STATUS 0"]), "A")).toEqual({ code: "unknown" });
  });

  it("does not confuse a longer serial with a shorter one", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE AA STATUS 0"]), "A")).toEqual({ code: "unknown" });
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS 0"]), "AA")).toEqual({ code: "unknown" });
  });

  it("ignores non-marker output labels entirely", () => {
    expect(readTerminalExitStatus(
      createObservation(["total 42", "drwxr-xr-x  staff", "some command output"]),
      "A"
    )).toEqual({ code: "unknown" });
  });

  it("parses identically across the duplicate marker lines printed for OCR redundancy", () => {
    const first = readTerminalExitStatus(
      createObservation(["SKFIY DONE A STATUS 0", "SKFIY DONE A STATUS 0"]),
      "A"
    );
    const second = readTerminalExitStatus(
      createObservation(["SKFIY DONE A STATUS 0"]),
      "A"
    );

    expect(first).toEqual({ code: 0 });
    expect(second).toEqual(first);
  });

  it("falls through to a later clean marker line when an earlier one is unparseable", () => {
    expect(readTerminalExitStatus(
      createObservation(["SKFIY DONE A STATUS 1O", "SKFIY DONE A STATUS 0"]),
      "A"
    )).toEqual({ code: 0 });
  });

  it("returns unknown when OCR labels are missing", () => {
    expect(readTerminalExitStatus(
      {
        bundleId: "com.mitchellh.ghostty",
        isRunning: true,
        isActive: true,
        screenshotPath: "/tmp/after.png"
      },
      "A"
    )).toEqual({ code: "unknown" });
  });

  it("returns unknown when the marker is present but carries no status", () => {
    expect(readTerminalExitStatus(createObservation(["SKFIY DONE A STATUS"]), "A")).toEqual({ code: "unknown" });
  });
});
