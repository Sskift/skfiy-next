#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
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
  createDefaultChromeSmokeOptions,
  createHelpText,
  EXPECTED_TEXT,
  FORM_EXPECTED_TEXT,
  parseChromeSmokeArgs,
  PRODUCT_PATH
} from "./smoke-chrome-plan.mjs";
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

async function runChromeReadinessDiagnostics(options) {
  const modulePath = path.join(ROOT_DIR, "dist", "main", "chrome-readiness.js");
  const { createChromeReadinessDiagnostics } = await import(pathToFileURL(modulePath).href);
  const appBinaryPath = path.join(options.appPath, "Contents", "MacOS", "skfiy");

  return createChromeReadinessDiagnostics({
    homeDir: os.homedir(),
    cliShimPath: appBinaryPath,
    extensionIds: [FIXTURE_EXTENSION_ID],
    extensionPath: path.join(ROOT_DIR, "chrome-extension"),
    approvalProbeCommand: `打开 Chrome 测试页面 https://example.com/skfiy-readiness 并提取正文`
  });
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

  // Fire the command without awaiting — Chrome tasks require a second
  // approval (action-plan gate) after the app-policy gate, and awaiting
  // the runCommand promise would deadlock against that approval.
  cdp.send("Runtime.evaluate", {
    expression:
      `window.skfiy.runCommand(${JSON.stringify(command)}, { mode: "active" })`,
    awaitPromise: false,
    returnByValue: true
  }).catch(() => undefined);

  // Wait for the first approval gate (app policy) or terminal state.
  await waitForNewEvent(cdp, startIndex, options.timeoutMs,
    (event) => event.status === "approval_required" || isTerminalStatus(event.status));

  let cursor = cdp.events.length;
  if (cdp.events.at(-1)?.status === "approval_required") {
    await approveCurrentTask(cdp);
  }

  // Wait for the Chrome action-plan approval (second gate) or completion.
  await waitForNewEvent(cdp, cursor, options.timeoutMs,
    (event) => event.status === "approval_required"
      || event.status === "needs_confirmation"
      || isTerminalStatus(event.status));

  // Chrome action-plan approval (second gate).
  if (cdp.events.at(-1)?.status === "approval_required") {
    await approveCurrentTask(cdp);
    cursor = cdp.events.length;
    await waitForNewEvent(cdp, cursor, options.timeoutMs,
      (event) => event.status === "needs_confirmation" || isTerminalStatus(event.status));
  }

  // Chrome submit confirmation (form fills).
  if (cdp.events.at(-1)?.status === "needs_confirmation") {
    await approveCurrentTask(cdp);
    cursor = cdp.events.length;
    await waitForNewEvent(cdp, cursor, options.timeoutMs,
      (event) => isTerminalStatus(event.status));
  }

  return cdp.events.slice(startIndex);
}

function isTerminalStatus(status) {
  return status === "completed"
    || status === "failed"
    || status === "needs_confirmation"
    || status === "idle"
    || status === "denied"
    || status === "blocked"
    || status === "cancelled";
}

async function waitForNewEvent(cdp, startIndex, timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cdp.events.slice(startIndex).some(predicate)) {
      return;
    }
    await sleep(250);
  }
}

async function approveCurrentTask(cdp) {
  const taskControl = await cdp.send("Runtime.evaluate", {
    expression: "window.skfiy.getTaskControl()",
    awaitPromise: true,
    returnByValue: true
  });
  const snapshot = taskControl.result?.value;
  if (!snapshot?.executionId) {
    return;
  }
  // Chrome submit confirmations and Finder plan confirmations use a derived
  // planId stored on the approval, not the base plan's planId.
  const planId = snapshot.approval?.planId ?? snapshot.plan?.planId;
  if (!planId) {
    return;
  }
  await cdp.send("Runtime.evaluate", {
    expression: `window.skfiy.approveTask(${JSON.stringify({
      executionId: snapshot.executionId,
      planId
    })})`,
    awaitPromise: true,
    returnByValue: true
  });
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
    item?.status === "verifying"
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

async function writeSmokeEvidence(outputPath, evidence) {
  const artifactPath = path.resolve(outputPath);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

await main();
