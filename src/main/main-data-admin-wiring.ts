import { isDataDomain, type DataDomain } from "../shared/data-export.js";
import { readRecord } from "./record-utils.js";
import type { DataAdminRuntime } from "./data-admin-runtime.js";

export const DATA_ADMIN_IPC_CHANNELS = [
  "skfiy:export-data",
  "skfiy:preview-restore-data",
  "skfiy:restore-data",
  "skfiy:reset-data-domain",
  "skfiy:get-storage-health",
  "skfiy:get-retention",
  "skfiy:set-retention",
  "skfiy:apply-retention"
] as const;

export type DataAdminIpcChannel = (typeof DATA_ADMIN_IPC_CHANNELS)[number];

export interface DataAdminIpcMain {
  handle(
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown
  ): void;
}

export function registerDataAdminIpc({
  ipcMain,
  runtime
}: {
  ipcMain: DataAdminIpcMain;
  runtime: DataAdminRuntime;
}): void {
  ipcMain.handle("skfiy:export-data", (_event, input: unknown) => {
    const record = readRecord(input);
    const domains = readRequestedDomains(record?.domains);
    return runtime.exportData(domains);
  });

  ipcMain.handle("skfiy:preview-restore-data", (_event, bundle: unknown) => {
    if (bundle === undefined) {
      throw new Error("skfiy:preview-restore-data requires an export bundle.");
    }
    return runtime.previewRestore(bundle);
  });

  ipcMain.handle("skfiy:restore-data", async (_event, preview: unknown) => {
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
      throw new Error("skfiy:restore-data requires a restore preview.");
    }
    return runtime.restoreData(preview as Parameters<DataAdminRuntime["restoreData"]>[0]);
  });

  ipcMain.handle("skfiy:reset-data-domain", (_event, input: unknown) => {
    const record = readRecord(input);
    const domain = readDomain(record?.domain);
    if (record?.confirm !== true) {
      throw new Error("skfiy:reset-data-domain requires explicit confirmation.");
    }
    return runtime.resetDomain(domain);
  });

  ipcMain.handle("skfiy:get-storage-health", () => {
    return runtime.readHealth();
  });

  ipcMain.handle("skfiy:get-retention", () => {
    return runtime.getRetention();
  });

  ipcMain.handle("skfiy:set-retention", (_event, update: unknown) => {
    return runtime.setRetention(update);
  });

  ipcMain.handle("skfiy:apply-retention", async () => {
    return runtime.applyRetention();
  });
}

function readRequestedDomains(value: unknown): DataDomain[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("skfiy:export-data domains must be an array.");
  }
  return value.map(readDomain);
}

function readDomain(value: unknown): DataDomain {
  if (!isDataDomain(value)) {
    throw new Error(`Unknown data domain: ${String(value)}.`);
  }
  return value;
}
