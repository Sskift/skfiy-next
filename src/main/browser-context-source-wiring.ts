import { readRecord } from "./record-utils.js";
import type { BrowserContextSourceActions } from "./browser-context-source-actions.js";

export const BROWSER_CONTEXT_SOURCE_IPC_CHANNELS = [
  "skfiy:get-browser-context-source",
  "skfiy:discover-browser-tabs",
  "skfiy:select-browser-tab",
  "skfiy:refresh-browser-context",
  "skfiy:pause-browser-context",
  "skfiy:disconnect-browser-context",
  "skfiy:clear-browser-context"
] as const;

export type BrowserContextSourceIpcChannel =
  typeof BROWSER_CONTEXT_SOURCE_IPC_CHANNELS[number];

export interface BrowserContextSourceIpcMain {
  handle(
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown
  ): void;
}

export function registerBrowserContextSourceIpc({
  ipcMain,
  actions
}: {
  ipcMain: BrowserContextSourceIpcMain;
  actions: BrowserContextSourceActions;
}): void {
  ipcMain.handle("skfiy:get-browser-context-source", () => {
    return actions.getSnapshot();
  });

  ipcMain.handle("skfiy:discover-browser-tabs", () => {
    return actions.discoverTabs();
  });

  ipcMain.handle("skfiy:select-browser-tab", async (_event, input: unknown) => {
    const record = readRecord(input);
    const tabId = record?.tabId;
    if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId <= 0) {
      throw new Error("skfiy:select-browser-tab requires a positive integer tabId.");
    }
    return actions.selectTab(tabId);
  });

  ipcMain.handle("skfiy:refresh-browser-context", () => {
    return actions.refresh();
  });

  ipcMain.handle("skfiy:pause-browser-context", async () => {
    const snapshot = await actions.getSnapshot();
    return snapshot.paused ? actions.resume() : actions.pause();
  });

  ipcMain.handle("skfiy:disconnect-browser-context", async () => {
    const snapshot = await actions.getSnapshot();
    return snapshot.disconnected ? actions.reconnect() : actions.disconnect();
  });

  ipcMain.handle("skfiy:clear-browser-context", () => {
    return actions.clearForTurn();
  });
}
