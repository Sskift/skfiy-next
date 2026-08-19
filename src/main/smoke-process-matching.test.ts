import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("smoke process matching", () => {
  const modulePath = path.join(process.cwd(), "scripts", "skfiy-process-matching.mjs");

  it("matches real skfiy app bundle processes without matching runner command arguments", async () => {
    const { filterSkfiyAppProcessLines } = await import(pathToFileURL(modulePath).href) as {
      filterSkfiyAppProcessLines: (lines: string[]) => string[];
    };

    expect(filterSkfiyAppProcessLines([
      "80605 npm run dogfood:tester -- --app /repo/dist/skfiy.app --tester-id local",
      "80673 node scripts/smoke-ui-product.mjs --app /repo/dist/skfiy.app --output ui.json",
      "80749 /repo/dist/skfiy.app/Contents/MacOS/skfiy --remote-debugging-port=9310",
      "80750 /repo/dist/skfiy.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)"
    ])).toEqual([
      "80749 /repo/dist/skfiy.app/Contents/MacOS/skfiy --remote-debugging-port=9310",
      "80750 /repo/dist/skfiy.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)"
    ]);
  });

  it("matches only skfiy-owned Ghostty smoke sessions", async () => {
    const {
      filterSkfiyGhosttySessionProcessLines,
      parseProcessIds
    } = await import(pathToFileURL(modulePath).href) as {
      filterSkfiyGhosttySessionProcessLines: (lines: string[]) => string[];
      parseProcessIds: (lines: string[]) => number[];
    };
    const lines = [
      "24984 /Applications/Ghostty.app/Contents/MacOS/ghostty --title=skfiy-shell --shell-integration-features=no-title",
      "25020 /Applications/Ghostty.app/Contents/MacOS/ghostty --title=user-terminal",
      "25021 node scripts/smoke-ghostty-product.mjs --pattern /Applications/Ghostty.app/Contents/MacOS/ghostty --title=skfiy-shell",
      "25022 /Applications/Ghostty.app/Contents/MacOS/ghostty --shell-integration-features=no-title --title=skfiy-shell"
    ];

    const matches = filterSkfiyGhosttySessionProcessLines(lines);

    expect(matches).toEqual([
      lines[0],
      lines[3]
    ]);
    expect(parseProcessIds(matches)).toEqual([24984, 25022]);
  });

  it("keeps product smoke scripts off the broad dist/skfiy.app process pattern", () => {
    const productScripts = [
      "smoke-ui-product.mjs",
      "smoke-chrome-product.mjs"
    ];

    for (const scriptName of productScripts) {
      const source = readFileSync(path.join(process.cwd(), "scripts", scriptName), "utf8");
      expect(source).toContain("SKFIY_APP_PROCESS_PATTERN");
      expect(source).not.toContain("dist/skfiy.app|/skfiy.app/Contents/MacOS|Electron.*skfiy");
    }
  });
});
