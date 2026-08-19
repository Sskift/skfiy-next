import { describe, expect, it } from "vitest";
import {
  createDesktopAppCapabilityModel,
  getBlockedDesktopAppCapabilities
} from "./app-capabilities";

describe("createDesktopAppCapabilityModel", () => {
  it("marks generic app control capabilities ready when desktop and TCC gates are ready", () => {
    expect(createDesktopAppCapabilityModel({
      bundleId: "com.apple.finder",
      name: "Finder",
      permissions: {
        screenRecording: { state: "granted" },
        accessibility: { state: "granted" },
      },
      desktopSession: {
        controllable: true,
        frontmostBundleId: "com.apple.finder",
        frontmostLocalizedName: "Finder"
      }
    })).toEqual({
      target: {
        bundleId: "com.apple.finder",
        name: "Finder",
        pid: undefined
      },
      status: "ready",
      capabilities: [
        { id: "observe_screenshot", status: "ready", blockers: [] },
        { id: "observe_accessibility", status: "ready", blockers: [] },
        { id: "activate_app", status: "ready", blockers: [] },
        { id: "pointer_input", status: "ready", blockers: [] },
        { id: "keyboard_input", status: "ready", blockers: [] }
      ]
    });
  });

  it("separates screenshot and Accessibility dependent blockers", () => {
    const model = createDesktopAppCapabilityModel({
      bundleId: "com.apple.TextEdit",
      permissions: {
        screenRecording: { state: "granted" },
        accessibility: { state: "denied" },
      },
      desktopSession: {
        controllable: true
      }
    });

    expect(model.status).toBe("blocked");
    expect(model.capabilities.find((capability) => capability.id === "observe_screenshot"))
      .toEqual({ id: "observe_screenshot", status: "ready", blockers: [] });
    expect(getBlockedDesktopAppCapabilities(model).map((capability) => capability.id)).toEqual([
      "observe_accessibility",
      "activate_app",
      "pointer_input",
      "keyboard_input"
    ]);
  });

  it("blocks every capability when loginwindow or display sleep owns the desktop", () => {
    const model = createDesktopAppCapabilityModel({
      bundleId: "com.mitchellh.ghostty",
      permissions: {
        screenRecording: { state: "granted" },
        accessibility: { state: "granted" },
      },
      desktopSession: {
        controllable: false,
        frontmostBundleId: "com.apple.loginwindow",
        frontmostProcessIdentifier: 591,
        mainDisplayAsleep: true
      }
    });

    expect(model.status).toBe("blocked");
    expect(model.capabilities).toHaveLength(5);
    expect(model.capabilities.every((capability) => capability.status === "blocked")).toBe(true);
    expect(model.capabilities[0].blockers).toEqual([
      {
        type: "desktop_session",
        reason: "display_asleep",
        message: "Main display is asleep. Wake and unlock the Mac, then retry."
      }
    ]);
  });
});
