import { useBrowserContextSource } from "./app-browser-context-state";
import type { DesktopApi } from "./app-types";

export function useBrowserContextState(api: DesktopApi) {
  const browserContextSource = useBrowserContextSource(api);
  return { browserContextSource };
}
