import { describe, expect, it } from "vitest";
import {
  MAX_TESTED_EXTENSION_VERSION,
  MIN_COMPATIBLE_EXTENSION_VERSION,
  compareChromeExtensionVersions,
  evaluateChromeExtensionCompatibility,
  parseChromeExtensionVersion
} from "./chrome-extension-compatibility";

describe("parseChromeExtensionVersion", () => {
  it("parses 2, 3, and 4 component versions", () => {
    expect(parseChromeExtensionVersion("0.0")).toEqual([0, 0]);
    expect(parseChromeExtensionVersion("0.0.16")).toEqual([0, 0, 16]);
    expect(parseChromeExtensionVersion("0.0.17.1")).toEqual([0, 0, 17, 1]);
  });

  it("accepts a leading v and surrounding whitespace", () => {
    expect(parseChromeExtensionVersion("v0.0.16")).toEqual([0, 0, 16]);
    expect(parseChromeExtensionVersion("  0.0.17  ")).toEqual([0, 0, 17]);
  });

  it("accepts prerelease and build suffixes", () => {
    expect(parseChromeExtensionVersion("0.0.17-beta.1")).toEqual([0, 0, 17]);
    expect(parseChromeExtensionVersion("0.0.17+build.42")).toEqual([0, 0, 17]);
  });

  it("rejects garbage input", () => {
    expect(parseChromeExtensionVersion("")).toBeNull();
    expect(parseChromeExtensionVersion("latest")).toBeNull();
    expect(parseChromeExtensionVersion("0.0.0.0.0")).toBeNull();
    expect(parseChromeExtensionVersion("v0")).toBeNull();
    expect(parseChromeExtensionVersion("0.0.x")).toBeNull();
    expect(parseChromeExtensionVersion("not-a-version")).toBeNull();
  });
});

describe("compareChromeExtensionVersions", () => {
  it("orders versions component-wise", () => {
    expect(compareChromeExtensionVersions("0.0.16", "0.0.17")).toBe(-1);
    expect(compareChromeExtensionVersions("0.0.17", "0.0.16")).toBe(1);
    expect(compareChromeExtensionVersions("0.0.16", "0.0.16")).toBe(0);
    expect(compareChromeExtensionVersions("0.1.0", "0.0.99")).toBe(1);
  });

  it("treats missing trailing components as zero", () => {
    expect(compareChromeExtensionVersions("0.1", "0.1.0")).toBe(0);
    expect(compareChromeExtensionVersions("0.0", "0.0.16")).toBe(-1);
  });

  it("returns null when either side is unparsable", () => {
    expect(compareChromeExtensionVersions("garbage", "0.0.16")).toBeNull();
    expect(compareChromeExtensionVersions("0.0.16", "garbage")).toBeNull();
  });
});

describe("evaluateChromeExtensionCompatibility", () => {
  it("reports compatible for versions inside the supported range", () => {
    const verdict = evaluateChromeExtensionCompatibility({
      appVersion: "0.1.0",
      extensionVersion: MIN_COMPATIBLE_EXTENSION_VERSION
    });

    expect(verdict.state).toBe("compatible");
    expect(verdict.extensionVersion).toBe(MIN_COMPATIBLE_EXTENSION_VERSION);
    expect(verdict.appVersion).toBe("0.1.0");
    expect(verdict.minVersion).toBe(MIN_COMPATIBLE_EXTENSION_VERSION);
    expect(verdict.maxTestedVersion).toBe(MAX_TESTED_EXTENSION_VERSION);
  });

  it("reports extension_outdated below the minimum", () => {
    const verdict = evaluateChromeExtensionCompatibility({
      appVersion: "0.1.0",
      extensionVersion: "0.0.15"
    });

    expect(verdict.state).toBe("extension_outdated");
    expect(verdict.reason).toContain("older than the minimum supported");
    expect(verdict.nextAction).toContain("Reload the unpacked extension");
  });

  it("reports extension_untested above the max tested version", () => {
    const verdict = evaluateChromeExtensionCompatibility({
      appVersion: "0.1.0",
      extensionVersion: "9.9.9"
    });

    expect(verdict.state).toBe("extension_untested");
    expect(verdict.reason).toContain("newer than the newest tested");
  });

  it("reports unknown when the extension version is missing", () => {
    const verdict = evaluateChromeExtensionCompatibility({
      appVersion: "0.1.0"
    });

    expect(verdict.state).toBe("unknown");
    expect(verdict.extensionVersion).toBeNull();
    expect(verdict.reason).toContain("has not been reported");
  });

  it("reports unknown when the extension version is garbage", () => {
    const verdict = evaluateChromeExtensionCompatibility({
      appVersion: "0.1.0",
      extensionVersion: "banana"
    });

    expect(verdict.state).toBe("unknown");
    expect(verdict.reason).toContain("not a valid version");
  });

  it("normalizes blank app versions to null", () => {
    const verdict = evaluateChromeExtensionCompatibility({
      appVersion: "   ",
      extensionVersion: "0.0.16"
    });

    expect(verdict.appVersion).toBeNull();
    expect(verdict.state).toBe("compatible");
  });

  it("supports custom release-declared bounds", () => {
    const verdict = evaluateChromeExtensionCompatibility({
      appVersion: "0.1.0",
      extensionVersion: "0.0.17",
      minVersion: "0.0.17",
      maxTestedVersion: "0.0.17"
    });

    expect(verdict.state).toBe("compatible");
    expect(verdict.minVersion).toBe("0.0.17");
  });

  it("keeps the version verdict independent of the hard schema gate", () => {
    // The schema gate lives in chrome-native-host.ts; a schema mismatch must
    // not change the version verdict and vice versa.
    const verdict = evaluateChromeExtensionCompatibility({
      appVersion: "0.1.0",
      extensionVersion: "0.0.16"
    });

    expect(verdict.state).toBe("compatible");
    expect(verdict).not.toHaveProperty("schemaVersion");
  });
});
