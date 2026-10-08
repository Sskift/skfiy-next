# 真实应用兼容性基线

这份表记录 skfiy 在真实应用里的五类基本操作——截图、点击、输入、滚动、弹窗——分别在三种状态下的实际表现。表格由 `scripts/compat_baseline.py --report` 从最近的实测结果生成，只写实测到的结论；没有条件测的格子标“未测”，不按推测填写。

## 测什么、怎么判定

| 状态 | 含义 | 运行条件 |
| --- | --- | --- |
| 解锁·前台 | 系统解锁，被测应用是前台应用 | `--mode front --allow-front`，且用户已空闲 ≥ 60 s；测试结束把前台还给原应用 |
| 解锁·后台 | 系统解锁，被测应用在后台；用户的前台应用全程不得改变 | `--mode background` |
| 锁屏 direct | 系统真实锁定，`SKFIY_LOCKED_USE=direct` | `--mode locked`，只在 Mac 已锁定时运行，不锁屏也不解锁 |

| 应用 | 测试对象（每次运行新建） | 截图 | 点击 | 输入 | 滚动 | 弹窗 |
| --- | --- | --- | --- | --- | --- | --- |
| TextEdit | 160 行的临时 .txt | 文本可见 | 点第 10 行，光标落在该行 | 在光标处输入标记 | 下滚 2 页后首个可见行号变大 | 新建未命名文档→关闭→“是否保留”表单→点“删除” |
| 预览 | 6 页临时 PDF | 页面文字可识别 | 点搜索栏，焦点落入 | 输入 “page 4” | 下滚 3 页，滚动条或首个可见页变化 | “前往页面…”表单 |
| Finder | 80 个文件的临时文件夹 | 文件名可见 | 点 item-05，被选中 | 键入 “item-42” 选中该项 | 滚动条变化 | “显示简介”窗口 |
| Chrome（应用工具） | Chrome for Testing + 本地测试页 | 标题可见 | 点 Increment，页面计数 +1 | 点输入框后输入，页面回显 | 页面 scrollY 增加 | 页面 alert 出现在状态中，点 OK 关闭 |
| Chrome（扩展） | 同上，扩展在后台标签页操作 | 后台标签页截图 | 同上 | 同上 | 同上 | alert 被自动应答并写入页面状态 |
| Electron | 独立 Electron 运行时载入同一测试页 | 同 Chrome | 同 Chrome | 同 Chrome | 同 Chrome | 同 Chrome |

- 判定全部来自 skfiy 之外：原生应用由独立探针（`scripts/fixtures/AXProbe.swift`，直接读辅助功能和窗口服务器）核验光标、选中项、表单、滚动条；网页由测试页自己把状态回报给本地服务（`scripts/compat_server.py`）。skfiy 自己说“成功”不算通过。
- 状态含义：✅ 通过＝独立核验到效果；❌ 失败＝没有效果或 skfiy 报错；⛔ 拒绝＝skfiy 按设计拒绝或如实说明做不到（例如菜单项在后台禁用）；⏭ 跳过＝测试会碰到用户自己的窗口或数据，测试主动不做；— 未测＝该状态或前置条件当时不具备。
- 测试只用自己新建的文件、文件夹和本地网页。TextEdit、预览里若开着用户的文档，对应用例整组不测。Chrome 只用 Chrome for Testing 的独立配置，浏览器工具按进程号指定它，不连用户的 Chrome。Electron 用 `~/.cache/skfiy-test/electron` 里的独立运行时和 `scripts/fixtures/electron`，数据目录在 `/tmp`。
- 测试窗口不压在用户窗口之上：运行期间 `scripts/fixtures/WindowGuard.swift` 每 30 ms 检查一次，测试应用的窗口一旦成为最上层而它不是前台应用，就把前台应用自己的窗口放回最上面（不激活、不改焦点），次数记在运行记录里。
- 每次运行同时以 0.25 s 间隔记录系统锁态；“解锁·后台”还在每次调用前后核对前台应用。

## 运行

```bash
python3 scripts/compat_baseline.py .build/debug/skfiy --mode background
python3 scripts/compat_baseline.py .build/debug/skfiy --mode locked            # 仅在 Mac 已锁定时
python3 scripts/compat_baseline.py .build/debug/skfiy --mode front --allow-front   # 仅在用户离开时
python3 scripts/compat_baseline.py --report                                    # 更新下表与 docs/compat/baseline.json
```

`--case textedit|preview|finder|chrome|chrome-extension|electron` 只跑其中几项。原始截图、MCP 往返和探针结果在 `eval/results/compat-*`（本机，不入库）；汇总在 `docs/compat/baseline.json`。

## 结果


<!-- compat-table:start -->
| 应用 | 操作 | 解锁·前台 | 解锁·后台 | 锁屏 direct |
| --- | --- | --- | --- | --- |
| TextEdit | screenshot | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| TextEdit | click | ✅ 通过 | ✅ 通过 | ❌ 失败 |
| TextEdit | type | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| TextEdit | scroll | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| TextEdit | popup | ✅ 通过 | ✅ 通过 | ⛔ 拒绝 |
| Preview | screenshot | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Preview | click | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Preview | type | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Preview | scroll | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Preview | popup | ✅ 通过 | ⛔ 拒绝 | ❌ 失败 |
| Finder | screenshot | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Finder | click | ✅ 通过 | ✅ 通过 | ❌ 失败 |
| Finder | type | ✅ 通过 | ✅ 通过 | ⛔ 拒绝 |
| Finder | scroll | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Finder | popup | ✅ 通过 | ⛔ 拒绝 | ⛔ 拒绝 |
| Chrome（应用工具） | screenshot | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Chrome（应用工具） | click | ✅ 通过 | ✅ 通过 | ❌ 失败 |
| Chrome（应用工具） | type | ✅ 通过 | ✅ 通过 | ❌ 失败 |
| Chrome（应用工具） | scroll | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Chrome（应用工具） | popup | ✅ 通过 | ✅ 通过 | ❌ 失败 |
| Chrome（扩展） | screenshot | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Chrome（扩展） | click | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Chrome（扩展） | type | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Chrome（扩展） | scroll | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Chrome（扩展） | popup | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Electron | screenshot | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Electron | click | ✅ 通过 | ✅ 通过 | ❌ 失败 |
| Electron | type | ✅ 通过 | ✅ 通过 | ❌ 失败 |
| Electron | scroll | ✅ 通过 | ✅ 通过 | ✅ 通过 |
| Electron | popup | ✅ 通过 | ✅ 通过 | ❌ 失败 |

**运行记录**

- background（Chrome（扩展）, Finder, Preview, TextEdit）：2026-10-05 17:46，macOS 26.6.1，会话锁定=False，锁态采样 364 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 0 次；证据 `eval/results/compat-background-20261005-174652-6f084ae9b8`（本机，不入库）
- background（Chrome（应用工具）, Electron）：2026-10-05 17:54，macOS 26.6.1，会话锁定=False，锁态采样 124 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 2 次；证据 `eval/results/compat-background-20261005-175413-00be05d389`（本机，不入库）
- locked（Chrome（应用工具）, Chrome（扩展）, Electron, Finder, Preview, TextEdit）：2026-10-06 00:37，macOS 26.6.1，会话锁定=True，锁态采样 501 次（锁定 501，未知 0），前台被改变 0 次，测试窗口被压回下层 0 次；证据 `eval/results/compat-locked-20261006-003734-58d051aa44`（本机，不入库）
- front（Chrome（应用工具）, Chrome（扩展）, Electron, Finder, Preview）：2026-10-06 23:32，macOS 26.6.1，会话锁定=False，锁态采样 283 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 5 次；证据 `eval/results/compat-front-20261006-233251-4309ff6162`（本机，不入库）
- front（TextEdit）：2026-10-07 09:23，macOS 26.6.1，会话锁定=False，锁态采样 50 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 2 次；证据 `eval/results/compat-front-20261007-092311-462bb1ebdc`（本机，不入库）

**失败、拒绝、跳过与未测的原因**

- TextEdit · click · locked：typed marker not on the clicked row (y 156 vs 38.0)
- TextEdit · popup · locked：This app has multiple or different active windows, so the keyboard destination cannot be verified while locked. Leave one window open before locking, or unlock manually.
- Preview · popup · background：no sheet appeared; skfiy: menu item "Go to Page…" disabled in the background
- Preview · popup · locked：no sheet appeared
- Finder · click · locked：selected: nothing readable
- Finder · type · locked：This app has multiple or different active windows, so the keyboard destination cannot be verified while locked. Leave one window open before locking, or unlock manually.
- Finder · popup · background：no Get Info window; skfiy: menu item "Get Info" disabled in the background
- Finder · popup · locked：This app has multiple or different active windows, so the keyboard destination cannot be verified while locked. Leave one window open before locking, or unlock manually.
- Chrome（应用工具） · click · locked：page clicks 0 -> 0
- Chrome（应用工具） · type · locked：page input value ''
- Chrome（应用工具） · popup · locked：the page did not open its alert
- Electron · click · locked：page clicks 0 -> 0
- Electron · type · locked：page input value ''
- Electron · popup · locked：the page did not open its alert
<!-- compat-table:end -->

## 基线发现（2026-10-05，macOS 26.6.1，单块 Retina 内置屏）

1. **Electron：后台启动、窗口从未成为 key window 时，键盘输入会丢失（已处理）。** 点输入框经辅助功能聚焦成功，但应用报告没有焦点元素，随后投递的按键可能全部丢失。现在 skfiy 记住点击聚焦的输入框；按键没有改变它的值时，改为经辅助功能在光标处插入，或把文字放到光标处后设置整个值（Chromium 会向页面发出 input 事件，页面照常收到）。Chromium 的辅助功能树是异步更新的，设值后会稍等读回的值跟上，再判断是否成功（此前 `set_value` 会因读回旧值而误报“页面拒绝了”）。2026-10-05 17:46 后台复测 Electron 5/5、整套 28 通过 2 按设计拒绝。
2. **Electron：网页的辅助功能树不稳定。** 多数运行能拿到网页元素；偶尔（此前整套连续运行 2/2 次，2026-10-05 又在单独运行中出现 1 次）只有窗口按钮，没有网页元素，只能退回截图坐标，而 Chromium 丢弃发往后台窗口的指针事件，点击、输入、弹窗随之失败。之后连续 3 次（单独 2 次、整套 1 次）都正常。原因未查清，仍列为限制。**2026-10-08 查清**：窗口守护会把刚显示出来的 Electron 窗口压到用户窗口下面；窗口被完全挡住后，Chromium 不再绘制它，也不建、不更新它的辅助功能树，skfiy 第一次读它时就只看到窗口按钮。露出任意一角树就出现。skfiy 现在会说明这种情况，并在下次读取时重新请求网页的树，见下文“不在最上层的窗口”。
3. **按坐标滚动的“页”取的是坐标下那个元素的高度。** 在网页里坐标落在一行文字上，“2 页”只滚了 80 px；Finder 列表里 2 页只把滚动条从 0.40 移到 0.46。被判为通过，是因为确实滚动了，但滚动量与参数不符。
4. **作用于当前文档的菜单命令在后台被禁用**（TextEdit 打印、预览“前往页面…”、Finder“显示简介”）。skfiy 如实说明并指向 `run_in_front`，表中记为“拒绝”。TextEdit 的弹窗用后台可触发的“关闭未命名文档→保留确认表单”测到，表单出现在树里，按编号点“删除”可关闭。
5. **测试窗口出现在用户窗口之上。** Chrome for Testing 和 Electron 后台启动后，它们的窗口会排到最上层（不激活应用）。窗口守护在每次运行中把用户的窗口放回最上层 1–3 次；skfiy 自身工具调用期间则由 `keepingFront` 处理。

## 锁屏 direct 的基线发现（2026-10-05 00:24–00:33，系统实际锁定）

锁屏运行由 `scripts/run_when_locked.py` 在用户自己锁屏 20 秒后启动，测试不锁屏也不解锁；每次运行的锁态采样全部为“锁定”（例如 450/450），见运行记录。

6. **浏览器扩展通道在锁屏时照常工作**：截图（调试接口截后台标签页）、点击、输入、滚动、弹窗 5/5 通过。
7. **Chrome 和 Electron 的坐标点击在锁屏时不生效**：Chromium 丢弃发往非活动窗口的指针事件，点击、经点击聚焦后的输入、打开 alert 都失败；滚轮事件有效（滚动通过）。锁屏下操作网页应走扩展通道。
8. **TextEdit：坐标点击不移动光标**（随后输入的标记落在文档开头，不在被点的第 10 行）；输入和滚动有效。快捷键在锁屏时能生效（cmd+n 新建了文档），但随即出现第二个窗口，按设计拒绝后续键盘输入。
9. **预览：点击搜索栏、输入、滚动有效**；“前往页面…”快捷键（cmd+alt+g）没有效果。
10. **Finder：坐标点击没有选中文件**（以 Finder 自己经 Apple Event 报告的选中项为准）；滚动有效。Finder 另开着一个窗口时，键盘输入按设计拒绝（目标窗口无法确认）。
11. **锁屏时 OCR 质量明显下降**：direct 模式在 1 倍截图上识别文字，单词被拆开、字符误识（如 “6a9344d055” 识别成 “бa9344d055”）；解锁时的 OCR 用 2 倍截图。这影响锁屏下按文字定位和等待文字出现；已在目标 3、4 中解决：锁屏也按显示器原始分辨率截图识别，并合并高、低分辨率和快速识别的结果。
12. **锁屏时辅助功能读到的不是应用的真实状态**：TextEdit 只报告一个名为 “TextEdit” 的窗口、没有文本区，焦点在应用本身。锁屏核验因此改用窗口服务器元数据、页面回报、Finder 的 Apple Event 和独立 OCR；点击是否生效由随后输入落在哪一行来判断，输入被拒时该点击记为“未测”。

前台状态（2026-10-06 23:22 至 10-07 09:23，用户同意后在其离开且解锁时运行，锁态采样全部为未锁定）：

13. **前台时 6 个应用（含扩展通道）的五类操作全部通过**，30/30。后台按设计拒绝的“作用于当前文档的菜单命令”（预览“前往页面…”、Finder“显示简介”）在前台都有效，与 `run_in_front` 的定位一致。Electron 在前台时网页的辅助功能树完整，点击、输入、弹窗都按元素编号完成。
14. **前台模式的保护**：测试只把自己的测试应用提到前面，每个应用测完立即把前台还给用户原来的应用；运行中检测到用户的按键、点击、移动或滚动就立刻结束测试用的 skfiy、还回前台，剩下的记为未测。第一次运行时这项检测误用了“硬件状态任意事件”的空闲计时，skfiy 自己发给测试应用的鼠标事件会刷新它，于是 TextEdit 做完三项就误停了，测试文档也留在了 TextEdit 里；下一次运行因此把 TextEdit 判为“开着用户的文档”而整组跳过。两处都已修正：改用只统计真实输入的计时；只开着往次遗留测试文档的 TextEdit 或预览会先被退出。
15. **TextEdit 不把经辅助功能插入的文字算作修改**（前台列发现）。前台且输入法处于激活状态时，skfiy 为避免按键被输入法组字，改经辅助功能把文字插到光标处；超过 200 字的文字在后台也走这条路。TextEdit 显示了这些文字，却不认为文档有改动：新建文档输入后关闭，不问是否保留就直接关掉，文字随之丢失。前台列的弹窗一项因此失败（2026-10-07 09:16）。现在经辅助功能插入时，文字后多插一个空格，再用一次真实的删除键删掉它；应用把删除键当作修改，文档随之标为已改动。删除键没有生效时，空格也经辅助功能删掉，并提示应用可能没把这次输入算作修改。新增 `scripts/test_text_entry.py`（后台、TextEdit）：修复前 250 字经辅助功能输入后关闭不提示；修复后 4/4 通过，内容一字不差、关闭时都询问是否保留。修复后前台列 TextEdit 重跑 5/5（09:23）。

## 不在最上层的窗口（2026-10-08，解锁·后台）

目标窗口被别的应用挡住（完全或部分）、压在同一应用的另一个窗口下面、不是应用的键盘窗口、被最小化、所在应用被隐藏时的表现。修复前的问题来自三轮后台调查（测试应用、TextEdit、Finder、Electron、WKWebView 测试应用、RustDesk）；修复后用下面的专用测试复核，修复前的版本（同一提交的上一版）跑同样的测试作对照。全部在解锁状态下运行（锁态采样 0 次锁定），不开窗口守护，每次调用前后核对前台应用和最上层窗口：测试应用从未到前台，测试窗口从未到最上层；运行中前台的变化都是用户自己在切换应用。

| 场景（遮挡情况） | 测试 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| 测试应用：第二个窗口压在主窗口下面，两者都被用户窗口完全挡住；主窗口是键盘窗口 | `scripts/test_background_windows.py` | 5/17 | 17/17 |
| 同上，复核后加测：按 id 查看的主窗口新开一个拿到键盘的窗口、该窗口关掉后、弹出表单；最小化的窗口（都被用户窗口完全挡住） | 同上（最小化一项要 `--minimize`） | — | 24/24 |
| TextEdit：按名字查看测试文档，cmd+n 新建文档后输入、cmd+w、回答保留询问（这套测试不记录遮挡比例；前台一直是用户的应用） | `compat_baseline.py --mode background --case textedit` | 5/5（复核前的版本 4/5） | 5/5 |
| TextEdit：两份测试自己的文档，alpha 压在 beta 下面（alpha 97.5% 被挡），beta 是键盘窗口 | 同上 `--textedit` | 3/8 | 8/8 |
| Electron：窗口被用户窗口完全挡住，及只露出一角 | `scripts/test_covered_chromium.py` | 4/11 | 11/11 |
| RustDesk 1.5.0（用户自己的，开着一个远程会话；只读与拒绝，不发送输入） | `scripts/test_rustdesk.py` | — | 13/13 |

16. **按键到的是应用的键盘窗口，不是模型看的窗口。** 投递给进程的按键由应用交给它的键盘窗口；按坐标或编号点了另一个窗口里的文本框，也只改了那个窗口内的焦点。修复前：测试应用的文字进了主窗口，TextEdit 的标记打进了 beta，`window_id` 指向 alpha 的 cmd+w 关掉了 beta，`expect` 还报“已验证”（它看的是键盘窗口）。实测：向目标窗口的文本框投递一次带该窗口号的后台鼠标点击，就让它成为应用的键盘窗口，窗口层级与前台应用都不变；现在点击文本框时一并这样做，键盘工具在键盘窗口不是目标窗口时也这样做，做不到就经辅助功能插入文字或拒绝。把窗口设为 AXMain 也能改键盘窗口，但会把它抬到所有别的应用窗口之上，不采用。复核发现第一版走过了头：cmd+n 新建的文档成为键盘窗口后，按键仍被拉回按名字查看的旧文档，文字写进了已存盘的文件。现在只把原来就开着的窗口设回键盘窗口；上次查看后新开的窗口拿到键盘时，操作结果换到它（截图显示它，按键到它那里），不是这次操作开的就拒绝并说明；操作的窗口关掉后键盘落在原来就开着的窗口上时，按键拒绝，直到模型看过那个窗口。
17. **同一应用的窗口压着时，坐标与滚轮落到上面那个窗口。** 辅助功能的命中测试和鼠标事件的窗口号都取该点最上面的那个窗口。修复后，单独查看的窗口在被压住的地方照样命中自己的按钮（测试应用：点第二个窗口的“完成”，下面主窗口的“应用”计数不变），滚轮只到它（TextEdit：alpha 滚动，beta 不动）；修复前点中的是上面窗口的按钮、滚的是 beta。
18. **完全被挡住的 Chromium 窗口不再更新。** Electron 窗口被用户窗口完全挡住一段时间后，页面变为 hidden：不绘制、辅助功能树不更新、滚轮被丢弃（滚动位置 245→245）。从被挡住到变 hidden 的时间不定，实测 13–27 秒，也有 40 秒内没变的；露出一角即恢复。按编号的点击和设值照样送到页面（页面计数 +1、收到值），只是截图和树看不到。修复前回复“窗口看起来与最新截图相同”，`set_value` 因读不回焦点而拒绝，`wait_for` 超时也不说原因；修复后都说明窗口被完全挡住、看到的可能过时，`expect` 不再判 no_effect。WKWebView 应用被挡住时一切照常（调查结论，未重测）。Chrome for Testing 因新窗口会出现在最上层而没有测，按同一 Chromium 内核推断表现相同。
19. **最小化与隐藏。** 隐藏自己的辅助应用（`LSUIElement`）NSRunningApplication 仍报未隐藏，修复前按坐标点击报“窗口已关闭”、按编号滚动报成功；现在读应用的 AXHidden，按坐标和滚轮的操作都说明“应用已隐藏”并拒绝（测试应用实测）。最小化窗口同样说明“已最小化”（复核后用 `--minimize` 实测：测试应用的窗口此前不可最小化，这一项原先测不出东西，已改）。别的桌面空间没有测（本机只有一个空间）。
20. **RustDesk。** 它以同一 bundle id 跑着界面进程和没有窗口的 `--server` 进程，修复前所有调用都落到后者、什么也做不了；现在取界面进程。Flutter 的树要打开 AXEnhancedUserInterface 才有（主窗口出现输入框和 “Connect” 按钮），会话结束后恢复原值（0）。主窗口按 id 查看时单独截取，截图里没有压在上面的远程会话。`set_value` 改 Flutter 输入框被拒且值不变。远程会话窗口能截图并标明是远程会话；`type_text`、`press_key`、`drag`、`scroll` 都在发送前拒绝，`get_app_capabilities` 报它的指针与键盘不可用；RustDesk 的键盘窗口前后不变。调查时测得：Flutter 不理会任何形式的后台鼠标点击（公开接口的 `CGEventPostToPid` 能点进去，但会激活 RustDesk，skfiy 不用）；主窗口是键盘窗口时，后台按键能输入到主窗口的输入框。为不改动用户的 RustDesk，这次没有向它发送点击和按键。
21. **表单（sheet）不在单独截取的图上（复核发现，已修）。** 单独截取被查看的窗口时没有带子窗口，按钮弹出的 NSAlert 表单、TextEdit 的保留询问不在操作后的截图里，回复说“窗口看起来相同”，而按坐标的点击已经会落到表单上。现在解锁时单独截取连同子窗口一起截：测试应用和复核的辅助应用里，表单都出现在操作后的截图和 `get_app_state` 截图里，按截图坐标点表单按钮生效。锁屏直连模式没有改，也没有测。
