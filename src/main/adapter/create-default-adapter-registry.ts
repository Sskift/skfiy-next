import type { AdapterRegistry } from "./adapter-registry.js";
import { createAdapterRegistry } from "./adapter-registry.js";
import { createChromeAdapter } from "./chrome-adapter.js";
import { createFinderAdapter } from "./finder-adapter.js";
import { createGhosttyAdapter } from "./ghostty-adapter.js";
import { createTmuxSupervisionAdapter } from "./tmux-supervision-adapter.js";

/**
 * Build the default adapter registry with the four shipped adapters.
 *
 * Registration order is the route-selection priority order and matches the
 * historical `selectBaseCommandRoute` chain: tmux supervision is checked
 * first (its money-run marker is unambiguous), then Chrome, then Finder, and
 * finally Ghostty (whose explicit-terminal check must run after the more
 * specific parsers).
 */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  const registry = createAdapterRegistry();

  registry.register(createTmuxSupervisionAdapter());
  registry.register(createChromeAdapter());
  registry.register(createFinderAdapter());
  registry.register(createGhosttyAdapter());

  return registry;
}
