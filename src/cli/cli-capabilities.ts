/**
 * CLI Capabilities — adapter capability discovery.
 *
 * A READ-ONLY PROJECTION of the AdapterRegistry. It exposes only static
 * declarative contract fields — never the mutation surface. The hidden
 * mutation primitives (`run`, `parseInput`, `readRisk`,
 * `readRequiredPermissions`, `matchesRoute`, `targetIdentity`) are never
 * reachable from this projection.
 */

import { createDefaultAdapterRegistry } from "../main/adapter/create-default-adapter-registry.js";
import type {
  AdapterBlockerStage,
  AdapterCapability,
  AdapterVerificationStrategy,
  AnyAdapterContract
} from "../shared/adapter-contract.js";
import type { SupportedAdapterId } from "../shared/adapter-contract.js";
import { createCliError, type CliError } from "./cli-contract.js";

export const ADAPTER_CAPABILITIES_SCHEMA_VERSION = 1;

export interface AdapterSmokeSummary {
  readonly npmScript: string;
  readonly productPath: string;
}

export interface AdapterCapabilityDto {
  readonly id: SupportedAdapterId;
  readonly displayName: string;
  readonly capabilities: readonly AdapterCapability[];
  readonly approvalPolicy: { readonly gates: readonly string[] };
  readonly planSchema: { readonly schemaVersion: number };
  readonly verificationStrategy: AdapterVerificationStrategy;
  readonly stopBehavior: { readonly supportsAbortSignal: boolean };
  readonly blockerStages: readonly AdapterBlockerStage[];
  readonly smoke?: AdapterSmokeSummary;
}

export interface AdapterCapabilitiesResult {
  readonly schemaVersion: typeof ADAPTER_CAPABILITIES_SCHEMA_VERSION;
  readonly adapters: readonly AdapterCapabilityDto[];
}

/**
 * The contract keys that MUST NOT appear in the discovery DTO. Asserted by
 * tests so the projection can never leak the hidden mutation primitives.
 */
export const ADAPTER_CAPABILITY_WITHHELD_KEYS = [
  "run",
  "parseInput",
  "readRisk",
  "readRequiredPermissions",
  "matchesRoute",
  "targetIdentity"
] as const;

export function projectAdapterCapabilities(
  adapter: AnyAdapterContract
): AdapterCapabilityDto {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    capabilities: [...adapter.capabilities],
    approvalPolicy: { gates: [...adapter.approvalPolicy.gates] },
    planSchema: { schemaVersion: adapter.planSchema.schemaVersion },
    verificationStrategy: adapter.verificationStrategy,
    stopBehavior: { supportsAbortSignal: adapter.stopBehavior.supportsAbortSignal },
    blockerStages: [...adapter.blockerStages],
    ...(adapter.smoke
      ? {
          smoke: {
            npmScript: adapter.smoke.npmScript,
            productPath: adapter.smoke.productPath
          }
        }
      : {})
  };
}

export function runCapabilitiesCommand(options: {
  adapterId?: string;
}):
  | { ok: true; data: AdapterCapabilitiesResult }
  | { ok: false; error: CliError } {
  const registry = createDefaultAdapterRegistry();

  if (options.adapterId !== undefined) {
    const adapter = registry.get(options.adapterId as SupportedAdapterId);
    if (!adapter) {
      return {
        ok: false,
        error: createCliError({
          code: "adapter-not-found",
          message: `Unknown adapter: ${options.adapterId}`,
          action: "Run `skfiy capabilities` to list the supported adapter ids."
        })
      };
    }
    return {
      ok: true,
      data: {
        schemaVersion: ADAPTER_CAPABILITIES_SCHEMA_VERSION,
        adapters: [projectAdapterCapabilities(adapter)]
      }
    };
  }

  return {
    ok: true,
    data: {
      schemaVersion: ADAPTER_CAPABILITIES_SCHEMA_VERSION,
      adapters: registry.list().map(projectAdapterCapabilities)
    }
  };
}
