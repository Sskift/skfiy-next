# 实验性锁屏运行

目标环境是 **Apple Silicon（M1 Pro）、macOS Tahoe 26.6.1**。目前提供原生实现、可回滚安装器和测试入口，**尚未完成该环境的真机验收**。CI 编译、签名验证、策略单元测试都不能证明锁屏后能够操作应用。普通 `make install` 和 `skfiy mcp` 不启用此功能。

macOS 锁屏会阻断部分 AX、输入和 ScreenCaptureKit 操作。这里使用 Authorization Plug-in 为已有本地登录会话提供短暂解锁授权，操作期间遮住显示器，结束后重新锁定。它不是在休眠中运行，也不是一个隔离的虚拟桌面；Mac 必须保持开机，CLI agent 还需要网络。没有开机登录、FileVault 解锁、合盖运行的承诺。

## 构建与安装

先在可恢复的测试账户/测试机上运行。Tahoe 的登录窗口接口和授权后的钥匙串状态都需要核实；不能仅凭一次按钮点击成功就用于日常无人值守任务。已有人报告同类授权插件在 macOS 26 上影响钥匙串，见 [Codex issue 40226](https://github.com/openai/codex/issues/40226)。本实现不写密码或 keychain 上下文，但这不能证明系统的后续处理没有影响。

在 Mac 上安装 Xcode Command Line Tools、Swift 6 和 Python 3，然后执行：

```bash
make test
make test-locked-use
make test-locked-use-plugin
make locked-use
sudo python3 scripts/locked_use.py install --experimental --uid "$(id -u)"
make install
```

`make locked-use` 在当前架构上构建 guardian app 和授权插件，启用 hardened runtime，默认本地 ad-hoc 签名。可用 `SKFIY_SIGN_IDENTITY='Developer ID Application: …' make locked-use` 指定自己的身份。插件在目标系统能否加载必须实测；不要通过关闭 SIP、AMFI 或系统库验证解决加载失败。分发给其他机器还需要独立处理正式签名、公证和系统兼容性。

安装器只接受原始 `system.login.screensaver` 的 `use-login-window-ui` 规则。存在 Codex、MDM 或其他自定义解锁规则时会拒绝覆盖，先通过原组件自己的卸载流程恢复。安装器备份完整原规则，并在文件与新分支准备好后最后接入系统规则；失败则尝试恢复原规则并保留恢复记录。

随后在 **Mac 已解锁时**启动：

```bash
skfiy mcp --locked-use
```

也可以把 MCP 客户端配置中的参数改为 `["mcp", "--locked-use"]`。首次需要在系统设置中为 **Skfiy Locked Use** 授予辅助功能权限，然后重新启动 MCP；skfiy 原有的辅助功能和屏幕录制权限也必须具备。启动会弹出本地确认并调用 Touch ID / 系统身份验证。客户端的 MCP 启动超时应留够本地确认时间（最多 90 秒）。模型不能通过工具自行安装或批准这项授权。

授权绑定当前 MCP 进程，最长一小时；断开后必须重新启动、重新批准。不支持后台续期或持久化令牌。每个用户同一时间只有一个锁屏运行会话。

## 运行约束

- `get_desktop_status` 返回桌面、授权和急停状态；不解锁屏幕。
- 原生桌面调用开始时若已锁屏，两个独立 guardian 进程先遮盖全部显示器并启用输入监视，再发出最长三秒、只能消费一次的解锁许可。授权插件只接受系统签名 loginwindow 发起的 screensaver right，检查 root 所有的已签名 guardian 的进程身份和代码哈希。
- 自动触发仅尝试唯一、空的系统密码框所公开的 `AXConfirm` 动作。没有输入密码、模拟回车、坐标猜测或重试兜底。系统不提供该动作、授权失败、无法确认解锁都会停止，要求手动解锁。
- 工具完成后先撤销解锁许可，再锁屏。只有读到明确的锁定状态才撤下遮盖；状态未知时继续遮盖并尝试锁定。
- 保护期间检测到本地键鼠输入、显示器变化、失去事件监视、连接断开、急停、心跳超时或授权到期都会撤销会话。独立 watchdog 在主 guardian 卡住/退出时尝试重新锁屏。恢复需要手动解锁并重新批准，不自动重放可能已部分执行的操作。
- 锁屏保护期间只用后台操作，`run_in_front` 被拒绝。Chrome 扩展的 `browser_*` DOM 通道不经过原生解锁流程。
- 不向 loginwindow、SecurityAgent 或 guardian 发送模型指定的输入。不改变系统登录、sudo、FileVault、钥匙串授权策略，也不读取或存储登录密码。

遮盖窗口和事件监视依赖系统图形会话正常运行。它们不等价于硬件安全边界，也不能承诺抵御管理员、系统崩溃或两个保护进程同时被强制终止。自动化权限本身可以改动用户数据，授权应只交给可信的本地 agent。

## 验收

```bash
# 不安装、不锁屏的测试
make test-locked-use          # Linux / macOS：租约、单次消费、超时、撤销、安装回滚
make test-locked-use-plugin   # macOS：真实插件 ABI，模拟系统身份/IPC，检查拒绝路径

# 真机：弹出本地授权，随后等待你手动锁屏；只操作独立测试窗口
python3 scripts/smoke_locked_use.py ~/.local/bin/skfiy --allow-lock
```

真机脚本不会安装插件或接管授权弹窗。脚本在锁屏前启动独立测试 app；你批准 guardian 后手动锁屏。脚本检查锁屏状态、窗口截图、后台按钮动作和每次操作后的重新锁屏。失败输出是验收失败，不等同于“降级成功”。记录 `sw_vers`、`uname -m`、签名身份和错误文本，不提供密码或私人应用截图。

在 M1 Pro / Tahoe 26.6.1 上发布为可用功能前，还要人工验证以下情况：

1. 插件已安装但 guardian 未运行/未批准时，正常密码与 Touch ID 解锁仍可用；批准过期后也一样。
2. 连续锁屏操作至少 20 次，单屏、外接屏、全屏空间下所有可见显示器均被覆盖；键鼠事件能中止，用户需手动解锁后接管。
3. 操作中关闭 MCP 客户端、`skfiy stop`、终止主 guardian：不再向应用输入，watchdog 重新锁屏；操作可能部分完成的错误清楚可见。
4. 拔插显示器、切换用户、睡眠/唤醒、权限撤销：停止会话，不能自动恢复旧授权。
5. 单独检查钥匙串：自动解锁前后访问自己新建的测试项，随后手动解锁、注销登录、重启后仍可访问，Safari/系统密码功能无异常。不用真实密码做测试。发现钥匙串异常立即停用并保留系统诊断，不尝试重置钥匙串。
6. 卸载后普通解锁、skfiy 原有后台输入与截图、Chrome 插件均正常。

## 停用、卸载与恢复

先停止 `mcp --locked-use` 会话并手动解锁，再执行：

```bash
python3 scripts/locked_use.py status
sudo python3 scripts/locked_use.py uninstall
```

卸载先恢复原 screensaver 规则，再移除插件与 guardian；如果管理员在安装后改过规则，会保留文件和备份并拒绝覆盖。authd 自动生成的修改时间、版本和写入者签名标识不参与策略比较，也不能通过 plist 原样恢复。更新组件也采用先停止、卸载，再重建、安装的流程，不能替换正在运行的已授权二进制。

恢复备份位于 `/Library/Application Support/skfiy/locked-use-install.plist`，成功卸载后保留为 `locked-use-install.last-uninstall.plist`。备份包含原始与安装时的规则，没有用户密码。若自动恢复拒绝，应由管理员比较当前规则与备份中的 `original`，通过 `security authorizationdb write system.login.screensaver` 恢复确认过的原始 plist，再移除自定义分支和组件。不要写入通用 `allow`、删除系统 auth.db，或先删除仍被规则引用的插件。

## 实现依据

- Apple [Authorization Plug-ins](https://developer.apple.com/documentation/security/extending-authorization-services-with-plug-ins) 定义插件机制；安装与 callback 依赖原生 Security API。
- Apple [authd engine](https://github.com/apple-oss-distributions/Security/blob/main/OSX/authd/engine.m) 的签名来源使用 immutable hints，PID/right 使用普通 hints；插件同时核对请求者与授权创建者来自 Apple，以及实际进程是 loginwindow。安装器只接受没有前置第三方机制的原规则。
- OpenAI [Codex computer use 文档](https://developers.openai.com/codex/app/computer-use) 描述 locked use 的授权插件、临时解锁和遮屏设计。这里是独立实现，未取得或复用 Codex 私有组件。
- `SACLockScreenImmediate`、CG session 锁定字段和 loginwindow 的 AX 行为存在私有/未承诺稳定的部分；不满足检查就拒绝继续。
