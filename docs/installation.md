# 安装与排错

[返回首页](../README.md) · [功能与参数](reference.md)

需要 macOS 14 或更新版本，支持 Apple 芯片和 Intel。普通安装下载已编译的二进制，不需要开发工具，也不需要 `sudo`。

## 安装与更新

```bash
curl -fsSL https://raw.githubusercontent.com/Sskift/skfiy-next/main/install.sh | bash
```

脚本校验发布包的 SHA-256，将二进制装到 `~/.local/bin/skfiy`，然后执行 `setup`：注册 Claude Code、准备可选浏览器扩展并检查权限。重复运行即可更新，已有设置会保留。已运行的 MCP 会话要重启；浏览器扩展文件更新后，在扩展页面点击 skfiy 卡片上的刷新按钮。

Codex 用户在安装命令末尾改用 `bash -s -- --codex`。只使用 Codex 时可再加 `--no-claude`。其他 MCP 客户端使用二进制的**完整绝对路径**作为命令，参数为 `mcp`；配置里的 `~` 不一定会被展开。

### 安装选项

选项放在 `bash -s --` 后面，例如：

```bash
curl -fsSL https://raw.githubusercontent.com/Sskift/skfiy-next/main/install.sh | bash -s -- --codex --no-browser
```

| 选项 | 作用 |
| --- | --- |
| `--codex` | 同时注册到 Codex；已有的 Codex 注册默认也会随更新维护 |
| `--no-claude` / `--no-codex` / `--no-browser` | 跳过对应客户端或浏览器部分 |
| `-e NAME=value` | 把设置写入客户端注册，之后更新保留 |
| `--prefix DIR` | 安装到 `DIR/bin`，默认 `~/.local/bin` |
| `--version X.Y.Z` | 下载指定版本 |
| `--no-setup` | 只安装二进制 |
| `--from-source` | 明确选择源码编译，需要 Swift 6 |
| `--release` | 下载发布包，也是默认行为 |
| `--binary FILE` | 安装本地已有的二进制 |
| `--uninstall` | 卸载该安装目录里的 skfiy |

前三行也可以直接传给 `~/.local/bin/skfiy setup`。脚本还支持 `SKFIY_PREFIX`、`SKFIY_REPO`、`SKFIY_RELEASE_URL`；`SKFIY_SOURCE_DIR` 只在 `--from-source` 时使用。

### 网络失败

下载失败会保留 curl 的错误信息并停止，已有安装保持原样。HTTP 404 表示对应文件不存在，应检查版本和 release 附件；连接、TLS 或超时错误应检查到 GitHub 的网络及终端代理。修复后重跑安装命令即可，**不会自动转成源码编译**。

浏览器能访问 GitHub，不一定代表终端也能。需要代理时，在当前终端按自己的代理软件说明配置 `HTTPS_PROXY` 或 `ALL_PROXY`。

## 授权与验证

在实际运行 MCP 客户端的应用中执行：

```bash
~/.local/bin/skfiy doctor
```

按提示给宿主应用授予“辅助功能”和“屏幕录制”权限，例如 Terminal、Ghostty、VS Code 或桌面客户端；`doctor` 会显示本次检测到的宿主。安装终端和实际运行客户端的应用不同时，需给实际宿主授权。完成后退出并重新打开宿主应用与 MCP 客户端。

然后执行只读检查：

```bash
~/.local/bin/skfiy doctor --check
```

确认权限正常，再在客户端里说：“用 skfiy 列出我的 Mac 上的应用。”能得到应用列表，说明客户端能调用服务；具体应用的读写兼容性见[兼容性记录](compatibility.md)。

### 命令找不到

始终可以使用 `~/.local/bin/skfiy`，不用修改 PATH。想直接输入 `skfiy` 时，在 zsh 的 `~/.zprofile` 中添加以下一行，再重开终端：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

自定义 `--prefix` 时，改为对应的 `DIR/bin`。

## 浏览器扩展（可选）

扩展让 agent 在带登录态的 Chromium 浏览器后台标签页里工作。原生应用工具不依赖它；Safari 使用原生应用工具。

1. Chrome 打开 `chrome://extensions`，开启“开发者模式”。Edge 等浏览器使用自己的扩展管理页面。
2. 点击“加载已解压的扩展程序”。
3. 在文件夹选择框按 `⌘⇧G`，粘贴 `~/Library/Application Support/skfiy/browser-extension` 并确认。

扩展 ID 为 `fkllhjogckpegfdomkajlkmjaaahnhbd`。悬停工具栏图标可看连接状态，未连接时角标为灰色 `!`。至少保留一个浏览器窗口；Chrome 没有窗口时会停止运行扩展。

安装时用了 `--no-browser`，或安装后才装浏览器，先重新执行 `~/.local/bin/skfiy setup`。自定义浏览器配置目录可用 `setup --user-data-dir /完整路径` 注册桥接。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 缺少辅助功能或屏幕录制权限 | 在实际宿主中运行 `doctor`，给该应用授权并重启 |
| 客户端没有 skfiy | 重新运行 `setup`；Codex 加 `--codex`，然后重启客户端 |
| 没有 `browser_*` 工具 | 运行 `setup` 注册浏览器桥接，再重启客户端 |
| 浏览器未连接 | 加载或刷新扩展，保持浏览器窗口打开，再运行 `doctor --check` |
| 每次操作都被拒绝 | 检查急停，运行 `~/.local/bin/skfiy resume` 或按 `⌃⌥⌘.` |
| 更新后行为没变 | 重启 MCP 会话；扩展更新过时也要刷新；`doctor` 会报告仍运行旧二进制的会话 |

## 从源码安装

需要 Swift 6 和 Xcode Command Line Tools（`xcode-select --install`），不需要完整 Xcode。已克隆仓库时：

```bash
./install.sh --from-source
```

`make install` 同样会编译当前代码再安装。直接运行 `./install.sh` 默认下载发布版，与在线安装一致。未克隆时，也可以给在线安装命令加 `--from-source`，由脚本克隆并编译。

## 卸载

```bash
~/.local/bin/skfiy uninstall
```

移除客户端注册、浏览器桥接、二进制以及 skfiy 的配置、缓存和日志（包括流程检查点）。`--keep-binary` 保留二进制。浏览器里的扩展卡片需手动移除，仍运行旧服务的 MCP 会话需要关闭。

另一份仍存在的 skfiy 如果被客户端或浏览器使用，它的注册与共享数据会保留。自定义 `--user-data-dir` 里的 `NativeMessagingHosts/com.skfiy.bridge.json` 需手动删除。Homebrew 管理的二进制使用 `brew uninstall skfiy` 移除；仓库仅提供未发布的 formula 模板。
