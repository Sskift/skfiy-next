import type {
  BrowserContextBlocker,
  BrowserContextBlockerCategory,
  BrowserContextSourceSnapshot,
  BrowserContextTabSummary
} from "../shared/browser-context-source";
import { BROWSER_CONTEXT_BLOCKER_LABELS } from "../shared/browser-context-source";
import type { BrowserContextSourceState } from "./app-browser-context-state";

export type BrowserContextStateTone = "ready" | "warning" | "danger" | "neutral";

export function readBrowserContextStateTone(state: string): BrowserContextStateTone {
  if (state === "ready") {
    return "ready";
  }
  if (
    state === "partial"
    || state === "sensitive-paused"
    || state === "stale"
    || state === "not-probed"
  ) {
    return "warning";
  }
  if (
    state.startsWith("blocked")
    || state === "unavailable"
    || state === "active_tab_unavailable"
    || state === "content_script_not_loaded"
    || state === "not_loaded"
  ) {
    return "danger";
  }

  return "neutral";
}

export function readBrowserContextStateLabel(state: string): string {
  const labels: Record<string, string> = {
    ready: "Ready",
    partial: "Partial",
    blocked: "Blocked",
    blocked_by_chrome_host_permission: "Site access needed",
    blocked_by_host_policy: "Host policy denied",
    active_tab_unavailable: "Selected tab unavailable",
    content_script_not_loaded: "Content script not loaded",
    not_loaded: "Not loaded",
    "sensitive-paused": "Paused",
    "not-probed": "Not probed",
    missing: "Missing",
    stale: "Stale",
    unavailable: "Unavailable"
  };

  return labels[state] ?? state;
}

export function formatBrowserContextFreshness(freshnessSeconds: number | undefined): string {
  if (freshnessSeconds === undefined) {
    return "not observed";
  }
  if (freshnessSeconds < 5) {
    return "just now";
  }
  if (freshnessSeconds < 60) {
    return `${freshnessSeconds}s ago`;
  }
  if (freshnessSeconds < 3_600) {
    return `${Math.floor(freshnessSeconds / 60)}m ago`;
  }

  return "stale";
}

function readTabHostLabel(tab: { host?: string; url?: string }): string {
  return tab.host || tab.url || "Unknown tab";
}

function BrowserContextSelectedTabCard({
  snapshot,
  onOpenPicker
}: {
  snapshot: BrowserContextSourceSnapshot;
  onOpenPicker: () => void;
}) {
  const selectedTab = snapshot.selectedTab;
  const tone = readBrowserContextStateTone(snapshot.contextState);

  if (!selectedTab) {
    return (
      <button
        type="button"
        className="browser-context-selected-tab browser-context-selected-tab-empty"
        aria-label="Select a Chrome tab for Browser Context"
        onClick={onOpenPicker}
      >
        <span className="browser-context-tab-avatar" aria-hidden="true">?</span>
        <span className="browser-context-tab-meta">
          <strong>No tab selected</strong>
          <span>Pick a tab to observe for Browser Context.</span>
        </span>
        <span className={`browser-context-state-badge tone-${tone}`}>
          {readBrowserContextStateLabel(snapshot.contextState)}
        </span>
      </button>
    );
  }

  const avatarLetter = (selectedTab.title || selectedTab.host || "?").charAt(0).toUpperCase();

  return (
    <button
      type="button"
      className="browser-context-selected-tab"
      aria-label={`Selected tab ${selectedTab.title ?? selectedTab.host ?? selectedTab.tabId}. Open tab picker.`}
      onClick={onOpenPicker}
    >
      <span className="browser-context-tab-avatar" aria-hidden="true">{avatarLetter}</span>
      <span className="browser-context-tab-meta">
        <strong>{selectedTab.title || readTabHostLabel(selectedTab)}</strong>
        <span>
          {selectedTab.host || "unknown host"}
          {selectedTab.scheme ? ` · ${selectedTab.scheme}` : ""}
          {selectedTab.active ? " · active" : ""}
        </span>
        <span className="browser-context-tab-freshness">
          {formatBrowserContextFreshness(selectedTab.freshnessSeconds)}
        </span>
      </span>
      <span className={`browser-context-state-badge tone-${tone}`}>
        {readBrowserContextStateLabel(snapshot.contextState)}
      </span>
    </button>
  );
}

function BrowserContextActionBar({
  snapshot,
  actionPending,
  onRefresh,
  onTogglePause,
  onToggleDisconnect,
  onClearForTurn
}: {
  snapshot: BrowserContextSourceSnapshot;
  actionPending: boolean;
  onRefresh: () => void;
  onTogglePause: () => void;
  onToggleDisconnect: () => void;
  onClearForTurn: () => void;
}) {
  return (
    <div className="browser-context-actions" aria-label="Browser Context actions">
      <button
        type="button"
        aria-label="Refresh Browser Context"
        disabled={actionPending}
        onClick={onRefresh}
      >
        Refresh
      </button>
      <button
        type="button"
        aria-label={snapshot.paused ? "Resume Browser Context" : "Pause Browser Context"}
        aria-pressed={snapshot.paused}
        disabled={actionPending}
        onClick={onTogglePause}
      >
        {snapshot.paused ? "Resume" : "Pause"}
      </button>
      <button
        type="button"
        aria-label={snapshot.disconnected ? "Reconnect Browser Context" : "Disconnect Browser Context"}
        aria-pressed={snapshot.disconnected}
        disabled={actionPending}
        onClick={onToggleDisconnect}
      >
        {snapshot.disconnected ? "Reconnect" : "Disconnect"}
      </button>
      <button
        type="button"
        aria-label="Clear Browser Context for this turn"
        disabled={actionPending || snapshot.clearedForTurn}
        onClick={onClearForTurn}
      >
        Clear for turn
      </button>
    </div>
  );
}

function BrowserContextBlockerRow({ blocker }: { blocker: BrowserContextBlocker }) {
  return (
    <li className={`browser-context-blocker browser-context-blocker-${blocker.category}`}>
      <span className="browser-context-blocker-label" aria-hidden="true">
        {readBlockerIcon(blocker.category)}
      </span>
      <div className="browser-context-blocker-meta">
        <strong>{blocker.label}</strong>
        {blocker.detail ? <span>{blocker.detail}</span> : null}
        {blocker.nextAction ? <span>{blocker.nextAction}</span> : null}
      </div>
    </li>
  );
}

function readBlockerIcon(category: BrowserContextBlockerCategory): string {
  switch (category) {
    case "internal-page":
      return "chrome://";
    case "file-page":
      return "file://";
    case "host-policy":
      return "policy";
    case "site-access":
      return "access";
    case "content-script":
      return "script";
    case "screenshot":
      return "capture";
    case "unsupported-scheme":
      return "scheme";
  }
}

function BrowserContextBlockerList({ blockers }: { blockers: BrowserContextBlocker[] }) {
  if (blockers.length === 0) {
    return null;
  }

  return (
    <ul className="browser-context-blockers" aria-label="Browser Context blockers">
      {blockers.map((blocker) => (
        <BrowserContextBlockerRow
          key={`${blocker.category}-${blocker.detail ?? ""}`}
          blocker={blocker}
        />
      ))}
    </ul>
  );
}

function BrowserContextTabPicker({
  state,
  tabs
}: {
  state: BrowserContextSourceState;
  tabs: BrowserContextTabSummary[];
}) {
  const eligibleTabs = tabs.filter((tab) => tab.eligible);
  const blockedTabs = tabs.filter((tab) => !tab.eligible);

  return (
    <div className="browser-context-tab-picker" aria-label="Chrome tab picker">
      <div className="browser-context-tab-picker-heading">
        <strong>Chrome tabs</strong>
        <button
          type="button"
          aria-label="Re-scan Chrome tabs"
          disabled={state.actionPending}
          onClick={() => void state.discover()}
        >
          Re-scan
        </button>
      </div>
      {eligibleTabs.length > 0 ? (
        <fieldset>
          <legend>Eligible tabs</legend>
          {eligibleTabs.map((tab) => (
            <button
              type="button"
              key={tab.tabId}
              className="browser-context-tab-option"
              aria-label={`Observe ${readTabHostLabel(tab)}`}
              aria-pressed={state.snapshot.selectedTab?.tabId === tab.tabId}
              disabled={state.actionPending}
              onClick={() => void state.selectTab(tab.tabId)}
            >
              <span className="browser-context-tab-option-title">
                {tab.title || readTabHostLabel(tab)}
              </span>
              <span className="browser-context-tab-option-host">
                {tab.host || "unknown host"}
                {tab.active ? " · active" : ""}
              </span>
            </button>
          ))}
        </fieldset>
      ) : (
        <p className="browser-context-tab-empty">
          No eligible tabs. Open an http or https page and re-scan.
        </p>
      )}
      {blockedTabs.length > 0 ? (
        <fieldset>
          <legend>Blocked tabs</legend>
          {blockedTabs.map((tab) => (
            <div
              key={tab.tabId}
              className="browser-context-tab-option browser-context-tab-option-blocked"
              aria-label={`Blocked tab ${readTabHostLabel(tab)}`}
            >
              <span className="browser-context-tab-option-title">
                {tab.title || readTabHostLabel(tab)}
              </span>
              <span className="browser-context-tab-option-host">
                {tab.blockerCategory
                  ? BROWSER_CONTEXT_BLOCKER_LABELS[tab.blockerCategory]
                  : (tab.blocker ?? "blocked")}
                {tab.nextAction ? ` — ${tab.nextAction}` : ""}
              </span>
            </div>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

export function BrowserContextPanel({ state }: { state: BrowserContextSourceState }) {
  const tabs = state.discovery?.tabs ?? [];

  return (
    <section className="browser-context-panel" aria-label="Browser Context">
      <div className="browser-context-heading">
        <strong>Browser Context</strong>
        <span className={`browser-context-state-badge tone-${readBrowserContextStateTone(state.snapshot.contextState)}`}>
          {readBrowserContextStateLabel(state.snapshot.contextState)}
        </span>
      </div>

      {state.loading ? (
        <p className="browser-context-loading" role="status">
          Checking Browser Context
        </p>
      ) : (
        <>
          <BrowserContextSelectedTabCard
            snapshot={state.snapshot}
            onOpenPicker={() => state.setPickerOpen(!state.pickerOpen)}
          />
          <BrowserContextActionBar
            snapshot={state.snapshot}
            actionPending={state.actionPending}
            onRefresh={() => void state.refresh()}
            onTogglePause={() => void state.togglePause()}
            onToggleDisconnect={() => void state.toggleDisconnect()}
            onClearForTurn={() => void state.clearForTurn()}
          />
          <BrowserContextBlockerList blockers={state.snapshot.blockers} />
          {state.pickerOpen ? (
            <BrowserContextTabPicker state={state} tabs={tabs} />
          ) : null}
          {state.error ? (
            <p className="browser-context-error" role="alert">
              {state.error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
