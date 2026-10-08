# skfiy

macOS 的 computer use 内核：一个 MCP server，让 Claude Code（或任何 MCP 客户端）看见并操作 Mac 上的应用，能力对标 Codex 的 Computer Use，并且**全程在后台进行**——不抢焦点、不改变窗口层级、不移动鼠标、不打断你正在进行的输入，你的剪贴板最多被借用一瞬间并原样放回。唯一的例外是 `run_in_front`：只有你在 Claude Code 里点了同意，它才会把应用提到前台一秒左右。

单个 Swift 二进制，无运行时依赖（只链接 macOS 自带的框架，浏览器插件也打包在二进制里）；另有一个可选的 Chromium 浏览器插件，让 agent 在你真实的 Chrome（带登录态）里用**后台标签页**工作。

English: [README.en.md](README.en.md)

## 一键安装

需要 macOS 14 或更新版本。在终端里运行：

```bash
curl -fsSL https://raw.githubusercontent.com/Sskift/skfiy-next/main/install.sh | bash
```

这条命令会：

1. 有 GitHub release 时下载预编译的通用二进制（Apple 芯片和 Intel 都能用，校验 sha256）；还没有 release 时自动改为从源码编译，这需要 Xcode Command Line Tools（`xcode-select --install`，约 1.3 GB，不需要完整的 Xcode；编译约 1 分钟）。
2. 装到 `~/.local/bin/skfiy`，不需要 `sudo`。
3. 运行 `skfiy setup`：写入浏览器插件文件、注册 native messaging；装了 `claude` 命令行时把 skfiy 注册到 Claude Code（用户级）；检查权限（只检查，不弹窗）；最后列出还剩哪几步要你手动做。`skfiy setup` 可以反复运行，只补缺的、改过时的，不会重复注册。

通常剩下两件事要你自己做：

- **权限**：macOS 把辅助功能和屏幕录制授予**运行 Claude Code 的应用**（终端如 Ghostty / Terminal / iTerm，或 VS Code、Claude 桌面版），而不是 skfiy 本身。在那个应用里运行 `~/.local/bin/skfiy doctor` 会弹出系统授权提示；授权后重启该应用和 Claude Code。
- **浏览器插件（可选，推荐）**：Chrome 打开 `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 `~/Library/Application Support/skfiy/browser-extension`（文件夹对话框里按 cmd+shift+G 粘贴路径）。插件 ID 固定为 `fkllhjogckpegfdomkajlkmjaaahnhbd`；工具栏图标悬停时显示是否已连上 skfiy，未连上时角标为灰色「!」。插件不要从 `~/Desktop`、`~/Documents` 加载——那里受隐私保护，Chrome 会弹权限请求。

之后在 Claude Code 里直接说「在备忘录里新建一条……」「把 Finder 里的……」即可。

**更新**：再运行一次同一条命令。插件文件有变化时 `skfiy setup` 会提醒你在 `chrome://extensions` 的 skfiy 卡片上点刷新；已经在运行的 Claude Code 会话要重启才会用上新版本（`skfiy doctor` 会列出还在跑旧版本的会话）。

**已经 clone 了仓库**：`./install.sh` 或 `make install` 从当前代码编译安装，其余步骤相同。

常用选项（经 curl 运行时写成 `curl … | bash -s -- --codex`；前三行也可以直接传给 `skfiy setup`，后三行只有安装脚本认）：

| 选项 | 作用 |
| --- | --- |
| `--codex` | 同时注册到 Codex（`codex mcp add`）；已经注册过的会一直随更新保持正确 |
| `-e SKFIY_LOCKED_USE=direct` | 注册时带上设置，这里是下文的锁屏 direct 模式；以后运行 `skfiy setup` 会保留你的设置 |
| `--no-claude` / `--no-browser` | 不动 Claude Code 注册 / 不装浏览器插件 |
| `--from-source` | 不下载，强制从源码编译 |
| `--prefix DIR` | 装到 `DIR/bin` 而不是 `~/.local/bin` |
| `--uninstall` | 卸载（见下） |

其他 MCP 客户端：命令填 `~/.local/bin/skfiy` 的完整路径，参数 `mcp`。

`skfiy doctor` 随时检查整体状态：权限（以及应该授予哪个应用）、PATH、Claude Code 注册的是哪个二进制、各浏览器的 native host 指向哪里、插件版本与连接、急停、仍在跑旧版本的 MCP server、无效或拼错的 `SKFIY_*` 设置。`skfiy doctor --check` 只检查、不弹授权提示。

`~/.local/bin` 默认不在 PATH 里：要直接敲 `skfiy`，运行 `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile` 后重开终端；否则用完整路径 `~/.local/bin/skfiy`。

### 卸载

`~/.local/bin/skfiy uninstall`（或 `install.sh --uninstall`、`make uninstall`）：从 Claude Code 和 Codex 注销 skfiy，删除各浏览器的 native host 清单、`~/Library/Application Support/skfiy`、`~/Library/Caches/skfiy`、`~/Library/Logs/skfiy`（含操作日志和流程记录）以及二进制本身（`--keep-binary` 保留二进制）。注册或 native host 指向另一份仍然存在的 skfiy（例如用 `--prefix` 装的第二份）时，这些注册、清单和共用的文件夹都保留，只删当前这份二进制；用 `--user-data-dir` 给自定义配置目录写的 native host 清单要手动删（该目录下的 `NativeMessagingHosts/com.skfiy.bridge.json`）。剩下要你做的：在 `chrome://extensions` 里移除 skfiy 卡片，重启还在用 skfiy 的 Claude Code 会话。

### 常见问题

| 现象 | 处理 |
| --- | --- |
| 工具说缺少辅助功能或屏幕录制权限 | 授予运行 Claude Code 的应用（`skfiy doctor` 会写出它的名字），然后重启它和 Claude Code |
| 浏览器工具说没有连接 | 运行 `skfiy setup`，再在 `chrome://extensions` 加载插件；Chrome 没有打开任何窗口时插件不运行 |
| 每个调用都被拒绝 | 急停开着：`skfiy resume` 或按 ⌃⌥⌘. |
| 更新后行为没变 | 重启 Claude Code 会话；插件文件更新过时在 `chrome://extensions` 点刷新 |
| `skfiy: command not found` | 见上文 PATH 一段，或用完整路径 |
| 不想装 Command Line Tools | 等有 release 后用上面的一键命令下载预编译版本 |

### 锁屏后继续操作（direct 模式）

使用上面的普通安装即可，不需要 `sudo`、Apple 开发者证书或额外系统插件。给 MCP server 设置 `SKFIY_LOCKED_USE=direct`，最简单的是让 setup 把它写进注册：

```bash
~/.local/bin/skfiy setup -e SKFIY_LOCKED_USE=direct
# 手动做法（已注册过的先 claude mcp remove --scope user skfiy）：
# claude mcp add --scope user skfiy -e SKFIY_LOCKED_USE=direct -- ~/.local/bin/skfiy mcp
```

direct 模式在真正的 macOS 锁定会话内截取目标应用的单个窗口，并向目标进程投递坐标点击、滚动、拖拽、按键和文字；不解锁系统，也不修改系统授权规则。MCP 可以在已经锁屏时启动，但目标应用须已运行，宿主须已获得辅助功能和屏幕录制权限。解锁状态仍走原有 AX 等功能。

锁屏时先调用 `get_app_state` 获取新截图，再使用截图坐标操作；`wait_for` 可等待文字出现、消失或窗口画面稳定，`zoom` 可放大局部看清小字并按放大图坐标操作。AX 元素编号、前台操作、文件面板和剪贴板功能不可用；多个窗口时拒绝键盘输入。截取窗口需要显示器亮着：锁屏后显示器熄灭时，skfiy 会把它唤醒到锁屏画面（只显示锁屏界面，不解锁），并在最后一次截图后 2 分钟内保持点亮，之后照常熄灭；设置 `SKFIY_LOCKED_WAKE_DISPLAY=0` 可关闭这一行为，此时显示器熄灭期间截图不可用，`get_app_capabilities` 和报错会说明原因。`locked_use_end` 结束当前 MCP 会话的 direct 操作权限，不改变系统锁定状态。不同应用是否接受后台输入仍须逐个验证。

2026-10-04：合并前的 direct release 版本已安装并通过真实锁屏 MCP 测试，覆盖截图、文字输入、点击提交、按键、滚动、拖动及拒绝路径；518 个锁态采样保持锁定。另通过双窗口键盘拒绝回归，当时 72 项自动测试通过。验收范围是本机专用 fixture，不表示所有第三方应用都兼容。配置、限制和验证记录见 [locked-use/README.md](locked-use/README.md)。

真实应用的兼容性基线（TextEdit、预览、Finder、Chrome、Electron 在解锁前台/后台/锁屏下的截图、点击、输入、滚动、弹窗）见 [docs/compatibility.md](docs/compatibility.md)；后台与锁屏能力建设的进度和验证记录见 [docs/roadmap.md](docs/roadmap.md)。

## 工具

`list_apps`、`get_app_state`、`click`、`perform_secondary_action`、`set_value`、`select_text`、`scroll`、`drag`、`press_key`、`type_text` 这 10 个工具的名字和核心参数与 Codex 的 Computer Use 保持一致，提示词与使用习惯可以互通；其余工具和 `target`、`expect` 参数是 skfiy 额外加的。下表中 AX、前台和文件操作的完整功能用于解锁状态；锁屏 direct 模式的可用范围见上文。

| 工具 | 作用 |
| --- | --- |
| `list_apps` | 正在运行的应用，以及最近 14 天用过的应用（最后使用时间、使用次数） |
| `get_app_capabilities` | 操作前先问：这个应用此刻能用哪些路径——辅助功能树、截图、OCR、坐标指针、键盘、浏览器扩展、前台、文件面板、剪贴板——各自不可用的原因或限制，以及现在能用的工具。随锁态、窗口数量、权限和浏览器连接变化；带版本号并指出与上次查询相比变了什么。只读，不启动应用、不发送任何输入 |
| `get_app_state` | 应用窗口的截图 + 带编号的辅助功能树；未运行时在后台启动；可用 `window` 查看其他窗口（不会把它提到前面），用 `find` 只列出含某段文字的元素（大窗口省 token）；也列出应用在菜单栏右侧的状态图标。每个窗口带窗口 id，`window` 可传 id；同名窗口必须用 id 区分；操作可带 `window_id`，若最新截图不是该窗口、或窗口已移动/关闭/被重建，则拒绝且不发送输入。元素的悬停提示（tooltip）直接写在树里（`help="…"`），不用悬停。每次结果带状态版本 `State: vN`；再次查看时传 `since: "vN"` 只返回变化（改动、新增、消失的行，打开/关闭的窗口），没变化时只回一句且不附截图，仍在的元素编号不变。不公开辅助功能的窗口会自动识别截图里的文字（本机 Vision 框架，中英日韩），列出每段文字和可直接用于 `click` 的 x/y；`ocr: true` 可在其他窗口里识别画布、图片中的文字 |
| `click` | 按元素编号或截图像素坐标点击；支持右键、中键、双击/三击、修饰键 |
| `target`（参数） | `click`、`scroll`、`set_value`、`perform_secondary_action`、`select_text` 和网页的 `browser_click` / `browser_type` / `browser_select` / `browser_press_key` / `browser_scroll` / `browser_hover` / `browser_upload` 可以不给编号或坐标，而是描述控件：名称、类型（button、text field…）、窗口区域（`bottom-right`、`右下角`…或截图像素矩形）、所在分组（`within`：分组框、fieldset、标题下的区块）、邻近文字（`near` / `below` / `right_of`）。执行时按当下的界面重新查找（解锁用辅助功能树，树里没有时补上截图识别文字；锁屏用当场截图的识别文字及其位置；网页用页面元素），恰好一个时才操作；几个同样符合时不挑，什么都不做并列出候选 |
| `locate` | 只查找不操作：按同样的描述列出当下符合的控件，各带元素编号（以及最新截图里的 x/y）、区域、所在分组；没有符合的时说明名称相同的控件现在在哪里 |
| `expect`（参数） | `click`、`type_text`、`press_key`、`set_value`、`scroll`、`drag` 等操作都可带 `expect`：文字出现/消失、值改变、窗口打开/关闭、有变化。结果首行给出“已验证完成（verified）／未观察到效果（no_effect）／目标变化（target_changed）／超时（timeout）”，未验证时附当前状态。提交、发送、付款等只能发生一次的操作 skfiy 从不自动重试；上一次未验证时，再原样重复会被拒绝，直到重新查看过状态（或明确 `confirm_repeat`） |
| `perform_secondary_action` | 执行元素的辅助功能动作（Increment、ShowMenu、Confirm…） |
| `set_value` | 直接设置文本框、滑块等可设值元素 |
| `select_text` | 在文本元素中选中文字或把光标放在其前后（可用 prefix/suffix 消歧） |
| `scroll` | 按页滚动元素或截图中的某个位置 |
| `drag` | 按截图像素坐标拖拽 |
| `press_key` | 按键 / 组合键（xdotool 语法：`Return`、`super+c`、`Page_Down`、`F5`…）；`hold_seconds` 可按住不放 |
| `type_text` | 向当前焦点输入文字 |
| `zoom` | 按截图坐标取一块区域的原始分辨率图像（Retina 下 2 倍，`scale` 可设 1–8 倍），用来看清小字；锁屏 direct 模式也可用。返回放大图与原截图的坐标换算公式和 `zoom_id`，`click`/`scroll`/`drag` 可直接用放大图上的坐标；窗口移动、尺寸变化或截图过期（锁屏时 30 秒）后拒绝沿用旧坐标 |
| `open_file` | 在后台用指定应用打开文件或文件夹，不经过"打开"面板（后台应用的打开/存储面板操作不了） |
| `save_document` | 把应用的前台文档存到指定路径：可脚本化的应用（TextEdit、预览、Pages 等）走 Apple Event；其他应用从"另存为…"菜单打开自己的存储面板，再像 `file_dialog` 那样填好；默认不覆盖已有文件 |
| `run_in_front` | 唯一会把应用提到前台的工具，只用于必须在前台才生效的操作：快捷键（加粗、撤销、查找…；后台被禁用的拷贝/粘贴），或从某个元素的右键菜单（或菜单按钮）里选一项（`element_index` + `menu_item`，子菜单用 `>` 分隔）。先在 Claude Code 里征得你同意，等你停手后提前约一秒，随即还原你的前台和窗口层级；菜单里没有这一项时关掉菜单并列出已有的项 |
| `file_dialog` | 填写应用正显示的"打开"或"存储"面板：经面板的边栏和分栏一级级走到目标位置，存储时填好文件名，再按"打开"/"存储"，全程在后台（后台发的按键到不了这类面板）。用于附加/插入文件、Safari 里上传、以及 `save_document` 脚本不了的应用 |
| `read_clipboard` | 经你同意，把你复制的内容取进 skfiy 的剪贴板（之后 cmd+v 可粘贴到任何应用），有文字时一并返回；密码管理器标成机密的内容不读 |
| `hand_over` | 把一步交给你：登录、验证码、付款确认、系统权限弹窗、输密码。Claude Code 里显示要你做什么，你做完点确认（最多等 30 分钟）再继续；给了 `app` 和 `expect` 时，还会在 10 秒内核对应用里是否真的出现了预期的文字。你拒绝时，agent 被告知不要自己去做 |
| `wait_for` | 不发送任何输入，等某段文字在窗口里出现（或 `gone` 时消失；不公开辅助功能的窗口也匹配截图里识别出的文字），不给文字则等窗口停止变化（`stable_for` 秒）；满足后返回新状态，超时报错并附当前状态。锁屏 direct 模式下按窗口截图的识别文字和像素判断，可用 `region` 只看截图的一部分；锁态变化、窗口关闭、应用退出时立即停下并说明原因；客户端可取消。解锁时由应用的辅助功能通知唤醒（每秒兜底看一次），锁屏时比对小截图、画面不变时放慢、像素变了才识别文字；可带 `since` 只返回变化。用来代替反复调 `get_app_state` |
| `flow_start` / `flow_record` / `flow_status` | 长任务的检查点（存在磁盘上，断线、重启、你接手后都在）：每步完成时附上能复核的证据（文件及其内容指纹、应用窗口或文字、标签页文字、已完成的下载），当场核对成立才记下；只能做一次的动作（提交、发送）先记为待确认。`flow_status` 每次都对照现实重新核对：哪些仍成立、哪些已失效及原因（文件没了、窗口关了、应用重启过）、待确认的动作是否已生效，给出下一步或“需要重新规划” |
| `get_desktop_status` | 查看桌面锁定、锁屏模式和急停状态，不触发解锁 |
| `locked_use_status` | direct 模式下查看当前 MCP 会话是否启用、系统是否锁定及锁态是否已知，不触发解锁 |
| `locked_use_end` | direct 模式下结束当前 MCP 会话的锁屏操作权限并清除截图坐标；不改变系统锁定状态 |

浏览器插件连上后多出 15 个网页工具，按标签页 ID 操作，不切换你正在看的标签页。同源和跨域 iframe 里的元素一并编号，可以直接操作；在 agent 自己开的标签页里，网页的 alert / confirm / prompt 不会卡住页面，而是立即按 `browser_click` 的 `dialog` / `prompt_text` 应答并在页面状态里注明：

| 工具 | 作用 |
| --- | --- |
| `browser_tabs` | 列出窗口和标签页，`[shown]` 标出你正在看的那个 |
| `browser_open` | 在后台新标签页打开网址（归入名为 "skfiy" 的标签组），或导航指定标签页 |
| `browser_locate` | 按描述（名称、类型、视口区域、所在 fieldset/标题区块、邻近文字）在页面当下的元素和文字里查找，列出候选及刷新后的编号，不挑、不操作 |
| `browser_state` | 以文本读取页面：标题与正文按文档顺序，所有可交互元素带编号。标签页正显示时附截图；后台标签页要截图（canvas、图表、图片）需传 `background_screenshot`，经 Chrome 调试接口截取，约 0.3 秒，之后可按截图坐标点击 |
| `browser_click` | 按编号点击（或按截图坐标）；`target=_blank` 链接改为后台新标签页打开 |
| `browser_type` / `browser_select` / `browser_press_key` / `browser_scroll` | 输入（可清空、可提交）、选下拉项、按键、滚动页面或元素 |
| `browser_navigate` / `browser_close_tab` | 后退/前进/刷新、关闭标签页 |
| `browser_upload` | 把本地文件填进网页的上传框（不弹文件选择器）；每次上传前都在 Claude Code 里征得你同意，最大 20 MB |
| `browser_hover` | 在后台标签页里悬停到元素上：页面收到打开悬停菜单所需的指针事件，页面 CSS 的 `:hover` 样式也会生效（其他域名的样式表由插件取回）；之后可按编号点击出现的菜单项 |
| `browser_downloads` | 只列出 skfiy 引起的下载（在它操作过的标签页里 15 秒内发起的，或由它直接下载的），不列用户自己的下载：状态、本地路径、失败原因（网络中断、服务器无此文件、已取消……）。`wait` 等下载结束，只有完成且文件存在时才给出路径；`start` 直接下载某个网址（同名时浏览器自动改名，结果给出真实文件名）；`cancel` 取消。完成的文件可交给 `open_file(path)` 或 `browser_upload(download_id)`。Chrome 只允许一个网站在没有真实手势时自动下载一次，之后合成点击触发的下载会被拦截，这时 `wait` 会说明并建议用 `start` |
| `browser_wait` | 不操作页面，等某段文字出现/消失（含所有 frame、标题和输入框的值），不给文字则等页面加载完且半秒内不再变化 |

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

下面说明解锁状态下的后台路径：优先走辅助功能（AX），做不到才向目标**进程**投递事件，任何时候都不经过你的光标和前台。锁屏 direct 模式只使用独立窗口截图和 PID 定向输入，不进入 AX、前台或剪贴板路径。

- **点击**：先按坐标命中测试出元素，再按语义执行——按钮/链接用 AXPress，文本框聚焦并用 `AXRangeForPosition` 把光标放到点击处，表格行设为选中，双击用 AXOpen，右键用 AXShowMenu。都不适用时才把带窗口路由字段的鼠标事件投递给进程（SkyLight `SLEventPostToPid`，缺失时退回公开的 `CGEvent.postToPid`），鼠标不动。
- **键盘**：事件直接投递给目标进程。后台应用不走你的输入法，所以中文输入法开着也不会把 `,` 变成 `，`。带 cmd/ctrl 的快捷键若对应一个可用菜单项，就直接执行该菜单项；全选/关闭窗口/最小化这些依赖前台状态的快捷键用 AX 等价实现。
- **剪贴板**：cmd+c / cmd+x / cmd+v 走 skfiy 自己的剪贴板。
  - 文字经辅助功能直接取出、写入，完全不经过系统剪贴板。
  - 文件、表格单元格、图片这类只能由应用自己复制的内容，会借用你的剪贴板：先记下里面的全部内容，让应用执行它的"拷贝"或"粘贴"命令，随即把你的内容原样写回。写入的东西都带 `org.nspasteboard.TransientType` 标记，按约定剪贴板管理器不会记录；但应用自己拷贝的那一下，有的管理器可能会记下。如果这一瞬间你恰好复制了别的东西，skfiy 不覆盖它。
  - 后台应用的"拷贝/粘贴"菜单项常常是禁用的（它们作用于前台窗口），这时改用 `run_in_front` 的 cmd+c / cmd+v，同样借用后放回。
  - `read_clipboard` 可以取用你复制的内容，每次都要你在 Claude Code 里同意；密码管理器标成机密的内容一律不读。
- **文字**：逐字投递 Unicode 键盘事件；长文本或应用忽略后台按键时，改用 AX 直接插入。
- **菜单与窗口层级**：后台应用的菜单不会被真的打开（那会盖在你的屏幕上），点击菜单栏项时返回菜单内容和编号，再点具体项执行；右键菜单和菜单按钮在后台应用里不打开，窗口的 Raise 动作一律拒绝。每次操作之后还会检查：目标应用的窗口若盖住了你原来最顶层的窗口，就把你的窗口放回上面；目标应用若弹出了菜单，就把它关掉；弹出别的浮动面板（例如 Finder 里按空格打开的快速查看）则告诉模型。
- **截图**：ScreenCaptureKit 只截目标应用自己的窗口，被别的窗口挡住也能截到；隐藏或最小化的窗口不会被拉出来（此时没有截图，但按编号的操作照常可用）。
- **启动应用**：后台启动；若应用启动时自己抢了前台，会把前台交还给你原来的应用。
- **不碰终端**：终端里打的字会作为 shell 命令执行，绕过 Claude Code 自己的权限确认，而且终端里往往正跑着 agent 本身。所以对 Ghostty、Terminal、iTerm2、Warp、kitty 等终端，以及承载 skfiy 的应用（沿父进程链找到的那个），skfiy 只读取、只滚动，不点击、不输入。终端可用 `SKFIY_ALLOW_TERMINALS=1` 放开，承载 skfiy 的应用始终不放开。
- **打开文件**：`open_file` 通过 Launch Services 在后台打开文档，不激活应用。文件夹会在新的 Finder 窗口里打开，不占用你已有的窗口；这需要 skfiy 所在终端已有控制 Finder 的"自动化"权限，没有的话不会弹窗申请，而是提示模型改用 Finder 菜单。应用本身和可执行文件不会通过它打开。
- **自己的光标**（参考 Codex）：你的鼠标不动，skfiy 用一个自己的强调色光标显示它在哪里操作。点击、滚动、拖动、设值之前，光标沿一条带弧度的路径滑到目标点；点击时有一圈波纹（右键是虚线），滚动时出现方向箭头，按键和输入时在旁边显示键帽（输入只显示 ⌨︎，不显示内容）；两次操作之间轻轻摆动，表示在等下一步；20 秒没有操作就淡出。光标由一个辅助进程（`skfiy cursor-overlay`，永远不会被激活，没有 Dock 图标）画在一个点不中的小窗口里，这个窗口始终紧贴在目标窗口的正上方：目标窗口被你的窗口挡住时，光标也一起被挡住，不会画到你正在用的窗口上。目标窗口移动时光标跟着走，最小化或关闭时光标消失。截图只截目标应用自己的窗口，所以截图里没有光标。skfiy 退出（包括崩溃）时辅助进程随之退出，不会留下残余的光标。锁屏时不显示。`SKFIY_CURSOR=0` 关闭。
- **急停**：任何时候按 ⌃⌥⌘.（control-option-command-句号），所有正在运行的 skfiy 立刻停下：正在逐字输入的在下一个字符前停住，之后的每个调用都被拒绝并提示模型先问你；再按一次恢复（停止和恢复各有一声提示音）。也可以用 `skfiy stop` / `skfiy resume` / `skfiy status`。
- **兜底**：少数应用会在执行某个动作时自己激活自己（例如 Finder 的「前往文件夹…」「新建 Finder 窗口」），或者被别的动作带到前台（例如「打开方式」打开的应用）。每次操作期间，skfiy 用独立线程直接向窗口服务器查询前台应用；只要有别的应用跑到前台，而这期间你没有点鼠标或按修饰键（打字不算，所以你一直在打字时它照样生效），就在几十毫秒内把前台交还给你原来的应用；如果它的窗口盖住了你原来最顶层的窗口，也会把你的窗口放回最上面，并在结果里告诉模型换一种做法。

### 网页

- **插件路径（推荐）**：在页面的隔离环境里操作 DOM，后台标签页照样可用。输入用 `execCommand('insertText')`，产生 React 等框架认的 input 事件，中文也不经过输入法。点击是合成事件（`isTrusted=false`），绝大多数网站不在意；少数要求真实用户手势的操作（弹窗、写剪贴板）可传 `trusted: true`，通过 `chrome.debugger` 发真实输入事件——执行期间 Chrome 顶部会短暂出现「正在调试此浏览器」提示条，且真实点击/按键只对窗口中正显示的标签页有效（Chrome 会丢弃发往隐藏标签页的这类事件，真实输入文字则不受限）。
- **应用路径（无插件）**：`get_app_state` 读浏览器的辅助功能树（Chrome 等 Chromium 系和 Safari 都可以），只能操作每个窗口当前显示的标签页。链接/按钮/勾选框/表单/下拉框/可编辑区/滚动都走 AX，产生的是真实可信事件；但 Chromium 和 WebKit 都会丢弃发往后台窗口网页内容的指针事件，所以画布这类只能靠坐标点的内容要用 `click` 的 `focus: true`（见下文，首次对每个应用征得你同意）。

### 已知限制

- 作用于当前选区或文档的命令（加粗等格式、撤销、查找）只在前台应用里生效：后台应用的这些菜单项是禁用的，格式栏上对应的按钮按了也没反应，开 `SKFIY_BRIEF_FOCUS` 也不行。保存用 `save_document`；其余的要么经你同意用 `run_in_front`，要么由模型如实说明做不到。
- 有些视图不接受纯后台的鼠标点击，实测分三类（`make smoke-fixture` 的自绘视图和网页视图）：
  - 普通自绘视图：后台点击直接生效。
  - Chromium 系的网页内容（Chrome 窗口、CEF 应用）：`click` 传 `focus: true`，在你键盘鼠标空闲 ≥0.8 秒时让目标窗口在应用内获得键盘焦点约 0.1 秒（不激活、不抬升窗口）完成点击，再把焦点还给你的窗口。每个应用第一次用时在 Claude Code 里问你一次，本次会话内有效；`SKFIY_BRIEF_FOCUS=1` 则全部默认开启、不再询问。
  - 拒绝"非活跃窗口第一下点击"的 AppKit 视图，以及 WebKit 网页视图（Safari、Tauri 应用）：后台点击和上面的短暂聚焦都不生效，只能 `run_in_front` 传坐标，经你同意把应用提到前台约一秒点一下。点击是发给应用的，你的鼠标指针不动。
  - 工具不假装成功：后台点击后会说明"没变化的话该怎么办"，由模型看截图判断。
  - 投递给应用的鼠标事件带着窗口内坐标：AppKit 会自己从屏幕坐标换算，WebKit 则直接读这个字段，之前填成屏幕坐标时 WebKit 视图即使在前台也收不到点击。
- 经同意的 `run_in_front` 期间，所有 skfiy 进程（包括其他 Claude Code 会话里的）都不会把那个应用送回去：批准写在 `~/Library/Caches/skfiy/front-grant`，20 秒内有效，结束即删。
- 应用自己激活自己只能事后纠正、无法事先阻止：它会在前台停留十几毫秒（实测 13 ms），这期间你敲的键可能落到它那里。
- SkyLight 与 `_AXUIElementGetWindow` 是私有接口，运行时动态查找；缺失时退回公开 API。
- `SKFIY_BRIEF_FOCUS` 会在你空闲时短暂改变键盘焦点，所以默认关闭。实测时以 10 毫秒间隔采样你前台应用的焦点窗口和焦点元素，全程没有变化；但没法模拟你真的在打字，所以仍按"有风险"对待。
- 沙盒应用的"打开/存储"面板由另一个系统进程提供，后台投递给应用的按键到不了它（直接发给那个进程也不行）。不过面板的辅助功能树挂在应用自己名下：`file_dialog` 选中边栏里的位置，再在分栏里逐级设置选中项，最后按面板的"好"按钮，都不需要按键和焦点。限制：
  - 只支持分栏视图（面板记住的是用户上次选的视图）；
  - 隐藏的位置（`/tmp`、`~/Library`、以点开头的文件夹）在面板里看不到，也就选不了，工具会直接说明；
  - 名字栏里的 `/` 会被存成 `:`，所以位置一定靠导航，不靠在名字里写路径；
  - 文档类应用的"存储…"在后台是禁用的，这时要先用 `run_in_front`（经你同意）把存储面板打开，再用 `file_dialog` 在后台填完。
- ScreenCaptureKit 同一时间只服务同一路径的一个进程，所以每个 `skfiy mcp` 进程都从 `~/Library/Caches/skfiy/instances/` 下自己的硬链接运行，多个 Claude Code 会话可以同时截图；截图不会卡住工具：
  - 未启用 direct 模式时，skfiy 会拒绝锁定状态下的普通窗口读取和输入；启用后改走独立窗口截图和坐标输入。屏保运行或显示器睡眠也可能使截图拒绝或不回应，工具说明具体原因。不能将锁屏前的元素树当作锁屏后的状态；
  - 截图服务偶尔会停止回应，有时持续一分钟左右。3 秒没回应就先不带截图返回，之后改由一个临时的子进程截图（进程内的截图服务卡住后不会恢复，新进程往往正常）；
  - 截图只用到可截图应用列表里的应用和显示器对象，所以这张列表只在缺少目标应用时才重新获取，获取被拒时沿用上一份；
  - 目标应用没有可见窗口时直接说明，不转述系统那条误导性的报错；
  - `skfiy stop` / `resume` 会等提示音播完再退出。
- 插件只支持 Chromium 系浏览器；Safari 走应用路径。
- 后台标签页截图要挂一下 Chrome 调试接口。Chrome for Testing 里实测没有出现"正在调试此浏览器"提示条（每 0.1 秒截一次窗口，60 帧都没有），但正式版 Chrome 可能会短暂显示，所以默认不截，需要时由模型显式要求。
- 原生应用里的悬停效果没法在后台触发：AppKit 的悬停跟踪依据的是真实鼠标位置，投递给应用的鼠标移动事件不会触发它，浏览器窗口里的网页也一样不理会（实测 Chrome 的脚本悬停菜单不展开；正在运行的 11 个应用约 4600 个元素里，没有一个提供辅助功能的"显示悬停控件"动作）。悬停提示从树里的 `help` 读；网页用 `browser_hover`。
- 菜单栏右侧的状态图标：能列出；点击时若应用事先建好了菜单，就列出菜单项供选择，否则不点（打开会把菜单画在你屏幕上）。
- 不做的：系统弹窗（权限请求、钥匙串密码等）不自动操作；跨应用拖放在后台做不到；全屏应用和其他桌面空间里的窗口没有测试过（建空间会打扰你）。多显示器用临时虚拟显示器在锁屏和解锁时都实测过（1× 与 2× 屏、负坐标、跨屏窗口、运行中接入和拔掉显示器），没有在真实外接显示器上验证。
- 有些应用根本不向辅助功能公开界面：自绘界面（微信 4.x）、CEF 内嵌网页（网易云音乐；按 Chrome 的方式开启辅助功能也没用）、部分 WKWebView 外壳（Clash Verge 等 Tauri 应用）。这时 `get_app_state` 会明确说明，并识别截图里的文字给出位置（网易云音乐实测识别出 21 段文字，整个调用 1.3 秒）；Vision 会把同一行上的几个按钮连成一段，skfiy 按字间的大间隔拆开，每个按钮各有自己的坐标。坐标点击按上一条的三类处理。
- 启动期弹出的模态对话框（例如扩展加载失败的提示）有时不在辅助功能树里，只能从截图看到。

## 操作日志

skfiy 做过的每个改动类操作（点击、输入、按键、文件打开和保存、网页操作、经你同意的前台操作、读取你的剪贴板）都追加到 `~/Library/Logs/skfiy/actions.jsonl`：时间、会话、工具、参数、结果的第一行。只读操作（看状态、放大、等待）不记。文件只有你能读（600），超过 5 MB 时轮换成 `actions.1.jsonl`。

- 输入到密码框里的文字只记长度（应用里靠辅助功能的 `AXSecureTextField`，网页里靠 `type=password`）；剪贴板的内容从不记。
- `skfiy log [N]` 查看最近 N 条（默认 30）。
- `SKFIY_ACTION_LOG=off` 关闭记录，或设为别的路径；测试脚本都用临时文件或关闭，不写你的日志。

## 环境变量

设置写进 MCP server 的注册里：`skfiy setup -e 变量=值`（会保留到以后的 setup），或 `claude mcp add --scope user skfiy -e 变量=值 -- ~/.local/bin/skfiy mcp`（名字 `skfiy` 要写在 `-e` 前面：`-e` 可以接多个值，写在后面会被当成又一个设置）。`skfiy doctor` 会指出无效的值（例如旧的 `SKFIY_LOCKED_USE=1`）和拼错的变量名。

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `SKFIY_LOCKED_USE` | 关 | `direct`：启用保持系统锁定的单窗口截图和 PID 定向输入；旧值 `1` 不再支持 |
| `SKFIY_LOCKED_WAKE_DISPLAY` | 开 | `0`：锁屏时不唤醒熄灭的显示器（此时截图不可用，见上文 direct 模式） |
| `SKFIY_BRIEF_FOCUS` | 关 | `1`：所有指针点击都用上文的空闲时短暂应用内聚焦，不再逐个应用询问 |
| `SKFIY_ALLOW_TERMINALS` | 关 | `1` 允许向终端类应用输入（承载 skfiy 的应用仍然不行） |
| `SKFIY_CURSOR` | 开 | `0`：不显示 skfiy 自己的光标（见“自己的光标”） |
| `SKFIY_CURSOR_IDLE` | `20` | 没有操作多少秒后光标淡出 |
| `SKFIY_ACTION_LOG` | `~/Library/Logs/skfiy/actions.jsonl` | 操作日志的路径；`off` 不记录 |
| `SKFIY_FLOW_DIR` | `~/Library/Application Support/skfiy/flows` | 流程检查点（`flow_*`）存放的位置 |
| `SKFIY_SETTLE_SECONDS` | `0.4` | 动作后等待界面稳定再截图的时间 |
| `SKFIY_SCREENSHOT_FORMAT` | `jpeg` | `png` 可得到无损截图 |

只给测试和调试用的（平时不要设）：

| 变量 | 作用 |
| --- | --- |
| `SKFIY_STOP_FILE` | 急停标记文件的位置（默认 `~/Library/Application Support/skfiy/stopped`；测试用它互不干扰） |
| `SKFIY_UPLOAD_WITHOUT_ASKING` | `1` 让 `browser_upload` 不再逐次征求同意（只用于无人值守的测试） |
| `SKFIY_WAIT_EVENTS` | `0`：等待改回固定间隔轮询（`scripts/bench_reads.py` 用来对比） |
| `SKFIY_FRONT_GRANT_FILE` | `run_in_front` 批准文件的位置（默认 `~/Library/Caches/skfiy/front-grant`） |
| `SKFIY_OCR_DUMP` | 一个文件夹：把每次文字识别的图片和结果存进去 |
| `SKFIY_SIMULATE_CAPTURE_STALL` | `1`：一开始就当作截图卡住，测试改用独立进程截图的路径 |
| `SKFIY_SCREENSHOT_OUT` | `skfiy call` 保存截图的位置 |

skfiy 自己的文件（插件、急停标记、流程、操作日志、实例链接）都放在 `$HOME/Library` 下并跟随 `HOME` 变量，所以 `HOME=$(mktemp -d) skfiy setup` 这样的试装不会碰到真实的配置。例外：`run_in_front` 的批准文件目前仍按真实用户目录定位（要隔离就设 `SKFIY_FRONT_GRANT_FILE`），待后台窗口那部分改动合并后再改。

## 开发

除了 Swift 工具链，开发只在跑端到端测试时需要 Python 3（只用标准库）；`make` 是可选的快捷方式。只装了 Command Line Tools 时，单元测试要用 `make test`（它补上 swift-testing 宏插件的路径；直接 `swift test` 会报 TestingMacros 找不到）。

```bash
make build          # swift build
make test           # 单元测试（swift-testing）
make test-install   # install.sh、skfiy setup / doctor / uninstall：在临时 HOME 里用假的 claude/codex 跑一遍，并核对你真实的配置没被改动；不碰界面
make embed-extension  # 改了 browser-extension/ 之后：重新生成二进制里携带的插件副本（make release/install、源码安装和 release.sh 会自动做；不一致时 make test 失败）
make dist           # 发布用的通用二进制压缩包（dist/），不发布任何东西；打 vX.Y.Z 标签后由 .github/workflows/release.yml 构建并发布
make smoke          # 端到端：经 MCP 在后台驱动 TextEdit，并断言 TextEdit 从未到前台
make smoke-fixture  # 自建的小应用（窗口放在所有窗口之后）：悬停提示、打开/存储面板、自绘视图的点击
make smoke-web      # 端到端：用应用工具操作测试网页（一次性的 Chrome for Testing + 独立 profile）
make smoke-browser  # 端到端：用浏览器插件在后台标签页操作测试网页，并断言你看到的标签页没变（先跑 scripts/test_bridge_host.py：插件重连时旧桥接进程不会删掉新进程的连接）
python3 scripts/smoke_browser.py ~/.local/bin/skfiy --user-browser   # 同上，但跑在你自己的 Chrome 里：只用自己开的后台标签页，不用调试接口（需先起测试页服务，见 scripts/test_browser.sh）
python3 scripts/smoke_chromium.py .build/debug/skfiy Safari   # 同一套网页测试跑在 Safari 上（先在后台打开测试页）
python3 scripts/app_coverage.py     # 只读探测：对正在运行的应用各取一次状态，只报数量和耗时，不输出内容
python3 eval/run_eval.py            # 真实任务：交给无头 `claude -p`（只开放 skfiy 工具）完成，独立检查结果，并监视前台与最顶层窗口
skfiy call get_app_state '{"app":"Finder"}'   # 单次调用调试，截图存到 /tmp/skfiy-screenshot.jpg
```

`scripts/test_browser.sh` 会把 Chrome for Testing 下载到 `~/.cache/skfiy-test`，在后台用全新的临时 profile 启动它（加载插件、打开 `scripts/fixtures/web.html`），不碰你自己的浏览器。

最近一次结果（2026-09-29，macOS 26.6.1）：

- 单元测试 62/62；TextEdit 25 项全过；插件 34/34（Chrome for Testing 154，含悬停菜单、`browser_wait`、后台标签页截图后按像素点击）。
- 自建小应用（`make smoke-fixture`）17/17：悬停提示、`hand_over` 的三种结果、操作日志只记密码长度、不公开辅助功能的窗口里识别文字并点击、打开/存储面板、`save_document` 走存储面板、非文字拷贝粘贴后你的剪贴板原样放回、`read_clipboard` 必须经同意、右键菜单在后台被拒并指向 `run_in_front`。加 `--front` 后 17/17：经同意用 `run_in_front` 选右键子菜单项、点"拒绝非活跃窗口第一下点击"的视图和 WebKit 网页视图，前台每次都还回你原来的应用。
- 应用工具操作网页（Chrome for Testing）11/11；`SKFIY_BRIEF_FOCUS=1` 时 12/12（画布像素点击生效）。
- 只读覆盖（`scripts/app_coverage.py`）：11 个正在运行的应用都能取到状态，每次 0.1–0.5 秒；微信、网易云音乐、Clash Verge 不公开辅助功能，工具会明确提示。
- `run_in_front`（`scripts/smoke_foreground.py --accept`）：不同意时什么也不做；同意后 TextEdit 在前台约 1.1 秒，加粗生效，前台还回你原来的应用。
- 插件在日常使用的 Chrome 里（`--user-browser`，0.3.0 时）：23/23，你正在看的标签页没变，Chrome 没到过前台。
- 真实任务（`eval/run_eval.py`，claude-sonnet-5，只开放 skfiy 工具）：11 项中 9 项完成，全程在后台（在加入等待、文件面板、剪贴板等工具之前测的）。
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
  Setup.swift         skfiy setup / doctor / uninstall：插件文件、native host、Claude Code / Codex 注册、检查清单
  Paths.swift         skfiy 自己的文件位置（跟随 $HOME）
  EmbeddedExtension.swift  二进制里携带的插件副本（scripts/embed_extension.sh 生成）
Sources/skfiy/main.swift   CLI：setup / doctor / uninstall / mcp / tools / call / install-browser-bridge（浏览器以扩展 origin 作参数启动时即为宿主）
install.sh                 一键安装：下载 release 或从源码编译，装到 ~/.local/bin，再运行 skfiy setup
packaging/homebrew/        Homebrew formula 模板（未发布）
browser-extension/         MV3 插件：service worker + 注入页面的快照/操作函数
scripts/                   端到端冒烟测试、应用覆盖探测、测试浏览器启动脚本
eval/                      真实任务评测：任务、独立判定、前台/最顶层窗口监视（结果在 eval/results，不入库）
```

## 历史

这个仓库原先是「桌宠 + 后台 Agent」的 Electron 项目（约 16 万行，含设置网页、记忆中心、自动化、旧版 Chrome 扩展等），2026-09-28 按"先做内核"的方向重写为现在的样子，旧实现与旧提交历史一并移除。桌宠素材保留在 `art/`，桌面浮窗/桌宠之后在这个内核之上重做。
