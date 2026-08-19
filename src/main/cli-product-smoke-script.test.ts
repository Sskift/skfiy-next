import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("CLI product smoke script", () => {
  it("is exposed as an npm script", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    const sourcePath = path.join(process.cwd(), "scripts/smoke-cli-product.mjs");

    expect(existsSync(sourcePath)).toBe(true);
    expect(packageJson.scripts).toMatchObject({
      "smoke:cli": "node scripts/smoke-cli-product.mjs",
      "smoke:cli:basic": "node scripts/smoke-cli-product.mjs --profile basic"
    });
  });

  it("parses CLI smoke options for a repeatable dist-module contract run", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-cli-plan.mjs");

    expect(existsSync(modulePath)).toBe(true);

    const {
      PRODUCT_PATH,
      createCliSmokeHelpText,
      createDefaultCliSmokeOptions,
      parseCliSmokeArgs
    } = await import(pathToFileURL(modulePath).href) as {
      PRODUCT_PATH: string;
      createCliSmokeHelpText: (defaults: Record<string, unknown>) => string;
      createDefaultCliSmokeOptions: (rootDir: string) => Record<string, unknown>;
      parseCliSmokeArgs: (
        argv: string[],
        defaults: Record<string, unknown>
      ) => Record<string, unknown>;
    };
    const defaults = createDefaultCliSmokeOptions("/repo");

    expect(PRODUCT_PATH).toBe("dist/main -> assistant-agent + session-memory + browser-page-context + personal-memory + personal-skills + working-profile contracts");
    expect(defaults).toMatchObject({
      isolatedHomeDir: path.join("/repo", ".skfiy-cli-smoke", "home"),
      timeoutMs: 30_000,
      outputPath: undefined,
      profile: "full",
      requirePassed: false,
      help: false
    });
    expect(parseCliSmokeArgs([], defaults)).toMatchObject({
      outputPath: undefined,
      requirePassed: false
    });
    expect(parseCliSmokeArgs([
      "--isolated-home",
      ".skfiy-cli-smoke/home",
      "--output",
      ".skfiy-smoke/cli.json",
      "--timeout-ms",
      "1200",
      "--profile",
      "basic",
      "--require-passed"
    ], defaults)).toMatchObject({
      isolatedHomeDir: path.resolve(".skfiy-cli-smoke/home"),
      outputPath: path.resolve(".skfiy-smoke/cli.json"),
      timeoutMs: 1200,
      profile: "basic",
      requirePassed: true
    });
    expect(createCliSmokeHelpText(defaults)).toContain("smoke:cli");
    expect(createCliSmokeHelpText(defaults)).toContain("--isolated-home");
    expect(createCliSmokeHelpText(defaults)).toContain("--profile <full|basic>");
  });

  it("classifies CLI smoke evidence only when dist module contracts pass", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-cli-plan.mjs");
    const {
      PRODUCT_PATH,
      classifyCliSmokeEvidence
    } = await import(pathToFileURL(modulePath).href) as {
      PRODUCT_PATH: string;
      classifyCliSmokeEvidence: (input: Record<string, unknown>) => string;
    };
    const passedEvidence = {
      isolatedHomeDir: "/repo/.skfiy-cli-smoke/home",
      runnerHasTmux: false,
      productPath: PRODUCT_PATH,
      profile: "full",
      providerPromptContract: createPassingProviderPromptContract(),
      realTurnIdentityContract: createPassingRealTurnIdentityContract(),
      realBrowserContextContract: createPassingRealBrowserContextContract(),
      personalMemoryPromptSanitizationContract: createPassingPersonalMemoryPromptSanitizationContract(),
      personalMemoryAtomicBatchContract: createPassingPersonalMemoryAtomicBatchContract(),
      result: "passed"
    };

    expect(classifyCliSmokeEvidence(passedEvidence)).toBe("passed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      productPath: "dist/main -> other contract"
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      providerPromptContract: undefined
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      realTurnIdentityContract: undefined
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      realBrowserContextContract: undefined
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      realBrowserContextContract: {
        ...createPassingRealBrowserContextContract(),
        promptIncludesVisibleText: false
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      realTurnIdentityContract: {
        ...createPassingRealTurnIdentityContract(),
        providers: createPassingRealTurnIdentityContract().providers.map((provider) => provider.mode === "claude-code"
          ? { ...provider, identityChannel: "query-prompt" }
          : provider)
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      realTurnIdentityContract: {
        ...createPassingRealTurnIdentityContract(),
        providers: createPassingRealTurnIdentityContract().providers.map((provider) => provider.mode === "hermes"
          ? { ...provider, runnerSawSkfiyIdentity: false }
          : provider)
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      providerPromptContract: {
        ...createPassingProviderPromptContract(),
        providers: createPassingProviderPromptContract().providers.map((provider) => provider.mode === "hermes"
          ? { ...provider, providerIdentityInternalized: false }
          : provider)
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      providerPromptContract: {
        ...createPassingProviderPromptContract(),
        providers: createPassingProviderPromptContract().providers.map((provider) => provider.mode === "codex"
          ? { ...provider, identitySelfAcceptancePresent: false }
          : provider)
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      providerPromptContract: {
        ...createPassingProviderPromptContract(),
        providers: createPassingProviderPromptContract().providers.map((provider) => provider.mode === "codex"
          ? { ...provider, providerDefaultOverridePresent: false }
          : provider)
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      realTurnIdentityContract: {
        ...createPassingRealTurnIdentityContract(),
        providers: createPassingRealTurnIdentityContract().providers.map((provider) => provider.mode === "claude-code"
          ? { ...provider, replyPrefixBlocked: false }
          : provider)
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      providerPromptContract: {
        ...createPassingProviderPromptContract(),
        providers: createPassingProviderPromptContract().providers.map((provider) => provider.mode === "hermes"
          ? { ...provider, sessionRecallBeforeBrowserContext: false }
          : provider)
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      providerPromptContract: {
        ...createPassingProviderPromptContract(),
        providers: createPassingProviderPromptContract().providers.map((provider) => provider.mode === "codex"
          ? { ...provider, sessionRecallBasisPresent: false }
          : provider)
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      providerPromptContract: {
        ...createPassingProviderPromptContract(),
        providers: createPassingProviderPromptContract().providers.map((provider) => provider.mode === "codex"
          ? { ...provider, workingProfileBeforeBrowserContext: false }
          : provider)
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      providerPromptContract: {
        ...createPassingProviderPromptContract(),
        providers: createPassingProviderPromptContract().providers.map((provider) => provider.mode === "hermes"
          ? { ...provider, personalSkillBeforeWorkingProfile: false }
          : provider)
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      personalMemoryPromptSanitizationContract: undefined
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      personalMemoryPromptSanitizationContract: {
        ...createPassingPersonalMemoryPromptSanitizationContract(),
        unsafeTextReachedPrompt: true
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      personalMemoryAtomicBatchContract: undefined
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      personalMemoryAtomicBatchContract: {
        ...createPassingPersonalMemoryAtomicBatchContract(),
        overBudgetBatch: {
          ...createPassingPersonalMemoryAtomicBatchContract().overBudgetBatch,
          durableUserEntryCount: 2
        }
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      runnerHasTmux: true
    })).toBe("failed");
  });
});

function createPassingProviderPromptContract() {
  return {
    productPath: "dist/main/assistant-agent.js -> buildAssistantAgentInvocation -> provider prompt contract",
    result: "passed",
    tokenLeakDetected: false,
    providers: [
      {
        mode: "codex",
        label: "Codex",
        commandBasename: "codex",
        skfiyIdentityBeforeUser: true,
        memoryBeforeBrowserContext: true,
        sessionRecallAfterMemory: true,
        sessionRecallBeforeBrowserContext: true,
        sessionRecallBasisPresent: true,
        workingProfileBeforeBrowserContext: true,
        workingProfileBeforeUser: true,
        personalSkillBeforeWorkingProfile: true,
        workingProfileRedactsToken: true,
        sessionRecallRedactsToken: true,
        browserContextBeforeUser: true,
        providerIdentityInternalized: true,
        identitySelfAcceptancePresent: true,
        providerDefaultOverridePresent: true,
        replyPrefixBlocked: true,
        providerBoundaryPresent: true,
        usesReadOnlySandbox: true,
        rejectsDirectDesktopControl: true,
        dangerousFlagsAbsent: true
      },
      {
        mode: "claude-code",
        label: "Claude Code",
        commandBasename: "claude",
        skfiyIdentityBeforeUser: true,
        memoryBeforeBrowserContext: true,
        sessionRecallAfterMemory: true,
        sessionRecallBeforeBrowserContext: true,
        sessionRecallBasisPresent: true,
        workingProfileBeforeBrowserContext: true,
        workingProfileBeforeUser: true,
        personalSkillBeforeWorkingProfile: true,
        workingProfileRedactsToken: true,
        sessionRecallRedactsToken: true,
        browserContextBeforeUser: true,
        providerIdentityInternalized: true,
        identitySelfAcceptancePresent: true,
        providerDefaultOverridePresent: true,
        replyPrefixBlocked: true,
        providerBoundaryPresent: true,
        usesSystemIdentityPrompt: true,
        disallowsMutatingTools: true,
        rejectsDirectDesktopControl: true,
        dangerousFlagsAbsent: true
      },
      {
        mode: "hermes",
        label: "Hermes",
        commandBasename: "hermes",
        skfiyIdentityBeforeUser: true,
        memoryBeforeBrowserContext: true,
        sessionRecallAfterMemory: true,
        sessionRecallBeforeBrowserContext: true,
        sessionRecallBasisPresent: true,
        workingProfileBeforeBrowserContext: true,
        workingProfileBeforeUser: true,
        personalSkillBeforeWorkingProfile: true,
        workingProfileRedactsToken: true,
        sessionRecallRedactsToken: true,
        browserContextBeforeUser: true,
        providerIdentityInternalized: true,
        identitySelfAcceptancePresent: true,
        providerDefaultOverridePresent: true,
        replyPrefixBlocked: true,
        providerBoundaryPresent: true,
        usesBoundedChatToolset: true,
        rejectsDirectDesktopControl: true,
        dangerousFlagsAbsent: true
      }
    ]
  };
}

function createPassingRealTurnIdentityContract() {
  return {
    productPath: "dist/main/assistant-agent.js -> runAssistantAgentTurn -> real provider identity contract",
    result: "passed",
    tokenLeakDetected: false,
    providers: [
      {
        mode: "codex",
        label: "Codex",
        commandBasename: "codex",
        status: "completed",
        identityChannel: "query-prompt",
        runnerSawSkfiyIdentity: true,
        runnerSawUserPrompt: true,
        skfiyIdentityBeforeUser: true,
        providerBoundaryPresent: true,
        providerDefaultOverridePresent: true,
        replyPrefixBlocked: true,
        responseProviderLabel: "Codex",
        responseMessage: "我是 skfiy。"
      },
      {
        mode: "claude-code",
        label: "Claude Code",
        commandBasename: "claude",
        status: "completed",
        identityChannel: "system-prompt",
        runnerSawSkfiyIdentity: true,
        runnerSawUserPrompt: true,
        userPromptHasNoDuplicateIdentity: true,
        providerBoundaryPresent: true,
        providerDefaultOverridePresent: true,
        replyPrefixBlocked: true,
        responseProviderLabel: "Claude Code",
        responseMessage: "我是 skfiy。"
      },
      {
        mode: "hermes",
        label: "Hermes",
        commandBasename: "hermes",
        status: "completed",
        identityChannel: "query-prompt",
        runnerSawSkfiyIdentity: true,
        runnerSawUserPrompt: true,
        skfiyIdentityBeforeUser: true,
        providerBoundaryPresent: true,
        providerDefaultOverridePresent: true,
        replyPrefixBlocked: true,
        responseProviderLabel: "Hermes",
        responseMessage: "我是 skfiy。"
      }
    ]
  };
}

function createPassingRealBrowserContextContract() {
  return {
    productPath: "dist/main/browser-page-context.js -> dist/main/assistant-agent.js -> real Browser Context prompt contract",
    result: "passed",
    tokenLeakDetected: false,
    providerLabel: "Codex",
    responseMessage: "我看到当前 Chrome 页面。",
    connectionState: "connected",
    contextState: "ready",
    contextUrl: "https://example.test/skfiy-browser-context",
    promptIncludesCurrentChromePage: true,
    promptIncludesUrl: true,
    promptIncludesTitle: true,
    promptIncludesVisibleText: true,
    browserContextBeforeUser: true,
    runnerSawSkfiyIdentity: true
  };
}

function createPassingPersonalMemoryPromptSanitizationContract() {
  return {
    productPath: "dist/main/personal-memory.js -> createPersonalMemoryPromptBlock -> prompt sanitization contract",
    result: "passed",
    tokenLeakDetected: false,
    rawSnapshotKeepsUnsafeEntry: true,
    safeMemoryStillInjected: true,
    blockedPlaceholderInjected: true,
    unsafeTextReachedPrompt: false,
    promptBlockIncludesFence: true
  };
}

function createPassingPersonalMemoryAtomicBatchContract() {
  return {
    productPath: "dist/main/personal-memory.js -> createPersonalMemoryStore -> atomic batch contract",
    result: "passed",
    tokenLeakDetected: false,
    overBudgetBatch: {
      applied: 0,
      blockedCount: 1,
      durableUserEntryCount: 0
    },
    removeThenAddBatch: {
      applied: 2,
      blockedCount: 0,
      durableUserEntryCount: 2,
      keptExistingEntry: true,
      addedReplacementEntry: true
    },
    unsafeBatch: {
      applied: 0,
      blockedCount: 1,
      durableUserEntryCount: 0
    }
  };
}
