import { describe, expect, it, vi } from "vitest";
import type { DesktopHelperClient } from "./computer-use/desktop-helper.js";
import type {
  DesktopExecutableAction,
  PermissionSummary
} from "./computer-use/types.js";
import {
  assertDesktopActionResult,
  createChromeDesktopClient,
  createFinderDesktopClient,
  createFinderFileClient,
  createGhosttyDesktopClient
} from "./main-desktop-clients.js";

const clickAction = { type: "click", x: 10, y: 20 } satisfies DesktopExecutableAction;

describe("main desktop client adapters", () => {
  it("throws failed helper action results with the helper message", () => {
    expect(() => assertDesktopActionResult({ ok: true }, "click")).not.toThrow();
    expect(() => assertDesktopActionResult({ ok: false, message: "Screen Recording missing." }, "click"))
      .toThrow("Screen Recording missing.");
    expect(() => assertDesktopActionResult({ ok: false }, "click"))
      .toThrow("Desktop helper could not click.");
  });

  it("adapts the desktop helper to the Ghostty task client", async () => {
    const permissions: PermissionSummary = {
      screenRecording: { state: "granted" },
      accessibility: { state: "granted" }
    };
    const helper = {
      getPermissions: vi.fn(async () => permissions),
      listApps: vi.fn(async () => [
        { name: "Ghostty", bundleId: "com.mitchellh.ghostty", pid: 42 }
      ]),
      ocrImage: vi.fn(async () => ({ labels: [] })),
      executeAction: vi.fn(async () => ({ ok: true }))
    } as unknown as DesktopHelperClient;

    const client = createGhosttyDesktopClient(helper);

    await expect(client.getPermissions?.()).resolves.toBe(permissions);
    await expect(client.listApps()).resolves.toEqual([
      { name: "Ghostty", bundleId: "com.mitchellh.ghostty", pid: 42 }
    ]);
    await expect(client.ocrImage?.("/tmp/screen.png")).resolves.toEqual({ labels: [] });
    await expect(client.executeAction(clickAction)).resolves.toEqual({ ok: true });
    expect(helper.executeAction).toHaveBeenCalledWith(clickAction);
  });

  it("rejects failed Ghostty helper actions before the orchestrator continues", async () => {
    const helper = {
      getPermissions: vi.fn(),
      listApps: vi.fn(),
      ocrImage: vi.fn(),
      executeAction: vi.fn(async () => ({ ok: false, message: "Accessibility missing." }))
    } as unknown as DesktopHelperClient;

    const client = createGhosttyDesktopClient(helper);

    await expect(client.executeAction(clickAction)).rejects.toThrow("Accessibility missing.");
  });

  it("adapts the desktop helper to Finder and Chrome task clients", async () => {
    const desktopSessionStatus = {
      consoleUser: "tester",
      sessionOnConsole: true,
      screenLocked: false,
      displayAsleep: false
    };
    const helper = {
      executeAction: vi.fn(async () => ({ ok: true })),
      getDesktopSessionStatus: vi.fn(async () => desktopSessionStatus),
      getFinderSelection: vi.fn(async () => ({
        source: "finder-applescript" as const,
        selection: []
      })),
      getFinderItemLayout: vi.fn(async (folderPath: string, _itemNames: string[]) => ({
        source: "finder-applescript-layout" as const,
        folderPath,
        items: []
      })),
      atomicCopyFileNoReplace: vi.fn(async () => ({ state: "copied" as const })),
      atomicMoveFileNoReplace: vi.fn(async () => ({ state: "moved" as const }))
    } as unknown as DesktopHelperClient;

    const finderClient = createFinderDesktopClient(helper);
    const finderFileClient = createFinderFileClient(helper);
    const chromeClient = createChromeDesktopClient(helper);

    expect(finderClient.getFinderSelection).toBeDefined();
    expect(finderClient.getFinderItemLayout).toBeDefined();
    expect(finderClient.getDesktopSessionStatus).toBeDefined();
    await expect(finderClient.getDesktopSessionStatus!()).resolves.toBe(desktopSessionStatus);
    await expect(finderClient.getFinderSelection!()).resolves.toEqual({
      source: "finder-applescript",
      selection: []
    });
    await expect(finderClient.getFinderItemLayout!("/tmp/folder", ["photo.png"])).resolves.toEqual({
      source: "finder-applescript-layout",
      folderPath: "/tmp/folder",
      items: []
    });
    await expect(finderClient.executeAction(clickAction)).resolves.toEqual({ ok: true });
    const atomicMoveRequest = {
      sourcePath: "/tmp/source.txt",
      destinationPath: "/tmp/destination.txt",
      expectedSourceIdentity: {
        device: 1,
        inode: 2,
        size: 3,
        modifiedAtMs: 4,
        changedAtMs: 5
      }
    };
    await expect(finderFileClient.atomicMoveFileNoReplace(atomicMoveRequest))
      .resolves.toEqual({ state: "moved" });
    await expect(finderFileClient.atomicCopyFileNoReplace(atomicMoveRequest))
      .resolves.toEqual({ state: "copied" });
    await expect(chromeClient.executeAction(clickAction)).resolves.toEqual({ ok: true });
    expect(helper.getFinderItemLayout).toHaveBeenCalledWith("/tmp/folder", ["photo.png"]);
    expect(helper.atomicMoveFileNoReplace).toHaveBeenCalledWith(atomicMoveRequest);
    expect(helper.atomicCopyFileNoReplace).toHaveBeenCalledWith(atomicMoveRequest);
    expect(helper.executeAction).toHaveBeenCalledTimes(2);
  });
});
