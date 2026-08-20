import { describe, expect, it } from "vitest";
import {
  ADAPTER_CAPABILITY_WITHHELD_KEYS,
  projectAdapterCapabilities,
  runCapabilitiesCommand
} from "./cli-capabilities.js";
import { createDefaultAdapterRegistry } from "../main/adapter/create-default-adapter-registry.js";
import type { AdapterCapability } from "../shared/adapter-contract.js";

const ALL_ADAPTER_IDS = ["ghostty", "chrome", "finder", "tmux_supervision"] as const;

describe("CLI capabilities", () => {
  it("projects all 4 adapters with the static declarative fields", () => {
    const result = runCapabilitiesCommand({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.schemaVersion).toBe(1);
    const ids = result.data.adapters.map((adapter) => adapter.id).sort();
    expect(ids).toEqual([...ALL_ADAPTER_IDS].sort());

    for (const adapter of result.data.adapters) {
      expect(adapter.displayName.length).toBeGreaterThan(0);
      expect(Array.isArray(adapter.capabilities)).toBe(true);
      expect(adapter.approvalPolicy.gates.length).toBeGreaterThan(0);
      expect(typeof adapter.planSchema.schemaVersion).toBe("number");
      expect(typeof adapter.verificationStrategy).toBe("string");
      expect(typeof adapter.stopBehavior.supportsAbortSignal).toBe("boolean");
      expect(Array.isArray(adapter.blockerStages)).toBe(true);
    }
  });

  it("never exposes the hidden mutation primitives or internals", () => {
    const registry = createDefaultAdapterRegistry();
    for (const adapter of registry.list()) {
      const dto = projectAdapterCapabilities(adapter);
      const dtoKeys = Object.keys(dto);
      for (const withheld of ADAPTER_CAPABILITY_WITHHELD_KEYS) {
        expect(dtoKeys, `${adapter.id} must not expose ${withheld}`).not.toContain(withheld);
      }
      // The raw adapter still has them (the DTO is a projection, not a deletion).
      expect(typeof (adapter as unknown as Record<string, unknown>).run).toBe("function");
    }
  });

  it("projects capability values from the AdapterCapability union", () => {
    const result = runCapabilitiesCommand({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const knownCapabilities: readonly AdapterCapability[] = [
      "desktop_action_execute",
      "desktop_screenshot",
      "desktop_ocr",
      "desktop_session_status",
      "desktop_permissions",
      "cdp_command",
      "finder_selection",
      "finder_item_layout",
      "tmux_observe",
      "app_list"
    ];
    for (const adapter of result.data.adapters) {
      for (const capability of adapter.capabilities) {
        expect(knownCapabilities).toContain(capability);
      }
    }
  });

  it("--adapter ghostty returns only ghostty", () => {
    const result = runCapabilitiesCommand({ adapterId: "ghostty" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.adapters).toHaveLength(1);
    expect(result.data.adapters[0].id).toBe("ghostty");
  });

  it("--adapter unknown returns a typed adapter-not-found error", () => {
    const result = runCapabilitiesCommand({ adapterId: "unknown-adapter" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("adapter-not-found");
    expect(result.error.action.length).toBeGreaterThan(0);
  });

  it("exposes smoke contract only when the adapter declares one", () => {
    const result = runCapabilitiesCommand({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const withSmoke = result.data.adapters.filter((adapter) => adapter.smoke !== undefined);
    expect(withSmoke.length).toBeGreaterThan(0);
    for (const adapter of withSmoke) {
      expect(adapter.smoke?.npmScript.length).toBeGreaterThan(0);
      expect(adapter.smoke?.productPath.length).toBeGreaterThan(0);
    }
  });
});
