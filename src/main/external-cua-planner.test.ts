import { describe, expect, it, vi } from "vitest";
import { createExternalCuaTerminalPlanner } from "./external-cua-planner";

function createResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body))
  } as unknown as Response;
}

describe("external CUA terminal planner", () => {
  it("posts the desktop task to the configured endpoint and returns a terminal command", async () => {
    const fetchImpl = vi.fn(async () => createResponse({
      command: "pwd",
      rationale: "Read the current working directory."
    }));
    const planner = createExternalCuaTerminalPlanner({
      endpoint: "https://cua.example.test/plan",
      apiKey: "sk-test",
      label: "External CUA",
      fetchImpl
    });

    await expect(planner.planTerminalCommand({
      input: "打开 Ghostty 执行 pwd 并截图"
    })).resolves.toEqual({
      command: "pwd",
      rationale: "Read the current working directory."
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://cua.example.test/plan", {
      method: "POST",
      headers: {
        authorization: "Bearer sk-test",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        task: "打开 Ghostty 执行 pwd 并截图",
        targetApp: "Ghostty",
        capability: "terminal-command"
      }),
      signal: undefined
    });
  });

  it("rejects empty or multi-line commands from the external provider", async () => {
    const planner = createExternalCuaTerminalPlanner({
      endpoint: "https://cua.example.test/plan",
      apiKey: "sk-test",
      label: "External CUA",
      fetchImpl: vi.fn(async () => createResponse({
        command: "pwd\nrm -rf ~/Desktop"
      }))
    });

    await expect(planner.planTerminalCommand({ input: "do something" })).rejects.toThrow(
      "External CUA returned an invalid terminal command."
    );
  });

  it("includes provider HTTP failures in the error message", async () => {
    const planner = createExternalCuaTerminalPlanner({
      endpoint: "https://cua.example.test/plan",
      apiKey: "sk-test",
      label: "External CUA",
      fetchImpl: vi.fn(async () => createResponse({ error: "bad request" }, false, 400))
    });

    await expect(planner.planTerminalCommand({ input: "pwd" })).rejects.toThrow(
      "External CUA request failed with HTTP 400"
    );
  });
});
