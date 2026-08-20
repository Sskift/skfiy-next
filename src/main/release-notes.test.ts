import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE_PATH = path.join(process.cwd(), "scripts/generate-release-notes.mjs");
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

interface ReleaseCommit {
  sha: string;
  shortSha: string;
  subject: string;
}

interface ReleaseNotesModule {
  RELEASE_NOTE_SECTIONS: ReadonlyArray<{ heading: string; prefixes: string[] }>;
  DEFAULT_UPGRADE_NOTES: readonly string[];
  resolveTagRange: (input: {
    from?: string;
    to: string;
    rootDir?: string;
    io?: {
      execFile: (
        command: string,
        args: string[],
        options?: { cwd?: string }
      ) => Promise<{ stdout: string; stderr: string }>;
    };
  }) => Promise<{ from?: string; to: string; isFirstRelease: boolean }>;
  readCommitLog: (input: {
    from?: string;
    to: string;
    rootDir?: string;
    io?: {
      execFile: (
        command: string,
        args: string[],
        options?: { cwd?: string }
      ) => Promise<{ stdout: string; stderr: string }>;
    };
  }) => Promise<ReleaseCommit[]>;
  groupCommits: (commits: ReleaseCommit[]) => Array<{
    heading: string;
    commits: ReleaseCommit[];
  }>;
  createReleaseNotes: (input: {
    version: string;
    tagName: string;
    commitSha?: string;
    buildTimeIso?: string;
    electronVersion?: string;
    checksums?: string;
    commits: ReleaseCommit[];
    upgradeNotes?: readonly string[];
  }) => string;
  parseReleaseNotesArgs: (argv: string[]) => {
    to?: string;
    from?: string;
    buildInfoPath?: string;
    checksumsPath?: string;
    outputPath?: string;
    execute: boolean;
    help: boolean;
  };
}

async function loadModule(): Promise<ReleaseNotesModule> {
  return await import(pathToFileURL(MODULE_PATH).href) as ReleaseNotesModule;
}

function commit(sha: string, subject: string): ReleaseCommit {
  return { sha, shortSha: sha.slice(0, 7), subject };
}

describe("generate-release-notes.mjs groupCommits", () => {
  it("groups conventional commits into Features, Fixes, Refactors, Tests, Docs, Other", async () => {
    const { groupCommits } = await loadModule();
    const sections = groupCommits([
      commit("aaaaaaa1", "feat: add provenance gate"),
      commit("bbbbbbb2", "fix: stop relabeling"),
      commit("ccccccc3", "refactor: extract plan"),
      commit("ddddddd4", "test: cover fallback"),
      commit("eeeeeee5", "docs: write release process"),
      commit("fffffff6", "chore: bump deps"),
      commit("ggggggg7", "ci: pin runner"),
      commit("hhhhhhh8", "plain subject without prefix")
    ]);

    expect(sections.map((s) => s.heading)).toEqual([
      "Features",
      "Fixes",
      "Refactors",
      "Tests",
      "Docs",
      "Other"
    ]);
    expect(sections.find((s) => s.heading === "Features")?.commits).toHaveLength(1);
    expect(sections.find((s) => s.heading === "Other")?.commits).toHaveLength(3);
  });

  it("filters merge commits and version-bump commits", async () => {
    const { groupCommits } = await loadModule();
    const sections = groupCommits([
      commit("aaaaaaa1", "merge: integrate code health cleanup"),
      commit("bbbbbbb2", "Merge branch 'main' into feature"),
      commit("ccccccc3", "release: v0.1.0"),
      commit("ddddddd4", "chore(release): 0.1.0"),
      commit("eeeeeee5", "0.1.0"),
      commit("fffffff6", "version bump"),
      commit("ggggggg7", "feat: real change")
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe("Features");
    expect(sections[0]?.commits[0]?.subject).toBe("feat: real change");
  });

  it("omits empty sections and keeps deterministic order", async () => {
    const { groupCommits } = await loadModule();
    const sections = groupCommits([
      commit("aaaaaaa1", "docs: only docs"),
      commit("bbbbbbb2", "fix: and a fix")
    ]);

    expect(sections.map((s) => s.heading)).toEqual(["Fixes", "Docs"]);
  });
});

describe("generate-release-notes.mjs createReleaseNotes", () => {
  const commits = [
    commit("aaaaaaa100000000000000000000000000000000", "feat: add provenance gate"),
    commit("bbbbbbb200000000000000000000000000000000", "fix: stop relabeling"),
    commit("ccccccc300000000000000000000000000000000", "docs: write release process")
  ];

  it("renders title, grouped sections, upgrade notes, provenance footer, and install steps", async () => {
    const { createReleaseNotes } = await loadModule();
    const notes = createReleaseNotes({
      version: "0.1.0",
      tagName: "v0.1.0",
      commitSha: COMMIT_SHA,
      buildTimeIso: "2026-08-20T12:00:00.000Z",
      electronVersion: "43.4.1",
      checksums: `${"a".repeat(64)}  skfiy-macos-0.1.0.zip\n`,
      commits
    });

    expect(notes.startsWith("# skfiy 0.1.0\n")).toBe(true);
    expect(notes).toContain("## Features");
    expect(notes).toContain("- `aaaaaaa` feat: add provenance gate");
    expect(notes).toContain("## Fixes");
    expect(notes).toContain("## Docs");
    expect(notes).toContain("## Upgrade notes");
    expect(notes).toContain("com.sskift.skfiy");
    expect(notes).toContain("## Build provenance");
    expect(notes).toContain(`https://github.com/Sskift/skfiy-next/commit/${COMMIT_SHA}`);
    expect(notes).toContain("2026-08-20T12:00:00.000Z");
    expect(notes).toContain("Electron: 43.4.1");
    expect(notes).toContain(`SHA256 (skfiy-macos-0.1.0.zip): \`${"a".repeat(64)}\``);
    expect(notes).toContain("## Install");
    expect(notes).toContain("skfiy-macos-0.1.0.zip");
  });

  it("is deterministic for the same inputs", async () => {
    const { createReleaseNotes } = await loadModule();
    const input = {
      version: "0.1.0",
      tagName: "v0.1.0",
      commitSha: COMMIT_SHA,
      buildTimeIso: "2026-08-20T12:00:00.000Z",
      checksums: `${"b".repeat(64)}  skfiy-macos-0.1.0.zip\n`,
      commits
    };
    expect(createReleaseNotes(input)).toBe(createReleaseNotes({ ...input }));
  });

  it("accepts custom upgrade notes and omits optional footer fields", async () => {
    const { createReleaseNotes } = await loadModule();
    const notes = createReleaseNotes({
      version: "0.1.0",
      tagName: "v0.1.0",
      commits,
      upgradeNotes: ["Custom upgrade note."]
    });

    expect(notes).toContain("- Custom upgrade note.");
    expect(notes).not.toContain("com.sskift.skfiy");
    expect(notes).not.toContain("Commit:");
    expect(notes).not.toContain("SHA256");
  });
});

describe("generate-release-notes.mjs resolveTagRange and readCommitLog", () => {
  it("uses the explicit --from without invoking git describe", async () => {
    const { resolveTagRange } = await loadModule();
    let described = false;
    const range = await resolveTagRange({
      from: "v0.0.9",
      to: "v0.1.0",
      io: {
        execFile: async () => {
          described = true;
          return { stdout: "v0.0.5\n", stderr: "" };
        }
      }
    });

    expect(range).toEqual({ from: "v0.0.9", to: "v0.1.0", isFirstRelease: false });
    expect(described).toBe(false);
  });

  it("resolves the previous tag via git describe", async () => {
    const { resolveTagRange } = await loadModule();
    const range = await resolveTagRange({
      to: "v0.1.0",
      io: {
        execFile: async (command, args) => {
          expect(command).toBe("git");
          expect(args).toEqual(["describe", "--tags", "--abbrev=0", "v0.1.0^"]);
          return { stdout: "v0.0.9\n", stderr: "" };
        }
      }
    });

    expect(range.from).toBe("v0.0.9");
    expect(range.isFirstRelease).toBe(false);
  });

  it("falls back to the full commit list for the first release", async () => {
    const { resolveTagRange } = await loadModule();
    const range = await resolveTagRange({
      to: "v0.1.0",
      io: {
        execFile: async () => {
          throw new Error("fatal: No tags can describe");
        }
      }
    });

    expect(range.from).toBeUndefined();
    expect(range.isFirstRelease).toBe(true);
  });

  it("parses git log lines into commits with short SHAs", async () => {
    const { readCommitLog } = await loadModule();
    const commits = await readCommitLog({
      from: "v0.0.9",
      to: "v0.1.0",
      io: {
        execFile: async (command, args) => {
          expect(args[0]).toBe("log");
          expect(args).toContain("v0.0.9..v0.1.0");
          return {
            stdout: [
              `${COMMIT_SHA}\tfeat: add provenance gate`,
              `bbbbbbb200000000000000000000000000000000\tfix: stop relabeling`
            ].join("\n"),
            stderr: ""
          };
        }
      }
    });

    expect(commits).toEqual([
      { sha: COMMIT_SHA, shortSha: COMMIT_SHA.slice(0, 7), subject: "feat: add provenance gate" },
      {
        sha: "bbbbbbb200000000000000000000000000000000",
        shortSha: "bbbbbbb",
        subject: "fix: stop relabeling"
      }
    ]);
  });

  it("parses CLI args", async () => {
    const { parseReleaseNotesArgs } = await loadModule();
    expect(
      parseReleaseNotesArgs([
        "--to",
        "v0.1.0",
        "--from",
        "v0.0.9",
        "--build-info",
        "/tmp/build-info.json",
        "--checksums",
        "/tmp/SHA256SUMS",
        "--output",
        "/tmp/notes.md",
        "--execute"
      ])
    ).toMatchObject({
      to: "v0.1.0",
      from: "v0.0.9",
      buildInfoPath: path.resolve("/tmp/build-info.json"),
      checksumsPath: path.resolve("/tmp/SHA256SUMS"),
      outputPath: path.resolve("/tmp/notes.md"),
      execute: true,
      help: false
    });
    expect(parseReleaseNotesArgs(["--help"]).help).toBe(true);
    expect(() => parseReleaseNotesArgs(["--bogus"])).toThrow("Unknown release-notes option: --bogus");
  });
});
