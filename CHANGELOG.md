# Release notes

## 0.10.2 — 2026-10-25

The 0.10.0 and 0.10.1 tags did not produce releases because CI exposed fixture scheduling and startup races. This release isolates blocking test workers, runs timing-sensitive tests serially, and waits for browser bridge readiness without relaxing test deadlines.

- `open_file` distinguishes accepted requests from confirmed document opens. A missing matching document URL returns `open_status: unverified` instead of claiming a chat attachment or successful open.
- A stalled ScreenCaptureKit connection switches to bounded system window captures, including for explicitly selected windows. Coordinates are checked against the captured window geometry; other apps' pixels are excluded. Shareable-content timeouts propagate immediately instead of being swallowed by retries.
- AppKit sheets and focus-only windows are included in app window lookup. Fields remain bound to their nearest sheet instead of silently switching back to the main document. System panel paths use exact, verified AX insertion; `set_value` also checks native text read-back.
- Window-only expectations avoid expensive tree/OCR reads, and observations have a bounded verification budget. Late/unavailable evidence is never reported as proof of success.
- Native pointer tools accept explicit `coordinate_space: screen` with a bound `window_id`, including after a tree-only read. Screenshot coordinates remain the default and stale/moved windows are refused.
- `run_in_front` explicitly asks once per local app process and MCP session, restoring the previous foreground app after each action. Remote-session actions keep their individual approvals. System panels and some custom views still require this foreground path; background delivery alone does not prove an effect.


- Apple Screen Sharing now recognizes `AXSharedScreen`, captures the selected connection independently, and supports background pointer control and ASCII keyboard input. Left clicks and drags use button-number routing verified on the RFB wire. Connection changes, stale screenshots and mismatched keyboard targets are rejected. Unicode is refused before sending; modifier shortcuts use the approved foreground path, bypassing local menus and clipboard emulation. See `docs/screen-sharing.md` for the supported scope.
- Native `expect.changed` compares independent window pixels as well as accessibility state, avoiding false `no_effect` results for canvas-only changes. Missing captures remain unknown. Verification and its follow-up state refresh stay on the inspected window, and value checks retain the original element across tree refreshes. Long verification waits renew supported Electron rendering leases.
- Action logs include failed reads, incomplete screenshot diagnostics, bounded structured arguments, verification outcomes, duration and the running binary's build identity. Screen Sharing inputs remain redacted even when expectation validation fails before dispatch.

- Screenshot coordinates expire when nested containers scroll, including before delivery of the scroll event. The target is checked again before dispatch.
- An unreadable or navigating page cannot prove that text disappeared. Failed waits retain repeat protection.
- Uploads preserve their execution receipt when the following page read fails; a lost acknowledgement remains unknown and must be inspected before retrying.
- Browser bridge replies use independent bounded client queues and write deadlines. One slow reader no longer blocks other sessions.
- Browser calls share monotonic time budgets across discovery, socket connection/write/read, observation and capture. Optional `SKFIY_BROWSER_TRACE=1` emits phase timings to stderr without page content.
- CI runs disposable Chrome integration and transport fault tests and retains diagnostic artifacts. Bundled extension: 0.9.3; reload it after updating.

## 0.9.0 — 2026-10-12

Find controls by table row, column and identifier, search virtual lists, and keep working in Electron windows that are completely covered. Approval prompts work with one click, or can be turned off.

- `target` takes `identifier` (AXIdentifier, DOM id or data-testid), `row` (text in the same table or list row) and `column` (the cell's column header). Rows and columns come only from the structure an app or page publishes, never from distances on screen. Tooltips name otherwise unnamed native controls, and `locate` attaches a window screenshot when nothing or several things match.
- `browser_scroll` scrolls the nearest scrollable container and stops at its boundary instead of spilling into the page. `direction: "to"` scrolls a target into view; `until` scrolls a virtual list step by step until a described item appears (`max_scrolls`, default 5) and never clicks it. After a scroll, Chrome's debugger delivers one frame so hidden tabs render their new rows.
- Browser element indices are refused when the page recycled the element for something else, and page script errors are reported instead of read as success. Text inside buttons and links is no longer repeated after the control's line.
- `browser_state` with `background_screenshot: true` always captures through Chrome's debugger, also for the active tab of a covered window.
- Completely covered Electron windows: `get_app_state`, actions and `wait_for` briefly turn off background throttling for that window through the app's own main-process inspector, wait for real frames, and read it again. The window is never activated, raised or moved; the app restores its setting about 15 seconds after the last use, and an inspector skfiy opened is closed right away. This needs Electron 32+ with the inspector fuse on; otherwise the warning that the window may be stale stays. `SKFIY_ELECTRON_RENDERING=0` turns it off.
- Approval prompts work with one click. Claude Code submits a form's default when you just accept it, and the switch in skfiy's prompts defaulted to off, so every accepted upload, `run_in_front`, clipboard and `hand_over` prompt read as a refusal. Accepting now approves; switching it off, declining or cancelling refuses.
- `SKFIY_APPROVE=all` grants every approval without asking: `browser_upload`, `run_in_front`, `read_clipboard` and brief in-app focus. `hand_over` still waits for you. Turn it on with `skfiy setup -e SKFIY_APPROVE=all`; `skfiy doctor` flags other values.
- `browser_upload` reaches file inputs that sites hide behind a styled button or drop zone: given the button, it attaches to the single file input the button labels or shares a container with, and refuses when there are several. It no longer reports a file as attached when the page did not confirm it, and says why an attach failed. `paths` attaches several files at once, in order, to an input that takes multiple.
- `browser_click` at x/y reaches controls inside shadow roots, open or closed (web components such as a site's publish button), instead of stopping at their host element.

Restart MCP clients after updating. The bundled browser extension is now 0.9.0: reload the skfiy card in chrome://extensions.

## 0.8.0 — 2026-10-10

Control a signed-in Windows desktop over an existing SSH connection while RustDesk stays in the background. Remote screenshots and input do not activate Mac windows, change Mac focus, move the Mac pointer or use its clipboard.

- Add a remote once with `skfiy remote add NAME SSH_HOST`, then use the new `remote_desktop` MCP tool to view, click, type Unicode text, send shortcuts, scroll and drag. The Windows helper is embedded in the Mac binary, starts on demand and exits after two idle minutes; it needs no extra runtime or listening port.
- Each input uses a screenshot token that expires after 30 seconds and accepts one action. Desktop layout, target-window and machine-identity checks reject stale or mismatched requests. Remote text and keys are redacted from action logs.
- Native RustDesk capability reports now point to the SSH control path instead of suggesting unsupported background keyboard input. Remote coordinates come from `remote_desktop` screenshots, independently of the selected RustDesk tab.
- Validation: 186 unit tests passed; 16 remote fixture checks verified actual input effects and screenshots. During that remote run, 836 independent Mac samples recorded no foreground or top-window changes. Covered local-window and native RustDesk regression checks also passed.

Windows must already be signed in as the SSH user. Locked screens, UAC secure desktops and elevated apps are unsupported. See the [remote desktop guide](docs/remote-desktop.md) for setup and limits.

Restart MCP clients after updating to load `remote_desktop`. The optional browser extension remains at 0.7.0 and needs no update for this release.

## 0.7.0 — 2026-10-10

Installation now has a clear path: install, grant macOS permissions, then verify the client connection. The Chinese and English READMEs follow these three steps; advanced settings, implementation details and test records live in `docs/`.

- Release downloads stop with useful network or missing-file errors. Failures preserve an existing installation and never start a source build. Plain `./install.sh` now downloads the published release even in a checkout; use `./install.sh --from-source` or `make install` to build local code.
- Setup shows commands using the installed binary's full path, so changing PATH is optional. Browser extension setup is listed separately, and `doctor` reports existing Codex registrations as well as Claude Code registrations.
- The release includes the recent simplification of tool definitions, window handling and foreground operations. `browser_navigate` is now part of `browser_open` (`action`), and `locked_use_status` is covered by `get_desktop_status`.
- Server and bundled browser extension versions are now 0.7.0. Restart MCP clients after updating; reload the skfiy extension card if you use browser tools.

The universal release supports Apple silicon and Intel on macOS 14 or later, without developer tools or additional runtimes. macOS permissions and loading the optional browser extension still require user interaction.

Previous release: [0.6.0](https://github.com/Sskift/skfiy-next/releases/tag/v0.6.0).
