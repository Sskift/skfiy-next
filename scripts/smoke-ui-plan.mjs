import fs from "node:fs/promises";
import path from "node:path";

export const UI_PRODUCT_PATH = "LaunchServices -> renderer DOM -> React permission onboarding";
export const STRICT_APPROVAL_ENV = "SKFIY_BYPASS_APPROVAL=strict";
export const HIDDEN_WINDOW_ENV = "SKFIY_SMOKE_WINDOW_MODE=hidden";
export const SMOKE_ASSISTANT_PROMPT_ENV = "SKFIY_SMOKE_ASSISTANT_PROMPT";
export const SMOKE_ASSISTANT_REPLY_ENV = "SKFIY_SMOKE_ASSISTANT_REPLY";
export const DEFAULT_SMOKE_ASSISTANT_PROMPT = "你好 skfiy，请用一句话回复。";
export const DEFAULT_SMOKE_ASSISTANT_REPLY = "你好，我是 skfiy。";
export const REQUIRED_COMPUTER_USE_PERMISSION_KEYS = ["screenRecording", "accessibility"];
export const REQUIRED_PERMISSION_KEYS = [
  "screenRecording",
  "accessibility"
];
export const REQUIRED_PERMISSION_LABELS = ["屏幕录制", "辅助功能"];
export const REQUIRED_PERMISSION_SETTING_TARGETS = [
  { label: "屏幕录制", target: "screen-recording", buttonLabel: "打开屏幕录制设置" },
  { label: "辅助功能", target: "accessibility", buttonLabel: "打开辅助功能设置" }
];
const REQUIRED_VISIBLE_PET_EDGE_CHECKS = ["top", "bottom", "left", "right"];

export function createDefaultUiSmokeOptions(rootDir) {
  return {
    appPath: path.join(rootDir, "dist", "skfiy.app"),
    outputPath: undefined,
    port: 9310,
    timeoutMs: 10_000,
    settleMs: 1_200,
    productPath: UI_PRODUCT_PATH,
    requiredPermissionLabels: [...REQUIRED_PERMISSION_LABELS],
    smokeAssistantPrompt: DEFAULT_SMOKE_ASSISTANT_PROMPT,
    smokeAssistantReply: DEFAULT_SMOKE_ASSISTANT_REPLY,
    launchMode: "hidden",
    stealsFocus: false,
    requirePassed: false,
    keepExisting: false,
    keepOpen: false,
    help: false
  };
}

export function parseUiSmokeArgs(argv, defaults) {
  const options = { ...defaults };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--app":
        options.appPath = path.resolve(readRequiredValue(argv, ++index, arg));
        break;
      case "--output":
        options.outputPath = path.resolve(readRequiredValue(argv, ++index, arg));
        break;
      case "--port":
        options.port = readPositiveInteger(readRequiredValue(argv, ++index, arg), arg);
        break;
      case "--timeout-ms":
        options.timeoutMs = readPositiveInteger(readRequiredValue(argv, ++index, arg), arg);
        break;
      case "--settle-ms":
        options.settleMs = readPositiveInteger(readRequiredValue(argv, ++index, arg), arg);
        break;
      case "--require-passed":
        options.requirePassed = true;
        break;
      case "--hidden":
        options.launchMode = "hidden";
        options.stealsFocus = false;
        break;
      case "--visible":
        options.launchMode = "visible";
        options.stealsFocus = true;
        break;
      case "--keep-existing":
        options.keepExisting = true;
        break;
      case "--keep-open":
        options.keepOpen = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown UI smoke option: ${arg}`);
    }
  }

  return options;
}

export function classifyUiSmokeEvidence(evidence) {
  if (!evidence?.appLaunchViaOpen || evidence.runnerHasTmux) {
    return "failed";
  }

  if (evidence.productPath !== UI_PRODUCT_PATH) {
    return "failed";
  }

  if (!evidence.petClicked) {
    return "failed";
  }

  if (!hasPetDragEvidence(evidence.petDrag)) {
    return "missing-pet-drag";
  }

  if (hasBlockedDesktopSessionEvidence(evidence.desktopSessionDiagnostics)) {
    return "desktop-session-blocked";
  }

  if (!hasStopTurnBehaviorEvidence(evidence.stopTurnBehavior)) {
    return "missing-stop-turn-behavior";
  }

  if (!hasAssistantConversationEvidence(evidence.assistantConversation)) {
    return "missing-assistant-conversation";
  }

  if (!evidence.onboardingVisible) {
    return hasAllRequiredPermissionsGranted(evidence.permissions) ? "no-onboarding" : "missing-onboarding";
  }

  const rowLabels = new Set(
    Array.isArray(evidence.permissionRows)
      ? evidence.permissionRows.map((row) => row?.label).filter(Boolean)
      : []
  );
  const requiredLabels = Array.isArray(evidence.requiredPermissionLabels)
    ? evidence.requiredPermissionLabels
    : REQUIRED_PERMISSION_LABELS;
  const missingLabels = requiredLabels.filter((label) => !rowLabels.has(label));

  if (missingLabels.length > 0) {
    return "missing-permission-rows";
  }

  return hasRequiredPermissionSettingTargets(evidence.permissionSettingTargets)
    ? "passed"
    : "missing-permission-settings";
}

export async function writeUiSmokeEvidence(outputPath, evidence, io = fs) {
  await io.mkdir(path.dirname(outputPath), { recursive: true });
  await io.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

export function formatUiLaunchCommand(options) {
  const noFocusFlag = options.launchMode === "hidden" ? " -g" : "";
  const hiddenEnv = options.launchMode === "hidden" ? ` --env ${HIDDEN_WINDOW_ENV}` : "";
  const smokeAssistantPromptEnv = options.smokeAssistantPrompt
    ? ` --env ${SMOKE_ASSISTANT_PROMPT_ENV}=${shellEscapeEnvValue(options.smokeAssistantPrompt)}`
    : "";
  const smokeAssistantEnv = options.smokeAssistantReply
    ? ` --env ${SMOKE_ASSISTANT_REPLY_ENV}=${shellEscapeEnvValue(options.smokeAssistantReply)}`
    : "";
  return `open -n${noFocusFlag} -a ${options.appPath} --env ${STRICT_APPROVAL_ENV}${hiddenEnv}${smokeAssistantPromptEnv}${smokeAssistantEnv} --args --remote-debugging-port=${options.port}`;
}

export function createUiHelpText(defaults) {
  return `Usage: npm run smoke:ui -- [options]

Runs the packaged skfiy app through the real desktop UI path:
  LaunchServices -> renderer DOM -> React permission onboarding

Options:
  --app <path>          App bundle path. Default: ${defaults.appPath}
  --output <path>       Optional: write the full JSON result to a file.
  --port <number>       Electron remote debugging port. Default: ${defaults.port}
  --timeout-ms <ms>     Wait time for the renderer CDP page. Default: ${defaults.timeoutMs}
  --settle-ms <ms>      Wait after clicking the pet. Default: ${defaults.settleMs}
  --require-passed      Exit 2 unless the UI smoke result is passed.
  --hidden              Launch skfiy hidden and without focusing the desktop. Default.
  --visible             Launch skfiy visibly for frontmost app evidence.
  --keep-existing       Do not quit an existing skfiy app before launch.
  --keep-open           Leave skfiy open after the smoke run.
  -h, --help            Show this help.
`;
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function readPositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  return parsed;
}

function shellEscapeEnvValue(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function hasAllRequiredPermissionsGranted(permissions) {
  if (!permissions || typeof permissions !== "object") {
    return false;
  }

  return REQUIRED_PERMISSION_KEYS.every((permission) =>
    permissions?.[permission]?.state === "granted"
  );
}

function hasBlockedDesktopSessionEvidence(diagnostics) {
  return Boolean(
    diagnostics &&
      typeof diagnostics === "object" &&
      diagnostics.state === "blocked"
  );
}

function hasRequiredPermissionSettingTargets(permissionSettingTargets) {
  if (!Array.isArray(permissionSettingTargets)) {
    return false;
  }

  return REQUIRED_PERMISSION_SETTING_TARGETS.every((required) =>
    permissionSettingTargets.some((target) =>
      target?.label === required.label
      && target?.target === required.target
      && target?.buttonLabel === required.buttonLabel
    )
  );
}

function hasPetDragEvidence(petDrag) {
  if (!petDrag || petDrag.result !== "passed") {
    return false;
  }

  return petDrag.source === "renderer-pointer-events-window-bounds"
    && hasWindowBounds(petDrag.beforeBounds)
    && hasWindowBounds(petDrag.afterBounds)
    && hasVisiblePetEdgeChecks(petDrag.visibleEdgeChecks)
    && Array.isArray(petDrag.moveEvents)
    && petDrag.moveEvents.length > 0
    && Number.isFinite(petDrag.totalDeltaX)
    && Number.isFinite(petDrag.totalDeltaY)
    && petDrag.totalDeltaY < 0
    && petDrag.upwardMovement === true
    && petDrag.suppressedClickAfterDrag === true;
}

function hasVisiblePetEdgeChecks(edgeChecks) {
  if (!Array.isArray(edgeChecks)) {
    return false;
  }

  return REQUIRED_VISIBLE_PET_EDGE_CHECKS.every((edge) =>
    edgeChecks.some((check) =>
      check?.edge === edge
      && check.passed === true
      && hasVisibleRectBounds(check.visiblePet)
      && hasWindowBounds(check.displayBounds)
      && hasWindowBounds(check.usableBounds)
    )
  );
}

function hasStopTurnBehaviorEvidence(value) {
  if (!value || value.result !== "passed") {
    return false;
  }

  return value.source === "renderer-escape-key-product-path"
    && typeof value.command === "string"
    && value.command.trim().length > 0
    && value.beforeStatus === "approval_required"
    && value.afterStatus === "cancelled"
    && typeof value.afterMessage === "string"
    && value.afterMessage.includes("Task stopped");
}

function hasAssistantConversationEvidence(value) {
  if (!value || value.result !== "passed") {
    return false;
  }

  return value.source === "renderer-assistant-conversation-product-path"
    && typeof value.prompt === "string"
    && value.prompt.trim().length > 0
    && value.eventStatus === "completed"
    && value.panelVisibleAfterReply === true
    && value.inputReadyAfterReply === true
    && value.replyVisible === true
    && typeof value.replyText === "string"
    && value.replyText.trim().length > 0;
}

function hasWindowBounds(bounds) {
  return bounds
    && typeof bounds === "object"
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height);
}

function hasVisibleRectBounds(bounds) {
  return hasWindowBounds(bounds)
    && Number.isFinite(bounds.top)
    && Number.isFinite(bounds.right)
    && Number.isFinite(bounds.bottom)
    && Number.isFinite(bounds.left);
}
