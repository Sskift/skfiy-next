# skfiy

macOS computer use for Claude Code and any other MCP client: an MCP server that sees and operates the apps on your Mac **in the background**. It does not take focus, raise windows, move your pointer or interrupt your typing; your clipboard is at most borrowed for an instant and put back. The only exception is `run_in_front`, which brings an app forward for about a second, and only after you approve it in Claude Code.

One Swift binary with no runtime dependencies (it links only macOS frameworks and carries its own browser extension). An optional Chromium extension lets the agent work in **background tabs** of your real Chrome, with your logins.

The full documentation is in Chinese: [README.md](README.md).

## Install

Requires macOS 14 or later. In a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/Sskift/skfiy-next/main/install.sh | bash
```

This:

1. Downloads the prebuilt universal binary (Apple silicon and Intel) from the latest GitHub release and checks its sha256. When there is no release yet, it builds from source instead, which needs Apple's Command Line Tools (`xcode-select --install`, about 1.3 GB; full Xcode is not needed; the build takes about a minute).
2. Installs it as `~/.local/bin/skfiy`. No `sudo`.
3. Runs `skfiy setup`: writes the browser extension files and registers its native messaging host, registers skfiy with Claude Code (user scope) when the `claude` CLI is installed, checks permissions without prompting, and lists what is left for you. `skfiy setup` can run any number of times; it only fixes what is missing or out of date.

What is usually left for you:

- **Permissions.** macOS grants Accessibility and Screen Recording to **the app that runs Claude Code** (your terminal, VS Code or the Claude desktop app), not to skfiy. Run `~/.local/bin/skfiy doctor` in that app to get the macOS prompts, then quit and reopen it and Claude Code.
- **Browser extension (optional, recommended).** In Chrome open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and choose `~/Library/Application Support/skfiy/browser-extension` (press cmd+shift+G in the folder dialog and paste the path).

Then ask Claude Code things like "make a new note in Notes saying …".

**Update:** run the same command again. Restart running Claude Code sessions to use the new version; when the extension files changed, click reload on the skfiy card in `chrome://extensions`.

**From a clone:** `./install.sh` or `make install` builds the checkout and does the rest the same way.

Options (when piping from curl: `curl … | bash -s -- --codex`; the first three also work with `skfiy setup`, the last three are installer-only):

| Option | Effect |
| --- | --- |
| `--codex` | Also register skfiy with Codex (`codex mcp add`); an existing Codex entry is always kept up to date |
| `-e SKFIY_LOCKED_USE=direct` | Add a setting to the registration (here: keep working while the Mac is locked); later setups keep it |
| `--no-claude` / `--no-browser` | Leave the Claude Code registration / the browser part alone |
| `--from-source` | Build from source even when a release exists |
| `--prefix DIR` | Install into `DIR/bin` instead of `~/.local/bin` |
| `--uninstall` | Uninstall (below) |

Other MCP clients: command `~/.local/bin/skfiy` (full path), argument `mcp`.

`skfiy doctor` checks everything: permissions (and which app needs them), PATH, which binary Claude Code runs, each browser's native host, the extension version and connection, the emergency stop, MCP servers still running an older build, and `SKFIY_*` settings that are invalid or misspelled. `skfiy doctor --check` never shows a prompt.

`~/.local/bin` is not on the default PATH. To type plain `skfiy`, run `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile` and open a new terminal.

## Uninstall

`~/.local/bin/skfiy uninstall` (or `install.sh --uninstall`) removes skfiy from Claude Code and Codex, deletes the native host manifests, `~/Library/Application Support/skfiy`, `~/Library/Caches/skfiy`, `~/Library/Logs/skfiy` (including the action log and flows) and the binary (`--keep-binary` keeps it). Registrations and native hosts that point at another skfiy that still exists (say a second copy installed with `--prefix`) are left alone, and so are the shared folders; only this binary goes. Host manifests written for a custom profile with `--user-data-dir` must be deleted by hand (`NativeMessagingHosts/com.skfiy.bridge.json` in that folder). Left for you: remove the skfiy card in `chrome://extensions` and restart Claude Code sessions that still run skfiy.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| A tool says Accessibility or Screen Recording is missing | Grant it to the app that runs Claude Code (`skfiy doctor` names it), then restart that app and Claude Code |
| Browser tools say no browser is connected | Run `skfiy setup`, then load the extension in `chrome://extensions`; Chrome with no window open has its extensions unloaded |
| Every call is refused | The emergency stop is on: `skfiy resume` or press ⌃⌥⌘. |
| Nothing changed after an update | Restart the Claude Code session; reload the extension if its files changed |
| `skfiy: command not found` | See PATH above, or use the full path |

## Settings

Pass settings with `skfiy setup -e NAME=value` (kept by later setups) or `claude mcp add --scope user skfiy -e NAME=value -- ~/.local/bin/skfiy mcp` (the name goes before `-e`, which takes several values).

| Variable | Default | Effect |
| --- | --- | --- |
| `SKFIY_LOCKED_USE` | off | `direct`: keep operating apps while the Mac stays locked (window screenshots and pid-targeted input) |
| `SKFIY_LOCKED_WAKE_DISPLAY` | on | `0`: do not wake a sleeping display while locked (no screenshots then) |
| `SKFIY_BRIEF_FOCUS` | off | `1`: use a brief in-app focus for every pointer click without asking per app |
| `SKFIY_ALLOW_TERMINALS` | off | `1`: allow input into terminal apps (never into the app hosting skfiy) |
| `SKFIY_CURSOR` | on | `0`: hide skfiy's own cursor |
| `SKFIY_CURSOR_IDLE` | `20` | Seconds without actions before that cursor fades out |
| `SKFIY_ACTION_LOG` | `~/Library/Logs/skfiy/actions.jsonl` | Action log path; `off` records nothing |
| `SKFIY_FLOW_DIR` | `~/Library/Application Support/skfiy/flows` | Where flow checkpoints are kept |
| `SKFIY_SETTLE_SECONDS` | `0.4` | Time to let the UI settle before a screenshot |
| `SKFIY_SCREENSHOT_FORMAT` | `jpeg` | `png` for lossless screenshots |

skfiy's own files live under `$HOME/Library` and follow `HOME`, so `HOME=$(mktemp -d) skfiy setup` tries an install without touching your real setup. One exception for now: the `run_in_front` grant file still uses the real home folder (set `SKFIY_FRONT_GRANT_FILE` to isolate it).

## Development

`make test` runs the unit tests (use it rather than plain `swift test` with Command Line Tools only), `make test-install` tests install.sh, setup, doctor and uninstall in a throwaway HOME with fake `claude`/`codex` CLIs, and `make dist` builds the release tarball. Python 3 (standard library only) is needed only for the end-to-end test scripts in `scripts/`.
