import { afterEach, describe, expect, it } from "vitest";
import {
  CONTROL_SERVER_HOST,
  createControlServer,
  writeControlTokenFile,
  createControlTokenPath,
  type ControlServerLive
} from "./control-server.js";
import { CONTROL_TOKEN_HEADER } from "../shared/control-contract.js";
import { createStopTaskEventDecision } from "./main-stop-task.js";
import type { TaskControlSnapshot } from "../shared/task-control.js";
import type { TurnReplay } from "./computer-use/turn-replay-store.js";

const TOKEN = "test-control-token-0123456789abcdef";

function createTaskControlSnapshot(
  overrides: Partial<TaskControlSnapshot> = {}
): TaskControlSnapshot {
  return {
    schemaVersion: 1,
    executionId: "exec-1",
    phase: "executing",
    status: "executing",
    message: "Running",
    plan: {
      planId: "plan-1",
      route: "ghostty",
      appName: "Ghostty",
      target: "window",
      risk: { level: "low", reason: "read-only", requiresApproval: false },
      approvalRequired: false,
      expectedVerification: "terminal marker",
      mutating: false
    },
    sideEffectState: "none",
    replayAvailable: false,
    recoveryActions: [],
    ...overrides
  };
}

function createFakeLive(overrides: Partial<ControlServerLive> = {}): ControlServerLive {
  const snapshot = createTaskControlSnapshot();
  return {
    readTaskControl: () => snapshot,
    readTurnReplay: () => null,
    readApprovalState: () => ({ pendingApproval: null, taskControl: snapshot }),
    resumeTask: async () => snapshot,
    denyTask: async () => snapshot,
    stopTask: async (reason) => {
      const decision = createStopTaskEventDecision({
        activeRoute: null,
        pendingApproval: null,
        ...(reason ? { message: reason } : {})
      });
      return {
        result: "no-active-task",
        stopDecision: {
          cancellationReason: decision.cancellationReason,
          delivery: decision.delivery,
          route: decision.route ? decision.route.kind : null
        },
        taskControl: snapshot
      };
    },
    ...overrides
  };
}

describe("control server", () => {
  let handle: ReturnType<typeof createControlServer> | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
  });

  async function startServer(live: ControlServerLive) {
    handle = createControlServer({ token: TOKEN, live });
    const { url, port } = await handle.start();
    return { url, port };
  }

  async function request(
    url: string,
    options: { method?: string; token?: string; body?: unknown } = {}
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        ...(options.token ? { [CONTROL_TOKEN_HEADER]: options.token } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    return { status: response.status, body: await response.json() };
  }

  it("binds 127.0.0.1 only", async () => {
    const { port } = await startServer(createFakeLive());
    expect(handle?.server.address()).toMatchObject({ address: CONTROL_SERVER_HOST, port });
  });

  it("rejects requests without the token with 401", async () => {
    const { url } = await startServer(createFakeLive());
    const response = await request(`${url}/task-control`);
    expect(response.status).toBe(401);
  });

  it("rejects requests with a wrong token with 401", async () => {
    const { url } = await startServer(createFakeLive());
    const response = await request(`${url}/task-control`, { token: "wrong-token" });
    expect(response.status).toBe(401);
  });

  it("GET /task-control returns the task control snapshot with the token", async () => {
    const snapshot = createTaskControlSnapshot();
    const { url } = await startServer(createFakeLive({ readTaskControl: () => snapshot }));
    const response = await request(`${url}/task-control`, { token: TOKEN });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(snapshot);
  });

  it("GET /turn-replay returns the turn replay", async () => {
    const replay: TurnReplay = {
      transcript: {
        outcome: "completed",
        apps: [],
        actions: [],
        screenshots: [],
        approvalRequired: false
      } as unknown as TurnReplay["transcript"],
      timeline: []
    };
    const { url } = await startServer(createFakeLive({ readTurnReplay: () => replay }));
    const response = await request(`${url}/turn-replay`, { token: TOKEN });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(replay);
  });

  it("POST /approve-task validates executionId+planId+gate and returns mismatch on stale request", async () => {
    const pendingApproval = { planId: "plan-current", gate: "action-plan" as const };
    const snapshot = createTaskControlSnapshot({
      phase: "approval",
      status: "approval_required",
      approval: { gate: "action-plan", planId: "plan-current" }
    });
    const { url } = await startServer(
      createFakeLive({
        readApprovalState: () => ({ pendingApproval, taskControl: snapshot })
      })
    );

    // Stale planId -> mismatch, resumeTask never called.
    let resumeCalled = false;
    const staleResponse = await request(`${url}/approve-task`, {
      method: "POST",
      token: TOKEN,
      body: {
        decision: "approve",
        executionId: "exec-1",
        planId: "plan-stale",
        gate: "action-plan"
      }
    });
    expect(staleResponse.status).toBe(200);
    expect((staleResponse.body as { result: string }).result).toBe("mismatch");
    expect((staleResponse.body as { message: string }).message).toBe(
      "Task approval no longer matches the displayed Task Control plan."
    );
    expect(resumeCalled).toBe(false);

    // Matching request -> resumed.
    const matchResponse = await request(`${url}/approve-task`, {
      method: "POST",
      token: TOKEN,
      body: {
        decision: "approve",
        executionId: "exec-1",
        planId: "plan-current",
        gate: "action-plan"
      }
    });
    expect(matchResponse.status).toBe(200);
    expect((matchResponse.body as { result: string }).result).toBe("resumed");
  });

  it("POST /approve-task rejects a request with extra/injected fields", async () => {
    const { url } = await startServer(createFakeLive());
    const response = await request(`${url}/approve-task`, {
      method: "POST",
      token: TOKEN,
      body: {
        decision: "approve",
        executionId: "exec-1",
        planId: "plan-1",
        gate: "action-plan",
        command: "rm -rf /"
      }
    });
    expect(response.status).toBe(400);
  });

  it("POST /stop-task reuses createStopTaskEventDecision and is idempotent", async () => {
    const { url } = await startServer(createFakeLive());
    const response = await request(`${url}/stop-task`, {
      method: "POST",
      token: TOKEN,
      body: { reason: "user requested" }
    });
    expect(response.status).toBe(200);
    const body = response.body as {
      result: string;
      stopDecision: { cancellationReason: string; delivery: string; route: string | null };
    };
    expect(body.result).toBe("no-active-task");
    expect(body.stopDecision.cancellationReason).toBe("user requested");
    expect(body.stopDecision.delivery).toBe("transient");
    expect(body.stopDecision.route).toBeNull();
  });

  it("GET /health returns 200 with the token", async () => {
    const { url } = await startServer(createFakeLive());
    const response = await request(`${url}/health`, { token: TOKEN });
    expect(response.status).toBe(200);
  });

  it("writes and removes the token file", () => {
    const files = new Map<string, string>();
    const appSupportDir = "/tmp/skfiy-control-server-test";
    const tokenFile = writeControlTokenFile(
      appSupportDir,
      { url: "http://127.0.0.1:51983", token: TOKEN, pid: 42 },
      {
        exists: (targetPath) => files.has(targetPath),
        mkdir: () => undefined,
        writeFile: (targetPath, content) => {
          files.set(targetPath, content);
        }
      }
    );
    expect(tokenFile.url).toBe("http://127.0.0.1:51983");
    expect(tokenFile.pid).toBe(42);
    const written = JSON.parse(files.get(createControlTokenPath(appSupportDir)) ?? "{}") as {
      schemaVersion: number;
      token: string;
    };
    expect(written.schemaVersion).toBe(1);
    expect(written.token).toBe(TOKEN);
  });
});
