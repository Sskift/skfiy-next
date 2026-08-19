import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export const PRODUCT_PATH = "dist/main -> assistant-agent + session-memory + browser-page-context + personal-memory + personal-skills + working-profile contracts";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const CLI_SMOKE_PROFILE_NAMES = ["full", "basic"];

export function createDefaultCliSmokeOptions(rootDir) {
  return {
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

export function classifyCliSmokeEvidence(evidence) {
  if (
    !evidence
    || evidence.runnerHasTmux
    || evidence.productPath !== PRODUCT_PATH
    || !hasProviderPromptContractEvidence(evidence.providerPromptContract)
    || !hasRealTurnIdentityContractEvidence(evidence.realTurnIdentityContract)
    || !hasRealBrowserContextContractEvidence(evidence.realBrowserContextContract)
    || !hasPersonalMemoryPromptSanitizationContractEvidence(evidence.personalMemoryPromptSanitizationContract)
    || !hasPersonalMemoryAtomicBatchContractEvidence(evidence.personalMemoryAtomicBatchContract)
  ) {
    return "failed";
  }

  return "passed";
}

export function createCliSmokeHelpText(defaults) {
  return `Usage: npm run smoke:cli -- [options]

Verifies compiled dist/main module contracts:
assistant-agent, session-memory, browser-page-context, personal-memory,
personal-skills, and working-profile prompt/memory behavior.

Options:
  --isolated-home <path>  Temporary HOME label for the smoke evidence. Default: ${defaults.isolatedHomeDir}
  --timeout-ms <ms>       Wait time for each contract collection. Default: ${defaults.timeoutMs}
  --profile <full|basic>  Smoke profile label. Default: ${defaults.profile}
  --output <path>         Optional: write the full JSON result to a file.
  --require-passed        Exit 2 unless the smoke result is passed.
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

function hasProviderPromptContractEvidence(contract) {
  if (
    contract?.productPath !== "dist/main/assistant-agent.js -> buildAssistantAgentInvocation -> provider prompt contract"
    || contract?.result !== "passed"
    || contract?.tokenLeakDetected !== false
    || !Array.isArray(contract?.providers)
    || contract.providers.length !== 1
  ) {
    return false;
  }

  return hasProviderContract(contract.providers, {
    mode: "codex",
    label: "Codex",
    commandBasename: "codex",
    requiredSafetyField: "usesReadOnlySandbox"
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
    && provider?.skfiyIdentityBeforeUser === true
    && provider?.providerBoundaryPresent === true
    && provider?.providerDefaultOverridePresent === true
    && provider?.replyPrefixBlocked === true
    && provider?.responseProviderLabel === expected.label
    && provider?.responseMessage === "我是 skfiy。";
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
