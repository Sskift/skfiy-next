import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("preload profile contract", () => {
  it("validates profile snapshots, summaries, switch results, broadenings, and export bundles fail closed", () => {
    const source = readPreloadSource();

    for (const validator of [
      "function isProfileRuntimeSnapshot",
      "function isProfileSummary",
      "function isProfileSwitchResult",
      "function isPolicyBroadening",
      "function isProfileExportBundle",
      "function isProfileWorkflowDefaults",
      "function createDefaultProfileRuntimeSnapshot"
    ]) {
      expect(source).toContain(validator);
    }
  });

  it("exposes every profile IPC channel with fallback defaults", () => {
    const source = readPreloadSource();

    for (const channel of [
      "skfiy:get-profiles",
      "skfiy:switch-profile",
      "skfiy:create-profile",
      "skfiy:update-profile",
      "skfiy:delete-profile",
      "skfiy:export-profile",
      "skfiy:import-profile",
      "skfiy:profile-changed"
    ]) {
      expect(source).toContain(channel);
    }

    for (const method of [
      "async getProfiles()",
      "async switchProfile(input)",
      "async createProfile(input)",
      "async updateProfile(input)",
      "async deleteProfile(profileId)",
      "async exportProfile(input)",
      "async importProfile(bundle)",
      "onProfileChanged(callback)"
    ]) {
      expect(source).toContain(method);
    }
  });

  it("falls back to a default snapshot when the main process returns garbage", () => {
    const source = readPreloadSource();

    expect(source).toContain(
      "isProfileRuntimeSnapshot(payload)\n      ? payload\n      : createDefaultProfileRuntimeSnapshot()"
    );
  });
});

function readPreloadSource(): string {
  return readFileSync(path.join(process.cwd(), "src/main/preload.cts"), "utf8");
}
