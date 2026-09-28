# skfiy

macOS 的 computer use 内核：一个 MCP server，让 Claude Code（或任何 MCP 客户端）看见并操作 Mac 上的应用，能力对标 Codex 的 Computer Use，并且**全程在后台进行**——不抢焦点、不改变窗口层级、不移动鼠标、不碰剪贴板、不打断你正在进行的输入。

单个 Swift 二进制，无运行时依赖；另有一个可选的 Chromium 浏览器插件，让 agent 在你真实的 Chrome（带登录态）里用**后台标签页**工作。

## 安装与接入 Claude Code

```bash
make install                     # 编译 release 版装到 ~/.local/bin/skfiy，复制浏览器插件，注册 native messaging
skfiy doctor                     # 检查辅助功能 + 屏幕录制权限
claude mcp add --scope user skfiy -- ~/.local/bin/skfiy mcp
```

浏览器插件（可选，推荐）：Chrome 打开 `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 `~/Library/Application Support/skfiy/browser-extension`（文件夹对话框里按 cmd+shift+G 粘贴路径）。插件 ID 固定为 `fkllhjogckpegfdomkajlkmjaaahnhbd`。插件不要从 `~/Desktop`、`~/Documents` 加载——那里受隐私保护，Chrome 会弹权限请求。

macOS 把这两项权限授予**启动 skfiy 的宿主进程**（你的终端，如 Ghostty / Terminal / iTerm），而不是 skfiy 本身。`skfiy doctor` 会触发系统授权提示；授权后需重启终端与 Claude Code。

之后在 Claude Code 里直接说「在备忘录里新建一条……」「把 Finder 里的……」即可。

## 工具

前 10 个工具的名字和核心参数与 Codex 的 Computer Use 保持一致，提示词与使用习惯可以互通；`open_file` 是 skfiy 额外加的。

| 工具 | 作用 |
| --- | --- |
| `list_apps` | 正在运行的应用，以及最近 14 天用过的应用（最后使用时间、使用次数） |
| `get_app_state` | 应用窗口的截图 + 带编号的辅助功能树；未运行时在后台启动；可用 `window` 查看其他窗口（不会把它提到前面） |
| `click` | 按元素编号或截图像素坐标点击；支持右键、中键、双击/三击、修饰键 |
| `perform_secondary_action` | 执行元素的辅助功能动作（Increment、ShowMenu、Confirm…） |
| `set_value` | 直接设置文本框、滑块等可设值元素 |
| `select_text` | 在文本元素中选中文字或把光标放在其前后（可用 prefix/suffix 消歧） |
| `scroll` | 按页滚动元素或截图中的某个位置 |
| `drag` | 按截图像素坐标拖拽 |
| `press_key` | 按键 / 组合键（xdotool 语法：`Return`、`super+c`、`Page_Down`、`F5`…） |
| `type_text` | 向当前焦点输入文字 |
| `open_file` | 在后台用指定应用打开文件或文件夹，不经过"打开"面板（后台应用的打开/存储面板操作不了） |

浏览器插件连上后多出 10 个网页工具，按标签页 ID 操作，不切换你正在看的标签页：

| 工具 | 作用 |
| --- | --- |
| `browser_tabs` | 列出窗口和标签页，`[shown]` 标出你正在看的那个 |
| `browser_open` | 在后台新标签页打开网址（归入名为 "skfiy" 的标签组），或导航指定标签页 |
| `browser_state` | 以文本读取页面：标题与正文按文档顺序，所有可交互元素带编号；只有标签页正显示时才附截图 |
| `browser_click` | 按编号点击（或按截图坐标）；`target=_blank` 链接改为后台新标签页打开 |
| `browser_type` / `browser_select` / `browser_press_key` / `browser_scroll` | 输入（可清空、可提交）、选下拉项、按键、滚动页面或元素 |
| `browser_navigate` / `browser_close_tab` | 后退/前进/刷新、关闭标签页 |

树的样子（Finder）：

```
App: Finder — com.apple.finder (pid 623), in background
Window: "Applications"
Keyboard focus: [21]
Screenshot: 1146×686 px showing screen region x=278 y=324 w=1146 h=686 pt (1 px = 1 pt). …

[0] Window "Applications" actions=[Raise]
  [1] ScrollArea vscroll=0%
    [2] Outline "sidebar"
      [6] Row(OutlineRow) "Applications" selected
  [20] ScrollArea vscroll=38%
    [21] Outline "list view" focused
      [25] Row(OutlineRow) "Feishu | 22/9/26, 7:39 PM | 1.67 GB | Application"
Menu bar: [76] "Apple" [77] "Finder" [78] "File" …
```

## 后台是怎么做到的

优先走辅助功能（AX），做不到才向目标**进程**投递事件，任何时候都不经过你的光标和前台：

- **点击**：先按坐标命中测试出元素，再按语义执行——按钮/链接用 AXPress，文本框聚焦并用 `AXRangeForPosition` 把光标放到点击处，表格行设为选中，双击用 AXOpen，右键用 AXShowMenu。都不适用时才把带窗口路由字段的鼠标事件投递给进程（SkyLight `SLEventPostToPid`，缺失时退回公开的 `CGEvent.postToPid`），鼠标不动。
- **键盘**：事件直接投递给目标进程。后台应用不走你的输入法，所以中文输入法开着也不会把 `,` 变成 `，`。带 cmd/ctrl 的快捷键若对应一个可用菜单项，就直接执行该菜单项；全选/复制/剪切/粘贴/关闭窗口/最小化这些依赖前台状态的快捷键用 AX 等价实现。
- **文字**：逐字投递 Unicode 键盘事件；长文本或应用忽略后台按键时，改用 AX 直接插入。
- **菜单与窗口层级**：后台应用的菜单不会被真的打开（那会盖在你的屏幕上），点击菜单栏项时返回菜单内容和编号，再点具体项执行；右键菜单和菜单按钮在后台应用里不打开，窗口的 Raise 动作一律拒绝。每次操作之后还会检查：目标应用的窗口若盖住了你原来最顶层的窗口，就把你的窗口放回上面；目标应用若弹出了菜单，就把它关掉；弹出别的浮动面板（例如 Finder 里按空格打开的快速查看）则告诉模型。
- **截图**：ScreenCaptureKit 只截目标应用自己的窗口，被别的窗口挡住也能截到；隐藏或最小化的窗口不会被拉出来（此时没有截图，但按编号的操作照常可用）。
- **启动应用**：后台启动；若应用启动时自己抢了前台，会把前台交还给你原来的应用。
- **不碰终端**：终端里打的字会作为 shell 命令执行，绕过 Claude Code 自己的权限确认，而且终端里往往正跑着 agent 本身。所以对 Ghostty、Terminal、iTerm2、Warp、kitty 等终端，以及承载 skfiy 的应用（沿父进程链找到的那个），skfiy 只读取、只滚动，不点击、不输入。终端可用 `SKFIY_ALLOW_TERMINALS=1` 放开，承载 skfiy 的应用始终不放开。
- **打开文件**：`open_file` 通过 Launch Services 在后台打开文档，不激活应用。文件夹会在新的 Finder 窗口里打开，不占用你已有的窗口；这需要 skfiy 所在终端已有控制 Finder 的"自动化"权限，没有的话不会弹窗申请，而是提示模型改用 Finder 菜单。应用本身和可执行文件不会通过它打开。
- **兜底**：少数应用会在执行某个动作时自己激活自己（例如 Finder 的「前往文件夹…」「新建 Finder 窗口」），或者被别的动作带到前台（例如「打开方式」打开的应用）。每次操作期间，skfiy 用独立线程直接向窗口服务器查询前台应用；只要有别的应用跑到前台，而这期间你没有点鼠标或按修饰键（打字不算，所以你一直在打字时它照样生效），就在几十毫秒内把前台交还给你原来的应用；如果它的窗口盖住了你原来最顶层的窗口，也会把你的窗口放回最上面，并在结果里告诉模型换一种做法。

### 网页

- **插件路径（推荐）**：在页面的隔离环境里操作 DOM，后台标签页照样可用。输入用 `execCommand('insertText')`，产生 React 等框架认的 input 事件，中文也不经过输入法。点击是合成事件（`isTrusted=false`），绝大多数网站不在意；少数要求真实用户手势的操作（弹窗、写剪贴板）可传 `trusted: true`，通过 `chrome.debugger` 发真实输入事件——执行期间 Chrome 顶部会短暂出现「正在调试此浏览器」提示条，且真实点击/按键只对窗口中正显示的标签页有效（Chrome 会丢弃发往隐藏标签页的这类事件，真实输入文字则不受限）。
- **应用路径（无插件）**：`get_app_state` 读浏览器的辅助功能树（Chrome 等 Chromium 系和 Safari 都可以），只能操作每个窗口当前显示的标签页。链接/按钮/勾选框/表单/下拉框/可编辑区/滚动都走 AX，产生的是真实可信事件；但 Chromium 和 WebKit 都会丢弃发往后台窗口网页内容的指针事件，所以画布这类只能靠坐标点的内容需要 `SKFIY_BRIEF_FOCUS=1`。

### 已知限制

- 作用于当前选区或文档的命令（加粗等格式、保存、撤销）只在前台应用里生效：后台应用的这些菜单项是禁用的，格式栏上对应的按钮按了也没反应，开 `SKFIY_BRIEF_FOCUS` 也不行。全选/复制/剪切/粘贴已用 AX 实现；其余的工具会明确告诉模型做不到，而不是假装成功。
- 少数视图（如 AppKit 文本视图、画布类视图）不接受纯后台鼠标事件。文本视图已由 AX 路径覆盖；其余情况可设 `SKFIY_BRIEF_FOCUS=1`：仅在你键盘鼠标空闲 ≥0.8 秒时，让目标窗口在应用内短暂获得键盘焦点（不激活、不抬升窗口）完成点击，随即把焦点还给你的窗口。默认关闭。
- 应用自己激活自己只能事后纠正、无法事先阻止：它会在前台停留十几毫秒（实测 13 ms），这期间你敲的键可能落到它那里。
- SkyLight 与 `_AXUIElementGetWindow` 是私有接口，运行时动态查找；缺失时退回公开 API。
- `SKFIY_BRIEF_FOCUS` 会在你空闲时短暂改变键盘焦点，所以默认关闭。实测时以 10 毫秒间隔采样你前台应用的焦点窗口和焦点元素，全程没有变化；但没法模拟你真的在打字，所以仍按"有风险"对待。
- 沙盒应用的"打开/存储"面板由另一个系统进程提供，后台投递给应用的按键到不了它：打开文档请用 `open_file`；把新文档存到指定位置目前做不到，工具和模型会如实说明。
- 插件只支持 Chromium 系浏览器；Safari 走应用路径。
- 有些应用根本不向辅助功能公开界面：自绘界面（微信 4.x）、CEF 内嵌网页（网易云音乐）、部分 WKWebView 外壳（Clash Verge 等 Tauri 应用）。这时 `get_app_state` 会明确说明，只能靠截图坐标、菜单栏和快捷键；而后台指针点击是否被接受取决于应用本身。
- 启动期弹出的模态对话框（例如扩展加载失败的提示）有时不在辅助功能树里，只能从截图看到。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SKFIY_SETTLE_SECONDS` | `0.4` | 动作后等待界面稳定再截图的时间 |
| `SKFIY_SCREENSHOT_FORMAT` | `jpeg` | `png` 可得到无损截图 |
| `SKFIY_BRIEF_FOCUS` | 关 | `1` 开启上文的空闲时短暂应用内聚焦 |
| `SKFIY_ALLOW_TERMINALS` | 关 | `1` 允许向终端类应用输入（承载 skfiy 的应用仍然不行） |

## 开发

```bash
make build          # swift build
make test           # 单元测试（swift-testing）
make smoke          # 端到端：经 MCP 在后台驱动 TextEdit，并断言 TextEdit 从未到前台
make smoke-web      # 端到端：用应用工具操作测试网页（一次性的 Chrome for Testing + 独立 profile）
make smoke-browser  # 端到端：用浏览器插件在后台标签页操作测试网页，并断言你看到的标签页没变
python3 scripts/smoke_browser.py ~/.local/bin/skfiy --user-browser   # 同上，但跑在你自己的 Chrome 里：只用自己开的后台标签页，不用调试接口（需先起测试页服务，见 scripts/test_browser.sh）
python3 scripts/smoke_chromium.py .build/debug/skfiy Safari   # 同一套网页测试跑在 Safari 上（先在后台打开测试页）
python3 scripts/app_coverage.py     # 只读探测：对正在运行的应用各取一次状态，只报数量和耗时，不输出内容
python3 eval/run_eval.py            # 真实任务：交给无头 `claude -p`（只开放 skfiy 工具）完成，独立检查结果，并监视前台与最顶层窗口
skfiy call get_app_state '{"app":"Finder"}'   # 单次调用调试，截图存到 /tmp/skfiy-screenshot.jpg
```

`scripts/test_browser.sh` 会把 Chrome for Testing 下载到 `~/.cache/skfiy-test`，在后台用全新的临时 profile 启动它（加载插件、打开 `scripts/fixtures/web.html`），不碰你自己的浏览器。

最近一次结果（2026-09-28，macOS 26.6.1）：

- 单元测试 52/52；TextEdit 12/12；插件 19/19（Chrome for Testing 154）。
- 应用工具操作网页：Chrome for Testing 与 Safari 26.6 都是 10/10。其中画布像素点击的通过标准是工具明确说明做不到；"点空白处失焦"需要 `SKFIY_BRIEF_FOCUS=1`，默认跳过。
- 只读覆盖（`scripts/app_coverage.py`）：11 个正在运行的应用都能取到状态，每次 0.1–0.5 秒；微信、网易云音乐、Clash Verge 不公开辅助功能，工具会明确提示。
- 插件在日常使用的 Chrome 里（`--user-browser`）：15/15，你正在看的标签页没变，Chrome 没到过前台。
- 真实任务（`eval/run_eval.py`，claude-sonnet-5，只开放 skfiy 工具）：8 项中 7 项完成，8 项全程在后台。失败的一项是 Finder 改名时模型输入新名字后没按回车确认；同一任务前两次都通过。
- 监视器每 0.25 秒采样前台应用和最顶层窗口。除了应用自己激活自己、随即被交还的情况（见上文「兜底」），没有出现过抢占。

```
Sources/SkfiyKit/
  MCPServer.swift     stdio JSON-RPC（MCP）
  ToolSchemas.swift   工具定义与给模型的使用说明
  ComputerUse.swift   工具实现：状态快照、动作分发、会话（元素编号 ↔ AX 元素，像素 ↔ 屏幕点）
  AXTree.swift        辅助功能树的遍历、裁剪与文本渲染
  AXElement.swift     AXUIElement 薄封装
  Input.swift         投递到进程的键盘/鼠标/滚轮事件，SkyLight 入口
  Capture.swift       ScreenCaptureKit 截图与坐标映射
  Apps.swift          应用列表、名称/路径/bundle id 解析、后台启动
  Keys.swift          xdotool 按键语法解析
  BrowserBridge.swift native messaging 宿主 ⇄ Unix socket ⇄ MCP 的桥接、安装
  BrowserTools.swift  browser_* 工具
Sources/skfiy/main.swift   CLI：mcp / doctor / tools / call / install-browser-bridge（浏览器以扩展 origin 作参数启动时即为宿主）
browser-extension/         MV3 插件：service worker + 注入页面的快照/操作函数
scripts/                   端到端冒烟测试、应用覆盖探测、测试浏览器启动脚本
eval/                      真实任务评测：任务、独立判定、前台/最顶层窗口监视（结果在 eval/results，不入库）
```

## 历史

这个仓库原先是「桌宠 + 后台 Agent」的 Electron 项目（约 16 万行，含设置网页、记忆中心、自动化、旧版 Chrome 扩展等），2026-09-28 按"先做内核"的方向重写为现在的样子，旧实现与旧提交历史一并移除。桌宠素材保留在 `art/`，桌面浮窗/桌宠之后在这个内核之上重做。
