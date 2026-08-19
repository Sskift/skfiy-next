import { describe, expect, it } from "vitest";
import {
  createPlannerProviderSettingsStore,
  readInitialPlannerProviderSettings,
  summarizePlannerProviderSettings
} from "./planner-provider-settings";

describe("planner provider settings", () => {
  it("defaults to local deterministic adapter mode", () => {
    expect(readInitialPlannerProviderSettings({})).toEqual({
      mode: "local-deterministic",
      externalProviderLabel: "External CUA",
      externalEndpoint: undefined,
      externalApiKeyConfigured: false
    });
  });

  it.each([
    ["local-deterministic"],
    ["external-cua"],
    ["disabled"]
  ])("reads %s from the environment", (mode) => {
    expect(readInitialPlannerProviderSettings({ SKFIY_PLANNER_MODE: mode })).toMatchObject({
      mode
    });
  });

  it("falls back to local deterministic mode for invalid environment values", () => {
    expect(readInitialPlannerProviderSettings({ SKFIY_PLANNER_MODE: "surprise" })).toMatchObject({
      mode: "local-deterministic"
    });
  });

  it("reads external CUA endpoint and redacted API key status from the environment", () => {
    expect(readInitialPlannerProviderSettings({
      SKFIY_PLANNER_MODE: "external-cua",
      SKFIY_EXTERNAL_CUA_ENDPOINT: "https://cua.example.test/plan",
      SKFIY_EXTERNAL_CUA_API_KEY: "sk-test"
    })).toEqual({
      mode: "external-cua",
      externalProviderLabel: "External CUA",
      externalEndpoint: "https://cua.example.test/plan",
      externalApiKeyConfigured: true
    });
  });

  it("ignores non-http external CUA endpoints from the environment", () => {
    expect(readInitialPlannerProviderSettings({
      SKFIY_PLANNER_MODE: "external-cua",
      SKFIY_EXTERNAL_CUA_ENDPOINT: "file:///tmp/local-cua.sock",
      SKFIY_EXTERNAL_CUA_API_KEY: "sk-test"
    })).toEqual({
      mode: "external-cua",
      externalProviderLabel: "External CUA",
      externalEndpoint: undefined,
      externalApiKeyConfigured: true
    });
  });

  it("lets the runtime store switch modes while ignoring invalid updates", () => {
    const store = createPlannerProviderSettingsStore(readInitialPlannerProviderSettings({}));

    expect(store.set({ mode: "external-cua" })).toMatchObject({ mode: "external-cua" });
    expect(store.set({ mode: "disabled" })).toMatchObject({ mode: "disabled" });
    expect(store.set({ mode: "invalid" })).toMatchObject({ mode: "disabled" });
  });

  it("lets dashboard configuration update external provider fields without exposing secrets", () => {
    const store = createPlannerProviderSettingsStore(readInitialPlannerProviderSettings({}));

    expect(store.set({
      mode: "external-cua",
      externalProviderLabel: "OpenAI CUA",
      externalEndpoint: " https://cua.example.test/plan ",
      externalApiKey: "sk-secret"
    })).toEqual({
      mode: "external-cua",
      externalProviderLabel: "OpenAI CUA",
      externalEndpoint: "https://cua.example.test/plan",
      externalApiKeyConfigured: true
    });

    expect(JSON.stringify(store.get())).not.toContain("sk-secret");

    expect(store.set({
      externalEndpoint: "not a url",
      externalProviderLabel: "",
      externalApiKey: ""
    })).toEqual({
      mode: "external-cua",
      externalProviderLabel: "OpenAI CUA",
      externalEndpoint: "https://cua.example.test/plan",
      externalApiKeyConfigured: false
    });
  });

  it("summarizes external provider settings for dashboard use without exposing secrets", () => {
    const summary = summarizePlannerProviderSettings({
      mode: "external-cua",
      externalProviderLabel: "OpenAI CUA",
      externalEndpoint: "https://cua.example.test/plan",
      externalApiKeyConfigured: true
    });

    expect(summary).toEqual({
      provider: "planner",
      mode: "external-cua",
      externalProviderLabel: "OpenAI CUA",
      externalEndpoint: "https://cua.example.test/plan",
      externalApiKeyConfigured: true
    });
    expect(summary).not.toHaveProperty("externalApiKey");
    expect(JSON.stringify(summary)).not.toContain("sk-");
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
});
