import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ported from the skfiy repo and extended: supervision never grants the
 * Background Agent direct terminal authority. The mutating tmux verbs live
 * only in the recovery client, and recovery is launched only by an explicit
 * user gesture — never by the automation-run supervisor.
 */
describe("money-run supervision app integration", () => {
  it("wires tmux supervision into the compiled app command path", () => {
    const mainSource = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const taskEventSource = readFileSync(path.join(process.cwd(), "src/main/task-event-view.ts"), "utf8");

    expect(mainSource).toContain("runTmuxSupervisionTask");
    expect(mainSource).toContain("createTmuxSupervisionClient");
    expect(mainSource).toContain("route.kind === \"tmux_supervision\"");
    expect(taskEventSource).toContain("tmuxSupervisionReport");
    expect(taskEventSource).toContain("\"report\" in event");
  });

  it("keeps mutating tmux verbs out of main.ts and task-event-view.ts", () => {
    const mainSource = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");
    const taskEventSource = readFileSync(path.join(process.cwd(), "src/main/task-event-view.ts"), "utf8");

    expect(mainSource).not.toContain("send-keys");
    expect(mainSource).not.toContain("kill-pane");
    expect(taskEventSource).not.toContain("send-keys");
    expect(taskEventSource).not.toContain("kill-pane");
  });

  it("wires tmux recovery behind an explicit approval IPC", () => {
    const mainSource = readFileSync(path.join(process.cwd(), "src/main/main.ts"), "utf8");

    expect(mainSource).toContain("runTmuxRecoveryTask");
    expect(mainSource).toContain("createTmuxRecoveryClient");
    expect(mainSource).toContain("skfiy:approve-tmux-recovery");
    expect(mainSource).toContain("parseTmuxRecoveryAction");
  });

  it("never lets the automation-run supervisor import the recovery client", () => {
    const supervisorSource = readFileSync(
      path.join(process.cwd(), "src/main/automation-run-supervisor.ts"),
      "utf8"
    );

    expect(supervisorSource).not.toContain("tmux-recovery-client");
    expect(supervisorSource).not.toContain("createTmuxRecoveryClient");
    expect(supervisorSource).not.toContain("runTmuxRecoveryTask");
  });

  it("keeps mutating tmux verbs out of the supervision client", () => {
    const supervisionClientSource = readFileSync(
      path.join(process.cwd(), "src/main/tmux-supervision-client.ts"),
      "utf8"
    );

    expect(supervisionClientSource).not.toContain("send-keys");
    expect(supervisionClientSource).not.toContain("kill-pane");
    expect(supervisionClientSource).not.toContain("respawn-pane");
    expect(supervisionClientSource).not.toContain("new-session");
  });

  it("declares a separate recovery approval gate on the tmux adapter", () => {
    const adapterSource = readFileSync(
      path.join(process.cwd(), "src/main/adapter/tmux-supervision-adapter.ts"),
      "utf8"
    );
    const contractSource = readFileSync(
      path.join(process.cwd(), "src/shared/adapter-contract.ts"),
      "utf8"
    );

    expect(adapterSource).toContain('gates: ["action", "recovery"]');
    expect(contractSource).toContain('"action" | "submit" | "plan" | "recovery"');
  });
});
