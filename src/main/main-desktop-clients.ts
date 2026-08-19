import type { DesktopHelperClient } from "./computer-use/desktop-helper.js";
import type {
  DesktopActionResult
} from "./computer-use/types.js";
import type { ChromeDesktopClient } from "./orchestrator/chrome-task.js";
import type { FinderDesktopClient } from "./orchestrator/finder-task.js";
import type { DesktopClient } from "./orchestrator/ghostty-task.js";

export function createGhosttyDesktopClient(helper: DesktopHelperClient): DesktopClient {
  return {
    getPermissions: async () => helper.getPermissions(),
    listApps: async () => helper.listApps(),
    ocrImage: async (inputPath) => helper.ocrImage(inputPath),
    executeAction: async (action) => {
      const result = await helper.executeAction(action);
      assertDesktopActionResult(result, action.type);
      return result;
    }
  };
}

export function createFinderDesktopClient(helper: DesktopHelperClient): FinderDesktopClient {
  return {
    executeAction: async (action) => helper.executeAction(action),
    getFinderSelection: async () => helper.getFinderSelection(),
    getFinderItemLayout: async (folderPath, itemNames) =>
      helper.getFinderItemLayout(folderPath, itemNames)
  };
}

export function createChromeDesktopClient(helper: DesktopHelperClient): ChromeDesktopClient {
  return {
    executeAction: async (action) => helper.executeAction(action)
  };
}

export function assertDesktopActionResult(result: DesktopActionResult, label: string): void {
  if ("ok" in result && !result.ok) {
    throw new Error(result.message ?? `Desktop helper could not ${label}.`);
  }
}
