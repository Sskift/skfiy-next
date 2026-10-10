# skfiy

Let Claude Code, Codex and other MCP clients see and operate Mac apps in the background. Normal operations keep your focus and pointer in place; operations that need the foreground ask for approval first.

**One Swift binary · No extra runtime dependencies · macOS 14+ · Apple silicon and Intel**

[中文](README.md) · [Tools and settings](docs/reference.md) · [Compatibility](docs/compatibility.md)

## 1. Install

For Claude Code, run in a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/Sskift/skfiy-next/main/install.sh | bash
```

For Codex:

```bash
curl -fsSL https://raw.githubusercontent.com/Sskift/skfiy-next/main/install.sh | bash -s -- --codex --no-claude
```

Downloads and verifies a prebuilt release, installs it at `~/.local/bin/skfiy`, registers the client and lists the next steps. No `sudo`, Xcode, Node or Python required. Download failures stop with an explanation; they never trigger a source build.

Other MCP clients: use the binary's full absolute path as the command and `mcp` as its argument. Run `~/.local/bin/skfiy setup --help` for options.

## 2. Grant permissions

In the app that actually runs your MCP client:

```bash
~/.local/bin/skfiy doctor
```

Follow the prompts to grant **the host app** (Terminal, Ghostty, VS Code or your desktop client) Accessibility and Screen Recording access. Quit and reopen the host app and your MCP client afterward.

## 3. Verify

```bash
~/.local/bin/skfiy doctor --check
```

Once permissions are granted, ask your client:

> Use skfiy to list the apps on my Mac.

After you get the app list, try “Make a shopping list in Notes.” See the [compatibility record](docs/compatibility.md) for app-specific support.

## Browser extension (optional)

Load this to work in background tabs of your real Chrome, with your logins. Desktop app tools work without it.

1. Open `chrome://extensions` in Chrome and enable Developer mode.
2. Click **Load unpacked**.
3. Press `⌘⇧G` in the folder dialog, paste `~/Library/Application Support/skfiy/browser-extension` and confirm.

Keep a browser window open. After extension updates, click reload on the skfiy card.

## Remote Windows desktops (optional)

Use `skfiy remote add NAME SSH_HOST` with an existing SSH connection to configure a signed-in Windows desktop. The `remote_desktop` tool can then take screenshots, click, type, send shortcuts, scroll and drag while RustDesk stays in the background, without changing Mac focus or raising its windows. The Windows helper starts on demand and exits after two idle minutes. See the [setup guide and limits](docs/remote-desktop.md) (Chinese).

## Update and uninstall

**Update:** run the installation command again; your settings are kept. Restart the MCP client and reload the browser extension when prompted.

**Uninstall:**

```bash
~/.local/bin/skfiy uninstall
```

This removes registrations, the binary and skfiy's data, including logs and flow checkpoints. Remove the extension card from your browser manually.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Download failed | Check the terminal's connection to GitHub or its proxy, then retry |
| Permissions missing | Run `doctor` in the actual host app, grant access and restart it and your client |
| `skfiy: command not found` | Use `~/.local/bin/skfiy`; changing PATH is optional |
| Browser not connected | Load or reload the extension and keep a browser window open |

Press `⌃⌥⌘.` to stop skfiy at any time; press it again to resume.

Advanced documentation is in Chinese: [Installation](docs/installation.md) · [Locked mode](locked-use/README.md) · [Development](docs/development.md). To build a checkout, use `./install.sh --from-source` or `make install` (Swift 6 required); plain `./install.sh` installs the published release.

[Release notes](CHANGELOG.md) · [MIT](LICENSE)
