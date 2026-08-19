import { describe, expect, it } from "vitest";
import { createChromeTurnHostGrantStore } from "./chrome-turn-host-grant";

describe("Chrome turn host grants", () => {
  const firstTool = {
    turnId: "assistant-turn-1",
    toolCallId: "assistant-turn-1-tool-1"
  };
  const retryTool = {
    turnId: "assistant-turn-2",
    toolCallId: "assistant-turn-2-tool-1"
  };

  it("normalizes a grant and scopes it to one opaque tool identity", () => {
    const store = createChromeTurnHostGrantStore();

    expect(store.grant(firstTool, "https://Example.com:8443/docs")).toEqual({
      ...firstTool,
      host: "example.com:8443"
    });
    expect(store.has(firstTool, "example.com:8443")).toBe(true);
    expect(store.has(firstTool, "https://EXAMPLE.com:8443/other")).toBe(true);
    expect(store.has(retryTool, "example.com:8443")).toBe(false);
  });

  it("clears all grants for a terminal, stopped, or failed tool", () => {
    const store = createChromeTurnHostGrantStore();
    store.grant(firstTool, "one.example");
    store.grant(firstTool, "two.example");

    expect(store.clear(firstTool)).toBe(true);
    expect(store.has(firstTool, "one.example")).toBe(false);
    expect(store.has(firstTool, "two.example")).toBe(false);
    expect(store.clear(firstTool)).toBe(false);
  });

  it("starts empty after a process restart instead of restoring orphaned grants", () => {
    const beforeRestart = createChromeTurnHostGrantStore();
    beforeRestart.grant(firstTool, "turn.example");

    const afterRestart = createChromeTurnHostGrantStore();
    expect(afterRestart.has(firstTool, "turn.example")).toBe(false);
  });

  it("rejects malformed identities and hosts instead of creating broad grants", () => {
    const store = createChromeTurnHostGrantStore();

    expect(() => store.grant({ turnId: "", toolCallId: firstTool.toolCallId }, "example.com"))
      .toThrow("Chrome turn host grant requires a tool identity.");
    expect(() => store.grant(firstTool, "bad host"))
      .toThrow("Chrome turn host grant requires a valid host.");
    expect(store.has({ turnId: "", toolCallId: firstTool.toolCallId }, "example.com")).toBe(false);
  });
});
