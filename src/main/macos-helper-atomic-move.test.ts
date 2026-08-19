import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const helperSource = readFileSync(path.join(
  process.cwd(),
  "macos-helper",
  "Sources",
  "skfiy-helper",
  "main.swift"
), "utf8");

function readFunctionSource(name: string, nextName: string): string {
  const start = helperSource.indexOf(`func ${name}`);
  const end = helperSource.indexOf(`func ${nextName}`, start + 1);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return helperSource.slice(start, end);
}

describe("macOS helper atomic no-replace move", () => {
  it("exposes one narrow typed command outside the generic desktop action surface", () => {
    expect(helperSource).toContain('"atomic-move-no-replace"');
    expect(helperSource).toContain('case "atomic-move-no-replace":');
    expect(helperSource).toContain(
      "succeed(command: commandName, data: try handleAtomicMoveNoReplace(arguments))"
    );
    expect(helperSource).toContain("struct AtomicMoveNoReplacePayload: Encodable");
  });

  it("uses the macOS exclusive rename primitive and rechecks the approved identity", () => {
    const source = readFunctionSource(
      "handleAtomicMoveNoReplace",
      "handleOpenPermissionSettings"
    );

    expect(source).toContain("readDirectRegularFileIdentity");
    expect(source).toContain("expectedIdentity");
    expect(source).toContain("renamex_np");
    expect(source).toContain("RENAME_EXCL");
    expect(source).toContain('state: "destination-exists"');
    expect(source).toContain('state: "cross-device"');
    expect(source).toContain('state: "source-changed"');
    expect(source).toContain('state: "rollback-incomplete"');
    expect(source).not.toContain("FileManager.default.moveItem");
  });

  it("binds direct regular files with lstat rather than following symlinks", () => {
    const source = readFunctionSource(
      "readDirectRegularFileIdentity",
      "performExclusiveRename"
    );

    expect(source).toContain("lstat");
    expect(source).toContain("S_IFMT");
    expect(source).toContain("S_IFREG");
    expect(source).toContain("st_dev");
    expect(source).toContain("st_ino");
    expect(source).toContain("st_size");
    expect(source).toContain("st_mtimespec");
    expect(source).toContain("st_ctimespec");
  });
});

describe("macOS helper atomic no-replace copy", () => {
  it("copies through an owned temporary file and publishes with exclusive rename", () => {
    expect(helperSource).toContain('"atomic-copy-no-replace"');
    expect(helperSource).toContain('case "atomic-copy-no-replace":');
    expect(helperSource).toContain(
      "succeed(command: commandName, data: try handleAtomicCopyNoReplace(arguments))"
    );
    expect(helperSource).toContain("struct AtomicCopyNoReplacePayload: Encodable");

    const source = readFunctionSource(
      "handleAtomicCopyNoReplace",
      "handleAtomicMoveNoReplace"
    );
    expect(source).toContain("FileManager.default.copyItem");
    expect(source).toContain("readDirectRegularFileIdentity");
    expect(source).toContain("renamex_np");
    expect(source).toContain("RENAME_EXCL");
    expect(source).toContain('state: "destination-exists"');
    expect(source).toContain('state: "source-changed"');
    expect(source).toContain('state: "cleanup-incomplete"');
  });
});
