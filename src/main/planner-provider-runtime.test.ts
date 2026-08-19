import { describe, expect, it } from "vitest";
import { decidePlannerProviderRuntime } from "./planner-provider-runtime";

describe("planner provider runtime gate", () => {
  it("allows local deterministic Computer Use execution", () => {
    expect(decidePlannerProviderRuntime({
      mode: "local-deterministic",
      externalProviderLabel: "External CUA",
      externalEndpoint: undefined,
      externalApiKeyConfigured: false
    })).toEqual({
      decision: "run-local-deterministic"
    });
  });

  it("fails closed when Computer Use planner mode is disabled", () => {
    expect(decidePlannerProviderRuntime({
      mode: "disabled",
      externalProviderLabel: "External CUA",
      externalEndpoint: undefined,
      externalApiKeyConfigured: false
    })).toEqual({
      decision: "unavailable",
      status: "failed",
      message: "Computer Use planner is disabled in settings."
    });
  });

  it("fails closed when external CUA endpoint is missing", () => {
    expect(decidePlannerProviderRuntime({
      mode: "external-cua",
      externalProviderLabel: "External CUA",
      externalEndpoint: undefined,
      externalApiKeyConfigured: true
    })).toEqual({
      decision: "unavailable",
      status: "failed",
      message: "External CUA endpoint is not configured. Set SKFIY_EXTERNAL_CUA_ENDPOINT."
    });
  });

  it("fails closed when external CUA API key is missing", () => {
    expect(decidePlannerProviderRuntime({
      mode: "external-cua",
      externalProviderLabel: "External CUA",
      externalEndpoint: "https://cua.example.test/plan",
      externalApiKeyConfigured: false
    })).toEqual({
      decision: "unavailable",
      status: "failed",
      message: "External CUA API key is not configured. Set SKFIY_EXTERNAL_CUA_API_KEY."
    });
  });

  it("runs external CUA when endpoint and API key are configured", () => {
    expect(decidePlannerProviderRuntime({
      mode: "external-cua",
      externalProviderLabel: "External CUA",
      externalEndpoint: "https://cua.example.test/plan",
      externalApiKeyConfigured: true
    })).toEqual({
      decision: "run-external-cua",
      label: "External CUA",
      endpoint: "https://cua.example.test/plan"
    });
  });
});
