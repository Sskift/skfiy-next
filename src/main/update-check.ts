/**
 * Update check — pure logic for the GitHub Releases feed.
 *
 * Everything here takes releases as data and returns decisions as data, so
 * the whole check pipeline is testable without network access. The IO layer
 * (fetch with etag caching, timeout, state pushes) lives in update-service.ts.
 */

import type { UpdateChannel } from "../shared/update.js";

export const GITHUB_RELEASES_API_BASE =
  "https://api.github.com/repos/Sskift/skfiy-next";

export const UPDATE_ASSET_PREFIX = "skfiy-";
export const UPDATE_SHASUMS_ASSET_NAME = "SHASUMS256.txt";

export type UpdateArch = "arm64" | "x64";

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GitHubRelease {
  tag_name: string;
  name: string;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
  html_url: string;
  body?: string | null;
  assets: GitHubReleaseAsset[];
}

export type UpdateEvaluation =
  | { kind: "not-available" }
  | {
      kind: "available";
      version: string;
      releaseNotes: string;
      releaseUrl: string;
      publishedAt: string;
      release: GitHubRelease;
    }
  | { kind: "skipped"; version: string };

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/**
 * Parse a semver string, tolerating a leading "v" (GitHub release tags are
 * "v1.2.3") and a missing patch/minor segment. Returns null for garbage.
 */
export function parseSemver(version: string): SemverParts | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim()
  );
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split(".")
  };
}

/**
 * Semver ordering including prerelease tags: 1.0.0-alpha < 1.0.0,
 * 1.0.0-alpha < 1.0.0-alpha.1, 1.0.0-alpha.1 < 1.0.0-alpha.beta,
 * numeric identifiers compare numerically and always sort before
 * alphanumeric ones. Unparseable versions sort as -1 (older than anything).
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    return left === right ? 0 : left ? 1 : -1;
  }
  if (left.major !== right.major) {
    return left.major < right.major ? -1 : 1;
  }
  if (left.minor !== right.minor) {
    return left.minor < right.minor ? -1 : 1;
  }
  if (left.patch !== right.patch) {
    return left.patch < right.patch ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(left: string[], right: string[]): number {
  // No prerelease ranks higher than any prerelease (1.0.0 > 1.0.0-alpha).
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = comparePrereleaseIdentifier(left[index], right[index]);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = Number(left);
    const rightValue = Number(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

/** Strip a leading "v" from a release tag ("v1.2.3" -> "1.2.3"). */
export function normalizeReleaseTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * Pick the release the channel should update from. Stable tracks the latest
 * full release (GitHub's /releases/latest feed); beta tracks the most
 * recently published release, prereleases included.
 */
export function selectReleaseForChannel(
  releases: GitHubRelease[],
  channel: UpdateChannel
): GitHubRelease | null {
  const published = releases
    .filter((release) => !release.draft)
    .slice()
    .sort(byPublishedAtDesc);
  if (channel === "beta") {
    return published[0] ?? null;
  }
  return published.find((release) => !release.prerelease) ?? null;
}

function byPublishedAtDesc(left: GitHubRelease, right: GitHubRelease): number {
  const leftTime = Date.parse(left.published_at);
  const rightTime = Date.parse(right.published_at);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return 0;
  }
  return rightTime - leftTime;
}

export function createUpdateAssetName(version: string, arch: UpdateArch): string {
  return `${UPDATE_ASSET_PREFIX}${version}-mac-${arch}.zip`;
}

export function selectUpdateAsset(
  assets: GitHubReleaseAsset[],
  version: string,
  arch: UpdateArch
): GitHubReleaseAsset | null {
  const expectedName = createUpdateAssetName(version, arch);
  return assets.find((asset) => asset.name === expectedName) ?? null;
}

export function selectShasumsAsset(assets: GitHubReleaseAsset[]): GitHubReleaseAsset | null {
  return assets.find((asset) => asset.name === UPDATE_SHASUMS_ASSET_NAME) ?? null;
}

/**
 * Parse a SHASUMS256.txt manifest ("<hex64>  <filename>" per line, as
 * emitted by `shasum -a 256`). Returns a filename -> hex digest map.
 */
export function parseShasums256(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+[* ]?(.+)$/.exec(line.trim());
    if (match) {
      result.set(match[2], match[1].toLowerCase());
    }
  }
  return result;
}

export function findChecksumForAsset(
  shasums: Map<string, string>,
  assetName: string
): string | null {
  return shasums.get(assetName) ?? shasums.get(pathBasename(assetName)) ?? null;
}

function pathBasename(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

export function createReleaseCheckRequest(channel: UpdateChannel): {
  url: string;
  listFeed: boolean;
} {
  if (channel === "beta") {
    return { url: `${GITHUB_RELEASES_API_BASE}/releases`, listFeed: true };
  }
  return { url: `${GITHUB_RELEASES_API_BASE}/releases/latest`, listFeed: false };
}

/**
 * Decide whether a release list contains an update for the current version.
 * Honors the user-dismissed skippedVersion. Pure: no IO, no state.
 */
export function evaluateUpdateCheck(input: {
  releases: GitHubRelease[];
  currentVersion: string;
  channel: UpdateChannel;
  skippedVersion?: string;
}): UpdateEvaluation {
  const release = selectReleaseForChannel(input.releases, input.channel);
  if (!release) {
    return { kind: "not-available" };
  }
  const version = normalizeReleaseTag(release.tag_name);
  if (!isNewerVersion(version, input.currentVersion)) {
    return { kind: "not-available" };
  }
  if (input.skippedVersion && input.skippedVersion === version) {
    return { kind: "skipped", version };
  }
  return {
    kind: "available",
    version,
    releaseNotes: readReleaseNotes(release),
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    release
  };
}

function readReleaseNotes(release: GitHubRelease): string {
  const body = release.body?.trim();
  return body && body.length > 0 ? body : release.name || release.tag_name;
}

/** Bound the release-notes excerpt the banner shows. */
export function excerptReleaseNotes(notes: string, maxLength = 280): string {
  const collapsed = notes.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength).trimEnd()}…`;
}
