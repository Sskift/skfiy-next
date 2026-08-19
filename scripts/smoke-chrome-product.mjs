#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  CURRENT_PAGE_COMMAND,
  FALLBACK_PRODUCT_PATH,
  FALLBACK_SWITCH_PRODUCT_PATH,
  classifyChromeBringYourOwnCurrentPageEvidence,
  classifyChromeCurrentPageSmokeEvidence,
  classifyChromeFallbackSwitchEvidence,
  classifyChromeFallbackSmokeEvidence,
  classifyChromeSmokeEvidence,
  classifyInstalledExtensionActionSmokeEvidence,
  createDefaultChromeSmokeOptions,
  createInstalledExtensionBlockerRemediation,
  createInstalledExtensionBlockers,
  createInstalledExtensionReadinessSnapshot,
  createHelpText,
  EXPECTED_TEXT,
  FORM_EXPECTED_TEXT,
  hasChromePageControlEvidence,
  INSTALLED_EXTENSION_ACTION_PRODUCT_PATH,
  INSTALLED_EXTENSION_PRODUCT_PATH,
  NATIVE_HOST_BRIDGE_PRODUCT_PATH,
  parseChromeSmokeArgs,
  PRODUCT_PATH,
  readInstalledExtensionActionTargetTabs,
  selectInstalledExtensionActionTargetTab,
  selectInstalledExtensionChromeApp
} from "./smoke-chrome-plan.mjs";
import { writeSmokeEvidence } from "./smoke-ghostty-plan.mjs";
import { acquireSmokeLock } from "./smoke-lock.mjs";
import { SKFIY_APP_PROCESS_PATTERN } from "./skfiy-process-matching.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const BUNDLE_IDENTIFIER = "com.sskift.skfiy";
const FIXTURE_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const STRICT_APPROVAL_ENV = "SKFIY_BYPASS_APPROVAL=strict";
const SMOKE_ASSISTANT_ENV = "SKFIY_SMOKE_ASSISTANT_COMPUTER_USE=1";
const SMOKE_APP_ENVS = [STRICT_APPROVAL_ENV, SMOKE_ASSISTANT_ENV];
const FORM_FIELDS = [
  { selector: "#name", value: "skfiy" },
  { selector: "#email", value: "agent@skfiy.test" },
  { selector: "#role", value: "operator" }
];
const SENSITIVE_FORM_FIELDS = [
  { selector: "#password", value: "skfiy-test-secret" }
];
const EXPECTED_CURRENT_PAGE_COMMAND = "观察 Chrome 当前页面并提取正文";
const INSTALLED_EXTENSION_ACTION_SMOKE_ARTIFACT = ".skfiy-smoke/chrome-extension-actions.json";
const INSTALLED_EXTENSION_ACTION_SCREENSHOT_BLOCKERS = [
  "chrome-capture-permission-missing",
  "chrome-capture-blocked"
];

async function main() {
  const defaults = createDefaultChromeSmokeOptions(ROOT_DIR);
  const options = parseChromeSmokeArgs(process.argv.slice(2), defaults);

  if (options.help) {
    process.stdout.write(createHelpText(defaults));
    return;
  }

  const chromeEndpoint = options.currentPageEndpoint ?? `http://127.0.0.1:${options.chromePort}`;
  const evidence = {
    timestamp: new Date().toISOString(),
    appPath: options.appPath,
    chromeAppName: options.chromeAppName,
    launchMode: options.launchMode,
    stealsFocus: options.allowFocusSteal === true,
    launch: formatLaunchCommand(options, chromeEndpoint),
    fallbackLaunch: formatFallbackLaunchCommand(options),
    chromeLaunch: options.currentPageEndpoint
      ? `provided Chrome CDP endpoint: ${options.currentPageEndpoint}`
      : formatChromeLaunchCommand(options),
    appLaunchViaOpen: true,
    chromeLaunchViaOpen: options.currentPageEndpoint ? false : true,
    runnerHasTmux: Boolean(process.env.TMUX),
    productPath: PRODUCT_PATH,
    approvalBypassEnv: STRICT_APPROVAL_ENV,
    assistantSmokeEnv: SMOKE_ASSISTANT_ENV,
    fallbackProductPath: FALLBACK_PRODUCT_PATH,
    fallbackSwitchProductPath: FALLBACK_SWITCH_PRODUCT_PATH,
    targetMode: options.currentPageEndpoint ? "bring-your-own-current-page" : "fixture-suite",
    artifactPath: options.outputPath,
    fixtureRoot: undefined,
    pageUrl: undefined,
    sensitivePageUrl: undefined,
    formPageUrl: undefined,
    chromeEndpoint,
    currentPageEndpoint: options.currentPageEndpoint,
    command: undefined,
    currentPageCommand: CURRENT_PAGE_COMMAND,
    sensitiveCommand: undefined,
    formCommand: undefined,
    sensitiveFormCommand: undefined,
    extractedText: "",
    events: [],
    realCurrentPageRun: undefined,
    currentPageRun: undefined,
    sensitiveRun: undefined,
    formRun: undefined,
    sensitiveFormRun: undefined,
    nativeHostBridgeRun: undefined,
    installedExtensionRun: undefined,
    installedExtensionActionRun: undefined,
    pageControl: undefined,
    readinessDiagnostics: undefined,
    fallbackRun: undefined,
    fallbackSwitchRun: undefined,
    permissions: undefined,
    runtimeStatus: undefined,
    startupWarnings: undefined,
    appPolicySettings: undefined,
    result: "not-run"
  };
  let smokeLock;

  try {
    assertChromeSmokeReady(options);
    smokeLock = await acquireSmokeLock({
      rootDir: ROOT_DIR,
      scriptName: "smoke:chrome"
    });
    evidence.readinessDiagnostics = await runChromeReadinessDiagnostics(options);
    evidence.nativeHostBridgeRun = await runChromeNativeHostBridgeSmoke(options);
    evidence.installedExtensionRun = await runInstalledChromeExtensionSmoke(options);
    evidence.installedExtensionActionRun = await runInstalledChromeExtensionActionSmoke(options);
    evidence.pageControl = createChromeSmokePageControlEvidence(evidence);

    if (options.currentPageEndpoint) {
      if (!options.keepExisting) {
        await quitSkfiy();
        await sleep(700);
      }

      await launchSkfiy(options, chromeEndpoint);
      evidence.processesAfterLaunch = await readSkfiyProcesses();

      const page = await waitForRendererPage(options.port, options.timeoutMs);
      const cdp = await createCdpClient(page.webSocketDebuggerUrl);

      try {
        await cdp.send("Runtime.enable");
        await cdp.send("Runtime.addBinding", { name: "skfiyChromeSmokeEvent" });
        await cdp.send("Runtime.evaluate", {
          expression: installEventSinkExpression(),
          awaitPromise: true,
          returnByValue: true
        });

        await readRendererEvidence(cdp, evidence);
        evidence.realCurrentPageRun = await runChromeBringYourOwnCurrentPageCommand(
          cdp,
          options,
          evidence
        );
        evidence.currentPageRun = evidence.realCurrentPageRun;
        evidence.events = evidence.realCurrentPageRun.events;
        evidence.result = evidence.realCurrentPageRun.result;
        if (
          evidence.result === "passed"
          && (
            evidence.nativeHostBridgeRun.result !== "passed"
            || !isInstalledExtensionSmokeAcceptable(evidence.installedExtensionRun)
            || !isInstalledExtensionActionSmokeAcceptable(evidence.installedExtensionActionRun)
            || !hasChromePageControlEvidence(evidence.pageControl, evidence.installedExtensionRun)
          )
        ) {
          evidence.result = "failed";
        }
      } finally {
        cdp.close();
      }

      if (options.requirePassed && evidence.result !== "passed") {
        process.exitCode = 2;
      }

      return;
    }

    const fixture = await createChromeFixture();
    evidence.fixtureRoot = fixture.rootPath;
    evidence.pageUrl = fixture.url;
    evidence.sensitivePageUrl = fixture.sensitiveUrl;
    evidence.formPageUrl = fixture.formUrl;
    evidence.command = `打开 Chrome 测试页面 ${fixture.url} 并提取正文`;
    evidence.sensitiveCommand = `打开 Chrome 测试页面 ${fixture.sensitiveUrl} 并提取正文`;
    evidence.formCommand = `填写 Chrome 测试表单 ${fixture.formUrl} 字段 ${formatFormAssignments(FORM_FIELDS)} 点击 #submit 并提取正文`;
    evidence.sensitiveFormCommand = `填写 Chrome 测试表单 ${fixture.formUrl} 字段 ${formatFormAssignments(SENSITIVE_FORM_FIELDS)} 点击 #submit 并提取正文`;

    if (!options.keepExisting) {
      await quitSkfiy();
      await killChromeSmokeProcesses(fixture.chromeUserDataDir);
      await waitForChromeSmokeProcessesExit(fixture.chromeUserDataDir);
    }

    await launchChrome(options, fixture.chromeUserDataDir);
    await waitForChromeEndpoint(options.chromePort, options.timeoutMs);
    evidence.chromeProcessesAfterLaunch = await readChromeSmokeProcesses(fixture.chromeUserDataDir);

    await launchSkfiy(options, chromeEndpoint);
    evidence.processesAfterLaunch = await readSkfiyProcesses();

    const page = await waitForRendererPage(options.port, options.timeoutMs);
    const cdp = await createCdpClient(page.webSocketDebuggerUrl);

    try {
      await cdp.send("Runtime.enable");
      await cdp.send("Runtime.addBinding", { name: "skfiyChromeSmokeEvent" });
      await cdp.send("Runtime.evaluate", {
        expression: installEventSinkExpression(),
        awaitPromise: true,
        returnByValue: true
      });

      const primaryEvents = await runChromeProductCommand(
        cdp,
        evidence.command,
        options
      );

      const permissions = await cdp.send("Runtime.evaluate", {
        expression: "window.skfiy.getPermissions()",
        awaitPromise: true,
        returnByValue: true
      });
      const runtimeStatus = await cdp.send("Runtime.evaluate", {
        expression: "window.skfiy.getRuntimeStatus()",
        awaitPromise: true,
        returnByValue: true
      });
      const startupWarnings = await cdp.send("Runtime.evaluate", {
        expression: "window.skfiy.getStartupWarnings()",
        awaitPromise: true,
        returnByValue: true
      });
      const appPolicySettings = await cdp.send("Runtime.evaluate", {
        expression: "window.skfiy.getAppPolicySettings()",
        awaitPromise: true,
        returnByValue: true
      });

      evidence.permissions = permissions.result?.value;
      evidence.runtimeStatus = runtimeStatus.result?.value;
      evidence.startupWarnings = startupWarnings.result?.value;
      evidence.appPolicySettings = appPolicySettings.result?.value;
      evidence.events = primaryEvents;
      evidence.extractedText = extractCompletedChromeText(primaryEvents);
      evidence.result = classifyChromeSmokeEvidence(evidence);

      const currentPageEvents = await runChromeProductCommand(
        cdp,
        evidence.currentPageCommand,
        options
      );
      const currentPageText = extractCompletedChromeCurrentPageText(currentPageEvents);
      const currentPageSnapshot = extractChromeCurrentPageSnapshot(currentPageEvents);
      evidence.currentPageRun = {
        command: evidence.currentPageCommand,
        pageSnapshot: currentPageSnapshot,
        events: currentPageEvents,
        extractedText: currentPageText,
        result: classifyChromeCurrentPageSmokeEvidence({
          ...evidence,
          events: currentPageEvents,
          pageSnapshot: currentPageSnapshot
        })
      };

       if (evidence.result === "passed" && evidence.currentPageRun.result !== "passed") {
         evidence.result = "failed";
       }

      const sensitiveEvents = await runChromeProductCommand(
        cdp,
        evidence.sensitiveCommand,
        options
      );
      evidence.sensitiveRun = {
        pageUrl: evidence.sensitivePageUrl,
        command: evidence.sensitiveCommand,
        events: sensitiveEvents,
        result: classifyChromeSmokeEvidence({
          ...evidence,
          events: sensitiveEvents,
          extractedText: ""
        })
      };

      if (evidence.result === "passed" && evidence.sensitiveRun.result !== "sensitive-paused") {
        evidence.result = "failed";
      }

      const formEvents = await runChromeProductCommand(
        cdp,
        evidence.formCommand,
        options
      );
      const formText = extractCompletedChromeText(formEvents);
      evidence.formRun = {
        pageUrl: evidence.formPageUrl,
        command: evidence.formCommand,
        fields: FORM_FIELDS,
        events: formEvents,
        extractedText: formText,
        result: classifyChromeSmokeEvidence({
          ...evidence,
          events: formEvents,
          extractedText: formText,
          expectedText: FORM_EXPECTED_TEXT
        })
      };

      if (evidence.result === "passed" && evidence.formRun.result !== "passed") {
        evidence.result = "failed";
      }

      const sensitiveFormEvents = await runChromeProductCommand(
        cdp,
        evidence.sensitiveFormCommand,
        options
      );
      evidence.sensitiveFormRun = {
        pageUrl: evidence.formPageUrl,
        command: evidence.sensitiveFormCommand,
        fields: SENSITIVE_FORM_FIELDS,
        events: sensitiveFormEvents,
        result: classifyChromeSmokeEvidence({
          ...evidence,
          events: sensitiveFormEvents,
          extractedText: ""
        })
      };

      if (evidence.result === "passed" && evidence.sensitiveFormRun.result !== "sensitive-paused") {
        evidence.result = "failed";
      }

      if (options.allowFocusSteal === true) {
        const fallback = await runChromeFallbackProductCommand(
          options,
          evidence.command
        );
        evidence.fallbackRun = {
          command: evidence.command,
          productPath: FALLBACK_PRODUCT_PATH,
          appLaunchViaOpen: true,
          runnerHasTmux: Boolean(process.env.TMUX),
          events: fallback.events,
          processesAfterLaunch: fallback.processesAfterLaunch,
          result: classifyChromeFallbackSmokeEvidence({
            events: fallback.events,
            appLaunchViaOpen: true,
            runnerHasTmux: Boolean(process.env.TMUX),
            productPath: FALLBACK_PRODUCT_PATH
          })
        };

        if (
          evidence.result === "passed"
          && !["fallback-observed", "fallback-blocked"].includes(evidence.fallbackRun.result)
        ) {
          evidence.result = "failed";
        }

        const fallbackSwitch = await runChromeFallbackSwitchProductCommand(
          options,
          evidence.command
        );
        evidence.fallbackSwitchRun = {
          command: evidence.command,
          productPath: FALLBACK_SWITCH_PRODUCT_PATH,
          configuredEndpoint: fallbackSwitch.configuredEndpoint,
          launch: fallbackSwitch.launch,
          appLaunchViaOpen: true,
          runnerHasTmux: Boolean(process.env.TMUX),
          events: fallbackSwitch.events,
          processesAfterLaunch: fallbackSwitch.processesAfterLaunch,
          result: classifyChromeFallbackSwitchEvidence({
            events: fallbackSwitch.events,
            appLaunchViaOpen: true,
            runnerHasTmux: Boolean(process.env.TMUX),
            productPath: FALLBACK_SWITCH_PRODUCT_PATH,
            configuredEndpoint: fallbackSwitch.configuredEndpoint
          })
        };

        if (
          evidence.result === "passed"
          && !["fallback-switched-observed", "fallback-switched-blocked"].includes(
            evidence.fallbackSwitchRun.result
          )
        ) {
          evidence.result = "failed";
        }
      } else {
        evidence.fallbackRun = createFocusStealingLaneSkippedRun({
          command: evidence.command,
          productPath: FALLBACK_PRODUCT_PATH
        });
        evidence.fallbackSwitchRun = createFocusStealingLaneSkippedRun({
          command: evidence.command,
          productPath: FALLBACK_SWITCH_PRODUCT_PATH,
          configuredEndpoint: readBrokenChromeEndpoint(options),
          launch: formatFallbackSwitchLaunchCommand(options, readBrokenChromeEndpoint(options))
        });
      }

      if (
        evidence.result === "passed"
        && !isInstalledExtensionActionSmokeAcceptable(evidence.installedExtensionActionRun)
      ) {
        evidence.result = "failed";
      }
    } finally {
      cdp.close();
    }

    if (options.requirePassed && evidence.result !== "passed") {
      process.exitCode = 2;
    }
  } catch (error) {
    evidence.result = "error";
    evidence.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    if (!options.keepOpen) {
      await quitSkfiy();
      await sleep(500);
      evidence.processesAfterCleanup = await readSkfiyProcesses();
    }
    if (evidence.fixtureRoot) {
      await killChromeSmokeProcesses(path.join(evidence.fixtureRoot, "chrome-profile"));
      evidence.chromeProcessesAfterCleanup = await waitForChromeSmokeProcessesExit(
        path.join(evidence.fixtureRoot, "chrome-profile")
      );
      await rm(evidence.fixtureRoot, { recursive: true, force: true });
    }
    await smokeLock?.release();

    if (options.outputPath) {
      try {
        await writeSmokeEvidence(options.outputPath, evidence);
      } catch (error) {
        evidence.artifactError = error instanceof Error ? error.message : String(error);
        process.exitCode = process.exitCode ?? 1;
      }
    }

    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }
}

function assertChromeSmokeReady(options) {
  if (!existsSync(options.appPath)) {
    throw new Error(`App bundle is missing at ${options.appPath}. Run npm run build first.`);
  }
  if (!existsSync(options.cliPath)) {
    throw new Error(`Packaged skfiy CLI is missing at ${options.cliPath}. Run npm run build first.`);
  }

  if (typeof WebSocket !== "function") {
    throw new Error("This smoke script requires a Node runtime with global WebSocket support.");
  }

  if (CURRENT_PAGE_COMMAND !== EXPECTED_CURRENT_PAGE_COMMAND) {
    throw new Error("Chrome current-page smoke command changed without updating product evidence.");
  }
}

function createFocusStealingLaneSkippedRun({
  command,
  productPath,
  configuredEndpoint,
  launch
}) {
  return {
    command,
    productPath,
    ...(configuredEndpoint ? { configuredEndpoint } : {}),
    ...(launch ? { launch } : {}),
    result: "skipped",
    requiresFocusSteal: true,
    reason: "quiet-background-mode",
    nextAction: "Re-run with --allow-focus-steal to exercise the screenshot fallback lane."
  };
}

async function runChromeNativeHostBridgeSmoke(options) {
  const launchOrigin = `chrome-extension://${FIXTURE_EXTENSION_ID}/`;
  const requestId = "chrome-smoke-native-host";
  const hostPolicyRequestId = "chrome-smoke-host-policy";
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "skfiy-chrome-native-host-"));
  const heartbeatPath = path.join(
    homeDir,
    "Library",
    "Application Support",
    "skfiy",
    "chrome-extension-connection.json"
  );
  const command = [options.cliPath, launchOrigin];
  const message = {
    schemaVersion: 1,
    type: "skfiy.page.observe",
    requestId,
    payload: { currentTab: true }
  };
  const hostPolicyMessage = {
    schemaVersion: 1,
    type: "skfiy.host_policy.request",
    requestId: hostPolicyRequestId
  };

  try {
    const { code, signal, stdout, stderr } = await runNativeHostFrame({
      command,
      homeDir,
      message
    });
    const response = readNativeHostResponse(stdout);
    const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
    const policyRun = await runNativeHostFrame({
      command,
      homeDir,
      message: hostPolicyMessage
    });
    const hostPolicyResponse = readNativeHostResponse(policyRun.stdout);
    const diagnostics = createNativeHostBridgeDiagnostics({
      response,
      hostPolicyResponse,
      heartbeat
    });
    const passed = code === 0
      && signal === null
      && policyRun.code === 0
      && policyRun.signal === null
      && response?.type === "skfiy.native.response"
      && response?.requestId === requestId
      && response?.result === "accepted"
      && hostPolicyResponse?.type === "skfiy.native.response"
      && hostPolicyResponse?.requestId === hostPolicyRequestId
      && hostPolicyResponse?.result === "accepted"
      && hostPolicyResponse?.hostPolicy?.schemaVersion === 1
      && hostPolicyResponse?.hostPolicy?.policy?.defaultMode === "ask"
      && heartbeat?.hostName === "com.sskift.skfiy"
      && heartbeat?.launchOrigin === launchOrigin
      && heartbeat?.messageType === "skfiy.page.observe"
      && heartbeat?.requestId === requestId
      && hasNativeHostBridgeDiagnostics(diagnostics);

    return {
      result: passed ? "passed" : "failed",
      productPath: NATIVE_HOST_BRIDGE_PRODUCT_PATH,
      command,
      exitCode: code,
      signal,
      response,
      hostPolicyExitCode: policyRun.code,
      hostPolicySignal: policyRun.signal,
      hostPolicyResponse,
      diagnostics,
      heartbeatPath,
      heartbeat,
      stderr: [stderr, policyRun.stderr].filter(Boolean).join("\n")
    };
  } catch (error) {
    return {
      result: "error",
      productPath: NATIVE_HOST_BRIDGE_PRODUCT_PATH,
      command,
      heartbeatPath,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function runChromeReadinessDiagnostics(options) {
  const modulePath = path.join(ROOT_DIR, "dist", "main", "chrome-readiness.js");
  const { createChromeReadinessDiagnostics } = await import(pathToFileURL(modulePath).href);
  const extensionId = options.extensionId || FIXTURE_EXTENSION_ID;

  return createChromeReadinessDiagnostics({
    homeDir: os.homedir(),
    cliShimPath: options.cliPath,
    extensionIds: [extensionId],
    extensionPath: path.join(ROOT_DIR, "chrome-extension"),
    approvalProbeCommand: `打开 Chrome 测试页面 https://example.com/skfiy-readiness 并提取正文`
  });
}

async function runInstalledChromeExtensionSmoke(options) {
  const extensionPath = path.join(ROOT_DIR, "chrome-extension");
  const requestId = "chrome-smoke-installed-extension";
  const statusRequestId = "chrome-smoke-extension-status";
  const healthRequestId = "chrome-smoke-page-control-health";
  const homeDir = os.homedir();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "skfiy-chrome-extension-smoke-"));
  const chromeUserDataDir = path.join(tempRoot, "chrome-profile");
  const chromePort = options.chromePort + 2000;
  const browserSelection = selectInstalledExtensionChromeApp({
    chromeAppName: options.chromeAppName,
    extensionChromeAppName: options.extensionChromeAppName,
    availableAppNames: discoverInstalledExtensionChromeAppNames()
  });
  const extensionChromeAppName = browserSelection.chromeAppName;
  const heartbeatPath = path.join(
    homeDir,
    "Library",
    "Application Support",
    "skfiy",
    "chrome-extension-connection.json"
  );
  let manifestPath;
  let profileManifestPath;
  let manifestBackup;
  let heartbeatBackup;
  let extensionId;
  let launchOrigin;
  let extensionPageUrl;
  let response;
  let extensionStatus;
  let pageControlHealth;

  try {
    const firstWorker = await launchChromeWithExtensionAndFindWorker({
      chromeAppName: extensionChromeAppName,
      chromeUserDataDir,
      chromePort,
      extensionPath,
      allowFocusSteal: options.allowFocusSteal,
      timeoutMs: options.timeoutMs
    });
    if (!firstWorker.worker) {
      return createInstalledExtensionLoadBlockedRun({
        chromeAppName: extensionChromeAppName,
        browserSelection,
        chromePort,
        chromeUserDataDir,
        extensionPath,
        allowFocusSteal: options.allowFocusSteal,
        heartbeatPath,
        diagnostic: firstWorker
      });
    }

    const { worker: loadedWorker } = firstWorker;
    extensionId = readExtensionIdFromUrl(loadedWorker.url);
    launchOrigin = `chrome-extension://${extensionId}/`;
    await killChromeSmokeProcesses(chromeUserDataDir);
    await waitForChromeSmokeProcessesExit(chromeUserDataDir);

    manifestPath = createNativeMessagingHostManifestPath(homeDir, extensionChromeAppName);
    manifestBackup = await readOptionalFile(manifestPath);
    heartbeatBackup = await readOptionalFile(heartbeatPath);
    await writeNativeMessagingHostManifest({
      homeDir,
      cliPath: options.cliPath,
      extensionId,
      chromeAppName: extensionChromeAppName
    });
    profileManifestPath = await writeNativeMessagingHostProfileManifest({
      chromeUserDataDir,
      cliPath: options.cliPath,
      extensionId
    });

    const secondWorker = await launchChromeWithExtensionAndFindWorker({
      chromeAppName: extensionChromeAppName,
      chromeUserDataDir,
      chromePort,
      extensionPath,
      allowFocusSteal: options.allowFocusSteal,
      timeoutMs: options.timeoutMs
    });
    if (!secondWorker.worker) {
      return createInstalledExtensionLoadBlockedRun({
        chromeAppName: extensionChromeAppName,
        browserSelection,
        chromePort,
        chromeUserDataDir,
        extensionPath,
        allowFocusSteal: options.allowFocusSteal,
        heartbeatPath,
        manifestPath,
        diagnostic: secondWorker
      });
    }

    extensionPageUrl = secondWorker.worker.url;
    const cdp = await createCdpClient(secondWorker.worker.webSocketDebuggerUrl);
    let heartbeat;
    let heartbeatReadError;

    try {
      await cdp.send("Runtime.enable");
      const evaluation = await cdp.send("Runtime.evaluate", {
        expression: createInstalledExtensionNativeMessageExpression(requestId),
        awaitPromise: true,
        returnByValue: true
      });
      response = readInstalledExtensionNativeMessageEvaluation(evaluation);

      const statusEvaluation = await cdp.send("Runtime.evaluate", {
        expression: createInstalledExtensionStatusExpression(statusRequestId),
        awaitPromise: true,
        returnByValue: true
      });
      extensionStatus = readInstalledExtensionNativeMessageEvaluation(statusEvaluation);

      const healthEvaluation = await cdp.send("Runtime.evaluate", {
        expression: createInstalledExtensionPageControlHealthExpression(healthRequestId),
        awaitPromise: true,
        returnByValue: true
      });
      pageControlHealth = readInstalledExtensionNativeMessageEvaluation(healthEvaluation);

      const finalEvaluation = await cdp.send("Runtime.evaluate", {
        expression: createInstalledExtensionNativeMessageExpression(requestId),
        awaitPromise: true,
        returnByValue: true
      });
      response = readInstalledExtensionNativeMessageEvaluation(finalEvaluation);

      try {
        heartbeat = await readInstalledExtensionHeartbeatForRequest(
          heartbeatPath,
          requestId,
          options.timeoutMs
        );
      } catch (error) {
        heartbeatReadError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      cdp.close();
    }
    const passed = response?.type === "skfiy.native.response"
      && response?.requestId === requestId
      && response?.result === "accepted"
      && hasInstalledExtensionHeartbeatEvidence(heartbeat, launchOrigin)
      && hasInstalledExtensionStatusDiagnostics(extensionStatus, extensionId)
      && hasInstalledExtensionPageControlHealth(pageControlHealth, extensionId);
    const readinessSnapshot = createInstalledExtensionReadinessSnapshot({
      result: passed ? "passed" : "failed",
      extensionId,
      launchOrigin,
      extensionStatus,
      pageControlHealth,
      response,
      heartbeat,
      heartbeatReadError
    });

    return {
      result: passed ? "passed" : "failed",
      productPath: INSTALLED_EXTENSION_PRODUCT_PATH,
      chromeLaunch: formatChromeExtensionLaunchCommand(
        extensionChromeAppName,
        chromePort,
        chromeUserDataDir,
        extensionPath,
        options.allowFocusSteal
      ),
      browserSelection,
      chromePort,
      extensionPath,
      extensionPageUrl,
      extensionId,
      launchOrigin,
      firstWorkerUrl: loadedWorker.url,
      launchAttempts: {
        first: firstWorker.launchAttempts,
        second: secondWorker.launchAttempts
      },
      response,
      extensionStatus,
      pageControlHealth,
      readinessSnapshot,
      heartbeatPath,
      ...(heartbeat ? { heartbeat } : {}),
      ...(heartbeatReadError ? { heartbeatReadError } : {}),
      manifestPath,
      profileManifestPath,
      processesAfterLaunch: await readChromeSmokeProcesses(chromeUserDataDir)
    };
  } catch (error) {
    return {
      result: "error",
      productPath: INSTALLED_EXTENSION_PRODUCT_PATH,
      extensionPath,
      browserSelection,
      chromePort,
      ...(extensionId ? { extensionId } : {}),
      ...(launchOrigin ? { launchOrigin } : {}),
      ...(extensionPageUrl ? { extensionPageUrl } : {}),
      ...(response ? { response } : {}),
      ...(extensionStatus ? { extensionStatus } : {}),
      ...(pageControlHealth ? { pageControlHealth } : {}),
      ...(manifestPath ? { manifestPath } : {}),
      ...(profileManifestPath ? { profileManifestPath } : {}),
      heartbeatPath,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await killChromeSmokeProcesses(chromeUserDataDir);
    await waitForChromeSmokeProcessesExit(chromeUserDataDir);
    if (manifestPath && manifestBackup) {
      await restoreOptionalFile(manifestPath, manifestBackup);
    }
    if (heartbeatBackup) {
      await restoreOptionalFile(heartbeatPath, heartbeatBackup);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function readInstalledExtensionHeartbeatForRequest(heartbeatPath, requestId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastHeartbeat;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8"));
      lastHeartbeat = heartbeat;

      if (
        heartbeat?.requestId === requestId
        || heartbeat?.latestCommand?.requestId === requestId
      ) {
        return heartbeat;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(100);
  }

  if (lastHeartbeat) {
    return lastHeartbeat;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for Chrome extension heartbeat ${requestId}.`);
}

async function runInstalledChromeExtensionActionSmoke(options) {
  if (!options.extensionId) {
    return {
      result: "skipped",
      productPath: INSTALLED_EXTENSION_ACTION_PRODUCT_PATH,
      reason: "extension-id-not-supplied",
      screenshotBlockers: INSTALLED_EXTENSION_ACTION_SCREENSHOT_BLOCKERS,
      nextAction: `Pass --extension-id <id> to run the installed-extension action smoke. Default artifact: ${INSTALLED_EXTENSION_ACTION_SMOKE_ARTIFACT}`
    };
  }

  const extensionId = options.extensionId;
  const browserSelection = selectInstalledExtensionChromeApp({
    chromeAppName: options.chromeAppName,
    extensionChromeAppName: options.extensionChromeAppName,
    availableAppNames: discoverInstalledExtensionChromeAppNames()
  });
  const actionOptions = {
    ...options,
    chromeAppName: browserSelection.chromeAppName,
    extensionChromeAppName: browserSelection.chromeAppName
  };
  const fixture = await createInstalledExtensionActionFixture();
  let cleanupBeforeRun;
  const cleanupBetweenCommands = [];
  let cleanupAfterRun;
  let tabsRun;
  let selectedTargetTab;
  let reloadRun;
  let postReloadOpenRun;
  let postReloadTabsRun;
  let refreshedTargetTab;
  let initialObserveRun;
  let observeRetryRun;
  let observeRun;
  let screenshotRun;
  let fillRun;
  let clickRun;
  let submitRun;
  let scrollRun;
  let finalObserveRun;
  let policyRun;
  let openRun;
  let actionRun;
  const wakeIsolationStrategy = "request-id-during-run";

  const recordRequestIdIsolation = (commandName) => {
    cleanupBetweenCommands.push({
      commandName,
      phase: "between-command",
      result: "skipped",
      reason: "request-id-isolation-during-run"
    });
  };

  const runChromeCliJsonWithWakeIsolation = async (commandName, args) => {
    recordRequestIdIsolation(commandName);
    return runChromeCliJson(actionOptions, commandName, args);
  };

  try {
    cleanupBeforeRun = await closeInstalledExtensionWakeTabs(actionOptions, extensionId);
    const host = new URL(fixture.url).host;
    policyRun = await runChromeCliJson(actionOptions, "chrome policy set", [
      "chrome",
      "policy",
      "set",
      "--host",
      host,
      "--action",
      "always-allow",
      "--json"
    ]);
    openRun = await openInstalledExtensionActionFixture(actionOptions, fixture.url);
    await sleep(Math.max(options.settleMs, 1_000));
    tabsRun = await runChromeCliJson(actionOptions, "chrome tabs", [
      "chrome",
      "tabs",
      "--extension-id",
      extensionId,
      "--json"
    ]);
    selectedTargetTab = selectInstalledExtensionActionTargetTab(
      readInstalledExtensionActionTargetTabs(tabsRun),
      fixture.url
    ) ?? readInstalledExtensionActionOpenedTab(openRun, fixture.url);

    if (!selectedTargetTab?.id) {
      actionRun = {
        result: "blocked",
        productPath: INSTALLED_EXTENSION_ACTION_PRODUCT_PATH,
        runnerHasTmux: Boolean(process.env.TMUX),
        extensionId,
        browserSelection,
        fixtureUrl: fixture.url,
        policyRun,
        openRun,
        tabsRun,
        selectedTargetTab,
        screenshotBlockers: INSTALLED_EXTENSION_ACTION_SCREENSHOT_BLOCKERS,
        reason: "no-eligible-target-tab",
        nextAction: "Open the local HTTP fixture in a normal Chrome tab, grant skfiy host policy and Chrome site access, then rerun smoke:chrome."
      };
    } else {
      const initialTargetTabId = String(selectedTargetTab.id);
      reloadRun = await runChromeCliJsonWithWakeIsolation("chrome reload-extension", [
        "chrome",
        "reload-extension",
        "--extension-id",
        extensionId,
        "--target-tab-id",
        initialTargetTabId,
        "--json"
      ]);
      ({
        postReloadOpenRun,
        postReloadTabsRun,
        refreshedTargetTab
      } = await refreshInstalledExtensionActionTargetTab({
        actionOptions,
        extensionId,
        fixtureUrl: fixture.url,
        runChromeCliJsonWithWakeIsolation,
        settleMs: options.settleMs
      }));
      if (!refreshedTargetTab?.id) {
        actionRun = {
          result: "blocked",
          productPath: INSTALLED_EXTENSION_ACTION_PRODUCT_PATH,
          runnerHasTmux: Boolean(process.env.TMUX),
          extensionId,
          browserSelection,
          fixtureUrl: fixture.url,
          policyRun,
          openRun,
          tabsRun,
          selectedTargetTab,
          screenshotBlockers: INSTALLED_EXTENSION_ACTION_SCREENSHOT_BLOCKERS,
          reloadRun,
          postReloadOpenRun,
          postReloadTabsRun,
          refreshedTargetTab,
          reason: "target-tab-unavailable-after-reload",
          nextAction: "Reload or reopen the local HTTP fixture in Chrome, rerun `skfiy chrome tabs`, then retry the installed-extension action smoke."
        };
      } else {
        const liveTargetTabId = String(refreshedTargetTab.id);
        ({
          initialObserveRun,
          observeRetryRun,
          observeRun
        } = await runInstalledExtensionActionObserveWithRetry({
          extensionId,
          targetTabId: liveTargetTabId,
          runChromeCliJsonWithWakeIsolation,
          settleMs: options.settleMs
        }));
        screenshotRun = await runChromeCliJsonWithWakeIsolation("chrome screenshot", [
          "chrome",
          "screenshot",
          "--extension-id",
          extensionId,
          "--target-tab-id",
          liveTargetTabId,
          "--json"
        ]);
        fillRun = await runChromeCliJsonWithWakeIsolation("chrome fill", [
          "chrome",
          "fill",
          "--extension-id",
          extensionId,
          "--target-tab-id",
          liveTargetTabId,
          "--selector",
          "#name",
          "--text",
          "skfiy",
          "--json"
        ]);
        clickRun = await runChromeCliJsonWithWakeIsolation("chrome click", [
          "chrome",
          "click",
          "--extension-id",
          extensionId,
          "--target-tab-id",
          liveTargetTabId,
          "--selector",
          "#click-only",
          "--json"
        ]);
        submitRun = await runChromeCliJsonWithWakeIsolation("chrome submit", [
          "chrome",
          "submit",
          "--extension-id",
          extensionId,
          "--target-tab-id",
          liveTargetTabId,
          "--selector",
          "form",
          "--json"
        ]);
        scrollRun = await runChromeCliJsonWithWakeIsolation("chrome scroll", [
          "chrome",
          "scroll",
          "--extension-id",
          extensionId,
          "--target-tab-id",
          liveTargetTabId,
          "--dy",
          "600",
          "--json"
        ]);
        finalObserveRun = await runChromeCliJsonWithWakeIsolation("chrome observe", [
          "chrome",
          "observe",
          "--extension-id",
          extensionId,
          "--target-tab-id",
          liveTargetTabId,
          "--json"
        ]);
        const finalVisibleText = readVisibleTextFromChromeCliRun(finalObserveRun);
        actionRun = {
          result: "not-classified",
          productPath: INSTALLED_EXTENSION_ACTION_PRODUCT_PATH,
          runnerHasTmux: Boolean(process.env.TMUX),
          extensionId,
          browserSelection,
          fixtureUrl: fixture.url,
          policyRun,
          openRun,
          tabsRun,
          selectedTargetTab,
          screenshotBlockers: INSTALLED_EXTENSION_ACTION_SCREENSHOT_BLOCKERS,
          reloadRun,
          postReloadOpenRun,
          postReloadTabsRun,
          refreshedTargetTab,
          initialObserveRun,
          observeRetryRun,
          observeRun,
          screenshotRun,
          fillRun,
          clickRun,
          submitRun,
          scrollRun,
          finalObserveRun,
          finalVisibleText
        };
      }
    }
  } catch (error) {
    actionRun = {
      result: "error",
      productPath: INSTALLED_EXTENSION_ACTION_PRODUCT_PATH,
      runnerHasTmux: Boolean(process.env.TMUX),
      extensionId,
      browserSelection,
      fixtureUrl: fixture.url,
      policyRun,
      openRun,
      tabsRun,
      selectedTargetTab,
      screenshotBlockers: INSTALLED_EXTENSION_ACTION_SCREENSHOT_BLOCKERS,
      reloadRun,
      postReloadOpenRun,
      postReloadTabsRun,
      refreshedTargetTab,
      initialObserveRun,
      observeRetryRun,
      observeRun,
      screenshotRun,
      fillRun,
      clickRun,
      submitRun,
      scrollRun,
      finalObserveRun,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    cleanupAfterRun = await closeInstalledExtensionWakeTabs(actionOptions, extensionId);
    const fixtureTabCleanup = await closeInstalledExtensionActionFixtureTabs(
      actionOptions,
      fixture.url
    );
    cleanupAfterRun = {
      ...cleanupAfterRun,
      fixtureTabCleanup
    };
    await fixture.close();
  }

  const runWithCleanup = {
    ...actionRun,
    wakeIsolationStrategy,
    cleanupBeforeRun,
    cleanupBetweenCommands,
    cleanupAfterRun
  };

  if (runWithCleanup.result === "error") {
    return runWithCleanup;
  }

  const classification = classifyInstalledExtensionActionSmokeEvidence(runWithCleanup);
  return {
    ...runWithCleanup,
    result: classification,
    classification
  };
}

async function createInstalledExtensionActionFixture() {
  const server = createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(`<!doctype html>
<html>
  <head>
    <title>skfiy installed-extension action smoke</title>
    <style>
      body { font-family: system-ui, sans-serif; min-height: 1800px; }
      main { max-width: 640px; margin: 40px auto; }
      label { display: block; margin: 12px 0; }
      #scroll-target { margin-top: 1200px; }
    </style>
  </head>
  <body>
    <main>
      <h1>skfiy action smoke ready</h1>
      <form id="profile">
        <label>Name <input id="name" name="name" autocomplete="off" /></label>
        <button id="click-only" type="button">Click</button>
        <button id="submit" type="submit">Submit</button>
      </form>
      <p id="result">clicked 0 submitted none #0</p>
      <p id="scroll-target">scroll target ready</p>
    </main>
    <script>
      const state = { clicked: 0, submitted: 0, name: "none" };
      const render = () => {
        document.querySelector("#result").textContent =
          "clicked " + state.clicked + " submitted " + state.name + " #" + state.submitted;
      };
      document.querySelector("#click-only").addEventListener("click", () => {
        state.clicked += 1;
        state.name = document.querySelector("#name").value || "none";
        render();
      });
      document.querySelector("#profile").addEventListener("submit", (event) => {
        event.preventDefault();
        state.submitted += 1;
        state.name = document.querySelector("#name").value || "none";
        render();
      });
      render();
    </script>
  </body>
</html>
`);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Installed-extension action fixture did not bind a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/?skfiy_action_live=smoke`,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}

async function openInstalledExtensionActionFixture(options, url) {
  if (options.allowFocusSteal !== true) {
    return openInstalledExtensionActionFixtureWithCdp(options, url);
  }

  return openInstalledExtensionActionFixtureWithAppleEvents(options, url);
}

async function openInstalledExtensionActionFixtureWithCdp(options, url) {
  const endpoint = `http://127.0.0.1:${options.chromePort}`;
  const command = ["cdp", "Target.createTarget", endpoint, url];

  try {
    const response = await fetch(`${endpoint}/json/version`);
    if (!response.ok) {
      throw new Error(`Chrome CDP returned HTTP ${response.status}.`);
    }
    const version = await response.json();
    const cdp = await createCdpClient(version.webSocketDebuggerUrl);
    try {
      const target = await cdp.send("Target.createTarget", {
        url,
        background: true
      });
      return {
        command,
        result: "launched",
        launchStrategy: "cdp-target-create",
        openedTab: {
          id: target.targetId,
          url,
          title: "",
          eligible: true,
          state: "eligible",
          source: "cdp-target-create"
        },
        stdout: JSON.stringify(target),
        stderr: ""
      };
    } finally {
      cdp.close();
    }
  } catch (error) {
    return {
      command,
      result: "error",
      launchStrategy: "cdp-target-create",
      exitCode: 1,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function openInstalledExtensionActionFixtureWithAppleEvents(options, url) {
  const script = `
tell application "${options.chromeAppName}"
  if not running then launch
  if (count of windows) = 0 then make new window
  tell window 1
    set skfiyNewTab to make new tab at end of tabs with properties {URL:${JSON.stringify(url)}}
    set active tab index to (count of tabs)
    delay 0.2
    return ((id of skfiyNewTab) as string) & "\t" & (URL of skfiyNewTab) & "\t" & (title of skfiyNewTab)
  end tell
end tell
`;
  const command = ["osascript", "-e", script];

  try {
    const { stdout, stderr } = await execFileAsync(command[0], command.slice(1));
    return {
      command,
      result: "launched",
      launchStrategy: "apple-events-new-tab",
      openedTab: parseInstalledExtensionActionOpenedTab(stdout, url),
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (error) {
    return {
      command,
      result: "error",
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseInstalledExtensionActionOpenedTab(stdout, expectedUrl) {
  const [idText, url = "", title = ""] = String(stdout ?? "").trim().split("\t");
  const id = Number(idText);

  if (!Number.isFinite(id) || id <= 0) {
    return undefined;
  }

  return {
    id,
    url: url || expectedUrl,
    title,
    eligible: true,
    state: "eligible",
    source: "apple-events-new-tab"
  };
}

function readInstalledExtensionActionOpenedTab(openRun, fixtureUrl) {
  const openedTab = readRecord(openRun?.openedTab);
  if (!openedTab) {
    return undefined;
  }

  if (!isInstalledExtensionActionFixtureUrl(openedTab.url, fixtureUrl)) {
    return undefined;
  }

  return openedTab;
}

async function refreshInstalledExtensionActionTargetTab({
  actionOptions,
  extensionId,
  fixtureUrl,
  runChromeCliJsonWithWakeIsolation,
  settleMs
}) {
  const postReloadOpenRun = await openInstalledExtensionActionFixture(actionOptions, fixtureUrl);
  await sleep(Math.max(settleMs ?? 0, 500));
  const postReloadTabsRun = await runChromeCliJsonWithWakeIsolation("chrome tabs post-reload", [
    "chrome",
    "tabs",
    "--extension-id",
    extensionId,
    "--json"
  ]);
  const refreshedTargetTab = selectInstalledExtensionActionTargetTab(
    readInstalledExtensionActionTargetTabs(postReloadTabsRun),
    fixtureUrl
  ) ?? readInstalledExtensionActionOpenedTab(postReloadOpenRun, fixtureUrl);

  return {
    postReloadOpenRun,
    postReloadTabsRun,
    refreshedTargetTab
  };
}

async function runInstalledExtensionActionObserveWithRetry({
  extensionId,
  targetTabId,
  runChromeCliJsonWithWakeIsolation,
  settleMs
}) {
  const runObserve = () => runChromeCliJsonWithWakeIsolation("chrome observe", [
    "chrome",
    "observe",
    "--extension-id",
    extensionId,
    "--target-tab-id",
    targetTabId,
    "--json"
  ]);
  const initialObserveRun = await runObserve();
  if (!isRetriableInstalledExtensionActionObserveRun(initialObserveRun)) {
    return {
      observeRun: initialObserveRun
    };
  }

  await sleep(Math.max(settleMs ?? 0, 500));
  const observeRetryRun = await runObserve();
  return {
    initialObserveRun,
    observeRetryRun,
    observeRun: observeRetryRun
  };
}

function isRetriableInstalledExtensionActionObserveRun(run) {
  const pageControl = readRecord(run?.extensionConnection?.pageControl);
  return run?.result === "blocked"
    && run.reason === "page-control-observe-not-verified"
    && pageControl?.state === "ready";
}

function isInstalledExtensionActionFixtureUrl(value, fixtureUrl) {
  try {
    const url = new URL(String(value ?? ""));
    const fixture = new URL(String(fixtureUrl ?? ""));

    return url.origin === fixture.origin
      && url.pathname === fixture.pathname
      && (
        url.search === fixture.search
        || (
          url.searchParams.get("skfiy_action_live") === "<redacted>"
          && fixture.searchParams.has("skfiy_action_live")
        )
      );
  } catch {
    return false;
  }
}

async function closeInstalledExtensionActionFixtureTabs(options, url) {
  const chromeAppName = options.chromeAppName;
  const fixtureUrlPrefix = String(url);
  const script = `
(() => {
const chromeAppName = ${JSON.stringify(chromeAppName)};
const fixtureUrlPrefix = ${JSON.stringify(fixtureUrlPrefix)};
const chrome = Application(chromeAppName);
let closedCount = 0;

if (!chrome.running()) {
  return JSON.stringify({ chromeRunning: false, closedCount, fixtureUrlPrefix });
}

for (const window of chrome.windows()) {
  const tabs = window.tabs();
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    const url = String(tab.url() || "");
    if (url.startsWith(fixtureUrlPrefix)) {
      tab.close();
      closedCount += 1;
    }
  }
}
return JSON.stringify({ chromeRunning: true, closedCount, fixtureUrlPrefix });
})();
`;
  const command = ["osascript", "-l", "JavaScript", "-e", script];

  try {
    const { stdout, stderr } = await execFileAsync(command[0], command.slice(1));
    const parsed = JSON.parse(stdout.trim() || "{}");

    return {
      command,
      result: "passed",
      chromeAppName,
      fixtureUrlPrefix,
      chromeRunning: parsed.chromeRunning === true,
      closedCount: Number.isInteger(parsed.closedCount) ? parsed.closedCount : 0,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (error) {
    return {
      command,
      result: "blocked",
      chromeAppName,
      fixtureUrlPrefix,
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function closeInstalledExtensionWakeTabs(options, extensionId) {
  const chromeAppName = options.chromeAppName;
  const wakeUrlPrefix = `chrome-extension://${extensionId}/popup.html?skfiyWake=`;
  const script = `
(() => {
const chromeAppName = ${JSON.stringify(chromeAppName)};
const wakeUrlPrefix = ${JSON.stringify(wakeUrlPrefix)};
const chrome = Application(chromeAppName);
let closedCount = 0;

if (!chrome.running()) {
  return JSON.stringify({ chromeRunning: false, closedCount, wakeUrlPrefix });
}

for (const window of chrome.windows()) {
  const tabs = window.tabs();
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    const url = String(tab.url() || "");
    if (url.startsWith(wakeUrlPrefix)) {
      tab.close();
      closedCount += 1;
    }
  }
}
return JSON.stringify({ chromeRunning: true, closedCount, wakeUrlPrefix });
})();
`;
  const command = ["osascript", "-l", "JavaScript", "-e", script];

  try {
    const { stdout, stderr } = await execFileAsync(command[0], command.slice(1));
    const parsed = JSON.parse(stdout.trim() || "{}");

    return {
      command,
      result: "passed",
      chromeAppName,
      extensionId,
      wakeUrlPrefix,
      chromeRunning: parsed.chromeRunning === true,
      closedCount: Number.isInteger(parsed.closedCount) ? parsed.closedCount : 0,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (error) {
    return {
      command,
      result: "blocked",
      chromeAppName,
      extensionId,
      wakeUrlPrefix,
      closedCount: 0,
      reason: "wake-tab-cleanup-failed",
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runChromeCliJson(options, commandName, args) {
  const command = [options.cliPath, ...args];
  const chromeAppName = options.extensionChromeAppName || options.chromeAppName;
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let stdoutJson;

  try {
    const result = await execFileAsync(command[0], command.slice(1), {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ...(chromeAppName ? { SKFIY_CHROME_APP_NAME: chromeAppName } : {})
      },
      maxBuffer: 4 * 1024 * 1024
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    exitCode = typeof error.code === "number" ? error.code : 1;
    stdout = typeof error.stdout === "string" ? error.stdout : "";
    stderr = typeof error.stderr === "string" ? error.stderr : "";
  }

  try {
    stdoutJson = stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch (error) {
    stdoutJson = {
      result: "error",
      reason: "invalid-json",
      error: error instanceof Error ? error.message : String(error)
    };
  }

  return {
    commandName,
    command,
    exitCode,
    stderr: stderr.trim(),
    ...(stdoutJson && typeof stdoutJson === "object" ? stdoutJson : { stdout: stdout.trim() })
  };
}

function readVisibleTextFromChromeCliRun(run) {
  const extensionConnection = readRecord(run?.extensionConnection);
  const latestCommand = readRecord(extensionConnection?.latestCommand);
  const pageObservation = readRecord(extensionConnection?.pageObservation)
    ?? readRecord(latestCommand?.pageObservation);

  return typeof pageObservation?.visibleText === "string" ? pageObservation.visibleText : "";
}

async function launchChromeWithExtension({
  chromeAppName,
  chromeUserDataDir,
  chromePort,
  extensionPath,
  allowFocusSteal = false
}) {
  await execFileAsync("open", [
    "-n",
    ...(allowFocusSteal === true ? [] : ["-g"]),
    "-a",
    chromeAppName,
    "--args",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${chromeUserDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "about:blank"
  ]);
}

async function launchChromeWithExtensionAndFindWorker({
  chromeAppName,
  chromeUserDataDir,
  chromePort,
  extensionPath,
  allowFocusSteal = false,
  timeoutMs
}) {
  let diagnostic;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await launchChromeWithExtension({
      chromeAppName,
      chromeUserDataDir,
      chromePort,
      extensionPath,
      allowFocusSteal
    });
    diagnostic = await findSkfiyExtensionWorker(chromePort, timeoutMs);
    if (diagnostic.worker) {
      return {
        ...diagnostic,
        launchAttempts: attempt
      };
    }

    if (attempt < 2) {
      await killChromeSmokeProcesses(chromeUserDataDir);
      await waitForChromeSmokeProcessesExit(chromeUserDataDir);
    }
  }

  return {
    ...diagnostic,
    launchAttempts: 2
  };
}

async function writeNativeMessagingHostManifest({
  homeDir,
  cliPath,
  extensionId,
  chromeAppName
}) {
  const manifestPath = createNativeMessagingHostManifestPath(homeDir, chromeAppName);
  const manifest = createNativeMessagingHostManifest({
    cliPath,
    extensionId
  });

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return manifestPath;
}

async function writeNativeMessagingHostProfileManifest({
  chromeUserDataDir,
  cliPath,
  extensionId
}) {
  const manifestPath = createNativeMessagingHostProfileManifestPath(chromeUserDataDir);
  const manifest = createNativeMessagingHostManifest({
    cliPath,
    extensionId
  });

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return manifestPath;
}

function createNativeMessagingHostManifest({
  cliPath,
  extensionId
}) {
  return {
    name: "com.sskift.skfiy",
    description: "skfiy desktop Computer Use bridge",
    path: cliPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
}

function createNativeMessagingHostManifestPath(homeDir, chromeAppName = "") {
  const supportRoot = readChromeNativeMessagingSupportRoot(chromeAppName);
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    ...supportRoot,
    "NativeMessagingHosts",
    "com.sskift.skfiy.json"
  );
}

function createNativeMessagingHostProfileManifestPath(chromeUserDataDir) {
  return path.join(
    chromeUserDataDir,
    "NativeMessagingHosts",
    "com.sskift.skfiy.json"
  );
}

function readChromeNativeMessagingSupportRoot(chromeAppName) {
  if (/Chrome for Testing/i.test(chromeAppName)) {
    return ["Google", "ChromeForTesting"];
  }

  if (/Chromium/i.test(chromeAppName)) {
    return ["Chromium"];
  }

  return ["Google", "Chrome"];
}

function discoverInstalledExtensionChromeAppNames() {
  const appNames = [
    "Google Chrome for Testing",
    "Chromium",
    "Google Chrome"
  ];

  return appNames.filter((appName) => isMacAppInstalled(appName));
}

function isMacAppInstalled(appName) {
  return [
    path.join("/Applications", `${appName}.app`),
    path.join(os.homedir(), "Applications", `${appName}.app`)
  ].some((appPath) => existsSync(appPath));
}

function formatChromeExtensionLaunchCommand(
  chromeAppName,
  chromePort,
  chromeUserDataDir,
  extensionPath,
  allowFocusSteal = false
) {
  const noFocusFlag = allowFocusSteal === true ? "" : " -g";
  return `open -n${noFocusFlag} -a ${chromeAppName} --args --remote-debugging-port=${chromePort} --user-data-dir=${chromeUserDataDir} --load-extension=${extensionPath}`;
}

async function readOptionalFile(targetPath) {
  if (!existsSync(targetPath)) {
    return { exists: false, content: "" };
  }

  return {
    exists: true,
    content: await readFile(targetPath, "utf8")
  };
}

async function restoreOptionalFile(targetPath, backup) {
  if (backup.exists) {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, backup.content);
    return;
  }

  await rm(targetPath, { force: true });
}

function createInstalledExtensionLoadBlockedRun({
  chromeAppName,
  browserSelection,
  chromePort,
  chromeUserDataDir,
  extensionPath,
  allowFocusSteal = false,
  heartbeatPath,
  manifestPath,
  diagnostic
}) {
  const blockedReason = isBrandedChromeLoadExtensionRemoved({
    chromeAppName,
    chromeVersion: diagnostic.chromeVersion
  })
    ? "branded_chrome_load_extension_removed"
    : "skfiy_extension_worker_not_loaded";
  const result = blockedReason === "branded_chrome_load_extension_removed" ? "blocked" : "error";
  const remediation = createInstalledExtensionBlockerRemediation({
    blockedReason,
    chromeAppName,
    chromeVersion: diagnostic.chromeVersion,
    recommendedBrowser: "Chrome for Testing or Chromium"
  });
  const blockers = createInstalledExtensionBlockers({
    blockedReason,
    chromeAppName,
    chromeVersion: diagnostic.chromeVersion,
    recommendedBrowser: "Chrome for Testing or Chromium"
  });

  return {
    result,
    productPath: INSTALLED_EXTENSION_PRODUCT_PATH,
    chromeLaunch: formatChromeExtensionLaunchCommand(
      chromeAppName,
      chromePort,
      chromeUserDataDir,
      extensionPath,
      allowFocusSteal
    ),
    browserSelection,
    chromePort,
    chromeVersion: diagnostic.chromeVersion,
    extensionPath,
    heartbeatPath,
    ...(manifestPath ? { manifestPath } : {}),
    ...(diagnostic.launchAttempts ? { launchAttempts: diagnostic.launchAttempts } : {}),
    blockedReason,
    blockers,
    remediation,
    readinessSnapshot: createInstalledExtensionReadinessSnapshot({
      result,
      blockedReason,
      blockers,
      remediation
    }),
    recommendedBrowser: "Chrome for Testing or Chromium",
    diagnosticTargets: diagnostic.targets,
    diagnosticExtensions: diagnostic.extensions
  };
}

function isInstalledExtensionSmokeAcceptable(run) {
  return run?.result === "passed"
    || (
      run?.result === "blocked"
      && run?.blockedReason === "branded_chrome_load_extension_removed"
    );
}

function isInstalledExtensionActionSmokeAcceptable(run) {
  return !run
    || run.result === "skipped"
    || run.result === "passed"
    || run.result === "screenshot-blocked";
}

function createChromeSmokePageControlEvidence(evidence) {
  const action = readChromeSmokePageControlFromInstalledExtensionAction(
    evidence.installedExtensionActionRun
  );

  if (action) {
    return normalizeChromeSmokePageControlEvidence(
      action.record,
      action.source
    );
  }

  const reportedHealth = readChromeSmokePageControlFromExtensionHealth(
    evidence.installedExtensionRun?.pageControlHealth
  );

  if (reportedHealth) {
    return normalizeChromeSmokePageControlEvidence(
      reportedHealth.record,
      reportedHealth.source
    );
  }

  const reported = readChromeSmokePageControlFromExtensionStatus(
    evidence.installedExtensionRun?.extensionStatus
  );

  if (reported) {
    return normalizeChromeSmokePageControlEvidence(
      reported.record,
      reported.source
    );
  }

  const installedExtensionRun = evidence.installedExtensionRun;
  if (
    installedExtensionRun?.result === "blocked"
    && installedExtensionRun.blockedReason === "branded_chrome_load_extension_removed"
  ) {
    return {
      schemaVersion: 1,
      capability: "chrome-extension-page-control",
      state: "unavailable",
      capable: false,
      reason: "Installed Chrome extension pageControl could not be probed because branded Chrome blocked automated unpacked extension loading.",
      nextAction: "Use Chrome for Testing, Chromium, or a manually installed skfiy extension, then rerun `npm run smoke:chrome`.",
      source: "installed-extension-run",
      capabilities: {},
      blockers: [
        {
          code: installedExtensionRun.blockedReason,
          message: "Google Chrome 137+ branded builds remove automated --load-extension support for this proof path.",
          nextAction: installedExtensionRun.remediation?.nextAction,
          docsPath: installedExtensionRun.remediation?.docsPath,
          recommendedBrowser: installedExtensionRun.recommendedBrowser ?? "Chrome for Testing or Chromium"
        }
      ],
      remediation: installedExtensionRun.remediation ?? null,
      browserSelection: installedExtensionRun.browserSelection ?? null
    };
  }

  const nativeHostState = evidence.readinessDiagnostics?.nativeHost?.state;
  const liveConnection = evidence.readinessDiagnostics?.liveConnection?.liveConnection;
  return {
    schemaVersion: 1,
    capability: "chrome-extension-page-control",
    state: "not-probed",
    capable: false,
    reason: "Chrome smoke did not receive pageControl readiness from an installed skfiy extension.",
    nextAction: "Load the skfiy extension in Chrome for Testing, Chromium, or a manually installed Chrome extension session, then rerun `npm run smoke:chrome`.",
    source: "chrome-smoke",
    capabilities: {},
    evidence: {
      ...(typeof nativeHostState === "string" ? { nativeHostState } : {}),
      ...(typeof liveConnection === "string" ? { liveConnection } : {})
    }
  };
}

function readChromeSmokePageControlFromInstalledExtensionAction(actionRun) {
  const run = readRecord(actionRun);
  if (!run) {
    return undefined;
  }

  const names = [
    "finalObserveRun",
    "scrollRun",
    "submitRun",
    "clickRun",
    "fillRun",
    "screenshotRun",
    "observeRun",
    "reloadRun"
  ];
  const candidates = [];

  for (const name of names) {
    const step = readRecord(run[name]);
    const connection = readRecord(step?.extensionConnection);
    const latestCommand = readRecord(connection?.latestCommand);
    const pageActionResult = readRecord(latestCommand?.pageActionResult);
    const pageObservation = readRecord(latestCommand?.pageObservation)
      ?? readRecord(connection?.pageObservation);

    candidates.push(
      [readRecord(connection?.pageControl), `installedExtensionActionRun.${name}.extensionConnection.pageControl`],
      [readRecord(latestCommand?.pageControl), `installedExtensionActionRun.${name}.extensionConnection.latestCommand.pageControl`],
      [readRecord(pageActionResult?.pageControl), `installedExtensionActionRun.${name}.extensionConnection.latestCommand.pageActionResult.pageControl`],
      [readRecord(pageObservation?.pageControl), `installedExtensionActionRun.${name}.extensionConnection.pageObservation.pageControl`]
    );
  }

  const ready = candidates.find(([record]) => record?.state === "ready" || record?.capable === true);
  if (ready) {
    return { record: ready[0], source: ready[1] };
  }

  const fallback = candidates.find(([record]) => record);
  return fallback ? { record: fallback[0], source: fallback[1] } : undefined;
}

function readChromeSmokePageControlFromExtensionHealth(health) {
  const candidates = [
    [readRecord(health?.pageControl), "installedExtensionRun.pageControlHealth.pageControl"],
    [readRecord(health?.readiness), "installedExtensionRun.pageControlHealth.readiness"],
    [readRecord(readRecord(health?.diagnostics)?.session)?.pageControl, "installedExtensionRun.pageControlHealth.diagnostics.session.pageControl"]
  ];

  for (const [record, source] of candidates) {
    if (record) {
      return { record, source };
    }
  }

  return undefined;
}

function readChromeSmokePageControlFromExtensionStatus(status) {
  const diagnostics = readRecord(status?.diagnostics);
  const candidates = [
    [readRecord(status?.pageControl), "extensionStatus.pageControl"],
    [readRecord(diagnostics?.pageControl), "extensionStatus.diagnostics.pageControl"],
    [readRecord(readRecord(diagnostics?.currentTab)?.pageControl), "extensionStatus.diagnostics.currentTab.pageControl"],
    [readRecord(readRecord(diagnostics?.session)?.pageControl), "extensionStatus.diagnostics.session.pageControl"]
  ];

  for (const [record, source] of candidates) {
    if (record) {
      return { record, source };
    }
  }

  return undefined;
}

function hasInstalledExtensionHeartbeatEvidence(heartbeat, launchOrigin) {
  const record = readRecord(heartbeat);

  return record?.hostName === "com.sskift.skfiy"
    && record?.launchOrigin === launchOrigin;
}

function normalizeChromeSmokePageControlEvidence(pageControl, source) {
  const capabilities = readRecord(pageControl.capabilities) ?? {};
  const state = typeof pageControl.state === "string" && pageControl.state.length > 0
    ? pageControl.state
    : "not-probed";

  return {
    ...pageControl,
    schemaVersion: 1,
    capability: "chrome-extension-page-control",
    state,
    capable: typeof pageControl.capable === "boolean"
      ? pageControl.capable
      : isChromeSmokePageControlCapable(state, capabilities),
    reason: typeof pageControl.reason === "string" && pageControl.reason.length > 0
      ? pageControl.reason
      : "Installed extension reported pageControl readiness without a reason.",
    nextAction: typeof pageControl.nextAction === "string" && pageControl.nextAction.length > 0
      ? pageControl.nextAction
      : createChromeSmokePageControlNextAction(state),
    source: typeof pageControl.source === "string" && pageControl.source.length > 0
      ? pageControl.source
      : source,
    capabilities
  };
}

function isChromeSmokePageControlCapable(state, capabilities) {
  return ["ready", "partial", "sensitive-paused", "needs_confirmation"].includes(state)
    && Object.values(capabilities).some((value) => value === true || value === "background_required");
}

function createChromeSmokePageControlNextAction(state) {
  switch (state) {
    case "ready":
    case "partial":
      return "Use extension pageControl for Chrome Computer Use.";
    case "sensitive-paused":
    case "needs_confirmation":
      return "Ask for explicit confirmation before continuing page actions.";
    case "blocked_by_host_policy":
      return "Allow the active host in skfiy Chrome host policy, then rerun diagnostics.";
    case "blocked_by_chrome_host_permission":
      return "Grant Chrome site access for the active host, then rerun diagnostics.";
    case "content_script_not_loaded":
    case "not_loaded":
      return "Reload the active page or extension so the content script can report controls.";
    case "unavailable":
    case "active_tab_unavailable":
      return "Open an active controllable Chrome tab, then rerun extension diagnostics.";
    default:
      return "Rerun Chrome extension diagnostics after loading the skfiy extension.";
  }
}

function readRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function isBrandedChromeLoadExtensionRemoved({ chromeAppName, chromeVersion }) {
  return /Google Chrome/i.test(chromeAppName)
    && !/Chrome for Testing/i.test(chromeAppName)
    && readChromeMajorVersion(chromeVersion) >= 137;
}

function readChromeMajorVersion(chromeVersion) {
  const matched = String(chromeVersion ?? "").match(/(?:Chrome|Chromium)\/(\d+)/i);
  return matched ? Number.parseInt(matched[1], 10) : 0;
}

async function findSkfiyExtensionWorker(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  let lastExtensions = [];
  let chromeVersion = "";
  let lastError;

  while (Date.now() < deadline) {
    try {
      chromeVersion = chromeVersion || await readChromeVersion(port).catch(() => "");
      const targets = await readChromeTargets(port);
      lastTargets = targets;
      lastExtensions = [];
      const workers = targets.filter((target) =>
        target.type === "service_worker"
          && typeof target.url === "string"
          && target.url.startsWith("chrome-extension://")
          && typeof target.webSocketDebuggerUrl === "string"
      );

      for (const worker of workers) {
        const extension = await readExtensionWorkerIdentity(worker).catch((error) => ({
          url: worker.url,
          error: error instanceof Error ? error.message : String(error)
        }));
        lastExtensions.push(extension);

        if (extension.manifestName === "skfiy Chrome Adapter") {
          return {
            worker,
            targets: summarizeChromeTargets(lastTargets),
            extensions: lastExtensions,
            chromeVersion
          };
        }
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  return {
    worker: undefined,
    targets: summarizeChromeTargets(lastTargets),
    extensions: lastExtensions,
    chromeVersion,
    error: lastError instanceof Error ? lastError.message : undefined
  };
}

async function readChromeVersion(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) {
    throw new Error(`Chrome CDP version endpoint returned HTTP ${response.status}.`);
  }

  const version = await response.json();
  return typeof version.Browser === "string" ? version.Browser : "";
}

async function readChromeTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`Chrome CDP target list returned HTTP ${response.status}.`);
  }

  return response.json();
}

function summarizeChromeTargets(targets) {
  return targets.map((target) => ({
    type: target.type,
    url: target.url,
    title: target.title
  }));
}

async function readExtensionWorkerIdentity(worker) {
  const cdp = await createCdpClient(worker.webSocketDebuggerUrl);

  try {
    await cdp.send("Runtime.enable");
    const evaluation = await cdp.send("Runtime.evaluate", {
      expression: "JSON.stringify({ id: chrome.runtime.id, manifestName: chrome.runtime.getManifest().name, permissions: chrome.runtime.getManifest().permissions ?? [] })",
      awaitPromise: true,
      returnByValue: true
    });
    const value = evaluation.result?.value;
    const parsed = typeof value === "string" ? JSON.parse(value) : {};

    return {
      url: worker.url,
      id: parsed.id,
      manifestName: parsed.manifestName,
      permissions: parsed.permissions
    };
  } finally {
    cdp.close();
  }
}

function readExtensionIdFromUrl(url) {
  const matched = url.match(/^chrome-extension:\/\/([^/]+)\//);
  if (!matched?.[1]) {
    throw new Error(`Could not read extension id from URL: ${url}`);
  }

  return matched[1];
}

function createInstalledExtensionNativeMessageExpression(requestId) {
  return `(() => new Promise((resolve) => {
    const finishJson = (response) => resolve(JSON.stringify(response));
    if (typeof chrome.runtime.connectNative !== "function") {
      finishJson({
        type: "skfiy.native.message",
        schemaVersion: 1,
        requestId: ${JSON.stringify(requestId)},
        ok: false,
        error: "native_messaging_api_unavailable",
        runtimeKeys: Object.keys(chrome.runtime).sort(),
        manifestPermissions: chrome.runtime.getManifest().permissions ?? []
      });
      return;
    }

    const port = chrome.runtime.connectNative("com.sskift.skfiy");
    let settled = false;
    const timeout = setTimeout(() => finish({
      type: "skfiy.native.message",
      schemaVersion: 1,
      requestId: ${JSON.stringify(requestId)},
      ok: false,
      error: "native_host_timeout"
    }), 5000);
    const finish = (response) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        port.disconnect();
      } catch {}
      finishJson(response);
    };
    port.onMessage.addListener((response) => finish(response));
    port.onDisconnect.addListener(() => finish({
      type: "skfiy.native.message",
      schemaVersion: 1,
      requestId: ${JSON.stringify(requestId)},
      ok: false,
      error: chrome.runtime.lastError?.message ?? "native_host_disconnected"
    }));
    port.postMessage({
      schemaVersion: 1,
      type: "skfiy.page.observe",
      requestId: ${JSON.stringify(requestId)},
      payload: { currentTab: true }
    });
  }))()`;
}

function createInstalledExtensionStatusExpression(requestId) {
  return `(() => Promise.resolve()
    .then(async () => {
      if (globalThis.skfiyChromeAdapterDiagnostics?.refreshHostPolicy) {
        return globalThis.skfiyChromeAdapterDiagnostics.refreshHostPolicy(${JSON.stringify(requestId)});
      }

      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          schemaVersion: 1,
          type: "skfiy.host_policy.sync_refresh",
          requestId: ${JSON.stringify(requestId)}
        }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              type: "skfiy.host_policy.response",
              schemaVersion: 1,
              requestId: ${JSON.stringify(requestId)},
              ok: false,
              error: chrome.runtime.lastError.message
            });
            return;
          }

          resolve(response);
        });
      });
    })
    .then((response) => JSON.stringify(response))
    .catch((error) => JSON.stringify({
      type: "skfiy.host_policy.response",
      schemaVersion: 1,
      requestId: ${JSON.stringify(requestId)},
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })))()`;
}

function createInstalledExtensionPageControlHealthExpression(requestId) {
  return `(() => Promise.resolve()
    .then(async () => {
      if (globalThis.skfiyChromeAdapterDiagnostics?.readPageControlHealth) {
        return globalThis.skfiyChromeAdapterDiagnostics.readPageControlHealth(${JSON.stringify(requestId)});
      }

      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          schemaVersion: 1,
          type: "skfiy.page_control.health",
          requestId: ${JSON.stringify(requestId)}
        }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              type: "skfiy.page_control.health_result",
              schemaVersion: 1,
              requestId: ${JSON.stringify(requestId)},
              ok: false,
              error: chrome.runtime.lastError.message
            });
            return;
          }

          resolve(response);
        });
      });
    })
    .then((response) => JSON.stringify(response))
    .catch((error) => JSON.stringify({
      type: "skfiy.page_control.health_result",
      schemaVersion: 1,
      requestId: ${JSON.stringify(requestId)},
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })))()`;
}

function readInstalledExtensionNativeMessageEvaluation(evaluation) {
  const value = evaluation.result?.value;
  if (typeof value !== "string") {
    return {
      ok: false,
      error: "extension_evaluation_not_json",
      valueType: typeof value,
      resultType: evaluation.result?.type,
      resultSubtype: evaluation.result?.subtype,
      exceptionText: evaluation.exceptionDetails?.text,
      exceptionDescription: evaluation.exceptionDetails?.exception?.description
    };
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return {
      ok: false,
      error: "extension_evaluation_invalid_json",
      raw: value,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function createNativeHostBridgeDiagnostics({
  response,
  hostPolicyResponse,
  heartbeat
}) {
  const hostPolicy = hostPolicyResponse?.hostPolicy;

  return {
    schemaVersion: 1,
    nativeHost: {
      name: "com.sskift.skfiy",
      heartbeatState: heartbeat?.hostName === "com.sskift.skfiy" ? "recorded" : "missing",
      policyState: hostPolicy?.state ?? "unknown",
      launchOrigin: response?.launchOrigin ?? heartbeat?.launchOrigin ?? null,
      messageType: response?.messageType ?? heartbeat?.messageType ?? null,
      responseResult: response?.result ?? null,
      lastError: response?.error ?? response?.reason ?? hostPolicyResponse?.error ?? hostPolicyResponse?.reason ?? null
    },
    capabilities: {
      nativeMessaging: true,
      hostPolicySync: true,
      connectionHeartbeat: true
    },
    hostPolicy: {
      schemaVersion: hostPolicy?.schemaVersion ?? 1,
      state: hostPolicy?.state ?? "unknown",
      defaultMode: hostPolicy?.policy?.defaultMode ?? "ask",
      entryCount: countChromeHostPolicyEntries(hostPolicy?.policy),
      allowedHosts: Array.isArray(hostPolicy?.policy?.allowedHosts)
        ? hostPolicy.policy.allowedHosts.length
        : 0,
      currentTurnAllowedHosts: Array.isArray(hostPolicy?.policy?.currentTurnAllowedHosts)
        ? hostPolicy.policy.currentTurnAllowedHosts.length
        : 0,
      blockedHosts: Array.isArray(hostPolicy?.policy?.blockedHosts)
        ? hostPolicy.policy.blockedHosts.length
        : 0
    }
  };
}

function hasInstalledExtensionStatusDiagnostics(status, extensionId) {
  return status
    && typeof status === "object"
    && status.type === "skfiy.host_policy.response"
    && status.requestId === "chrome-smoke-extension-status"
    && status.syncStatus?.state === "synced"
    && status.syncStatus?.source === "native_host"
    && status.syncStatus?.lastError === null
    && status.syncStatus?.nativeBridgeState === "connected"
    && status.syncStatus?.nativeLaunchOrigin === `chrome-extension://${extensionId}/`
    && status.syncStatus?.nativeMessageType === "skfiy.host_policy.request"
    && (
      status.syncStatus?.hostPolicyState === "default"
      || status.syncStatus?.hostPolicyState === "configured"
      || status.syncStatus?.hostPolicyState === "invalid"
    )
    && status.diagnostics?.extension?.id === extensionId
    && typeof status.diagnostics?.extension?.version === "string"
    && status.diagnostics.extension.version.length > 0
    && status.diagnostics?.capabilities?.nativeMessaging === true
    && status.diagnostics?.capabilities?.scripting === true
    && status.diagnostics?.nativeHost?.name === "com.sskift.skfiy"
    && status.diagnostics?.nativeHost?.bridgeState === "connected"
    && status.diagnostics?.nativeHost?.launchOrigin === `chrome-extension://${extensionId}/`
    && status.diagnostics?.nativeHost?.messageType === "skfiy.host_policy.request"
    && status.diagnostics?.nativeHost?.lastError === null
    && (
      status.diagnostics?.nativeHost?.policyState === "default"
      || status.diagnostics?.nativeHost?.policyState === "configured"
      || status.diagnostics?.nativeHost?.policyState === "invalid"
    )
    && status.diagnostics?.hostPolicy?.defaultMode === "ask"
    && Number.isInteger(status.diagnostics?.hostPolicy?.entryCount);
}

function hasInstalledExtensionPageControlHealth(health, extensionId) {
  const protocol = readRecord(health?.protocol);
  const pageControl = readRecord(health?.pageControl) ?? readRecord(health?.readiness);

  return health
    && typeof health === "object"
    && health.type === "skfiy.page_control.health_result"
    && health.schemaVersion === 1
    && health.requestId === "chrome-smoke-page-control-health"
    && protocol?.name === "skfiy.chrome.page-control"
    && protocol?.extensionId === extensionId
    && protocol?.nativeHostName === "com.sskift.skfiy"
    && protocol?.contentScriptFile === "content-script.js"
    && protocol?.messageTypes?.health === "skfiy.page_control.health"
    && protocol?.messageTypes?.diagnostics === "skfiy.page.diagnostics"
    && protocol?.messageTypes?.observe === "skfiy.page.observe"
    && protocol?.messageTypes?.action === "skfiy.page.action"
    && protocol?.messageTypes?.screenshot === "skfiy.page.screenshot"
    && protocol?.permissionModel?.hostPermissions === "optional"
    && Array.isArray(protocol?.permissionModel?.optionalHostPermissions)
    && protocol.permissionModel.optionalHostPermissions.includes("http://*/*")
    && protocol.permissionModel.optionalHostPermissions.includes("https://*/*")
    && pageControl
    && pageControl.schemaVersion === 1
    && typeof pageControl.state === "string"
    && typeof pageControl.capable === "boolean"
    && health.diagnostics?.extension?.id === extensionId
    && health.diagnostics?.nativeHost?.name === "com.sskift.skfiy";
}

function hasNativeHostBridgeDiagnostics(diagnostics) {
  return diagnostics
    && typeof diagnostics === "object"
    && diagnostics.nativeHost?.name === "com.sskift.skfiy"
    && diagnostics.nativeHost?.heartbeatState === "recorded"
    && typeof diagnostics.nativeHost?.launchOrigin === "string"
    && diagnostics.nativeHost.launchOrigin.startsWith("chrome-extension://")
    && diagnostics.nativeHost?.messageType === "skfiy.page.observe"
    && diagnostics.nativeHost?.lastError === null
    && (
      diagnostics.nativeHost?.policyState === "default"
      || diagnostics.nativeHost?.policyState === "configured"
      || diagnostics.nativeHost?.policyState === "invalid"
    )
    && diagnostics.capabilities?.nativeMessaging === true
    && diagnostics.capabilities?.hostPolicySync === true
    && diagnostics.capabilities?.connectionHeartbeat === true
    && diagnostics.hostPolicy?.defaultMode === "ask"
    && Number.isInteger(diagnostics.hostPolicy?.entryCount);
}

function countChromeHostPolicyEntries(policy) {
  return [
    policy?.allowedHosts,
    policy?.currentTurnAllowedHosts,
    policy?.blockedHosts
  ].reduce((count, entries) => count + (Array.isArray(entries) ? entries.length : 0), 0);
}

function runNativeHostFrame({ command, homeDir, message }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.alloc(payload.byteLength + 4);
    frame.writeUInt32LE(payload.byteLength, 0);
    payload.copy(frame, 4);

    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        HOME: homeDir,
        SKFIY_NATIVE_MESSAGING_HOST: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    child.stdin.end(frame);
  });
}

function readNativeHostResponse(stdout) {
  if (!Buffer.isBuffer(stdout) || stdout.byteLength < 4) {
    throw new Error("Chrome Native Messaging host did not write a response frame.");
  }

  const payloadByteLength = stdout.readUInt32LE(0);
  if (stdout.byteLength < payloadByteLength + 4) {
    throw new Error("Chrome Native Messaging host wrote an incomplete response frame.");
  }

  return JSON.parse(stdout.subarray(4, 4 + payloadByteLength).toString("utf8"));
}

function formatLaunchCommand(options, chromeEndpoint) {
  return `open -n${formatBackgroundOpenFlag(options)} -a ${options.appPath}${formatOpenEnvFlags()} --args --remote-debugging-port=${options.port} --skfiy-chrome-cdp-endpoint=${chromeEndpoint}`;
}

function formatFallbackLaunchCommand(options) {
  return `open -n${formatBackgroundOpenFlag(options)} -a ${options.appPath}${formatOpenEnvFlags()} --args --remote-debugging-port=${options.port}`;
}

function formatFallbackSwitchLaunchCommand(options, configuredEndpoint) {
  return `open -n${formatBackgroundOpenFlag(options)} -a ${options.appPath}${formatOpenEnvFlags()} --args --remote-debugging-port=${options.port} --skfiy-chrome-cdp-endpoint=${configuredEndpoint}`;
}

function formatChromeLaunchCommand(options) {
  return `open -n${formatBackgroundOpenFlag(options)} -a ${options.chromeAppName} --args --remote-debugging-port=${options.chromePort}`;
}

function formatBackgroundOpenFlag(options) {
  return options.allowFocusSteal === true ? "" : " -g";
}

function createBackgroundOpenArgs(options) {
  return options.allowFocusSteal === true ? [] : ["-g"];
}

function formatOpenEnvFlags() {
  return SMOKE_APP_ENVS.map((value) => ` --env ${value}`).join("");
}

function createOpenEnvArgs() {
  return SMOKE_APP_ENVS.flatMap((value) => ["--env", value]);
}

async function createChromeFixture() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "skfiy-chrome-smoke-"));
  const chromeUserDataDir = path.join(rootPath, "chrome-profile");
  const pagePath = path.join(rootPath, "index.html");
  const sensitivePagePath = path.join(rootPath, "sensitive.html");
  const formPagePath = path.join(rootPath, "form.html");
  await writeFile(pagePath, `<!doctype html>
<html>
  <head><title>skfiy chrome smoke</title></head>
  <body><main>${EXPECTED_TEXT}</main></body>
</html>
`);
  await writeFile(sensitivePagePath, `<!doctype html>
<html>
  <head><title>skfiy sensitive smoke</title></head>
  <body><main>Enter password and one-time code</main></body>
</html>
`);
  await writeFile(formPagePath, `<!doctype html>
<html>
  <head><title>skfiy form smoke</title></head>
  <body>
    <main>
      <form id="profile">
        <label>Name <input id="name" name="name" /></label>
        <label>Email <input id="email" name="email" /></label>
        <label>Role <input id="role" name="role" /></label>
        <button id="submit" type="submit">Submit</button>
      </form>
      <p id="result">waiting for input</p>
    </main>
    <script>
      document.querySelector("#profile").addEventListener("submit", (event) => {
        event.preventDefault();
        document.querySelector("#result").textContent =
          document.querySelector("#name").value + " "
          + document.querySelector("#email").value + " "
          + document.querySelector("#role").value + " form submitted";
      });
    </script>
  </body>
</html>
`);
  return {
    rootPath,
    chromeUserDataDir,
    url: pathToFileURL(pagePath).href,
    sensitiveUrl: pathToFileURL(sensitivePagePath).href,
    formUrl: pathToFileURL(formPagePath).href
  };
}

function formatFormAssignments(fields) {
  return fields.map((field) => `${field.selector}=${field.value}`).join("; ");
}

async function launchChrome(options, chromeUserDataDir) {
  await execFileAsync("open", [
    "-n",
    ...createBackgroundOpenArgs(options),
    "-a",
    options.chromeAppName,
    "--args",
    `--remote-debugging-port=${options.chromePort}`,
    `--user-data-dir=${chromeUserDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ]);
}

async function launchSkfiy(options, chromeEndpoint) {
  await execFileAsync("open", [
    "-n",
    ...createBackgroundOpenArgs(options),
    "-a",
    options.appPath,
    ...createOpenEnvArgs(),
    "--args",
    `--remote-debugging-port=${options.port}`,
    `--skfiy-chrome-cdp-endpoint=${chromeEndpoint}`
  ]);
}

async function launchSkfiyWithoutChromeEndpoint(options) {
  await execFileAsync("open", [
    "-n",
    ...createBackgroundOpenArgs(options),
    "-a",
    options.appPath,
    ...createOpenEnvArgs(),
    "--args",
    `--remote-debugging-port=${options.port}`
  ]);
}

async function runChromeFallbackProductCommand(options, command) {
  await quitSkfiy();
  await sleep(500);
  await launchSkfiyWithoutChromeEndpoint(options);
  const processesAfterLaunch = await readSkfiyProcesses();
  const page = await waitForRendererPage(options.port, options.timeoutMs);
  const cdp = await createCdpClient(page.webSocketDebuggerUrl);

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Runtime.addBinding", { name: "skfiyChromeSmokeEvent" });
    await cdp.send("Runtime.evaluate", {
      expression: installEventSinkExpression(),
      awaitPromise: true,
      returnByValue: true
    });

    return {
      events: await runChromeProductCommand(cdp, command, options),
      processesAfterLaunch
    };
  } finally {
    cdp.close();
  }
}

async function runChromeFallbackSwitchProductCommand(options, command) {
  await quitSkfiy();
  await sleep(500);
  const configuredEndpoint = readBrokenChromeEndpoint(options);
  const launch = formatFallbackSwitchLaunchCommand(options, configuredEndpoint);
  await launchSkfiy(options, configuredEndpoint);
  const processesAfterLaunch = await readSkfiyProcesses();
  const page = await waitForRendererPage(options.port, options.timeoutMs);
  const cdp = await createCdpClient(page.webSocketDebuggerUrl);

  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Runtime.addBinding", { name: "skfiyChromeSmokeEvent" });
    await cdp.send("Runtime.evaluate", {
      expression: installEventSinkExpression(),
      awaitPromise: true,
      returnByValue: true
    });

    return {
      configuredEndpoint,
      launch,
      events: await runChromeProductCommand(cdp, command, options),
      processesAfterLaunch
    };
  } finally {
    cdp.close();
  }
}

async function runChromeBringYourOwnCurrentPageCommand(cdp, options, evidence) {
  const events = await runChromeProductCommand(cdp, CURRENT_PAGE_COMMAND, options);
  const extractedText = extractCompletedChromeCurrentPageText(events);
  const pageSnapshot = extractChromeCurrentPageSnapshot(events);

  return {
    command: CURRENT_PAGE_COMMAND,
    chromeEndpoint: options.currentPageEndpoint,
    productPath: PRODUCT_PATH,
    appLaunchViaOpen: true,
    chromeLaunchViaOpen: false,
    runnerHasTmux: Boolean(process.env.TMUX),
    pageSnapshot,
    events,
    extractedText,
    result: classifyChromeBringYourOwnCurrentPageEvidence({
      ...evidence,
      chromeEndpoint: options.currentPageEndpoint,
      chromeLaunchViaOpen: false,
      events,
      pageSnapshot
    })
  };
}

async function readRendererEvidence(cdp, evidence) {
  const permissions = await cdp.send("Runtime.evaluate", {
    expression: "window.skfiy.getPermissions()",
    awaitPromise: true,
    returnByValue: true
  });
  const runtimeStatus = await cdp.send("Runtime.evaluate", {
    expression: "window.skfiy.getRuntimeStatus()",
    awaitPromise: true,
    returnByValue: true
  });
  const startupWarnings = await cdp.send("Runtime.evaluate", {
    expression: "window.skfiy.getStartupWarnings()",
    awaitPromise: true,
    returnByValue: true
  });
  const appPolicySettings = await cdp.send("Runtime.evaluate", {
    expression: "window.skfiy.getAppPolicySettings()",
    awaitPromise: true,
    returnByValue: true
  });

  evidence.permissions = permissions.result?.value;
  evidence.runtimeStatus = runtimeStatus.result?.value;
  evidence.startupWarnings = startupWarnings.result?.value;
  evidence.appPolicySettings = appPolicySettings.result?.value;
}

function readBrokenChromeEndpoint(options) {
  return `http://127.0.0.1:${options.chromePort + 1000}`;
}

async function waitForChromeEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        if (pages.some((page) => page.type === "page" && page.webSocketDebuggerUrl)) {
          return;
        }
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for Chrome CDP on port ${port}.`
      + (lastError instanceof Error ? ` Last error: ${lastError.message}` : "")
  );
}

async function waitForRendererPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => {
        if (!response.ok) {
          throw new Error(`CDP returned HTTP ${response.status}.`);
        }

        return response.json();
      });
      const page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);

      if (page) {
        return page;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for skfiy renderer on CDP port ${port}.`
      + (lastError instanceof Error ? ` Last error: ${lastError.message}` : "")
  );
}

async function createCdpClient(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  const events = [];
  let nextId = 1;

  ws.addEventListener("message", (raw) => {
    const message = JSON.parse(raw.data.toString());

    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }

      return;
    }

    if (
      message.method === "Runtime.bindingCalled"
      && message.params?.name === "skfiyChromeSmokeEvent"
    ) {
      events.push(JSON.parse(message.params.payload));
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  return {
    events,
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      ws.close();
    }
  };
}

async function runChromeProductCommand(cdp, command, options) {
  const startIndex = cdp.events.length;
  await cdp.send("Runtime.evaluate", {
    expression:
      `window.skfiy.runCommand(${JSON.stringify(command)}, { mode: "active" })`,
    awaitPromise: true,
    returnByValue: true
  });
  await sleep(options.settleMs);

  if (cdp.events.at(-1)?.status === "approval_required") {
    await cdp.send("Runtime.evaluate", {
      expression: "window.skfiy.approveTask()",
      awaitPromise: true,
      returnByValue: true
    });
  }

  await waitForTerminalTaskEvent(cdp, options.timeoutMs);
  return cdp.events.slice(startIndex);
}

function installEventSinkExpression() {
  return `(() => {
    if (!window.skfiy) {
      throw new Error("window.skfiy preload API is unavailable.");
    }

    if (!window.__skfiyChromeSmokeInstalled) {
      window.__skfiyChromeSmokeInstalled = true;
      window.skfiy.onTaskEvent((event) => {
        globalThis.skfiyChromeSmokeEvent(JSON.stringify(event));
      });
    }

    return true;
  })()`;
}

async function waitForTerminalTaskEvent(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = cdp.events.at(-1)?.status;
    if (
      status === "completed"
      || status === "failed"
      || status === "needs_confirmation"
      || status === "idle"
    ) {
      return;
    }

    await sleep(250);
  }
}

function extractCompletedChromeText(events) {
  const completed = events.findLast((event) =>
    event?.status === "completed"
      && typeof event.message === "string"
      && event.message.startsWith("Chrome test page extracted:")
  );

  return completed?.message?.slice("Chrome test page extracted:".length).trim() ?? "";
}

function extractCompletedChromeCurrentPageText(events) {
  const prefix = "Chrome current page extracted:";
  const completed = events.findLast((event) =>
    event?.status === "completed"
      && typeof event.message === "string"
      && event.message.startsWith(prefix)
  );

  return completed?.message?.slice(prefix.length).trim() ?? "";
}

function extractChromeCurrentPageSnapshot(events) {
  const extractedText = extractCompletedChromeCurrentPageText(events);
  const event = events.findLast((item) =>
    item?.status === "executing"
      && typeof item.message === "string"
      && item.message.startsWith("Verified current_page_snapshot:")
  );
  const matched = event?.message?.match(
    /^Verified current_page_snapshot: Observed current page: (.*) \((.*)\)$/
  );

  return {
    title: matched?.[1]?.trim() ?? "",
    url: matched?.[2]?.trim() ?? "",
    text: extractedText
  };
}

async function quitSkfiy() {
  await execFileAsync("osascript", [
    "-e",
    `tell application id "${BUNDLE_IDENTIFIER}" to quit`
  ]).catch(() => undefined);
}

async function killChromeSmokeProcesses(chromeUserDataDir) {
  await execFileAsync("pkill", ["-f", chromeUserDataDir]).catch(() => undefined);
}

async function waitForChromeSmokeProcessesExit(chromeUserDataDir, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let processes = await readChromeSmokeProcesses(chromeUserDataDir);

  while (processes.length > 0 && Date.now() < deadline) {
    await sleep(250);
    processes = await readChromeSmokeProcesses(chromeUserDataDir);
  }

  return processes;
}

async function readSkfiyProcesses() {
  return readProcessLines(SKFIY_APP_PROCESS_PATTERN);
}

async function readChromeSmokeProcesses(chromeUserDataDir) {
  return readProcessLines(chromeUserDataDir);
}

async function readProcessLines(pattern) {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-fl", pattern]);
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

await main();
