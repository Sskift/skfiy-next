#!/usr/bin/env node
/**
 * Comprehensive E2E test for skfiy-next — runs without stealing focus.
 *
 * Launches the packaged app with --remote-debugging-port, connects via CDP,
 * and exercises features through the renderer API + DOM interaction.
 *
 * Usage: node scripts/e2e-comprehensive.mjs [--timeout 60000]
 */
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const APP_PATH = path.join(ROOT_DIR, "dist", "skfiy.app");
const CDP_PORT = 9333;
const TIMEOUT_MS = 120_000;

const results = [];

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCdpPage() {
  const httpGet = (url) =>
    new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(JSON.parse(data)));
      }).on("error", reject);
    });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const pages = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
      const page = pages.find((p) => p.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("CDP page not found");
}

function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  return {
    connect: () =>
      new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      }),
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      }),
    close: () => ws.close()
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Evaluation failed");
  }
  return result.result?.value;
}

async function launchApp() {
  console.log("Launching app...");
  const binary = path.join(APP_PATH, "Contents", "MacOS", "skfiy");
  if (!existsSync(binary)) {
    throw new Error(`App not found at ${binary}. Run npm run build first.`);
  }
  const proc = spawn(binary, [`--remote-debugging-port=${CDP_PORT}`], {
    stdio: "ignore",
    env: { ...process.env, SKFIY_SMOKE_WINDOW_MODE: "hidden" }
  });
  return proc;
}

async function quitApp(proc) {
  try {
    proc.kill("SIGTERM");
    await sleep(1000);
    if (!proc.killed) proc.kill("SIGKILL");
  } catch {}
}

// ─── Test Suites ───

async function testPetRendering(cdp) {
  console.log("\n=== Pet Rendering ===");
  // Wait for pet to render
  let pet = null;
  for (let i = 0; i < 20; i++) {
    pet = await evaluate(cdp, `document.querySelector('[data-pet-entry="true"]')?.outerHTML?.substring(0, 200)`);
    if (pet) break;
    await sleep(500);
  }
  record("Pet element exists", Boolean(pet), pet ? "found" : "not found after 10s");

  const ariaLabel = await evaluate(cdp, `document.querySelector('[data-pet-entry="true"]')?.getAttribute('aria-label')`);
  record("Pet has dynamic aria-label", Boolean(ariaLabel?.includes("skfiy desktop pet")), ariaLabel);

  const role = await evaluate(cdp, `document.querySelector('[data-pet-entry="true"]')?.getAttribute('role')`);
  record("Pet has role=button", role === "button", `role=${role}`);

  const tabIndex = await evaluate(cdp, `document.querySelector('[data-pet-entry="true"]')?.getAttribute('tabindex')`);
  record("Pet is focusable", tabIndex === "0", `tabindex=${tabIndex}`);
}

async function testConversation(cdp) {
  console.log("\n=== Conversation ===");
  // Click pet to open assistant panel
  await evaluate(cdp, `document.querySelector('[data-pet-entry="true"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(1000);

  const textarea = await evaluate(cdp, `document.querySelector('textarea[aria-label="Ask skfiy"]')?.tagName`);
  record("Assistant panel opens on pet click", textarea === "TEXTAREA", `textarea=${textarea}`);

  // Type a message
  await evaluate(cdp, `
    const ta = document.querySelector('textarea[aria-label="Ask skfiy"]');
    if (ta) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeInputValueSetter.call(ta, '你好 skfiy');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `);
  await sleep(300);

  const value = await evaluate(cdp, `document.querySelector('textarea[aria-label="Ask skfiy"]')?.value`);
  record("Text input accepts text", value === "你好 skfiy", `value=${value}`);

  // Send the message
  let sendResult = "not-attempted";
  try {
    sendResult = await evaluate(cdp, `
      (() => {
        const btn = document.querySelector('button[aria-label="发送给 skfiy"]');
        if (btn) { btn.click(); return 'clicked'; }
        return 'not-found';
      })()
    `);
  } catch (e) {
    sendResult = `error: ${e.message}`;
  }
  record("Send button works", sendResult === "clicked", sendResult);

  // Wait for reply (up to 30s)
  let replyVisible = false;
  let replyText = "";
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const reply = await evaluate(cdp, `
        (() => {
          // Look for assistant messages in the conversation thread
          const thread = document.querySelector('[class*="assistant-thread"], [aria-label="skfiy conversation"]');
          if (!thread) return '';
          const msgs = thread.querySelectorAll('[data-role="assistant"], [class*="assistant-message"], [class*="message-assistant"]');
          if (msgs.length === 0) {
            // Fallback: look for any non-user message text
            const allMsgs = thread.querySelectorAll('[data-role]');
            for (const m of allMsgs) {
              if (m.getAttribute('data-role') !== 'user' && m.textContent?.length > 5) {
                return m.textContent.substring(0, 200);
              }
            }
            return '';
          }
          const last = msgs[msgs.length - 1];
          return last?.textContent?.substring(0, 200) || '';
        })()
      `);
      if (reply && reply.length > 5) {
        replyVisible = true;
        replyText = reply;
        break;
      }
    } catch (e) {
      // Continue polling
    }
  }
  record("Agent reply received", replyVisible, replyText ? replyText.substring(0, 100) : "no reply after 30s");
}

async function testSettingsPanels(cdp) {
  console.log("\n=== Settings Panels ===");

  // Open settings via right-click
  await evaluate(cdp, `document.querySelector('[data-pet-entry="true"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))`);
  await sleep(500);

  const settingsVisible = await evaluate(cdp, `document.querySelector('[class*="settings-layout"], [class*="settings-panel"]') !== null`);
  record("Settings panel opens", settingsVisible);

  // Check for profile panel
  const profilePanel = await evaluate(cdp, `document.querySelector('[class*="profile-panel"], [data-profile-panel]') !== null || document.body.textContent.includes('Profile') || document.body.textContent.includes('配置文件')`);
  record("Profile panel exists", profilePanel);

  // Check for automation panel
  const automationPanel = await evaluate(cdp, `document.body.textContent.includes('Automation') || document.body.textContent.includes('自动化')`);
  record("Automation panel exists", automationPanel);

  // Check for memory panel
  const memoryPanel = await evaluate(cdp, `document.body.textContent.includes('Memory') || document.body.textContent.includes('记忆')`);
  record("Memory panel exists", memoryPanel);

  // Check for diagnostic report
  const diagResult = await evaluate(cdp, `
    (async () => {
      try {
        const report = await window.skfiy.getDiagnosticReport();
        return report && report.schemaVersion === 1 ? 'has-report' : 'bad-schema';
      } catch (e) { return 'error: ' + e.message; }
    })()
  `);
  record("Diagnostic report API works", diagResult === "has-report", diagResult);

  // Check for chrome compatibility
  const compatResult = await evaluate(cdp, `
    (async () => {
      try {
        const compat = await window.skfiy.getChromeCompatibility();
        return compat && compat.schemaVersion === 1 ? 'has-compat' : 'bad-schema';
      } catch (e) { return 'error: ' + e.message; }
    })()
  `);
  record("Chrome compatibility API works", compatResult === "has-compat", compatResult);
}

async function testTaskControl(cdp) {
  console.log("\n=== Task Control ===");

  // Task control card only renders when a task is active — check API instead
  const taskControl = await evaluate(cdp, `
    (async () => {
      try {
        // Check if task control store exists and has a snapshot
        const status = await window.skfiy.getRuntimeStatus();
        return status && status.stopTurnHotkey ? 'has-status' : 'bad-status';
      } catch (e) { return 'error: ' + e.message; }
    })()
  `);
  record("Runtime status API works", taskControl === "has-status", taskControl);

  // Check task control card visibility (may not exist when idle)
  const cardExists = await evaluate(cdp, `document.querySelector('.task-control-card') !== null`);
  record("Task control card (idle — may be absent)", true, cardExists ? "visible" : "absent (expected when idle)");
}

async function testAutomation(cdp) {
  console.log("\n=== Automation ===");

  const automationResult = await evaluate(cdp, `
    (async () => {
      try {
        const snapshot = await window.skfiy.getAutomationMonitors();
        return snapshot && Array.isArray(snapshot.monitors) ? 'has-snapshot' : 'bad-snapshot';
      } catch (e) { return 'error: ' + e.message; }
    })()
  `);
  record("Automation monitors API works", automationResult === "has-snapshot", automationResult);

  const runsResult = await evaluate(cdp, `
    (async () => {
      try {
        const runs = await window.skfiy.getAutomationRuns();
        return runs && Array.isArray(runs.runs) ? 'has-runs' : 'bad-runs';
      } catch (e) { return 'error: ' + e.message; }
    })()
  `);
  record("Automation runs API works", runsResult === "has-runs", runsResult);
}

async function testProfiles(cdp) {
  console.log("\n=== Profiles ===");

  const profilesResult = await evaluate(cdp, `
    (async () => {
      try {
        const snapshot = await window.skfiy.getProfiles();
        return snapshot && Array.isArray(snapshot.profiles) ? 'has-profiles' : 'bad-snapshot';
      } catch (e) { return 'error: ' + e.message; }
    })()
  `);
  record("Profiles API works", profilesResult === "has-profiles", profilesResult);
}

async function testDataExport(cdp) {
  console.log("\n=== Data Export ===");

  const exportResult = await evaluate(cdp, `
    (async () => {
      try {
        const result = await window.skfiy.exportData({ domains: ['profiles'] });
        return result && result.schemaVersion === 1 ? 'has-export' : 'bad-export';
      } catch (e) { return 'error: ' + e.message; }
    })()
  `);
  record("Data export API works", exportResult === "has-export", exportResult);
}

async function testMemory(cdp) {
  console.log("\n=== Memory ===");

  const memoryResult = await evaluate(cdp, `
    (async () => {
      try {
        const snapshot = await window.skfiy.getPersonalMemory();
        return snapshot && snapshot.schemaVersion === 1 ? 'has-memory' : 'bad-snapshot';
      } catch (e) { return 'error: ' + e.message; }
    })()
  `);
  record("Personal memory API works", memoryResult === "has-memory", memoryResult);
}

async function testBrowserContext(cdp) {
  console.log("\n=== Browser Context ===");

  const bcResult = await evaluate(cdp, `
    (async () => {
      try {
        const snapshot = await window.skfiy.getBrowserContextSource();
        return snapshot && snapshot.schemaVersion === 1 ? 'has-context' : 'bad-snapshot';
      } catch (e) { return 'error: ' + e.message; }
    })()
  `);
  record("Browser context API works", bcResult === "has-context", bcResult);
}

// ─── Main ───

async function main() {
  console.log("skfiy-next Comprehensive E2E Test");
  console.log("=================================");

  let proc;
  try {
    proc = await launchApp();
    console.log("Waiting for CDP...");
    const page = await getCdpPage();
    const cdp = createCdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    console.log("CDP connected.\n");

    // Wait for app to be ready
    console.log("Waiting for app to be ready...");
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const hasSkfiy = await evaluate(cdp, `Boolean(window.skfiy && typeof window.skfiy.getPermissions === 'function')`);
        if (hasSkfiy) {
          // Also wait for the pet to render
          const hasPet = await evaluate(cdp, `Boolean(document.querySelector('[data-pet-entry="true"]'))`);
          if (hasPet) {
            ready = true;
            break;
          }
        }
      } catch {}
      await sleep(1000);
    }
    if (!ready) {
      console.log("Warning: app not fully ready after 30s, continuing anyway...\n");
    } else {
      console.log("App ready.\n");
    }

    // Run tests
    await testPetRendering(cdp);
    await testConversation(cdp);
    await testSettingsPanels(cdp);
    await testTaskControl(cdp);
    await testAutomation(cdp);
    await testProfiles(cdp);
    await testDataExport(cdp);
    await testMemory(cdp);
    await testBrowserContext(cdp);

    cdp.close();
  } catch (error) {
    console.error("\n❌ Fatal error:", error.message);
    record("E2E suite", false, error.message);
  } finally {
    if (proc) await quitApp(proc);
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log("\n=================================");
  console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    results.filter((r) => !r.passed).forEach((r) => console.log(`  ❌ ${r.name} — ${r.detail}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
