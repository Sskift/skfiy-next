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
| TextEdit | screenshot | — 未测 | ✅ 通过 | ✅ 通过 |
| TextEdit | click | — 未测 | ✅ 通过 | ❌ 失败 |
| TextEdit | type | — 未测 | ✅ 通过 | ✅ 通过 |
| TextEdit | scroll | — 未测 | ✅ 通过 | ✅ 通过 |
| TextEdit | popup | — 未测 | ✅ 通过 | ⛔ 拒绝 |
| Preview | screenshot | — 未测 | ✅ 通过 | ✅ 通过 |
| Preview | click | — 未测 | ✅ 通过 | ✅ 通过 |
| Preview | type | — 未测 | ✅ 通过 | ✅ 通过 |
| Preview | scroll | — 未测 | ✅ 通过 | ✅ 通过 |
| Preview | popup | — 未测 | ⛔ 拒绝 | ❌ 失败 |
| Finder | screenshot | — 未测 | ✅ 通过 | ✅ 通过 |
| Finder | click | — 未测 | ✅ 通过 | ❌ 失败 |
| Finder | type | — 未测 | ✅ 通过 | ⛔ 拒绝 |
| Finder | scroll | — 未测 | ✅ 通过 | ✅ 通过 |
| Finder | popup | — 未测 | ⛔ 拒绝 | ⛔ 拒绝 |
| Chrome（应用工具） | screenshot | — 未测 | ✅ 通过 | ✅ 通过 |
| Chrome（应用工具） | click | — 未测 | ✅ 通过 | ❌ 失败 |
| Chrome（应用工具） | type | — 未测 | ✅ 通过 | ❌ 失败 |
| Chrome（应用工具） | scroll | — 未测 | ✅ 通过 | ✅ 通过 |
| Chrome（应用工具） | popup | — 未测 | ✅ 通过 | ❌ 失败 |
| Chrome（扩展） | screenshot | — 未测 | ✅ 通过 | ✅ 通过 |
| Chrome（扩展） | click | — 未测 | ✅ 通过 | ✅ 通过 |
| Chrome（扩展） | type | — 未测 | ✅ 通过 | ✅ 通过 |
| Chrome（扩展） | scroll | — 未测 | ✅ 通过 | ✅ 通过 |
| Chrome（扩展） | popup | — 未测 | ✅ 通过 | ✅ 通过 |
| Electron | screenshot | — 未测 | ✅ 通过 | ✅ 通过 |
| Electron | click | — 未测 | ✅ 通过 | ❌ 失败 |
| Electron | type | — 未测 | ✅ 通过 | ❌ 失败 |
| Electron | scroll | — 未测 | ✅ 通过 | ✅ 通过 |
| Electron | popup | — 未测 | ✅ 通过 | ❌ 失败 |

**运行记录**

- front（Chrome（应用工具）, Chrome（扩展）, Electron, Finder, Preview, TextEdit）：2026-10-05 00:22，macOS 26.6.1，会话锁定=False，锁态采样 1 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 0 次；证据 `eval/results/compat-front-20261005-002245-a543ee33fa`（本机，不入库）
- locked（Chrome（应用工具）, Chrome（扩展）, Electron, Finder, Preview, TextEdit）：2026-10-05 03:05，macOS 26.6.1，会话锁定=True，锁态采样 529 次（锁定 529，未知 0），前台被改变 0 次，测试窗口被压回下层 0 次；证据 `eval/results/compat-locked-20261005-030527-850e957617`（本机，不入库）
- background（Chrome（应用工具）, Chrome（扩展）, Electron, Finder, Preview, TextEdit）：2026-10-05 17:46，macOS 26.6.1，会话锁定=False，锁态采样 364 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 0 次；证据 `eval/results/compat-background-20261005-174652-6f084ae9b8`（本机，不入库）

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
- front 未测：front mode brings apps forward; pass --allow-front (only while the user is away)
<!-- compat-table:end -->

## 基线发现（2026-10-05，macOS 26.6.1，单块 Retina 内置屏）

1. **Electron：后台启动、窗口从未成为 key window 时，键盘输入会丢失（已处理）。** 点输入框经辅助功能聚焦成功，但应用报告没有焦点元素，随后投递的按键可能全部丢失。现在 skfiy 记住点击聚焦的输入框；按键没有改变它的值时，改为经辅助功能在光标处插入，或把文字放到光标处后设置整个值（Chromium 会向页面发出 input 事件，页面照常收到）。Chromium 的辅助功能树是异步更新的，设值后会稍等读回的值跟上，再判断是否成功（此前 `set_value` 会因读回旧值而误报“页面拒绝了”）。2026-10-05 17:46 后台复测 Electron 5/5、整套 28 通过 2 按设计拒绝。
2. **Electron：网页的辅助功能树不稳定。** 多数运行能拿到网页元素；偶尔（此前整套连续运行 2/2 次，2026-10-05 又在单独运行中出现 1 次）只有窗口按钮，没有网页元素，只能退回截图坐标，而 Chromium 丢弃发往后台窗口的指针事件，点击、输入、弹窗随之失败。之后连续 3 次（单独 2 次、整套 1 次）都正常。原因未查清，仍列为限制。
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
11. **锁屏时 OCR 质量明显下降**：direct 模式在 1 倍截图上识别文字，单词被拆开、字符误识（如 “6a9344d055” 识别成 “бa9344d055”）；解锁时的 OCR 用 2 倍截图。这影响锁屏下按文字定位和等待文字出现，留待目标 3、4 处理。
12. **锁屏时辅助功能读到的不是应用的真实状态**：TextEdit 只报告一个名为 “TextEdit” 的窗口、没有文本区，焦点在应用本身。锁屏核验因此改用窗口服务器元数据、页面回报、Finder 的 Apple Event 和独立 OCR；点击是否生效由随后输入落在哪一行来判断，输入被拒时该点击记为“未测”。

前台状态尚未实测：须在用户离开且解锁时运行，测试脚本不会自行触发。
