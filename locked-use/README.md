# 锁屏期间继续使用 skfiy

direct 模式通过 ScreenCaptureKit 的独立窗口捕获和按 PID 投递的键鼠事件，在 macOS 会话保持锁定时操作已经运行的应用。它使用普通 skfiy MCP 二进制，不解锁系统，不需要 guardian、系统授权插件、管理员安装或 Apple 开发者签名身份，也不读取或保存登录密码。

## 当前验收状态

**2026-10-04：合并前的 direct release 版本已安装并通过真实锁屏 MCP 端到端测试，当时 72 项自动测试通过。** 安装版本测试覆盖实时截图、按截图 OCR 坐标点击、输入随机文本、提交、按键、滚动和拖动，并由 fixture 的真实事件日志和独立截图 OCR 核验。518 个独立锁态采样以及 fixture 操作记录均保持锁定；20 项不支持或非法请求和会话结束后的访问均被拒绝。测试全过程未安装或调用 skfiy 授权插件。

双窗口回归还验证了同一进程的两个真实窗口（一个标题为空）均可截图，但键盘输入因目标不唯一而被拒绝，实际收到的键事件为零。测试从已锁定状态启动 MCP；有限采样不能证明未采样的每个瞬间，也没有替代所有第三方应用、多显示器或解锁切换场景的兼容性验证。

合并至 `main` 后，71 项 Swift 测试、9 项安装策略测试、C lease 与插件边界测试、release 及 guardian 构建均通过。合并后的真机重测在前置检查时发现会话已再次解锁，因此该轮未完成；上面的完整锁屏验收结果来自合并前的 direct release。

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

在 MCP 客户端配置中，`command` 使用普通 `skfiy` 二进制的绝对路径，`args` 为 `["mcp"]`，给该 server 的 `env` 添加 `"SKFIY_LOCKED_USE": "direct"`。更新二进制或环境变量后重新启动 MCP 会话。不需要安装 guardian 或系统授权插件；不要同时添加 `--locked-use` 参数。

截取窗口需要显示器亮着。锁屏后显示器通常很快熄灭，此时 ScreenCaptureKit 只返回内部错误（-3811）。direct 模式在需要截图而显示器已熄灭时，会用电源管理的“用户活动”把显示器唤醒到锁屏画面（屏幕上只有锁屏界面，系统保持锁定），并在最后一次截图后 2 分钟内阻止显示器休眠，之后放开，显示器照常熄灭；MCP 进程退出时也随之放开。设置 `SKFIY_LOCKED_WAKE_DISPLAY=0` 可禁止唤醒，此时显示器熄灭期间截图、文字识别和坐标操作不可用，`get_app_capabilities` 与报错会说明原因。解锁状态下不会唤醒显示器。

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
| `zoom` | 以显示器原始分辨率（或指定倍数）截取最新截图中的一块，给出与原截图的换算公式和 `zoom_id`；截图超过 30 秒、窗口移动或缩放后拒绝 |
| `wait_for` | 不发送输入，等截图识别文字中某段文字出现或消失，或等窗口（或 `region` 指定的一部分）画面稳定；锁态变化、窗口关闭、应用退出时停止并说明原因。每次只截小图比对，画面不变时放慢，像素变了才截全分辨率图识别文字 |
| `get_app_state` 的 `since` | 与某次版本相比：同一窗口、同一位置、像素相同则只回“未变”（不附截图、不重新识别）；否则列出识别文字的增删改和窗口变化 |
| `locate` / `target` | 按名称、窗口区域、所在区块（离它最近的上方标题）、邻近文字查找控件：当场重新截图并识别文字，按位置关系判断；只用于 `click`、`scroll`；类型无法从像素核对；几个同样符合时不操作并列出候选。新截图即成为最新截图 |
| `locked_use_status` | 查看 direct 会话阶段、锁态是否已知及系统是否仍锁定 |
| `locked_use_end` | 结束当前 MCP 会话的 direct 操作权限并清除坐标；不锁屏、不解锁 |

每个操作都需要近期截图及仍匹配的应用进程、窗口和几何位置。窗口移动、关闭、进程变化、系统锁态未知或锁态改变会使旧状态失效；重新调用 `get_app_state` 后才能操作。坐标必须位于最新截图内。操作后的截图用于确认效果，事件投递成功本身不代表应用已完成操作。

`locked_use_end` 之后若需再次使用锁屏能力，要新建 MCP 会话。关闭 MCP 也不会改变系统锁定状态。`skfiy stop` 仍可中止操作。

## 当前限制

- 锁屏 direct 模式不支持 `element_index`、`set_value`、`select_text` 或其他 AX 动作，也不把锁屏前的元素树当作当前状态。
- 不支持 `run_in_front`、`focus: true`、文件打开/保存面板、剪贴板操作或剪贴板快捷键。需要这些功能的步骤应在手动解锁后执行。
- 多窗口应用可以按窗口选择截图和坐标操作，但键盘目标无法可靠确认时会拒绝 `press_key` 和 `type_text`。单窗口也仍受应用是否接受后台事件的限制。
- 2026-10-05 锁屏可行性实验（`scripts/experiment_locked_keyboard.py`，同一进程两个窗口，4 种投递方式各 12 次，锁态采样全部为锁定）：按进程投递时按键进入应用自己当前的 key window，与目标窗口无关（8/12 恰好命中）；加窗口路由字段相同；先发焦点记录后始终进入主窗口（6/12）。锁屏时辅助功能的焦点/主窗口均读不到，窗口服务器层级只与实际接收窗口一致 6/12，ScreenCaptureKit 把两个窗口都标为活动。没有任何 skfiy 可用的信号能事先确认接收窗口，因此多窗口时键盘输入继续拒绝。记录：`eval/results/locked-keyboard-locked-20261005-012238-bb58eae69b`（本机）。
- 不读取或控制系统登录、认证窗口。终端与承载 skfiy 的宿主仍受原有目标保护规则约束。
- 未承诺对所有 AppKit、Chromium、WebKit、自绘应用、文件面板、多显示器、全屏或其他桌面空间都有效。独立 fixture 成功只证明该测试覆盖的窗口和操作。多显示器只用临时虚拟显示器验证过（`scripts/test_displays.py`：主屏左侧 1× 屏、运行中接入的 2× 屏、跨屏窗口、移除显示器，2026-10-06 锁屏 23/23），未在真实外接显示器上验证。
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
python3 scripts/smoke_locked_direct_multiwindow.py ~/.local/bin/skfiy --run
```

此测试只操作自己创建的 fixture，通过真实 MCP 工具获取截图及坐标，再发送输入；fixture 独立记录收到的事件，另一个采样器记录系统锁态。它不请求解锁，运行结束仍保持原有锁定状态。单窗口结果保存在 `eval/results/locked-direct-mcp-*`，双窗口拒绝回归结果保存在 `eval/results/locked-direct-multiwindow-*`。`diagnose_locked_direct.py --already-locked` 则只用于底层 API 能力诊断，不是产品 MCP 的验收替代品。

## 独立的实验性 guardian 方案

仓库另保留 `skfiy mcp --locked-use` 路径：经本地身份验证后，由授权插件和 guardian 在桌面操作期间遮屏、短暂解锁，完成后重新锁定。其安装器、签名配置、测试和恢复流程见 [GUARDIAN.md](GUARDIAN.md)。该路径仍未完成 M1 Pro / macOS Tahoe 26.6.1 真机验收；上面的 direct 测试不能用于证明它可用。

`SKFIY_LOCKED_USE=direct` 与 `--locked-use` 是互斥的启用方式。direct 的安装与使用不依赖 guardian；停止 direct MCP 会话或移除环境变量即可停用，不需要管理员卸载。

早期开发分支还曾使用 `SKFIY_LOCKED_USE=1` 和另一套插件/guardian。该版本已从当前代码移除，旧安装命令不适用于此版本。其 ad-hoc 插件曾被系统宿主拒绝加载，本机实验组件随后已撤回；这一历史结果既不是 direct 的前提，也不是当前 `--locked-use` guardian 的真机验收结果。相关本机记录保留在 `eval/results/locked-use-20261004-193856-10f0c0e4fe6b/` 与 `eval/results/locked-use-audit-20261004-194734/summary.json`，不随代码发布。
