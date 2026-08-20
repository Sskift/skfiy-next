import { describe, expect, it, vi } from "vitest";

import {
  DATA_ADMIN_IPC_CHANNELS,
  registerDataAdminIpc
} from "./main-data-admin-wiring";
import type { DataAdminRuntime } from "./data-admin-runtime";
import type { DataExportBundle } from "../shared/data-export";
import type { RetentionSettings } from "../shared/retention";

function createBundle(): DataExportBundle {
  return {
    schemaVersion: 1,
    exportedAt: "2026-08-20T12:00:00.000Z",
    exporter: { app: "skfiy", version: "0.1.0" },
    domains: ["profiles"],
    profiles: { activeProfileId: "default", profiles: [] },
    redaction: { patterns: [], entriesRedacted: 0 }
  };
}

function createRetentionSettings(): RetentionSettings {
  return {
    schemaVersion: 1,
    replay: { enabled: true, maxTurns: 50, maxAgeDays: 30 },
    screenshots: { enabled: true, maxCount: 200, maxAgeDays: 14 },
    runHistory: { enabled: true, perMonitorCap: 20, globalCap: 200, maxAgeDays: 90 }
  };
}

function createRuntimeMock(): DataAdminRuntime & {
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {
    exportData: [],
    previewRestore: [],
    restoreData: [],
    resetDomain: [],
    readHealth: [],
    getRetention: [],
    setRetention: [],
    resetRetention: [],
    applyRetention: []
  };
  const runtime = {
    calls,
    exportData: vi.fn((domains?: unknown) => {
      calls.exportData.push([domains]);
      return createBundle();
    }),
    previewRestore: vi.fn((bundle: unknown) => {
      calls.previewRestore.push([bundle]);
      return {
        domains: [],
        requiresConfirmation: true,
        backupPlan: { path: "/backups/pre-restore-x", createdAt: "2026-08-20T12:00:00.000Z" },
        bundle: createBundle()
      };
    }),
    restoreData: vi.fn(async (preview: unknown) => {
      calls.restoreData.push([preview]);
      return {
        appliedDomains: ["profiles" as const],
        skipped: [],
        backupPath: "/backups/pre-restore-x",
        restoredAt: "2026-08-20T12:00:00.000Z"
      };
    }),
    resetDomain: vi.fn((domain: unknown) => {
      calls.resetDomain.push([domain]);
      return {
        domain: domain as never,
        resetImpact: "impact",
        cleared: ["cleared"]
      };
    }),
    readHealth: vi.fn(() => {
      calls.readHealth.push([]);
      return {
        status: "ok" as const,
        files: [],
        counts: { total: 0, ok: 0, missing: 0, corrupt: 0, futureSchema: 0 }
      };
    }),
    getRetention: vi.fn(() => {
      calls.getRetention.push([]);
      return createRetentionSettings();
    }),
    setRetention: vi.fn((update: unknown) => {
      calls.setRetention.push([update]);
      return createRetentionSettings();
    }),
    resetRetention: vi.fn(() => {
      calls.resetRetention?.push([]);
      return createRetentionSettings();
    }),
    applyRetention: vi.fn(async () => {
      calls.applyRetention.push([]);
      return {
        replay: { status: "noop" as const, note: "note" },
        screenshots: { status: "applied" as const, scanned: 0, deleted: 0 },
        runHistory: { status: "applied" as const, before: 0, after: 0 }
      };
    })
  };
  return runtime;
}

function createIpcMainFake() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }
  };
}

describe("data admin IPC wiring", () => {
  it("registers every data admin channel", () => {
    const ipcMain = createIpcMainFake();
    registerDataAdminIpc({ ipcMain, runtime: createRuntimeMock() });

    for (const channel of DATA_ADMIN_IPC_CHANNELS) {
      expect(ipcMain.handlers.has(channel)).toBe(true);
    }
  });

  it("exports data with validated domains", async () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerDataAdminIpc({ ipcMain, runtime });

    const result = await ipcMain.handlers.get("skfiy:export-data")?.(null, {
      domains: ["profiles", "sessions"]
    });

    expect(result).toBeDefined();
    expect(runtime.calls.exportData[0]).toEqual([["profiles", "sessions"]]);
  });

  it("defaults to all domains when no domains are requested", async () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerDataAdminIpc({ ipcMain, runtime });

    await ipcMain.handlers.get("skfiy:export-data")?.(null, undefined);

    expect(runtime.calls.exportData[0]).toEqual([undefined]);
  });

  it("rejects an invalid export domain", async () => {
    const ipcMain = createIpcMainFake();
    registerDataAdminIpc({ ipcMain, runtime: createRuntimeMock() });

    expect(() =>
      ipcMain.handlers.get("skfiy:export-data")?.(null, { domains: ["nope"] })
    ).toThrow(/Unknown data domain/);
  });

  it("previews a restore from a raw bundle", async () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerDataAdminIpc({ ipcMain, runtime });

    const bundle = createBundle();
    await ipcMain.handlers.get("skfiy:preview-restore-data")?.(null, bundle);

    expect(runtime.calls.previewRestore[0]).toEqual([bundle]);
  });

  it("requires a bundle for preview", async () => {
    const ipcMain = createIpcMainFake();
    registerDataAdminIpc({ ipcMain, runtime: createRuntimeMock() });

    expect(() =>
      ipcMain.handlers.get("skfiy:preview-restore-data")?.(null, undefined)
    ).toThrow(/export bundle/);
  });

  it("applies a restore from a preview", async () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerDataAdminIpc({ ipcMain, runtime });

    const preview = { domains: [], requiresConfirmation: true };
    await ipcMain.handlers.get("skfiy:restore-data")?.(null, preview);

    expect(runtime.calls.restoreData[0]).toEqual([preview]);
  });

  it("resets a domain only with explicit confirmation", async () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerDataAdminIpc({ ipcMain, runtime });

    expect(() =>
      ipcMain.handlers.get("skfiy:reset-data-domain")?.(null, { domain: "sessions" })
    ).toThrow(/confirmation/);

    await ipcMain.handlers.get("skfiy:reset-data-domain")?.(null, {
      domain: "sessions",
      confirm: true
    });
    expect(runtime.calls.resetDomain[0]).toEqual(["sessions"]);
  });

  it("rejects a reset for an unknown domain", async () => {
    const ipcMain = createIpcMainFake();
    registerDataAdminIpc({ ipcMain, runtime: createRuntimeMock() });

    expect(() =>
      ipcMain.handlers.get("skfiy:reset-data-domain")?.(null, {
        domain: "nope",
        confirm: true
      })
    ).toThrow(/Unknown data domain/);
  });

  it("reads storage health", async () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerDataAdminIpc({ ipcMain, runtime });

    const result = await ipcMain.handlers.get("skfiy:get-storage-health")?.(null);

    expect(result).toBeDefined();
    expect(runtime.calls.readHealth).toHaveLength(1);
  });

  it("reads and writes retention settings", async () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerDataAdminIpc({ ipcMain, runtime });

    await ipcMain.handlers.get("skfiy:get-retention")?.(null);
    expect(runtime.calls.getRetention).toHaveLength(1);

    const update = { runHistory: { perMonitorCap: 5 } };
    await ipcMain.handlers.get("skfiy:set-retention")?.(null, update);
    expect(runtime.calls.setRetention[0]).toEqual([update]);
  });

  it("applies retention on demand", async () => {
    const ipcMain = createIpcMainFake();
    const runtime = createRuntimeMock();
    registerDataAdminIpc({ ipcMain, runtime });

    await ipcMain.handlers.get("skfiy:apply-retention")?.(null);

    expect(runtime.calls.applyRetention).toHaveLength(1);
  });
});
