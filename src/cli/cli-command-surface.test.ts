import { describe, expect, it } from "vitest";
import { runSkfiyCli } from "./cli-command-surface.js";
import { CLI_SURFACE_SCHEMA_VERSION } from "./cli-contract.js";
import { CLI_COMMAND_DEFINITIONS } from "./cli-command-definitions.js";

function createOutputCapture() {
  const chunks: string[] = [];
  return {
    stdout: { write: (chunk: string) => { chunks.push(chunk); return true; } },
    stderr: { write: () => true },
    text: () => chunks.join(""),
    lastJson: <T>() => JSON.parse(chunks.join("")) as T
  };
}

const baseDeps = {
  homeDir: "/tmp/skfiy-cli-surface-test-home",
  appVersion: "0.1.0",
  exists: () => false,
  readFile: () => {
    throw new Error("not found");
  }
};

describe("CLI command surface", () => {
  it("returns schemaVersion 1 and exactly the 8 slim commands", async () => {
    const output = createOutputCapture();
    const exitCode = await runSkfiyCli({
      argv: ["commands"],
      stdout: output.stdout,
      stderr: output.stderr,
      ...baseDeps
    });

    expect(exitCode).toBe(0);
    const envelope = output.lastJson<{
      result: string;
      data: { surface: { schemaVersion: number; commands: { path: string }[] } };
    }>();
    expect(envelope.result).toBe("ok");
    expect(envelope.data.surface.schemaVersion).toBe(CLI_SURFACE_SCHEMA_VERSION);
    const paths = envelope.data.surface.commands.map((command) => command.path);
    expect(paths).toEqual([
      "commands",
      "status",
      "readiness",
      "doctor",
      "export",
      "restore preview",
      "capabilities",
      "mcp serve"
    ]);
  });

  it("declares executesSystemMutation=false and plannedMutation=false for every command", () => {
    for (const command of CLI_COMMAND_DEFINITIONS) {
      expect(command.executesSystemMutation, command.path).toBe(false);
      expect(command.plannedMutation, command.path).toBe(false);
    }
  });

  it("declares jsonOutput=true and a non-empty outputShape for every command", () => {
    for (const command of CLI_COMMAND_DEFINITIONS) {
      expect(command.jsonOutput, command.path).toBe(true);
      expect(command.outputShape.length, command.path).toBeGreaterThan(0);
    }
  });

  it("returns exit 2 and a typed unknown-command error envelope for an unknown command", async () => {
    const output = createOutputCapture();
    const exitCode = await runSkfiyCli({
      argv: ["frobnicate"],
      stdout: output.stdout,
      stderr: output.stderr,
      ...baseDeps
    });

    expect(exitCode).toBe(2);
    const envelope = output.lastJson<{
      result: string;
      error: { code: string; message: string; action: string };
    }>();
    expect(envelope.result).toBe("error");
    expect(envelope.error.code).toBe("unknown-command");
    expect(envelope.error.action.length).toBeGreaterThan(0);
  });

  it("defaults to compact JSON and indents with --pretty", async () => {
    const compact = createOutputCapture();
    await runSkfiyCli({
      argv: ["commands"],
      stdout: compact.stdout,
      stderr: compact.stderr,
      ...baseDeps
    });
    expect(compact.text()).not.toContain("\n  ");
    expect(compact.text().trim().split("\n")).toHaveLength(1);

    const pretty = createOutputCapture();
    await runSkfiyCli({
      argv: ["commands", "--pretty"],
      stdout: pretty.stdout,
      stderr: pretty.stderr,
      ...baseDeps
    });
    expect(pretty.text()).toContain("\n  ");
  });
});
