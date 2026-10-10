# Release notes

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
