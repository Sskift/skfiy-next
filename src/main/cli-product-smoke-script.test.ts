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

  it("parses CLI smoke options for a repeatable binary product run", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-cli-plan.mjs");

    expect(existsSync(modulePath)).toBe(true);

    const {
      CLI_COMMAND_MATRIX,
      CLI_BASIC_COMMAND_IDS,
      PRODUCT_PATH,
      createCliSmokeHelpText,
      createCliSmokeCommandRuns,
      createDefaultCliSmokeOptions,
      parseCliSmokeArgs
    } = await import(pathToFileURL(modulePath).href) as {
      CLI_COMMAND_MATRIX: Array<{ id: string; args: string[] }>;
      CLI_BASIC_COMMAND_IDS: string[];
      PRODUCT_PATH: string;
      createCliSmokeHelpText: (defaults: Record<string, unknown>) => string;
      createCliSmokeCommandRuns: (options: Record<string, unknown>) => Array<{ id: string }>;
      createDefaultCliSmokeOptions: (rootDir: string) => Record<string, unknown>;
      parseCliSmokeArgs: (
        argv: string[],
        defaults: Record<string, unknown>
      ) => Record<string, unknown>;
    };
    const defaults = createDefaultCliSmokeOptions("/repo");

    expect(PRODUCT_PATH).toBe("dist/skfiy -> skfiy CLI command matrix");
    expect(defaults).toMatchObject({
      cliPath: path.join("/repo", "dist", "skfiy"),
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
      "--cli",
      "dist/skfiy",
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
      cliPath: path.resolve("dist/skfiy"),
      isolatedHomeDir: path.resolve(".skfiy-cli-smoke/home"),
      outputPath: path.resolve(".skfiy-smoke/cli.json"),
      timeoutMs: 1200,
      profile: "basic",
      requirePassed: true
    });
    expect(CLI_COMMAND_MATRIX.map((command) => command.id)).toEqual([
      "commands-json",
      "status-json",
      "doctor-json",
      "chrome-status",
      "mcp-serve-json",
      "dashboard-json",
      "release-check-json",
      "alpha-artifact-json",
      "smoke-dashboard-json"
    ]);
    expect(CLI_BASIC_COMMAND_IDS).toEqual([
      "commands-json",
      "status-json",
      "doctor-json",
      "chrome-status",
      "mcp-serve-json",
      "dashboard-json"
    ]);
    expect(createCliSmokeCommandRuns({
      ...defaults,
      profile: "basic"
    }).map((command) => command.id)).toEqual(CLI_BASIC_COMMAND_IDS);
    expect(createCliSmokeHelpText(defaults)).toContain("smoke:cli");
    expect(createCliSmokeHelpText(defaults)).toContain("--isolated-home");
    expect(createCliSmokeHelpText(defaults)).toContain("--profile <full|basic>");
  });

  it("classifies CLI smoke evidence only when built binary commands are stable and isolated", async () => {
    const modulePath = path.join(process.cwd(), "scripts/smoke-cli-plan.mjs");
    const {
      CLI_COMMAND_MATRIX,
      PRODUCT_PATH,
      classifyCliSmokeEvidence
    } = await import(pathToFileURL(modulePath).href) as {
      CLI_COMMAND_MATRIX: Array<{ id: string; args: string[] }>;
      PRODUCT_PATH: string;
      classifyCliSmokeEvidence: (input: Record<string, unknown>) => string;
    };
    const passedEvidence = {
      cliPath: "/repo/dist/skfiy",
      isolatedHomeDir: "/repo/.skfiy-cli-smoke/home",
      runnerHasTmux: false,
      productPath: PRODUCT_PATH,
      profile: "full",
      commands: CLI_COMMAND_MATRIX.map((command) => createPassingCommandEvidence(command)),
      providerPromptContract: createPassingProviderPromptContract(),
      realTurnIdentityContract: createPassingRealTurnIdentityContract(),
      realBrowserContextContract: createPassingRealBrowserContextContract(),
      repeatedConversationLearningContract: createPassingRepeatedConversationLearningContract(),
      personalMemoryFallbackContract: createPassingPersonalMemoryFallbackContract(),
      personalMemoryPromptSanitizationContract: createPassingPersonalMemoryPromptSanitizationContract(),
      personalMemoryAtomicBatchContract: createPassingPersonalMemoryAtomicBatchContract(),
      postTurnPersonalizationContract: createPassingPostTurnPersonalizationContract(),
      result: "passed"
    };
    const basicEvidence = {
      ...passedEvidence,
      profile: "basic",
      commands: CLI_COMMAND_MATRIX
        .filter((command) => [
          "commands-json",
          "status-json",
          "doctor-json",
          "chrome-status",
          "mcp-serve-json",
          "dashboard-json"
        ].includes(command.id))
        .map((command) => createPassingCommandEvidence(command))
    };

    expect(classifyCliSmokeEvidence(passedEvidence)).toBe("passed");
    expect(classifyCliSmokeEvidence(basicEvidence)).toBe("passed");
    expect(classifyCliSmokeEvidence({
      ...basicEvidence,
      commands: [...basicEvidence.commands, createPassingCommandEvidence(CLI_COMMAND_MATRIX.at(-1)!)]
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      personalMemoryFallbackContract: {
        ...createPassingPersonalMemoryFallbackContract(),
        dashboardStylePreference: { operationCount: 0, operations: [] }
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      personalMemoryFallbackContract: {
        ...createPassingPersonalMemoryFallbackContract(),
        secretLikeRequest: {
          operationCount: 1,
          operations: [{ action: "add", target: "user", content: "User token=secret" }]
        }
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      commands: passedEvidence.commands.map((command) => command.id === "chrome-status"
        ? {
            ...command,
            stdoutJson: {
              ...command.stdoutJson,
              extension: {
                state: "connected",
                bridge: "native-messaging",
                liveConnection: "connected",
                nativeHostState: "installed",
                manifestPath: "/repo/.skfiy-cli-smoke/home/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sskift.skfiy.json",
                allowedOrigins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
                connection: {
                  state: "connected",
                  liveConnection: "connected",
                  path: "/repo/.skfiy-cli-smoke/home/Library/Application Support/skfiy/chrome-extension-connection.json",
                  ageSeconds: 42,
                  observedAt: "2026-06-19T23:59:18.000Z",
                  launchOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
                  messageType: "skfiy.page.observe",
                  requestId: "request-smoke"
                }
              }
            }
          }
        : command)
    })).toBe("passed");
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
      repeatedConversationLearningContract: undefined
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      repeatedConversationLearningContract: {
        ...createPassingRepeatedConversationLearningContract(),
        secondTurn: {
          ...createPassingRepeatedConversationLearningContract().secondTurn,
          promptIncludesPersonalSkill: false
        }
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      repeatedConversationLearningContract: {
        ...createPassingRepeatedConversationLearningContract(),
        secondTurn: {
          ...createPassingRepeatedConversationLearningContract().secondTurn,
          promptIncludesWorkingProfile: false
        }
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      repeatedConversationLearningContract: {
        ...createPassingRepeatedConversationLearningContract(),
        firstTurn: {
          ...createPassingRepeatedConversationLearningContract().firstTurn,
          sessionCount: 0
        }
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
      personalMemoryFallbackContract: undefined
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
      postTurnPersonalizationContract: undefined
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      postTurnPersonalizationContract: {
        ...createPassingPostTurnPersonalizationContract(),
        stagedWhenApprovalEnabled: {
          ...createPassingPostTurnPersonalizationContract().stagedWhenApprovalEnabled,
          durableUserEntryCount: 1
        }
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      postTurnPersonalizationContract: {
        ...createPassingPostTurnPersonalizationContract(),
        fallbackWrite: {
          ...createPassingPostTurnPersonalizationContract().fallbackWrite,
          memoryJournalSource: "post-turn-review"
        }
      }
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      runnerHasTmux: true
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      cliPath: "/repo/scripts/skfiy-cli.mjs"
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      isolatedHomeDir: "/Users/tester"
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      commands: passedEvidence.commands.slice(0, -1)
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      commands: passedEvidence.commands.map((command, index) => index === 0
        ? { ...command, exitCode: 1 }
        : command)
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      commands: passedEvidence.commands.map((command, index) => index === 0
        ? { ...command, tokenLeakDetected: true }
        : command)
    })).toBe("failed");
    expect(classifyCliSmokeEvidence({
      ...passedEvidence,
      commands: passedEvidence.commands.map((command) => command.id === "chrome-status"
        ? {
            ...command,
            stdoutJson: {
              ...command.stdoutJson,
              extension: undefined
            }
          }
        : command)
    })).toBe("failed");
  });
});

function createPassingCommandEvidence(command: { id: string; args: string[] }) {
  const base = {
    id: command.id,
    command: ["/repo/dist/skfiy", ...command.args],
    exitCode: 0,
    stdoutJson: {
      schemaVersion: 1,
      command: command.args.slice(0, 2).join(" "),
      result: "not-run"
    },
    stderr: "",
    tokenLeakDetected: false
  };

  if (command.id === "dashboard-json") {
    return {
      ...base,
      stdoutJson: {
        schemaVersion: 1,
        command: "dashboard",
        result: "running",
        tokenPrinted: false,
        bind: { host: "127.0.0.1", port: 51234 }
      },
      cleanup: { exited: true }
    };
  }

  if (command.id === "commands-json") {
    return {
      ...base,
      stdoutJson: {
        schemaVersion: 1,
        command: "commands",
        result: "available",
        commandCount: 4,
        surface: {
          schemaVersion: 1,
          commands: [
            { path: "commands" },
            { path: "status" },
            { path: "mcp serve" },
            { path: "smoke codex-plugin" }
          ]
        }
      }
    };
  }

  if (command.id === "status-json") {
    return {
      ...base,
      stdoutJson: {
        schemaVersion: 1,
        command: "status",
        readiness: {
          state: "needs-action",
          ready: false,
          blockers: [
            {
              area: "dashboard",
              code: "dashboard-not-running",
              state: "not-running"
            }
          ],
          checks: {
            runtime: {
              state: "ready",
              ready: true,
              blockers: []
            },
            dashboard: {
              state: "needs-action",
              ready: false,
              blockers: [
                {
                  code: "dashboard-not-running",
                  state: "not-running"
                }
              ]
            },
            extension: {
              state: "unknown",
              ready: false,
              blockers: []
            },
            moneyRun: {
              state: "needs-action",
              ready: false,
              session: "money-run",
              moneyRunState: "blocked",
              mutatesSession: false,
              blockers: [
                {
                  code: "money-run-not-observing",
                  state: "blocked"
                }
              ]
            }
          }
        },
        moneyRun: {
          state: "blocked",
          session: "money-run",
          source: "tmux-read-only-probe",
          mutatesSession: false,
          summary: {
            windowCount: 0,
            paneCount: 0,
            activePaneIds: [],
            deadPaneIds: []
          },
          recommendation: {
            action: "inspect_state",
            reason: "tmux session money-run was not found.",
            mutatesSession: false
          }
        }
      }
    };
  }

  if (command.id === "smoke-dashboard-json") {
    return {
      ...base,
      stdoutJson: {
        schemaVersion: 1,
        command: "smoke dashboard",
        result: "passed",
        exitCode: 0,
        smoke: {
          result: "passed",
          runnerHasTmux: false
        }
      }
    };
  }

  if (command.id === "chrome-status") {
    return {
      ...base,
      stdoutJson: {
        schemaVersion: 1,
        command: "chrome status",
        executesSystemMutation: false,
        nativeHost: {
          state: "missing",
          hostName: "com.sskift.skfiy",
          manifestPath: "/repo/.skfiy-cli-smoke/home/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sskift.skfiy.json",
          cliShimPath: "/repo/dist/skfiy",
          allowedOrigins: [],
          reason: "Chrome Native Messaging host manifest is not installed."
        },
        extension: {
          state: "native-host-missing",
          bridge: "native-messaging",
          liveConnection: "unknown",
          nativeHostState: "missing",
          manifestPath: "/repo/.skfiy-cli-smoke/home/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sskift.skfiy.json",
          reason: "Chrome Native Messaging host manifest is not installed."
        }
      }
    };
  }

  return base;
}

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

function createPassingRepeatedConversationLearningContract() {
  return {
    productPath: "dist/main/assistant-agent.js + dist/main/personalization-learning-loop.js -> repeated conversation learning contract",
    result: "passed",
    tokenLeakDetected: false,
    firstTurn: {
      providerLabel: "Codex",
      status: "completed",
      sessionCount: 1,
      durableUserEntries: [
        "User prefers dense Obsidian-like knowledge surfaces for dashboard work.",
        "User dislikes marketing-style hero/card-heavy dashboard layouts."
      ]
    },
    secondTurn: {
      providerLabel: "Hermes",
      status: "completed",
      responseMessage: "我记得你喜欢 Obsidian 风格的本地知识面板。",
      recalledSessionCount: 1,
      promptIncludesMemory: true,
      promptIncludesRecalledSession: true,
      promptIncludesPersonalSkill: true,
      promptIncludesWorkingProfile: true,
      memoryBeforeRecalledSession: true,
      recalledSessionBeforePersonalSkill: true,
      personalSkillBeforeWorkingProfile: true,
      workingProfileBeforeUser: true,
      personalSkillBeforeUser: true
    }
  };
}

function createPassingPersonalMemoryFallbackContract() {
  return {
    productPath: "dist/main/personal-memory-review.js -> createFallbackPersonalMemoryOperations -> local memory fallback contract",
    result: "passed",
    tokenLeakDetected: false,
    explicitPreference: {
      operationCount: 1,
      operations: [
        { action: "add", target: "user", content: "User prefers concise Chinese progress updates." }
      ]
    },
    dashboardStylePreference: {
      operationCount: 2,
      operations: [
        { action: "add", target: "user", content: "User prefers dense Obsidian-like knowledge surfaces for dashboard work." },
        { action: "add", target: "user", content: "User dislikes marketing-style hero/card-heavy dashboard layouts." }
      ]
    },
    explicitRemember: {
      operationCount: 1,
      operations: [
        { action: "add", target: "user", content: "User explicitly asked skfiy to remember: 以后回答我时先给结论，再给验证证据." }
      ]
    },
    explicitForget: {
      operationCount: 1,
      operations: [
        { action: "remove", target: "user", content: "User explicitly asked skfiy to remember: 以后回答我时先给结论，再给验证证据." }
      ]
    },
    secretLikeRequest: {
      operationCount: 0
    },
    oneOffRequest: {
      operationCount: 0
    },
    duplicatePreference: {
      operationCount: 0
    }
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

function createPassingPostTurnPersonalizationContract() {
  return {
    productPath: "dist/main/personalization-learning-loop.js -> recordCompletedAssistantTurnForPersonalization -> post-turn learning contract",
    result: "passed",
    tokenLeakDetected: false,
    durableReviewWrite: {
      sessionCount: 1,
      durableUserEntries: ["User prefers dense Obsidian-like dashboard surfaces."],
      reviewPromptIncludesDurableInstruction: true,
      reviewPromptReceivesExistingMemory: true,
      memoryJournalEntryCount: 1,
      memoryJournalStage: "durable",
      memoryJournalSource: "post-turn-review",
      memoryJournalProviderLabel: "Codex"
    },
    fallbackWrite: {
      durableUserEntries: ["User prefers concise Chinese progress updates."],
      memoryJournalEntryCount: 1,
      memoryJournalStage: "durable",
      memoryJournalSource: "local-fallback",
      memoryJournalProviderLabel: "Hermes"
    },
    stagedWhenApprovalEnabled: {
      durableUserEntryCount: 0,
      pendingWriteCount: 1,
      pendingSource: "post-turn-review",
      pendingContent: "User prefers dense Obsidian-like knowledge surfaces for dashboard work.",
      memoryJournalEntryCount: 1,
      memoryJournalStage: "pending",
      memoryJournalSource: "post-turn-review",
      memoryJournalProviderLabel: "Claude Code"
    }
  };
}
