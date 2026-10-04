# 锁屏期间继续使用 skfiy

direct 模式通过 ScreenCaptureKit 的独立窗口捕获和按 PID 投递的键鼠事件，在 macOS 会话保持锁定时操作已经运行的应用。它使用普通 skfiy MCP 二进制，不解锁系统，不需要 guardian、系统授权插件、管理员安装或 Apple 开发者签名身份，也不读取或保存登录密码。

## 当前验收状态

**2026-10-04：已安装的 release 版本通过真实锁屏 MCP 端到端测试，72 项自动测试通过。** 安装版本测试覆盖实时截图、按截图 OCR 坐标点击、输入随机文本、提交、按键、滚动和拖动，并由 fixture 的真实事件日志和独立截图 OCR 核验。518 个独立锁态采样以及 fixture 操作记录均保持锁定；20 项不支持或非法请求和会话结束后的访问均被拒绝。测试全过程未安装或调用 skfiy 授权插件。

双窗口回归还验证了同一进程的两个真实窗口（一个标题为空）均可截图，但键盘输入因目标不唯一而被拒绝，实际收到的键事件为零。测试从已锁定状态启动 MCP；有限采样不能证明未采样的每个瞬间，也没有替代所有第三方应用、多显示器或解锁切换场景的兼容性验证。

原始截图、日志和结果保存在执行测试的本机 `eval/results/` 中，不随代码发布。本次记录为 `locked-direct-mcp-20261004-201554-01360e619bb8/summary.json` 和 `locked-direct-multiwindow-20261004-201753-f9d30551aefa/summary.json`；可按下方“验证”步骤生成自己的记录。

## 安装与启用

在仓库执行普通安装，随后检查宿主的辅助功能和屏幕录制权限：

```bash
make install
~/.local/bin/skfiy doctor
```

这些命令不需要 `sudo` 或 Apple 开发者证书。macOS 权限仍由机主在系统设置中授予；授权后需重启启动 skfiy 的宿主与 MCP 会话。

启动 MCP 时显式选择 direct 模式：

```bash
SKFIY_LOCKED_USE=direct ~/.local/bin/skfiy mcp
```

在 MCP 客户端配置中，`command` 使用普通 `skfiy` 二进制的绝对路径，`args` 为 `["mcp"]`，给该 server 的 `env` 添加 `"SKFIY_LOCKED_USE": "direct"`。更新二进制或环境变量后重新启动 MCP 会话。不需要运行本目录的 `install.sh`、`package.py` 或 guardian。

可以先启动 MCP 再锁屏，也可以在已经锁屏时启动 MCP。目标应用必须已经运行，所需系统权限必须事先授予。direct 模式不会为工具调用解锁、启动新的应用或操作系统登录窗口。Mac 解锁时，普通应用操作继续使用原有 AX、文件、前台确认等功能；锁定状态变化后需要重新获取 app state，旧元素编号和截图坐标不再有效。

## 锁屏时的操作

先调用 `get_app_state`，指定应用名、路径或 bundle ID。它返回单个窗口的实时截图、窗口 ID、截图像素与屏幕坐标的对应关系，以及默认开启的截图文字识别；多个窗口时可用 `window` 指定标题或窗口 ID。

| 工具 | direct 锁屏模式行为 |
| --- | --- |
| `get_app_state` | 读取目标进程的单个窗口截图及 OCR 文字坐标，不使用 AX 元素树 |
| `click` | 使用最新截图内的 `x` / `y`，可选左右中键、双击或三击和修饰键 |
| `scroll` | 在最新截图的 `x` / `y` 处按方向和页数滚动 |
| `drag` | 在同一窗口内按截图像素坐标拖动 |
| `press_key` | 把按键投递给目标应用；须只有一个可确认的窗口 |
| `type_text` | 向目标应用发送 Unicode 键盘事件；须只有一个可确认的窗口 |
| `locked_use_status` | 查看 direct 会话阶段、锁态是否已知及系统是否仍锁定 |
| `locked_use_end` | 结束当前 MCP 会话的 direct 操作权限并清除坐标；不锁屏、不解锁 |

每个操作都需要近期截图及仍匹配的应用进程、窗口和几何位置。窗口移动、关闭、进程变化、系统锁态未知或锁态改变会使旧状态失效；重新调用 `get_app_state` 后才能操作。坐标必须位于最新截图内。操作后的截图用于确认效果，事件投递成功本身不代表应用已完成操作。

`locked_use_end` 之后若需再次使用锁屏能力，要新建 MCP 会话。关闭 MCP 也不会改变系统锁定状态。`skfiy stop` 仍可中止操作。

## 当前限制

- 锁屏 direct 模式不支持 `element_index`、`set_value`、`select_text` 或其他 AX 动作，也不把锁屏前的元素树当作当前状态。
- 不支持 `run_in_front`、`focus: true`、文件打开/保存面板、剪贴板操作、剪贴板快捷键、`zoom` 或 `wait_for`。需要这些功能的步骤应在手动解锁后执行。
- 多窗口应用可以按窗口选择截图和坐标操作，但键盘目标无法可靠确认时会拒绝 `press_key` 和 `type_text`。单窗口也仍受应用是否接受后台事件的限制。
- 不读取或控制系统登录、认证窗口。终端与承载 skfiy 的宿主仍受原有目标保护规则约束。
- 未承诺对所有 AppKit、Chromium、WebKit、自绘应用、文件面板、多显示器、全屏或其他桌面空间都有效。独立 fixture 成功只证明该测试覆盖的窗口和操作。
- 屏幕录制被拒绝、截图超时或窗口不可捕获会明确报错；不会退回整桌面截图、切换前台或临时解锁。
- 浏览器扩展继续使用独立通道；浏览器 DOM 操作成功不代替原生应用锁屏验收。

## 验证

```bash
make test
python3 scripts/diagnose_locked_direct.py --prepare
python3 scripts/smoke_locked_direct.py ~/.local/bin/skfiy --prepare
```

后两行只准备专用 fixture 与测试程序，不进行 GUI 操作。Mac 已真正锁定、宿主已有所需权限时，可执行产品 MCP 测试：

```bash
python3 scripts/smoke_locked_direct.py ~/.local/bin/skfiy --run
```

此测试只操作自己创建的 fixture，通过真实 MCP 工具获取截图及坐标，再发送输入；fixture 独立记录收到的事件，另一个采样器记录系统锁态。它不请求解锁，运行结束仍保持原有锁定状态。结果保存在 `eval/results/locked-direct-mcp-*`。`diagnose_locked_direct.py --already-locked` 则只用于底层 API 能力诊断，不是产品 MCP 的验收替代品。

## 附录：早期系统授权插件实验

早期实现参考 [OpenAI Computer Use 的 Locked use 机制](https://learn.chatgpt.com/docs/computer-use)：由自己的授权插件短时解锁系统会话，由 guardian 和 watchdog 遮挡所有显示器并拦截本地输入，结束或故障时重新锁屏。该实验使用 `SKFIY_LOCKED_USE=1`，与上面的 `direct` 是两条独立路径。

**这个插件实验未通过验收，不是当前默认安装指引。** 2026-10-04 实机日志证明 macOS AMFI 拒绝在 `SecurityAgentHelper` 中加载 ad-hoc 的 `SkfiyLockedUse.bundle`。当次短暂解锁由已有 Codex 插件批准，skfiy 因自身一次性授权未被消费而拒绝继续，不能把它算作 skfiy 插件成功。

失败记录位于 `eval/results/locked-use-20261004-193856-10f0c0e4fe6b/`；本机随后已撤回不可加载的 skfiy 系统组件，恢复原有 Codex 和 `use-login-window-ui` 规则，核验记录位于 `eval/results/locked-use-audit-20261004-194734/summary.json`。direct 模式不依赖这套系统组件。

普通 MCP 和独立 guardian 可以本地构建，不要求 Apple 开发者身份。失败限制在插件被系统宿主加载这一层，不代表所有锁屏实现都必须使用 Apple 签名。历史安装入口保留 Apple 证书链及 Team ID 检查，以拒绝已知不可用的 ad-hoc 插件；静态签名检查通过仍不能证明宿主接受加载或完整功能已通过验收。

仅进行历史方案的本地编译与自动测试时使用：

```bash
locked-use/build.sh --adhoc-for-tests
python3 locked-use/test_installer.py -v
locked-use/test_plugin.sh
```

测试构建的 ad-hoc 插件不会被系统安装入口接受。研究系统宿主加载需自行提供其认可的签名，再通过 `SKFIY_CODESIGN_IDENTITY` 构建和 `package.py` 打包；取得证书不保证加载成功。该方案仍需管理员安装、单独权限授权及全部真实锁屏和故障恢复测试。本机尚未完成这些验收，不应启用为日常路径。

若需撤回其他机器上此前安装的实验组件，先结束旧方案会话，再执行：

```bash
sudo locked-use/uninstall.sh
```

源码目录受 macOS 隐私访问限制时，可用 `python3 locked-use/package.py --uninstall` 生成独立卸载包后通过 Installer 执行。卸载只移除 skfiy 自己的授权分支和组件，保留其他规则及原始备份。direct 模式无需此卸载步骤；停止其 MCP 会话或移除配置中的环境变量即可停用。
