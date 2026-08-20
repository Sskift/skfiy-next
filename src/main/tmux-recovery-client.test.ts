import { describe, expect, it } from "vitest";
import {
  createTmuxRecoveryClient,
  type TmuxRecoveryClient
} from "./tmux-recovery-client";
import type { RunTmuxCommand, TmuxCommandResult } from "./tmux-supervision-client";

const catalog = {
  "restart-money-run": "npm run money-run",
  "restart-money-run-worker": "npm run money-run:worker"
};

function createRecordingRunner(results: TmuxCommandResult[]): {
  runner: RunTmuxCommand;
  calls: string[][];
} {
  const calls: string[][] = [];
  let index = 0;
  const runner: RunTmuxCommand = async (args) => {
    calls.push(args);
    const result = results[Math.min(index, results.length - 1)]!;
    index += 1;
    return result;
  };
  return { runner, calls };
}

function ok(stdout = ""): TmuxCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr = "tmux failed"): TmuxCommandResult {
  return { exitCode: 1, stdout: "", stderr };
}

function createClient(runner: RunTmuxCommand): TmuxRecoveryClient {
  return createTmuxRecoveryClient({
    catalog,
    runTmux: runner,
    now: () => "2026-08-19T00:00:00.000Z"
  });
}

describe("createTmuxRecoveryClient.sendInput", () => {
  it("sends keys in literal mode with exact argv", async () => {
    const { runner, calls } = createRecordingRunner([ok()]);
    const client = createClient(runner);

    const outcome = await client.sendInput("a", "%11", "y");

    expect(outcome).toMatchObject({ ok: true, actionId: "a" });
    expect(calls).toEqual([
      ["send-keys", "-l", "-t", "%11", "--", "y"]
    ]);
  });

  it("rejects empty or over-long keys without invoking tmux", async () => {
    const { runner, calls } = createRecordingRunner([ok()]);
    const client = createClient(runner);

    await expect(client.sendInput("a", "%11", "")).rejects.toThrow();
    await expect(client.sendInput("a", "%11", "y".repeat(300))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("returns a retryable failure outcome on non-zero exit", async () => {
    const { runner } = createRecordingRunner([failure("pane not found")]);
    const client = createClient(runner);

    const outcome = await client.sendInput("a", "%11", "y");

    expect(outcome).toEqual({
      ok: false,
      actionId: "a",
      at: "2026-08-19T00:00:00.000Z",
      error: "pane not found",
      retryable: true
    });
  });
});

describe("createTmuxRecoveryClient.restartStep", () => {
  it("restarts a registered step in an existing session via respawn-pane", async () => {
    const { runner, calls } = createRecordingRunner([ok(), ok()]);
    const client = createClient(runner);

    const outcome = await client.restartStep("a", "restart-money-run", {
      sessionName: "money-run"
    });

    expect(outcome).toMatchObject({ ok: true, actionId: "a" });
    expect(calls).toEqual([
      ["has-session", "-t", "money-run"],
      ["respawn-pane", "-k", "-t", "money-run", "npm run money-run"]
    ]);
  });

  it("creates the session when it does not exist", async () => {
    const { runner, calls } = createRecordingRunner([failure("can't find session"), ok()]);
    const client = createClient(runner);

    const outcome = await client.restartStep("a", "restart-money-run", {
      sessionName: "money-run"
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(calls).toEqual([
      ["has-session", "-t", "money-run"],
      ["new-session", "-d", "-s", "money-run", "npm run money-run"]
    ]);
  });

  it("rejects unknown stepIds without invoking tmux", async () => {
    const { runner, calls } = createRecordingRunner([ok()]);
    const client = createClient(runner);

    await expect(client.restartStep("a", "not-registered", {
      sessionName: "money-run"
    })).rejects.toThrow("Unknown tmux recovery step");
    expect(calls).toEqual([]);
  });
});

describe("createTmuxRecoveryClient.collectSummary", () => {
  it("captures a bounded pane tail", async () => {
    const longTail = "x".repeat(5_000);
    const { runner, calls } = createRecordingRunner([ok(longTail)]);
    const client = createClient(runner);

    const outcome = await client.collectSummary("a", "%11", 100);

    expect(outcome).toMatchObject({ ok: true, actionId: "a" });
    if (outcome.ok) {
      expect(outcome.result).toHaveLength(100);
    }
    expect(calls).toEqual([
      ["capture-pane", "-p", "-t", "%11", "-S", "-200"]
    ]);
  });

  it("rejects out-of-range tail bounds without invoking tmux", async () => {
    const { runner, calls } = createRecordingRunner([ok()]);
    const client = createClient(runner);

    await expect(client.collectSummary("a", "%11", 0)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("returns a retryable failure on non-zero exit", async () => {
    const { runner } = createRecordingRunner([failure("pane not found")]);
    const client = createClient(runner);

    const outcome = await client.collectSummary("a", "%11", 100);
    expect(outcome).toMatchObject({ ok: false, retryable: true });
  });
});

describe("recovery vs supervision separation", () => {
  it("exposes mutating verbs only on the recovery client", async () => {
    const { runner, calls } = createRecordingRunner([ok()]);
    const client = createClient(runner);

    await client.sendInput("a", "%11", "y");

    const argv = calls[0]!.join(" ");
    expect(argv).toContain("send-keys");
  });
});
