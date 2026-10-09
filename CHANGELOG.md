# Release notes

## 0.7.0 — 2026-10-10

Installation now has a clear path: install, grant macOS permissions, then verify the client connection. The Chinese and English READMEs follow these three steps; advanced settings, implementation details and test records live in `docs/`.

- Release downloads stop with useful network or missing-file errors. Failures preserve an existing installation and never start a source build. Plain `./install.sh` now downloads the published release even in a checkout; use `./install.sh --from-source` or `make install` to build local code.
- Setup shows commands using the installed binary's full path, so changing PATH is optional. Browser extension setup is listed separately, and `doctor` reports existing Codex registrations as well as Claude Code registrations.
- The release includes the recent simplification of tool definitions, window handling and foreground operations. `browser_navigate` is now part of `browser_open` (`action`), and `locked_use_status` is covered by `get_desktop_status`.
- Server and bundled browser extension versions are now 0.7.0. Restart MCP clients after updating; reload the skfiy extension card if you use browser tools.

The universal release supports Apple silicon and Intel on macOS 14 or later, without developer tools or additional runtimes. macOS permissions and loading the optional browser extension still require user interaction.

Previous release: [0.6.0](https://github.com/Sskift/skfiy-next/releases/tag/v0.6.0).
