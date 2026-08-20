import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BrowserContextPanel } from "./app-browser-context-panel";
import type { BrowserContextSourceState } from "./app-browser-context-state";
import { createUnknownBrowserContextSourceSnapshot } from "./app-browser-context-state";
import type {
  BrowserContextSourceSnapshot,
  BrowserContextTabDiscoveryResult
} from "../shared/browser-context-source";

function createSnapshot(
  overrides: Partial<BrowserContextSourceSnapshot> = {}
): BrowserContextSourceSnapshot {
  return {
    ...createUnknownBrowserContextSourceSnapshot(),
    ...overrides
  };
}

function createState(
  overrides: Partial<BrowserContextSourceState> = {}
): BrowserContextSourceState {
  return {
    snapshot: createSnapshot(),
    discovery: null,
    loading: false,
    actionPending: false,
    error: "",
    pickerOpen: false,
    setPickerOpen: vi.fn(),
    refresh: vi.fn(async () => undefined),
    discover: vi.fn(async () => undefined),
    selectTab: vi.fn(async () => undefined),
    togglePause: vi.fn(async () => undefined),
    toggleDisconnect: vi.fn(async () => undefined),
    clearForTurn: vi.fn(async () => undefined),
    ...overrides
  };
}

describe("BrowserContextPanel", () => {
  it("renders the heading and a ready state badge", () => {
    render(<BrowserContextPanel state={createState({
      snapshot: createSnapshot({ contextState: "ready" })
    })} />);

    expect(screen.getByLabelText("Browser Context")).toBeTruthy();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
  });

  it("shows a loading state while loading", () => {
    render(<BrowserContextPanel state={createState({ loading: true })} />);

    expect(screen.getByText("Checking Browser Context")).toBeTruthy();
  });

  it("prompts tab selection when no tab is selected", () => {
    render(<BrowserContextPanel state={createState()} />);

    expect(screen.getByLabelText("Select a Chrome tab for Browser Context")).toBeTruthy();
    expect(screen.getByText("No tab selected")).toBeTruthy();
  });

  it("shows the selected tab title, host, and freshness", () => {
    render(<BrowserContextPanel state={createState({
      snapshot: createSnapshot({
        contextState: "ready",
        selectedTab: {
          tabId: 5,
          title: "Example",
          host: "example.test",
          scheme: "https:",
          active: true,
          freshnessSeconds: 12
        }
      })
    })} />);

    expect(screen.getByText("Example")).toBeTruthy();
    expect(screen.getByText("example.test · https: · active")).toBeTruthy();
    expect(screen.getByText("12s ago")).toBeTruthy();
  });

  it("opens the picker when the selected tab card is clicked", () => {
    const setPickerOpen = vi.fn();
    render(<BrowserContextPanel state={createState({ setPickerOpen })} />);

    fireEvent.click(screen.getByLabelText("Select a Chrome tab for Browser Context"));
    expect(setPickerOpen).toHaveBeenCalledWith(true);
  });

  it("renders the action bar with pause and disconnect toggles", () => {
    render(<BrowserContextPanel state={createState({
      snapshot: createSnapshot({ paused: false, disconnected: false })
    })} />);

    expect(screen.getByLabelText("Refresh Browser Context")).toBeTruthy();
    expect(screen.getByLabelText("Pause Browser Context")).toBeTruthy();
    expect(screen.getByLabelText("Disconnect Browser Context")).toBeTruthy();
    expect(screen.getByLabelText("Clear Browser Context for this turn")).toBeTruthy();
  });

  it("reflects paused and disconnected state in the action labels", () => {
    render(<BrowserContextPanel state={createState({
      snapshot: createSnapshot({ paused: true, disconnected: true })
    })} />);

    expect(screen.getByLabelText("Resume Browser Context")).toBeTruthy();
    expect(screen.getByLabelText("Reconnect Browser Context")).toBeTruthy();
  });

  it("disables clear for turn once cleared", () => {
    render(<BrowserContextPanel state={createState({
      snapshot: createSnapshot({ clearedForTurn: true })
    })} />);

    const clearButton = screen.getByLabelText("Clear Browser Context for this turn");
    expect(clearButton.hasAttribute("disabled")).toBe(true);
  });

  it("wires action buttons to the state callbacks", () => {
    const refresh = vi.fn(async () => undefined);
    const togglePause = vi.fn(async () => undefined);
    const toggleDisconnect = vi.fn(async () => undefined);
    const clearForTurn = vi.fn(async () => undefined);
    render(<BrowserContextPanel state={createState({
      refresh,
      togglePause,
      toggleDisconnect,
      clearForTurn
    })} />);

    fireEvent.click(screen.getByLabelText("Refresh Browser Context"));
    fireEvent.click(screen.getByLabelText("Pause Browser Context"));
    fireEvent.click(screen.getByLabelText("Disconnect Browser Context"));
    fireEvent.click(screen.getByLabelText("Clear Browser Context for this turn"));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(togglePause).toHaveBeenCalledTimes(1);
    expect(toggleDisconnect).toHaveBeenCalledTimes(1);
    expect(clearForTurn).toHaveBeenCalledTimes(1);
  });

  it("renders blocker rows with labels and next actions", () => {
    render(<BrowserContextPanel state={createState({
      snapshot: createSnapshot({
        blockers: [
          { category: "site-access", label: "Site access", detail: "example.test", nextAction: "Grant site access." },
          { category: "screenshot", label: "Screenshot" }
        ]
      })
    })} />);

    expect(screen.getByText("Site access")).toBeTruthy();
    expect(screen.getByText("example.test")).toBeTruthy();
    expect(screen.getByText("Grant site access.")).toBeTruthy();
    expect(screen.getByText("Screenshot")).toBeTruthy();
  });

  it("renders the tab picker with eligible and blocked groups", () => {
    const discovery: BrowserContextTabDiscoveryResult = {
      result: "passed",
      tabs: [
        { tabId: 1, title: "Eligible", host: "eligible.test", eligible: true },
        { tabId: 2, title: "Blocked", host: "blocked.test", eligible: false, blocker: "internal_chrome_page", blockerCategory: "internal-page", nextAction: "Open a normal page." }
      ]
    };
    render(<BrowserContextPanel state={createState({ pickerOpen: true, discovery })} />);

    expect(screen.getByText("Eligible tabs")).toBeTruthy();
    expect(screen.getByText("Blocked tabs")).toBeTruthy();
    expect(screen.getByLabelText("Observe eligible.test")).toBeTruthy();
    expect(screen.getByLabelText("Blocked tab blocked.test")).toBeTruthy();
    expect(screen.getByText("Internal page — Open a normal page.")).toBeTruthy();
  });

  it("selects an eligible tab from the picker", () => {
    const selectTab = vi.fn(async () => undefined);
    const discovery: BrowserContextTabDiscoveryResult = {
      result: "passed",
      tabs: [{ tabId: 1, title: "Eligible", host: "eligible.test", eligible: true }]
    };
    render(<BrowserContextPanel state={createState({ pickerOpen: true, discovery, selectTab })} />);

    fireEvent.click(screen.getByLabelText("Observe eligible.test"));
    expect(selectTab).toHaveBeenCalledWith(1);
  });

  it("re-scans tabs from the picker", () => {
    const discover = vi.fn(async () => undefined);
    render(<BrowserContextPanel state={createState({ pickerOpen: true, discover })} />);

    fireEvent.click(screen.getByLabelText("Re-scan Chrome tabs"));
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state when there are no eligible tabs", () => {
    const discovery: BrowserContextTabDiscoveryResult = {
      result: "passed",
      tabs: [{ tabId: 2, title: "Blocked", eligible: false, blocker: "file_url_not_supported", blockerCategory: "file-page" }]
    };
    render(<BrowserContextPanel state={createState({ pickerOpen: true, discovery })} />);

    expect(screen.getByText("No eligible tabs. Open an http or https page and re-scan.")).toBeTruthy();
  });

  it("renders an error message when present", () => {
    render(<BrowserContextPanel state={createState({ error: "extension offline" })} />);

    expect(screen.getByRole("alert").textContent).toBe("extension offline");
  });
});
