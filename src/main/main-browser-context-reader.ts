import {
  createBrowserPageContextFromConnection,
  type BrowserPageContext
} from "./browser-page-context.js";
import type { ChromeExtensionConnectionStatus } from "./chrome-native-host.js";

export type ReadChromeExtensionConnectionStatus = (input: {
  homeDir: string;
}) => Promise<ChromeExtensionConnectionStatus>;

export async function readLatestBrowserPageContext({
  homeDir,
  readConnectionStatus
}: {
  homeDir: string;
  readConnectionStatus: ReadChromeExtensionConnectionStatus;
}): Promise<BrowserPageContext> {
  try {
    const connection = await readConnectionStatus({ homeDir });
    return createBrowserPageContextFromConnection(connection);
  } catch (error) {
    return createBrowserPageContextReadFailure(error);
  }
}

export function createBrowserPageContextReadFailure(error: unknown): BrowserPageContext {
  return createBrowserPageContextFromConnection({
    state: "unavailable",
    reason: error instanceof Error
      ? error.message
      : "Chrome extension diagnostics could not be read."
  });
}
