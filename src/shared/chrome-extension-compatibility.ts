/**
 * Chrome Extension Compatibility — shared contract.
 *
 * Two-layer compatibility model:
 *
 * 1. HARD GATE (already enforced in chrome-native-host.ts): the native
 *    messaging schema version is checked on every bridge message and fails
 *    closed with "unsupported_schema_version".
 *
 * 2. WARNING LAYER (this module): release-declared minimum/maximum-tested
 *    extension versions are compared against the running extension version
 *    so stale or untested builds surface as non-blocking warnings in the
 *    renderer, the first-run readiness snapshot, the extension popup, and
 *    the diagnostic report.
 *
 * Zero runtime dependencies — the dotted-version parser is hand-rolled to
 * match parseVersionOutput in diagnostic-report.ts.
 */

/**
 * Minimum extension version compatible with this app build. Bumped per
 * release when the native bridge contract changes.
 */
export const MIN_COMPATIBLE_EXTENSION_VERSION = "0.0.16";

/**
 * Newest extension version this app build has been tested against. Bumped
 * per release alongside chrome-extension/manifest.json.
 */
export const MAX_TESTED_EXTENSION_VERSION = "0.0.17";

export type ChromeExtensionCompatibilityState =
  | "compatible"
  | "extension_outdated"
  | "extension_untested"
  | "unknown";

export interface ChromeExtensionCompatibilityVerdict {
  state: ChromeExtensionCompatibilityState;
  appVersion: string | null;
  extensionVersion: string | null;
  minVersion: string;
  maxTestedVersion: string;
  reason?: string;
  nextAction?: string;
}

/**
 * Aggregated Chrome compatibility health record. This is the contract
 * between the main process (which produces it via
 * readChromeCompatibilityHealth), the preload bridge, and the renderer.
 * Every sub-read is fail-closed, so the record is always complete.
 */
export interface ChromeCompatibilityHealth {
  schemaVersion: 1;
  generatedAt: string;
  appVersion: string;
  nativeHost: {
    state: "installed" | "missing" | "mismatched" | "cli-missing" | "invalid" | "unknown";
    installedSkfiyVersion: string | null;
    reason: string;
  };
  extension: {
    state: "connected" | "on-disk" | "unknown";
    version: string | null;
    source: string;
  };
  compatibility: ChromeExtensionCompatibilityVerdict;
  staleness: {
    nativeHostStale: boolean;
    extensionStale: boolean;
    cliStale: boolean;
    helperStale: boolean;
  };
}

const VERSION_PATTERN = /^\d+(\.\d+){1,3}([-+][0-9A-Za-z.-]+)?$/;

/**
 * Parse a dotted version string ("0.0.16", "v0.0.17.1") into its numeric
 * components. Returns null for anything that is not a 2–4 component dotted
 * version. Prerelease/build suffixes are accepted but stripped before
 * comparison, matching Chrome's manifest version tolerance.
 */
export function parseChromeExtensionVersion(value: string): number[] | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/^v/i, "");
  if (!VERSION_PATTERN.test(trimmed)) {
    return null;
  }

  const core = trimmed.split(/[-+]/, 1)[0];
  const components = core.split(".").map((part) => Number.parseInt(part, 10));

  if (components.some((part) => !Number.isFinite(part))) {
    return null;
  }

  return components;
}

/**
 * Compare two dotted versions. Missing trailing components are treated as 0,
 * so "0.1" === "0.1.0" and "0.0.16" < "0.0.17". Returns null when either
 * side cannot be parsed.
 */
export function compareChromeExtensionVersions(
  left: string,
  right: string
): -1 | 0 | 1 | null {
  const leftComponents = parseChromeExtensionVersion(left);
  const rightComponents = parseChromeExtensionVersion(right);

  if (!leftComponents || !rightComponents) {
    return null;
  }

  const length = Math.max(leftComponents.length, rightComponents.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftComponents[index] ?? 0;
    const rightPart = rightComponents[index] ?? 0;
    if (leftPart < rightPart) {
      return -1;
    }
    if (leftPart > rightPart) {
      return 1;
    }
  }

  return 0;
}

export function evaluateChromeExtensionCompatibility({
  appVersion,
  extensionVersion,
  minVersion = MIN_COMPATIBLE_EXTENSION_VERSION,
  maxTestedVersion = MAX_TESTED_EXTENSION_VERSION
}: {
  appVersion?: string | null;
  extensionVersion?: string | null;
  minVersion?: string;
  maxTestedVersion?: string;
}): ChromeExtensionCompatibilityVerdict {
  const normalizedAppVersion = typeof appVersion === "string" && appVersion.trim()
    ? appVersion.trim()
    : null;
  const normalizedExtensionVersion = typeof extensionVersion === "string" && extensionVersion.trim()
    ? extensionVersion.trim()
    : null;

  const base = {
    appVersion: normalizedAppVersion,
    extensionVersion: normalizedExtensionVersion,
    minVersion,
    maxTestedVersion
  };

  if (!normalizedExtensionVersion) {
    return {
      ...base,
      state: "unknown",
      reason: "Chrome extension version has not been reported.",
      nextAction: "Reload the unpacked extension from chrome-extension/ to update."
    };
  }

  if (!parseChromeExtensionVersion(normalizedExtensionVersion)) {
    return {
      ...base,
      state: "unknown",
      reason: `Chrome extension version "${normalizedExtensionVersion}" is not a valid version.`,
      nextAction: "Reload the unpacked extension from chrome-extension/ to update."
    };
  }

  const belowMinimum = compareChromeExtensionVersions(
    normalizedExtensionVersion,
    minVersion
  );
  if (belowMinimum === -1 || belowMinimum === null) {
    return {
      ...base,
      state: "extension_outdated",
      reason: `Chrome extension v${normalizedExtensionVersion} is older than the minimum supported v${minVersion}.`,
      nextAction: "Reload the unpacked extension from chrome-extension/ to update."
    };
  }

  const aboveTested = compareChromeExtensionVersions(
    normalizedExtensionVersion,
    maxTestedVersion
  );
  if (aboveTested === 1) {
    return {
      ...base,
      state: "extension_untested",
      reason: `Chrome extension v${normalizedExtensionVersion} is newer than the newest tested v${maxTestedVersion}.`,
      nextAction: "Update skfiy to a release tested against this extension version."
    };
  }

  return {
    ...base,
    state: "compatible",
    reason: `Chrome extension v${normalizedExtensionVersion} is compatible with this skfiy build.`
  };
}
