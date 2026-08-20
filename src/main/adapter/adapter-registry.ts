import type {
  AdapterContract,
  AnyAdapterContract,
  SupportedAdapterId
} from "../../shared/adapter-contract.js";

export interface AdapterRegistry {
  register(adapter: AnyAdapterContract): void;
  get(id: SupportedAdapterId): AnyAdapterContract | undefined;
  list(): readonly AnyAdapterContract[];
  disable(id: SupportedAdapterId): void;
  enable(id: SupportedAdapterId): void;
  isEnabled(id: SupportedAdapterId): boolean;
  /**
   * Consult each enabled adapter's `matchesRoute` in priority (registration)
   * order. Returns the first matching adapter id, or `undefined` when no
   * adapter claims the input — callers then fall through to generic
   * desktop/chat logic.
   */
  selectRoute(input: string): SupportedAdapterId | undefined;
}

export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<SupportedAdapterId, AnyAdapterContract>();
  const disabled = new Set<SupportedAdapterId>();

  return {
    register(adapter: AnyAdapterContract): void {
      adapters.set(adapter.id, adapter);
    },

    get(id: SupportedAdapterId): AnyAdapterContract | undefined {
      return adapters.get(id);
    },

    list(): readonly AnyAdapterContract[] {
      return Array.from(adapters.values());
    },

    disable(id: SupportedAdapterId): void {
      disabled.add(id);
    },

    enable(id: SupportedAdapterId): void {
      disabled.delete(id);
    },

    isEnabled(id: SupportedAdapterId): boolean {
      return adapters.has(id) && !disabled.has(id);
    },

    selectRoute(input: string): SupportedAdapterId | undefined {
      for (const adapter of adapters.values()) {
        if (disabled.has(adapter.id)) {
          continue;
        }
        if (adapter.matchesRoute(input)) {
          return adapter.id;
        }
      }
      return undefined;
    }
  };
}

// Re-export the contract type for convenience.
export type { AdapterContract };
