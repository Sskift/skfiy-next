# Chrome Extension Setup And Diagnostics

This guide is for a local skfiy operator who wants to install the unpacked
Chrome adapter, register the Native Messaging host, and confirm that the current
tab is ready for skfiy browser control.

## What Gets Installed

- Extension source: `chrome-extension/`
- Extension manifest: `chrome-extension/manifest.json`
- Native host name: `com.sskift.skfiy`
- Packaged native host executable: `dist/skfiy`
- Chrome Native Messaging manifest for Google Chrome:
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sskift.skfiy.json`
- Chrome Native Messaging manifest for Chromium dogfood:
  `~/Library/Application Support/Chromium/NativeMessagingHosts/com.sskift.skfiy.json`
- Extension heartbeat:
  `~/Library/Application Support/skfiy/chrome-extension-connection.json`
- Host policy:
  `~/Library/Application Support/skfiy/chrome-host-policy.json`

The extension uses Manifest V3, `nativeMessaging`, `activeTab`, `scripting`,
`storage`, `tabs`, and `downloads`. It keeps `host_permissions` empty and uses
optional `http://*/*` and `https://*/*` permissions, so skfiy can ask for a host
before page observation or actions run.

The extension is a browser-control enhancement channel. It gives skfiy
structured access to Chrome-specific surfaces such as the current tab, DOM
readiness, safe page actions, visible-tab screenshots, downloads metadata, and
Native Messaging host policy. It does not replace the OS Computer Use path:
non-browser apps, window management, global screenshots, pointer/keyboard input,
and cross-app workflows still require macOS Accessibility and Screen Recording
through the packaged app/helper.

## Install The Extension

1. Build the packaged app and CLI:

```bash
npm run build
```

2. Print the local extension path, manifest summary, and follow-up commands:

```bash
./dist/skfiy chrome extension-info --json
```

3. Open Chromium for dogfood, or Chrome for Testing for automated unpacked
   smoke. Use branded Chrome only when explicitly testing a manually installed
   extension in that browser.

4. Go to `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
   and select the repository's `chrome-extension/` folder.

5. Copy the 32-character extension id from the extension card. Use that exact id
   in all native-host commands. If you reload the unpacked extension from a
   different path and Chrome assigns a new id, reinstall the native host.

Automated smoke loading with `--load-extension` should use Chromium first, then
Chrome for Testing. Branded Google Chrome 137+ can block that flag, and
`smoke:chrome` reports this as `branded_chrome_load_extension_removed` with the
recommended browser.

## Install The Native Messaging Host

Register the packaged `dist/skfiy` binary for the extension id:

```bash
./dist/skfiy chrome install-host --extension-id <extension-id>
```

Check the installed manifest:

```bash
./dist/skfiy chrome status --extension-id <extension-id>
```

A healthy manifest reports:

```json
{
  "nativeHost": {
    "state": "installed",
    "hostName": "com.sskift.skfiy",
    "manifestPath": ".../NativeMessagingHosts/com.sskift.skfiy.json",
    "allowedOrigins": ["chrome-extension://<extension-id>/"]
  }
}
```

If `nativeHost.state` is `missing`, run `chrome install-host`. If it is
`mismatched`, `invalid`, or `cli-missing`, rebuild and reinstall:

```bash
npm run build
./dist/skfiy chrome install-host --extension-id <extension-id>
```

The manifest must point at an absolute `dist/skfiy` path and include the loaded
extension origin in `allowed_origins`.

## Confirm The Bridge

Open the extension popup and click **Refresh host policy** to sync local policy,
or **Observe current page** to collect the current tab and send Browser Context
evidence through the installed Native Messaging host. The useful fields are:

- `Connection`: should move to `Synced with skfiy app`.
- `Bridge`: should be `Connected`.
- `Launch origin`: should be `chrome-extension://<extension-id>/`.
- `Heartbeat`: should move to `Connected ...` after the native host responds,
  or stay diagnostic-only while the page observation itself is accepted.
- `Native policy`: should be `Default`, `Configured`, or `Invalid`.
- `Policy sync`: should be `Synced`.
- `Last error`: should stay hidden.

The same native-message exchange writes the heartbeat file:

```bash
cat "$HOME/Library/Application Support/skfiy/chrome-extension-connection.json"
```

Expected heartbeat shape:

```json
{
  "schemaVersion": 1,
  "hostName": "com.sskift.skfiy",
  "observedAt": "2026-07-10T00:00:00.000Z",
  "launchOrigin": "chrome-extension://<extension-id>/",
  "messageType": "skfiy.host_policy.request",
  "requestId": "..."
}
```

`./dist/skfiy chrome status --extension-id <extension-id>` classifies this as
`extension.liveConnection: connected`, `stale`, `unknown`, or `invalid`.
Heartbeat evidence is fresh for five minutes. A stale or unknown heartbeat means
the native host may be installed but the extension has not talked to it recently.

## Development Reload

After the first **Load unpacked** install, day-to-day extension source edits do
not require returning to `chrome://extensions` for the reload button. Open the
skfiy extension popup and click **Reload extension**. The background worker will:

1. send a Native Messaging heartbeat using the existing
   `skfiy.host_policy.request` frame,
2. write diagnostic state into `chrome.storage.local` so the popup can show
   whether the heartbeat connected or failed,
3. call Chrome's `chrome.runtime.reload()` API from the extension context.

If the Native Messaging host is still unavailable, the popup keeps the reload
diagnostic visible and still schedules the browser reload when
`chrome.runtime.reload()` is available. This helps apply local JavaScript and
manifest-adjacent edits even while `extension.liveConnection` is `unknown`; use
the `Heartbeat` and `Last error` rows to diagnose the bridge separately.

For development loops that need to prove page control against a real tab, pass
the Chrome tab id into the desktop reload command:

```bash
./dist/skfiy chrome reload-extension \
  --extension-id <id> \
  --target-tab-id <chrome-tab-id>
```

The command first opens an extension-context wake URL with
`skfiyWakeAction=dev-reload`, then reopens a page-control wake URL that includes
`skfiyTargetTabId`. The popup/background path asks Chrome to reload the
extension from inside the extension context and then verifies the requested tab.
Only if that path cannot verify does skfiy fall back to the
`chrome://extensions` card reload path, which requires an unlocked desktop for
OCR/click control. A resulting `chrome_host_permission_missing` state is
expected until the user grants the extension optional site access for that
origin.

Some MV3 edits require Chrome to re-register the background service worker. If
the local `chrome-extension/manifest.json` version is newer than Chrome's stored
`service_worker_registration_info.version`, `chrome.runtime.reload()` may still
leave the old worker active. In that case, use the extension card's reload
button in `chrome://extensions`, then rerun:

```bash
./dist/skfiy chrome tabs --extension-id <id> --json
```

`skfiy chrome tabs` reports this as `extension-registration-stale` with the
local manifest version, registered service-worker version, extension path, and
next action instead of a generic tab-discovery failure. `skfiy chrome
reload-extension` reports the same condition as
`extension-card-reload-required` and preserves the desktop fallback blocker under
`desktopFallback` when the screen is locked or unavailable.

Chrome does not let an unpacked MV3 extension watch arbitrary local source files
or silently reload itself from outside the extension context. If
`Dev reload` says the reload API is unavailable, use the normal
`chrome://extensions` reload button for that browser/context. Do not bypass
Chrome's extension security policy with private browser files or unsupported
automation.

## Check Current Tab Readiness

For a normal `http:` or `https:` page, the popup's current-tab fields should
look like this before page observation or DOM actions are considered ready:

- `Current host`: the host you expect skfiy to control.
- `Host policy`: `Always allowed` or `Allowed this turn`, or `Ask by default`
  while waiting for a skfiy approval prompt.
- `Policy reason`: `Host allowed` after approval.
- `Host permission`: `Granted for http(s)://host/*`.
- `Page session`: `Loaded`.

This means skfiy may observe the page and run approved DOM actions such as
click, fill, submit, and scroll. Screenshot capture is a separate readiness lane.
Background `chrome.tabs.captureVisibleTab` requires either Chrome capture
permission for `<all_urls>` or an activeTab user gesture. If the current site is
granted but capture permission is missing, health/status should show the page
control state as `partial`, with DOM actions available and screenshot blocked
with `nextAction: "grant_chrome_capture_permission"`.

The background worker only queries the content-script session when the skfiy
host policy allows the host and Chrome has granted the optional host permission.
If `Page session` is `Blocked by host policy`, approve the host in skfiy or add a
temporary policy entry:

```bash
./dist/skfiy chrome policy set --host example.com --action allow-current-turn
```

If `Host permission` says `Missing optional Chrome host permission`, open the
skfiy extension popup on the current tab and click **Grant ... and observe**.
From the local Dashboard, the Browser Context checklist can also open a
target-tab recovery page with **Open access page**. That page keeps diagnostics
and the Grant button pointed at the original Chrome tab through
`skfiyTargetTabId`, so the extension page itself does not become the page being
diagnosed.
When both the current origin and visible-tab capture are missing, the popup
requests the site origin and `<all_urls>` capture permission in the same Chrome
user gesture, refreshes policy diagnostics, then observes the page and forwards
Browser Context evidence through Native Messaging. On `chrome://`, `file://`,
extension pages, or other non-HTTP pages, host permission can be `Not required
for this page`, but structured page actions may still be unavailable.

If screenshot readiness says Chrome capture permission is missing, the expected
interim command result is:

```json
{
  "result": "blocked",
  "reason": "chrome-capture-permission-missing",
  "nextAction": "grant_chrome_capture_permission"
}
```

Do not treat current-site host permission as screenshot permission. Until the
extension has a user-granted capture path or the packaged desktop screenshot
fallback is proven on an unlocked display, screenshot can remain blocked while
DOM page control is usable.

## Pet Agent Page Context

The pet's Background Agent can receive bounded Browser Context from the Chrome
extension when the current tab is an `http` or `https` page and pageControl has
observed it through the Native Messaging bridge.

Browser Context readiness is separate from both pet chat and screenshot
readiness. The skfiy host policy must allow the current host, and Chrome's
optional host permission must be granted for that site before the extension can
collect current-tab DOM text. Screenshot capture can still be blocked while DOM
observation and page actions are ready.

When Browser Context is ready, the agent prompt receives the current page URL,
title, observed timestamp, state, and a bounded visible-text excerpt. When it is
blocked, stale, missing, or unavailable, pet chat continues without page text and
the dashboard reports the typed state, blocker reason, and next action.

For machine probes, the background worker and content script both respond to the
read-only `skfiy.page_control.health` message. The response includes the
page-control protocol name, manifest/permission model, `content-script.js`
wire-up, current readiness, blockers, and next action. This health check never
calls `chrome.permissions.request`; missing site access remains a typed blocker
until the operator grants it.

## Readiness Snapshots

Use `doctor` before a real desktop test:

```bash
./dist/skfiy doctor --json --extension-id <extension-id>
```

The Chrome section combines:

- native host manifest status,
- extension adapter state and live heartbeat,
- host-policy file status,
- dashboard Chrome host-policy API reachability when `--dashboard-url` is also
  provided.

`readiness.checks.extension.ready` is true only when the native host is
installed and the extension heartbeat is connected.

For product evidence, run:

```bash
npm run smoke:chrome -- --extension-chrome-app "Chromium" --output .skfiy-smoke/chrome-extension.json
```

The smoke records `readinessDiagnostics`, `nativeHostBridgeRun`, and
`installedExtensionRun`. A complete installed-extension pass proves the MV3
extension sent a Native Messaging frame to `dist/skfiy`, the host responded, and
the heartbeat file matches the loaded `chrome-extension://.../` origin. The
`installedExtensionRun.pageControlHealth` field proves the read-only
`skfiy.page_control.health` protocol. `installedExtensionRun.readinessSnapshot`
summarizes manifest id/version, Native Messaging handshake state, health
protocol state, content-script state, and pageControl state in one small
contract for dashboards or dogfood reports.

## Chromium Dashboard Dogfood

Use Chromium for dashboard web-control dogfood. Do not run this path against the
user's primary branded Chrome profile unless the test is explicitly scoped to
that browser.

The current manually installed Chromium extension id used for dogfood is:

```text
plcpkkhlcacihjfohlojdknnkademlno
```

Before launching dashboard actions, verify Chromium has a Native Messaging
manifest for that id. This check is read-only:

```bash
CHROMIUM_HOST="$HOME/Library/Application Support/Chromium/NativeMessagingHosts/com.sskift.skfiy.json" node -e 'const fs=require("fs"); const id="plcpkkhlcacihjfohlojdknnkademlno"; const p=process.env.CHROMIUM_HOST; const m=JSON.parse(fs.readFileSync(p,"utf8")); if (m.name!=="com.sskift.skfiy" || m.type!=="stdio" || !String(m.path||"").endsWith("/dist/skfiy") || !Array.isArray(m.allowed_origins) || !m.allowed_origins.includes(`chrome-extension://${id}/`)) { throw new Error(`Chromium native host manifest does not match ${id}: ${p}`); } console.log(`Chromium native host manifest ok: ${p}`);'
```

Open a disposable `http://127.0.0.1` or `https://` test page in Chromium, grant
the skfiy extension site access for that host, approve the skfiy host policy for
the current turn, and click **Refresh host policy** or **Check heartbeat** in
the extension popup. Then run the dashboard smoke with Chromium selected:

```bash
npm run smoke:dashboard -- \
  --extension-id plcpkkhlcacihjfohlojdknnkademlno \
  --extension-chrome-app "Chromium" \
  --output .skfiy-smoke/dashboard-chromium-web-control.json
```

Add `--require-passed` only after the active Chromium tab is a disposable page
that can safely receive observe, fill, click, submit, and scroll actions. The
smoke starts `dist/skfiy dashboard` with `SKFIY_CHROME_APP_NAME=Chromium`, then
exercises `/api/chrome-control-action` through the installed extension id. The
artifact should include `extensionChromeAppName: "Chromium"` and
`dashboardChromeControlActionApi.result: "passed"` for a completed dashboard
dogfood loop.

## Common Blockers

- Extension id not provided: pass `--extension-id <id>` to `chrome status`,
  `doctor`, and plugin smoke commands.
- Native host missing: run `./dist/skfiy chrome install-host --extension-id <id>`.
- Chromium native host missing: verify
  `~/Library/Application Support/Chromium/NativeMessagingHosts/com.sskift.skfiy.json`
  separately before dashboard dogfood, because the Chromium path must allow the
  Chromium extension id.
- Native host mismatched: rebuild and reinstall after the extension id or CLI
  path changes.
- No live heartbeat: open the popup and click **Check heartbeat** or
  **Refresh host policy**; check that the Native Messaging manifest
  `allowed_origins` contains the current extension id.
- Source edit not visible in Chrome: open the popup and click
  **Reload extension**. If `Dev reload` reports the runtime reload API is
  unavailable, reload from `chrome://extensions`.
- Stale service-worker registration: when `chrome tabs --json` reports
  `extension-registration-stale`, reload the skfiy extension card in
  `chrome://extensions` so Chrome re-registers the MV3 service worker, then run
  `chrome tabs --json` again.
- Host policy blocked: approve the host for the current turn or set/reset the
  local Chrome host policy.
- Missing Chrome host permission: grant site access for the current site in the
  extension details page.
- Missing Chrome capture permission: screenshot capture can be blocked even when
  DOM actions are ready. Grant the extension a capture-capable permission path or
  run the packaged desktop screenshot fallback after the Mac is unlocked and
  Screen Recording is granted to `dist/skfiy.app`.
- Login or sensitive form visible: skfiy should pause rather than fill
  passwords, one-time codes, tokens, API keys, or payment fields.
- Screen locked, display asleep, or `loginwindow` active: unlock the Mac and
  keep the display awake before running Chrome smoke or desktop fallback tests.
- Screen Recording or Accessibility denied: grant the compiled `dist/skfiy.app`
  when CDP is unavailable and the Chrome path falls back to screenshot or
  pointer control.
- Branded Chrome blocks automated unpacked loading: use Chromium or Chrome for
  Testing for `smoke:chrome --extension-chrome-app`. The smoke also writes
  `installedExtensionRun.remediation` and typed blockers so the next command and
  docs path are visible without reading raw CDP targets.

## Reset

Uninstall only the Native Messaging manifest:

```bash
./dist/skfiy chrome uninstall-host --extension-id <extension-id>
```

Reset skfiy's host policy to ask by default:

```bash
./dist/skfiy chrome policy reset
```

Then reload the extension from `chrome://extensions` and reinstall the native
host if the extension id changed.
