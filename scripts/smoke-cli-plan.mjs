import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export const PRODUCT_PATH = "dist/skfiy -> skfiy CLI command matrix";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const FIXTURE_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const CLI_SMOKE_PROFILE_NAMES = ["full", "basic"];

export const CLI_COMMAND_MATRIX = [
  {
    id: "commands-json",
    args: ["commands", "--json"]
  },
  {
    id: "status-json",
    args: ["status", "--json"]
  },
  {
    id: "doctor-json",
    args: ["doctor", "--json"]
  },
  {
    id: "chrome-status",
    args: ["chrome", "status", "--extension-id", FIXTURE_EXTENSION_ID]
  },
  {
    id: "mcp-serve-json",
    args: ["mcp", "serve", "--stdio", "--json"]
  },
  {
    id: "dashboard-json",
    args: ["dashboard", "--no-open", "--port", "0", "--json"],
    longRunning: true
  },
  {
    id: "release-check-json",
    args: ["release", "check", "--json-output", "__CLI_SMOKE_RELEASE_JSON__"]
  },
  {
    id: "alpha-artifact-json",
    args: ["alpha", "artifact"]
  },
  {
    id: "smoke-dashboard-json",
    args: [
      "smoke",
      "dashboard",
      "--require-passed",
      "--json"
    ],
    nestedProductSmoke: true
  }
];

export const CLI_BASIC_COMMAND_IDS = [
  "commands-json",
  "status-json",
  "doctor-json",
  "chrome-status",
  "mcp-serve-json",
  "dashboard-json"
];

export function createDefaultCliSmokeOptions(rootDir) {
  return {
    cliPath: path.join(rootDir, "dist", "skfiy"),
    isolatedHomeDir: path.join(rootDir, ".skfiy-cli-smoke", "home"),
    scratchDir: path.join(rootDir, ".skfiy-cli-smoke"),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outputPath: undefined,
    profile: "full",
    requirePassed: false,
    help: false
  };
}

export function parseCliSmokeArgs(argv, defaults) {
  const options = { ...defaults };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--cli":
        options.cliPath = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--isolated-home":
        options.isolatedHomeDir = path.resolve(readRequiredValue(argv, index, arg));
        options.scratchDir = path.dirname(options.isolatedHomeDir);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = readPositiveInteger(readRequiredValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--output":
        options.outputPath = path.resolve(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--profile":
        options.profile = readProfileValue(readRequiredValue(argv, index, arg));
        index += 1;
        break;
      case "--require-passed":
        options.requirePassed = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown CLI smoke option: ${arg}`);
    }
  }

  return options;
}

export function createCliSmokeCommandRuns(options) {
  return getCliSmokeCommandMatrix(options.profile).map((entry) => ({
    ...entry,
    command: [
      options.cliPath,
      ...entry.args.map((arg) => replaceCommandPlaceholder(arg, options))
    ]
  }));
}

export function classifyCliSmokeEvidence(evidence) {
  const expectedMatrix = getCliSmokeCommandMatrix(evidence?.profile);

  if (
    !evidence
    || evidence.runnerHasTmux
    || evidence.productPath !== PRODUCT_PATH
    || !isBuiltCliPath(evidence.cliPath)
    || !isIsolatedHomeDir(evidence.isolatedHomeDir)
    || !Array.isArray(evidence.commands)
    || evidence.commands.length !== expectedMatrix.length
    || !hasProviderPromptContractEvidence(evidence.providerPromptContract)
    || !hasRealTurnIdentityContractEvidence(evidence.realTurnIdentityContract)
    || !hasRealBrowserContextContractEvidence(evidence.realBrowserContextContract)
    || !hasRepeatedConversationLearningContractEvidence(evidence.repeatedConversationLearningContract)
    || !hasPersonalMemoryFallbackContractEvidence(evidence.personalMemoryFallbackContract)
    || !hasPersonalMemoryPromptSanitizationContractEvidence(evidence.personalMemoryPromptSanitizationContract)
    || !hasPersonalMemoryAtomicBatchContractEvidence(evidence.personalMemoryAtomicBatchContract)
    || !hasPostTurnPersonalizationContractEvidence(evidence.postTurnPersonalizationContract)
  ) {
    return "failed";
  }

  for (const expected of expectedMatrix) {
    const command = evidence.commands.find((item) => item?.id === expected.id);

    if (!isPassingCommandEvidence(command, expected, evidence.cliPath)) {
      return "failed";
    }
  }

  return "passed";
}

export function createCliSmokeHelpText(defaults) {
  return `Usage: npm run smoke:cli -- [options]

Runs the built skfiy CLI through a binary command matrix:
dist/skfiy -> commands/status/doctor/chrome status/mcp/dashboard/release/alpha/smoke dashboard.

Options:
  --cli <path>            Built CLI path. Default: ${defaults.cliPath}
  --isolated-home <path>  Temporary HOME for Chrome host status. Default: ${defaults.isolatedHomeDir}
  --timeout-ms <ms>       Wait time for each CLI command. Default: ${defaults.timeoutMs}
  --profile <full|basic>  Matrix profile. basic skips release/alpha/nested dashboard smoke.
  --output <path>         Optional: write the full JSON result to a file.
  --require-passed        Exit 2 unless the CLI smoke result is passed.
  -h, --help              Show this help.
`;
}

export async function writeCliSmokeEvidence(
  outputPath,
  evidence,
  io = { mkdir, writeFile }
) {
  const artifactPath = path.resolve(outputPath);

  await io.mkdir(path.dirname(artifactPath), { recursive: true });
  await io.writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

function replaceCommandPlaceholder(arg, options) {
  if (arg === "__CLI_SMOKE_RELEASE_JSON__") {
    return path.join(options.scratchDir, "release-check.json");
  }
  return arg;
}

function readRequiredValue(argv, index, name) {
  const value = argv[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

function readPositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function readProfileValue(value) {
  if (!CLI_SMOKE_PROFILE_NAMES.includes(value)) {
    throw new Error(`--profile must be one of: ${CLI_SMOKE_PROFILE_NAMES.join(", ")}.`);
  }

  return value;
}

function getCliSmokeCommandMatrix(profile = "full") {
  if (profile === "basic") {
    return CLI_COMMAND_MATRIX.filter((entry) => CLI_BASIC_COMMAND_IDS.includes(entry.id));
  }

  return CLI_COMMAND_MATRIX;
}

function isPassingCommandEvidence(command, expected, cliPath) {
  if (
    !command
    || command.exitCode !== 0
    || command.tokenLeakDetected
    || typeof command.stderr !== "string"
    || hasTokenLeak([command.stderr])
    || !matchesExpectedCommand(command.command, expected, cliPath)
    || command.stdoutJson?.schemaVersion !== 1
  ) {
    return false;
  }

  if (expected.id === "dashboard-json") {
    return command.stdoutJson?.command === "dashboard"
      && command.stdoutJson?.result === "running"
      && command.stdoutJson?.tokenPrinted === false
      && command.stdoutJson?.bind?.host === "127.0.0.1"
      && Number.isInteger(command.stdoutJson?.bind?.port)
      && command.cleanup?.exited === true;
  }

  if (expected.id === "commands-json") {
    return command.stdoutJson?.command === "commands"
      && command.stdoutJson?.result === "available"
      && Number.isInteger(command.stdoutJson?.commandCount)
      && command.stdoutJson?.surface?.schemaVersion === 1
      && Array.isArray(command.stdoutJson?.surface?.commands)
      && command.stdoutJson.surface.commands.some((entry) => entry?.path === "status")
      && command.stdoutJson.surface.commands.some((entry) => entry?.path === "mcp serve")
      && command.stdoutJson.surface.commands.some((entry) => entry?.path === "smoke codex-plugin");
  }

  if (expected.id === "status-json") {
    return command.stdoutJson?.command === "status"
      && hasStatusReadinessEvidence(command.stdoutJson?.readiness)
      && hasMoneyRunStatusEvidence(command.stdoutJson?.moneyRun);
  }

  if (expected.id === "chrome-status") {
    return command.stdoutJson?.command === "chrome status"
      && command.stdoutJson?.executesSystemMutation === false
      && hasChromeNativeHostEvidence(command.stdoutJson?.nativeHost)
      && hasChromeExtensionAdapterEvidence(command.stdoutJson?.extension);
  }

  if (expected.id === "smoke-dashboard-json") {
    return command.stdoutJson?.command === "smoke dashboard"
      && command.stdoutJson?.result === "passed"
      && command.stdoutJson?.exitCode === 0
      && command.stdoutJson?.smoke?.result === "passed"
      && command.stdoutJson?.smoke?.runnerHasTmux === false;
  }

  return true;
}

function matchesExpectedCommand(command, expected, cliPath) {
  if (!Array.isArray(command) || command[0] !== cliPath) {
    return false;
  }

  const actualArgs = command.slice(1);

  if (actualArgs.length !== expected.args.length) {
    return false;
  }

  return expected.args.every((arg, index) => (
    arg.startsWith("__CLI_SMOKE_")
      ? typeof actualArgs[index] === "string" && actualArgs[index].length > 0
      : actualArgs[index] === arg
  ));
}

function isBuiltCliPath(cliPath) {
  if (typeof cliPath !== "string") {
    return false;
  }

  const normalized = path.normalize(cliPath);

  return path.basename(normalized) === "skfiy"
    && path.basename(path.dirname(normalized)) === "dist";
}

function hasStatusReadinessEvidence(readiness) {
  const allowedStates = new Set(["ready", "needs-action", "unknown"]);
  const checks = readiness?.checks;

  return allowedStates.has(readiness?.state)
    && typeof readiness?.ready === "boolean"
    && Array.isArray(readiness?.blockers)
    && hasReadinessCheck(checks?.runtime)
    && hasReadinessCheck(checks?.dashboard)
    && hasReadinessCheck(checks?.extension)
    && hasReadinessCheck(checks?.moneyRun)
    && checks.moneyRun.session === "money-run"
    && checks.moneyRun.mutatesSession === false;
}

function hasReadinessCheck(check) {
  const allowedStates = new Set(["ready", "needs-action", "unknown"]);

  return allowedStates.has(check?.state)
    && typeof check?.ready === "boolean"
    && Array.isArray(check?.blockers);
}

function hasMoneyRunStatusEvidence(moneyRun) {
  const allowedStates = new Set(["observing", "needs_attention", "blocked", "unknown"]);

  return allowedStates.has(moneyRun?.state)
    && moneyRun?.session === "money-run"
    && moneyRun?.source === "tmux-read-only-probe"
    && moneyRun?.mutatesSession === false;
}

function isIsolatedHomeDir(homeDir) {
  if (typeof homeDir !== "string") {
    return false;
  }

  const normalized = path.normalize(homeDir);

  return path.basename(normalized) === "home"
    && path.basename(path.dirname(normalized)) === ".skfiy-cli-smoke";
}

function hasChromeNativeHostEvidence(nativeHost) {
  const allowedStates = new Set([
    "installed",
    "missing",
    "mismatched",
    "cli-missing",
    "invalid"
  ]);

  return allowedStates.has(nativeHost?.state)
    && nativeHost?.hostName === "com.sskift.skfiy"
    && typeof nativeHost?.manifestPath === "string"
    && nativeHost.manifestPath.includes("NativeMessagingHosts/com.sskift.skfiy.json")
    && typeof nativeHost?.cliShimPath === "string"
    && path.basename(nativeHost.cliShimPath) === "skfiy"
    && Array.isArray(nativeHost?.allowedOrigins)
    && typeof nativeHost?.reason === "string";
}

function hasChromeExtensionAdapterEvidence(extension) {
  const allowedLiveConnectionStates = new Set(["unknown", "connected", "stale"]);

  return typeof extension?.state === "string"
    && extension.state !== "unknown"
    && extension?.bridge === "native-messaging"
    && allowedLiveConnectionStates.has(extension?.liveConnection)
    && (
      typeof extension?.reason === "string"
      || hasChromeExtensionConnectionEvidence(extension?.connection)
    );
}

function hasChromeExtensionConnectionEvidence(connection) {
  const allowedConnectionStates = new Set(["connected", "stale"]);

  return allowedConnectionStates.has(connection?.state)
    && connection?.liveConnection === connection.state
    && typeof connection?.path === "string"
    && connection.path.includes("Application Support/skfiy/chrome-extension-connection.json")
    && Number.isFinite(connection?.ageSeconds)
    && connection.ageSeconds >= 0
    && typeof connection?.observedAt === "string"
    && typeof connection?.launchOrigin === "string"
    && connection.launchOrigin.startsWith("chrome-extension://")
    && typeof connection?.messageType === "string"
    && typeof connection?.requestId === "string";
}

function hasProviderPromptContractEvidence(contract) {
  if (
    contract?.productPath !== "dist/main/assistant-agent.js -> buildAssistantAgentInvocation -> provider prompt contract"
    || contract?.result !== "passed"
    || contract?.tokenLeakDetected !== false
    || !Array.isArray(contract?.providers)
    || contract.providers.length !== 3
  ) {
    return false;
  }

  return hasProviderContract(contract.providers, {
    mode: "codex",
    label: "Codex",
    commandBasename: "codex",
    requiredSafetyField: "usesReadOnlySandbox"
  })
    && hasProviderContract(contract.providers, {
      mode: "claude-code",
      label: "Claude Code",
      commandBasename: "claude",
      requiredSafetyField: "disallowsMutatingTools"
    })
    && hasProviderContract(contract.providers, {
      mode: "hermes",
      label: "Hermes",
      commandBasename: "hermes",
      requiredSafetyField: "usesBoundedChatToolset"
    });
}

function hasProviderContract(providers, expected) {
  const provider = providers.find((candidate) => candidate?.mode === expected.mode);

  return provider?.label === expected.label
    && provider?.commandBasename === expected.commandBasename
    && provider?.skfiyIdentityBeforeUser === true
    && provider?.identitySelfAcceptancePresent === true
    && provider?.memoryBeforeBrowserContext === true
    && provider?.sessionRecallAfterMemory === true
    && provider?.sessionRecallBeforeBrowserContext === true
    && provider?.sessionRecallBasisPresent === true
    && provider?.workingProfileBeforeBrowserContext === true
    && provider?.workingProfileBeforeUser === true
    && provider?.personalSkillBeforeWorkingProfile === true
    && provider?.workingProfileRedactsToken === true
    && provider?.sessionRecallRedactsToken === true
    && provider?.browserContextBeforeUser === true
    && provider?.providerIdentityInternalized === true
    && provider?.providerDefaultOverridePresent === true
    && provider?.replyPrefixBlocked === true
    && provider?.providerBoundaryPresent === true
    && provider?.rejectsDirectDesktopControl === true
    && provider?.dangerousFlagsAbsent === true
    && (expected.mode !== "claude-code" || provider?.usesSystemIdentityPrompt === true)
    && provider?.[expected.requiredSafetyField] === true;
}

function hasRealTurnIdentityContractEvidence(contract) {
  if (
    contract?.productPath !== "dist/main/assistant-agent.js -> runAssistantAgentTurn -> real provider identity contract"
    || contract?.result !== "passed"
    || contract?.tokenLeakDetected !== false
    || !Array.isArray(contract?.providers)
  ) {
    return false;
  }

  return hasRealTurnProviderContract(contract.providers, {
    mode: "codex",
    label: "Codex",
    commandBasename: "codex",
    identityChannel: "query-prompt"
  })
    && hasRealTurnProviderContract(contract.providers, {
      mode: "claude-code",
      label: "Claude Code",
      commandBasename: "claude",
      identityChannel: "system-prompt"
    })
    && hasRealTurnProviderContract(contract.providers, {
      mode: "hermes",
      label: "Hermes",
      commandBasename: "hermes",
      identityChannel: "query-prompt"
    });
}

function hasRealTurnProviderContract(providers, expected) {
  const provider = providers.find((candidate) => candidate?.mode === expected.mode);

  return provider?.label === expected.label
    && provider?.commandBasename === expected.commandBasename
    && provider?.status === "completed"
    && provider?.identityChannel === expected.identityChannel
    && provider?.runnerSawSkfiyIdentity === true
    && provider?.runnerSawUserPrompt === true
    && provider?.providerBoundaryPresent === true
    && provider?.providerDefaultOverridePresent === true
    && provider?.replyPrefixBlocked === true
    && provider?.responseProviderLabel === expected.label
    && provider?.responseMessage === "我是 skfiy。"
    && (
      expected.identityChannel === "system-prompt"
      || provider?.skfiyIdentityBeforeUser === true
    )
    && (
      expected.mode !== "claude-code"
      || provider?.userPromptHasNoDuplicateIdentity === true
    );
}

function hasRealBrowserContextContractEvidence(contract) {
  return contract?.productPath === "dist/main/browser-page-context.js -> dist/main/assistant-agent.js -> real Browser Context prompt contract"
    && contract?.result === "passed"
    && contract?.tokenLeakDetected === false
    && contract?.providerLabel === "Codex"
    && contract?.responseMessage === "我看到当前 Chrome 页面。"
    && contract?.connectionState === "connected"
    && contract?.contextState === "ready"
    && contract?.contextUrl === "https://example.test/skfiy-browser-context"
    && contract?.promptIncludesCurrentChromePage === true
    && contract?.promptIncludesUrl === true
    && contract?.promptIncludesTitle === true
    && contract?.promptIncludesVisibleText === true
    && contract?.browserContextBeforeUser === true
    && contract?.runnerSawSkfiyIdentity === true;
}

function hasRepeatedConversationLearningContractEvidence(contract) {
  return contract?.productPath === "dist/main/assistant-agent.js + dist/main/personalization-learning-loop.js -> repeated conversation learning contract"
    && contract?.result === "passed"
    && contract?.tokenLeakDetected === false
    && contract?.firstTurn?.providerLabel === "Codex"
    && contract?.firstTurn?.status === "completed"
    && contract?.firstTurn?.sessionCount === 1
    && Array.isArray(contract?.firstTurn?.durableUserEntries)
    && contract.firstTurn.durableUserEntries.includes("User prefers dense Obsidian-like knowledge surfaces for dashboard work.")
    && contract.firstTurn.durableUserEntries.includes("User dislikes marketing-style hero/card-heavy dashboard layouts.")
    && contract?.secondTurn?.providerLabel === "Hermes"
    && contract?.secondTurn?.status === "completed"
    && contract?.secondTurn?.responseMessage === "我记得你喜欢 Obsidian 风格的本地知识面板。"
    && contract?.secondTurn?.recalledSessionCount === 1
    && contract?.secondTurn?.promptIncludesMemory === true
    && contract?.secondTurn?.promptIncludesRecalledSession === true
    && contract?.secondTurn?.promptIncludesPersonalSkill === true
    && contract?.secondTurn?.promptIncludesWorkingProfile === true
    && contract?.secondTurn?.memoryBeforeRecalledSession === true
    && contract?.secondTurn?.recalledSessionBeforePersonalSkill === true
    && contract?.secondTurn?.personalSkillBeforeWorkingProfile === true
    && contract?.secondTurn?.workingProfileBeforeUser === true
    && contract?.secondTurn?.personalSkillBeforeUser === true;
}

function hasPersonalMemoryFallbackContractEvidence(contract) {
  const explicitOperations = contract?.explicitPreference?.operations;
  const dashboardStyleOperations = contract?.dashboardStylePreference?.operations;
  const explicitRememberOperations = contract?.explicitRemember?.operations;
  const explicitForgetOperations = contract?.explicitForget?.operations;
  const explicitRememberContent = "User explicitly asked skfiy to remember: 以后回答我时先给结论，再给验证证据.";

  return contract?.productPath === "dist/main/personal-memory-review.js -> createFallbackPersonalMemoryOperations -> local memory fallback contract"
    && contract?.result === "passed"
    && contract?.tokenLeakDetected === false
    && contract?.explicitPreference?.operationCount === 1
    && Array.isArray(explicitOperations)
    && explicitOperations.length === 1
    && explicitOperations[0]?.action === "add"
    && explicitOperations[0]?.target === "user"
    && explicitOperations[0]?.content === "User prefers concise Chinese progress updates."
    && contract?.dashboardStylePreference?.operationCount === 2
    && Array.isArray(dashboardStyleOperations)
    && dashboardStyleOperations.some((operation) => (
      operation?.action === "add"
      && operation?.target === "user"
      && operation?.content === "User prefers dense Obsidian-like knowledge surfaces for dashboard work."
    ))
    && dashboardStyleOperations.some((operation) => (
      operation?.action === "add"
      && operation?.target === "user"
      && operation?.content === "User dislikes marketing-style hero/card-heavy dashboard layouts."
    ))
    && contract?.explicitRemember?.operationCount === 1
    && Array.isArray(explicitRememberOperations)
    && explicitRememberOperations.length === 1
    && explicitRememberOperations[0]?.action === "add"
    && explicitRememberOperations[0]?.target === "user"
    && explicitRememberOperations[0]?.content === explicitRememberContent
    && contract?.explicitForget?.operationCount === 1
    && Array.isArray(explicitForgetOperations)
    && explicitForgetOperations.length === 1
    && explicitForgetOperations[0]?.action === "remove"
    && explicitForgetOperations[0]?.target === "user"
    && explicitForgetOperations[0]?.content === explicitRememberContent
    && contract?.secretLikeRequest?.operationCount === 0
    && contract?.oneOffRequest?.operationCount === 0
    && contract?.duplicatePreference?.operationCount === 0;
}

function hasPersonalMemoryPromptSanitizationContractEvidence(contract) {
  return contract?.productPath === "dist/main/personal-memory.js -> createPersonalMemoryPromptBlock -> prompt sanitization contract"
    && contract?.result === "passed"
    && contract?.tokenLeakDetected === false
    && contract?.rawSnapshotKeepsUnsafeEntry === true
    && contract?.safeMemoryStillInjected === true
    && contract?.blockedPlaceholderInjected === true
    && contract?.unsafeTextReachedPrompt === false
    && contract?.promptBlockIncludesFence === true;
}

function hasPersonalMemoryAtomicBatchContractEvidence(contract) {
  return contract?.productPath === "dist/main/personal-memory.js -> createPersonalMemoryStore -> atomic batch contract"
    && contract?.result === "passed"
    && contract?.tokenLeakDetected === false
    && contract?.overBudgetBatch?.applied === 0
    && contract?.overBudgetBatch?.blockedCount === 1
    && contract?.overBudgetBatch?.durableUserEntryCount === 0
    && contract?.removeThenAddBatch?.applied === 2
    && contract?.removeThenAddBatch?.blockedCount === 0
    && contract?.removeThenAddBatch?.durableUserEntryCount === 2
    && contract?.removeThenAddBatch?.keptExistingEntry === true
    && contract?.removeThenAddBatch?.addedReplacementEntry === true
    && contract?.unsafeBatch?.applied === 0
    && contract?.unsafeBatch?.blockedCount === 1
    && contract?.unsafeBatch?.durableUserEntryCount === 0;
}

function hasPostTurnPersonalizationContractEvidence(contract) {
  return contract?.productPath === "dist/main/personalization-learning-loop.js -> recordCompletedAssistantTurnForPersonalization -> post-turn learning contract"
    && contract?.result === "passed"
    && contract?.tokenLeakDetected === false
    && contract?.durableReviewWrite?.sessionCount === 1
    && Array.isArray(contract?.durableReviewWrite?.durableUserEntries)
    && contract.durableReviewWrite.durableUserEntries.includes("User prefers dense Obsidian-like dashboard surfaces.")
    && contract?.durableReviewWrite?.reviewPromptIncludesDurableInstruction === true
    && contract?.durableReviewWrite?.reviewPromptReceivesExistingMemory === true
    && contract?.durableReviewWrite?.memoryJournalEntryCount === 1
    && contract?.durableReviewWrite?.memoryJournalStage === "durable"
    && contract?.durableReviewWrite?.memoryJournalSource === "post-turn-review"
    && contract?.durableReviewWrite?.memoryJournalProviderLabel === "Codex"
    && Array.isArray(contract?.fallbackWrite?.durableUserEntries)
    && contract.fallbackWrite.durableUserEntries.includes("User prefers concise Chinese progress updates.")
    && contract?.fallbackWrite?.memoryJournalEntryCount === 1
    && contract?.fallbackWrite?.memoryJournalStage === "durable"
    && contract?.fallbackWrite?.memoryJournalSource === "local-fallback"
    && contract?.fallbackWrite?.memoryJournalProviderLabel === "Hermes"
    && contract?.stagedWhenApprovalEnabled?.durableUserEntryCount === 0
    && contract?.stagedWhenApprovalEnabled?.pendingWriteCount === 1
    && contract?.stagedWhenApprovalEnabled?.pendingSource === "post-turn-review"
    && contract?.stagedWhenApprovalEnabled?.pendingContent === "User prefers dense Obsidian-like knowledge surfaces for dashboard work."
    && contract?.stagedWhenApprovalEnabled?.memoryJournalEntryCount === 1
    && contract?.stagedWhenApprovalEnabled?.memoryJournalStage === "pending"
    && contract?.stagedWhenApprovalEnabled?.memoryJournalSource === "post-turn-review"
    && contract?.stagedWhenApprovalEnabled?.memoryJournalProviderLabel === "Claude Code";
}

function hasTokenLeak(parts) {
  return parts
    .filter((part) => typeof part === "string")
    .some((part) =>
      /token=/i.test(part)
      || /"tokenPrinted"\s*:\s*true/i.test(part)
      || /"token"\s*:\s*"[^"]+"/i.test(part)
    );
}
