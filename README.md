# skfiy

让 Claude Code、Codex 等 MCP 客户端在后台查看和操作 Mac 应用。普通操作不抢焦点、不移动你的鼠标；需要前台操作时先征得同意。

**单个 Swift 二进制 · 无额外运行时依赖 · macOS 14+ · Apple 芯片与 Intel**

[English](README.en.md) · [功能与参数](docs/reference.md) · [兼容性](docs/compatibility.md)

## 1. 安装

使用 Claude Code，在终端运行：

```bash
curl -fsSL https://raw.githubusercontent.com/Sskift/skfiy-next/main/install.sh | bash
```

使用 Codex：

```bash
curl -fsSL https://raw.githubusercontent.com/Sskift/skfiy-next/main/install.sh | bash -s -- --codex --no-claude
```

下载已编译的发布包，校验后安装到 `~/.local/bin/skfiy`，自动注册客户端并列出后续步骤。不需要 `sudo`、Xcode、Node 或 Python。下载失败时会说明原因并停止，不会自动编译源码。

其他 MCP 客户端：命令填 skfiy 的完整绝对路径，参数填 `mcp`。更多选项见[安装说明](docs/installation.md)。

## 2. 授权

在实际运行客户端的应用里执行：

```bash
~/.local/bin/skfiy doctor
```

按提示给**宿主应用**（例如 Terminal、Ghostty、VS Code 或桌面客户端）授予“辅助功能”和“屏幕录制”权限，然后退出并重新打开宿主应用与客户端。

## 3. 验证

```bash
~/.local/bin/skfiy doctor --check
```

确认权限正常，再在客户端里说：

> 用 skfiy 列出我的 Mac 上的应用。

能得到应用列表后，就可以试试“在备忘录里新建一条购物清单”。具体应用的支持情况见[兼容性记录](docs/compatibility.md)。

## 浏览器扩展（可选）

需要操作带登录态的 Chrome 后台标签页时再加载；原生应用工具不依赖它。

1. Chrome 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”。
3. 在选择框按 `⌘⇧G`，粘贴 `~/Library/Application Support/skfiy/browser-extension` 并确认。

连接和其他浏览器的说明见[浏览器扩展](docs/installation.md#浏览器扩展可选)。

## 更新与卸载

**更新**：重跑安装命令，已有设置会保留。重启客户端；提示扩展更新时，也在扩展页面刷新 skfiy。

**卸载**：

```bash
~/.local/bin/skfiy uninstall
```

浏览器里的扩展卡片需手动移除。详细清理范围见[卸载说明](docs/installation.md#卸载)。

## 常见问题

| 问题 | 处理 |
| --- | --- |
| 下载失败 | 检查终端到 GitHub 的网络或代理，再重试；[详细说明](docs/installation.md#网络失败) |
| 缺少权限 | 在实际宿主中运行 `doctor`，授权后重启宿主与客户端 |
| `skfiy: command not found` | 使用 `~/.local/bin/skfiy`；[PATH 设置](docs/installation.md#命令找不到)可选 |
| 浏览器未连接 | 加载或刷新扩展，保持浏览器窗口打开 |

随时按 `⌃⌥⌘.` 急停，再按恢复。

[锁屏模式](locked-use/README.md) · [安装与排错](docs/installation.md) · [开发与测试](docs/development.md) · [更新记录](CHANGELOG.md) · [MIT](LICENSE)
