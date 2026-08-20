import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  AssistantAgentMode,
  AssistantAgentProviderState,
  AssistantAgentSettingsResponse
} from "./app-types";
import { ProviderDiscoveryPanel } from "./provider-discovery-panel";

function createProvider(
  id: AssistantAgentMode,
  overrides: Partial<AssistantAgentProviderState> = {}
): AssistantAgentProviderState {
  const label = id === "codex" ? "Codex" : id === "claude-code" ? "Claude Code" : "Hermes";
  return {
    provider: "assistant",
    id,
    label,
    selected: id === "codex",
    configured: true,
    executablePath: id,
    executableSource: "default",
    readiness: "version-ok",
    ...overrides
  };
}

function createResponse(
  overrides: Partial<AssistantAgentSettingsResponse> = {}
): AssistantAgentSettingsResponse {
  return {
    settings: {
      mode: "codex",
      codexBinary: "codex",
      codexBinarySource: "default",
      claudeCodeBinary: "claude",
      claudeCodeBinarySource: "default",
      hermesBinary: "hermes",
      hermesBinarySource: "default",
      cwd: "/tmp/skfiy",
      timeoutMs: 45_000
    },
    providers: [
      createProvider("codex", { selected: true, readiness: "chat-ready" }),
      createProvider("claude-code", { readiness: "unavailable" }),
      createProvider("hermes", { readiness: "unavailable" })
    ],
    ...overrides
  };
}

describe("ProviderDiscoveryPanel", () => {
  it("renders all discovered providers with readiness badges", () => {
    render(
      <ProviderDiscoveryPanel
        response={createResponse()}
        onSelectMode={() => undefined}
        onTestProvider={vi.fn()}
        onUpdateProviderRuntime={() => undefined}
      />
    );

    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Hermes")).toBeTruthy();
    expect(screen.getByText("chat ready")).toBeTruthy();
    expect(screen.getAllByText("unavailable")).toHaveLength(2);
  });

  it("calls onSelectMode when a provider is selected", () => {
    const onSelectMode = vi.fn();
    render(
      <ProviderDiscoveryPanel
        response={createResponse()}
        onSelectMode={onSelectMode}
        onTestProvider={vi.fn()}
        onUpdateProviderRuntime={() => undefined}
      />
    );

    fireEvent.click(screen.getByLabelText("选择 Claude Code background agent"));
    expect(onSelectMode).toHaveBeenCalledWith("claude-code");
  });

  it("calls onTestProvider when the test button is clicked", async () => {
    const onTestProvider = vi.fn().mockResolvedValue(
      createProvider("codex", { readiness: "chat-ready" })
    );
    render(
      <ProviderDiscoveryPanel
        response={createResponse()}
        onSelectMode={() => undefined}
        onTestProvider={onTestProvider}
        onUpdateProviderRuntime={() => undefined}
      />
    );

    fireEvent.click(screen.getByLabelText("测试 Codex provider"));
    expect(onTestProvider).toHaveBeenCalledWith("codex");
  });

  it("shows the offline banner when the fallback is offline", () => {
    render(
      <ProviderDiscoveryPanel
        response={createResponse({
          fallback: {
            kind: "offline",
            requestedMode: "codex",
            reason: "Codex is unavailable and no fallback provider is available."
          }
        })}
        onSelectMode={() => undefined}
        onTestProvider={vi.fn()}
        onUpdateProviderRuntime={() => undefined}
      />
    );

    expect(screen.getByText("Background Agent 离线")).toBeTruthy();
    expect(screen.getByText(/Codex is unavailable/)).toBeTruthy();
  });

  it("shows the fallback banner with a switch action when a fallback exists", () => {
    const onSelectFallbackProvider = vi.fn();
    render(
      <ProviderDiscoveryPanel
        response={createResponse({
          fallback: {
            kind: "fallback",
            requestedMode: "codex",
            activeMode: "hermes",
            reason: "Codex is unavailable; skfiy can fall back to Hermes."
          }
        })}
        onSelectMode={() => undefined}
        onTestProvider={vi.fn()}
        onUpdateProviderRuntime={() => undefined}
        onSelectFallbackProvider={onSelectFallbackProvider}
      />
    );

    expect(screen.getByText("Background Agent 已切换")).toBeTruthy();
    fireEvent.click(screen.getByText("切换到 hermes"));
    expect(onSelectFallbackProvider).toHaveBeenCalledWith("hermes");
  });

  it("expands per-provider runtime settings and commits updates", () => {
    const onUpdateProviderRuntime = vi.fn();
    render(
      <ProviderDiscoveryPanel
        response={createResponse()}
        onSelectMode={() => undefined}
        onTestProvider={vi.fn()}
        onUpdateProviderRuntime={onUpdateProviderRuntime}
      />
    );

    fireEvent.click(screen.getByLabelText("Codex 高级设置"));
    const cwdInput = screen.getByPlaceholderText("/tmp/skfiy");
    fireEvent.change(cwdInput, { target: { value: "/workspace/codex" } });
    fireEvent.click(screen.getByText("保存"));

    expect(onUpdateProviderRuntime).toHaveBeenCalledWith("codex", {
      cwd: "/workspace/codex"
    });
  });

  it("displays provider last errors", () => {
    render(
      <ProviderDiscoveryPanel
        response={createResponse({
          providers: [
            createProvider("codex", {
              readiness: "unavailable",
              lastError: "codex not found"
            }),
            createProvider("claude-code"),
            createProvider("hermes")
          ]
        })}
        onSelectMode={() => undefined}
        onTestProvider={vi.fn()}
        onUpdateProviderRuntime={() => undefined}
      />
    );

    expect(screen.getByText("codex not found")).toBeTruthy();
  });
});
