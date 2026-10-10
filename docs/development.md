# 开发与验证

[返回首页](../README.md) · [功能与参数](reference.md)

除了 Swift 工具链，开发只在跑端到端测试时需要 Python 3（只用标准库）；`make` 是可选的快捷方式。

只装了 Command Line Tools 时，单元测试要用 `make test`（它补上 swift-testing 宏插件的路径；直接 `swift test` 会报 TestingMacros 找不到）。

```bash
make build          # swift build
make test           # 单元测试（swift-testing）
make test-install   # install.sh、skfiy setup / doctor / uninstall：在临时 HOME 里用假的 claude/codex 跑一遍，并核对你真实的配置没被改动；不碰界面
make embed-extension  # 改了 browser-extension/ 之后：重新生成二进制里携带的插件副本（make release/install、源码安装和 release.sh 会自动做；不一致时 make test 失败）；内容变了而 manifest.json 的 version 没升时会提醒
make dist           # 发布用的通用二进制压缩包（dist/），不发布任何东西；打 vX.Y.Z 标签后由 .github/workflows/release.yml 构建并发布
make smoke          # 端到端：经 MCP 在后台驱动 TextEdit，并断言 TextEdit 从未到前台
make smoke-fixture  # 自建的小应用（窗口放在所有窗口之后）：悬停提示、打开/存储面板、自绘视图的点击
make smoke-web      # 端到端：用应用工具操作测试网页（一次性的 Chrome for Testing + 独立 profile）
make smoke-browser  # 端到端：用浏览器插件在后台标签页操作测试网页，并断言你看到的标签页没变（先跑 scripts/test_bridge_host.py：插件重连时旧桥接进程不会删掉新进程的连接）
python3 scripts/smoke_browser.py ~/.local/bin/skfiy --user-browser   # 同上，但跑在你自己的 Chrome 里：只用自己开的后台标签页，不用调试接口
python3 scripts/smoke_chromium.py .build/debug/skfiy Safari   # 同一套网页测试跑在 Safari 上（先在后台打开测试页）
python3 scripts/app_coverage.py     # 只读探测：对正在运行的应用各取一次状态，只报数量和耗时，不输出内容
python3 eval/run_eval.py            # 真实任务：交给无头 `claude -p`（只开放 skfiy 工具）完成，独立检查结果，并监视前台与最顶层窗口
skfiy call get_app_state '{"app":"Finder"}'   # 单次调用调试，截图存到 /tmp/skfiy-screenshot.jpg
swift scripts/make_extension_icons.swift browser-extension   # 重新画插件图标（browser-extension/icon-*.png，已入库）；之后跑 make embed-extension
```

`make smoke-web` / `make smoke-browser` 先运行 `python3 scripts/compat_baseline.py <skfiy> --test-browser`：第一次会把 Chrome for Testing 下载到 `~/.cache/skfiy-test`，然后在后台用全新的临时 profile 启动它（加载插件、打开本地测试页服务 `scripts/compat_server.py` 上的 `scripts/fixtures/web.html`），不碰你自己的浏览器。`eval/run_eval.py` 也用这个测试浏览器。测试脚本共用 `scripts/harness.py` 里的 MCP 客户端：它不写你的操作日志；需要你同意的操作（例如上传文件），由测试按脚本里写好的回答答复。

历史测试记录（2026-09-29，macOS 26.6.1；后续结果见 [roadmap](roadmap.md)）：

- 单元测试 62/62；TextEdit 25 项全过；插件 34/34（Chrome for Testing 154，含悬停菜单、`browser_wait`、后台标签页截图后按像素点击）。
- 自建小应用（`make smoke-fixture`）17/17：悬停提示、`hand_over` 的三种结果、操作日志只记密码长度、不公开辅助功能的窗口里识别文字并点击、打开/存储面板、`save_document` 走存储面板、非文字拷贝粘贴后你的剪贴板原样放回、`read_clipboard` 必须经同意、右键菜单在后台被拒并指向 `run_in_front`。加 `--front` 后 17/17：经同意用 `run_in_front` 选右键子菜单项、点"拒绝非活跃窗口第一下点击"的视图和 WebKit 网页视图，前台每次都还回你原来的应用。
- 应用工具操作网页（Chrome for Testing）11/11；`SKFIY_BRIEF_FOCUS=1` 时 12/12（画布像素点击生效）。
- 只读覆盖（`scripts/app_coverage.py`）：11 个正在运行的应用都能取到状态，每次 0.1–0.5 秒；微信、网易云音乐、Clash Verge 不公开辅助功能，工具会明确提示。
- `run_in_front`（`scripts/smoke_foreground.py --accept`）：不同意时什么也不做；同意后 TextEdit 在前台约 1.1 秒，加粗生效，前台还回你原来的应用。
- 插件在日常使用的 Chrome 里（`--user-browser`，0.3.0 时）：23/23，你正在看的标签页没变，Chrome 没到过前台。
- 真实任务（`eval/run_eval.py`，claude-sonnet-5，只开放 skfiy 工具）：11 项中 9 项完成，全程在后台（在加入等待、文件面板、剪贴板等工具之前测的）。
- 监视器每 0.25 秒采样前台应用和最顶层窗口。除了应用自己激活自己、随即被交还的情况（见[后台机制](reference.md#后台是怎么做到的)），没有出现过抢占。

```
Sources/SkfiyKit/
  MCPServer.swift     stdio JSON-RPC（MCP）
  ToolSchemas.swift   工具定义、给模型的使用说明；各工具的特性（是否输入、可验证、锁屏可用、急停时仍可用、记入日志），分发用的各个工具列表由此得出
  ComputerUse.swift   工具分发与会话（元素编号 ↔ AX 元素，像素 ↔ 屏幕点）、前台守护、操作后的截图、共用的检查
  AppState.swift      list_apps、get_app_state（截图、带编号的树、since 变化）、树里的菜单
  Actions.swift       click、perform_secondary_action、set_value、scroll、drag
  Typing.swift        select_text、press_key、type_text
  Foreground.swift    run_in_front、skfiy 自己的剪贴板（cmd+c/x/v）、read_clipboard、hand_over、快捷键对应的菜单项
  Documents.swift     open_file、save_document、file_dialog
  Waiting.swift       等待引擎（wait_for、browser_wait 共用）与解锁时的 wait_for
  Zoom.swift          zoom
  Locate.swift / Locator.swift   locate 与 target：按描述查找控件
  Verification.swift / VerifiedActions.swift   expect：操作结果验证、防重复提交
  Capabilities.swift  get_app_capabilities
  FlowTools.swift / Flow.swift   flow_start / flow_record / flow_status
  DirectLockedUse.swift / DirectLockedCapture.swift   锁屏 direct 模式：单窗口截图、按进程投递的输入
  AXTree.swift        辅助功能树的遍历、裁剪与文本渲染
  AXElement.swift     AXUIElement 薄封装、文本元素的光标与选区
  StateChanges.swift / ChangeEvents.swift   状态版本与变化摘要、辅助功能通知
  TextRecognition.swift   Vision 文字识别
  Input.swift         投递到进程的键盘/鼠标/滚轮事件，SkyLight 入口
  Windows.swift       窗口查找、最上层窗口、前台守护（FrontGuard）与 run_in_front 的批准文件
  WindowTargeting.swift   指针与键盘落在哪个窗口、窗口是否被挡住
  Capture.swift       ScreenCaptureKit 截图与坐标映射
  VirtualCursor.swift skfiy 自己的光标
  Apps.swift          应用列表、名称/路径/bundle id 解析、后台启动、锁屏状态
  Keys.swift          xdotool 按键语法解析
  Clipboard.swift     剪贴板内容与系统剪贴板的借用
  FilePanel.swift     打开/存储面板
  BrowserBridge.swift native messaging 宿主 ⇄ Unix socket ⇄ MCP 的桥接、安装
  BrowserTools.swift  browser_* 工具
  RemoteDesktop.swift / RemoteDesktopScripts.swift  SSH Windows 桌面工具、显式安装/移除、内嵌脚本
  EmergencyStop.swift / ActionLog.swift / Instance.swift   急停、操作日志、每个 MCP 服务独立的可执行文件链接
  Arguments.swift     工具参数的类型化读取
  Setup.swift         skfiy setup / doctor / uninstall：插件文件、native host、Claude Code / Codex 注册、检查清单
  Paths.swift         skfiy 自己的文件位置（跟随 $HOME）
  EmbeddedExtension.swift  二进制里携带的插件副本（scripts/embed_extension.sh 生成）
Sources/skfiy/main.swift   CLI：setup / doctor / uninstall / mcp / tools / call / install-browser-bridge（浏览器以扩展 origin 作参数启动时即为宿主）
install.sh                 一键安装：下载 release 或从源码编译，装到 ~/.local/bin，再运行 skfiy setup
packaging/homebrew/        Homebrew formula 模板（未发布）
browser-extension/         MV3 插件：service worker + 注入页面的快照/操作函数
scripts/                   端到端测试（共用 harness.py 的 MCP 客户端）、应用覆盖探测、插件图标生成
remote-windows/            Windows 交互会话组件及 SSH 入口；修改后 python3 scripts/embed_remote.py，make test 检查内嵌副本一致
eval/                      真实任务评测：任务、独立判定、前台/最顶层窗口监视（结果在 eval/results，不入库）
```

## 历史

这个仓库原先是「桌宠 + 后台 Agent」的 Electron 项目（约 16 万行，含设置网页、记忆中心、自动化、旧版 Chrome 扩展等），2026-09-28 按"先做内核"的方向重写为现在的样子，旧实现与旧提交历史一并移除。桌宠素材只留在本地的 `art/`（不随仓库分发），桌面浮窗/桌宠之后在这个内核之上重做。

