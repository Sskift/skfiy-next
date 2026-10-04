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
| TextEdit | screenshot | — 未测 | ✅ 通过 | — 未测 |
| TextEdit | click | — 未测 | ✅ 通过 | — 未测 |
| TextEdit | type | — 未测 | ✅ 通过 | — 未测 |
| TextEdit | scroll | — 未测 | ✅ 通过 | — 未测 |
| TextEdit | popup | — 未测 | ✅ 通过 | — 未测 |
| Preview | screenshot | — 未测 | ✅ 通过 | — 未测 |
| Preview | click | — 未测 | ✅ 通过 | — 未测 |
| Preview | type | — 未测 | ✅ 通过 | — 未测 |
| Preview | scroll | — 未测 | ✅ 通过 | — 未测 |
| Preview | popup | — 未测 | ⛔ 拒绝 | — 未测 |
| Finder | screenshot | — 未测 | ✅ 通过 | — 未测 |
| Finder | click | — 未测 | ✅ 通过 | — 未测 |
| Finder | type | — 未测 | ✅ 通过 | — 未测 |
| Finder | scroll | — 未测 | ✅ 通过 | — 未测 |
| Finder | popup | — 未测 | ⛔ 拒绝 | — 未测 |
| Chrome（应用工具） | screenshot | — 未测 | ✅ 通过 | — 未测 |
| Chrome（应用工具） | click | — 未测 | ✅ 通过 | — 未测 |
| Chrome（应用工具） | type | — 未测 | ✅ 通过 | — 未测 |
| Chrome（应用工具） | scroll | — 未测 | ✅ 通过 | — 未测 |
| Chrome（应用工具） | popup | — 未测 | ✅ 通过 | — 未测 |
| Chrome（扩展） | screenshot | — 未测 | ✅ 通过 | — 未测 |
| Chrome（扩展） | click | — 未测 | ✅ 通过 | — 未测 |
| Chrome（扩展） | type | — 未测 | ✅ 通过 | — 未测 |
| Chrome（扩展） | scroll | — 未测 | ✅ 通过 | — 未测 |
| Chrome（扩展） | popup | — 未测 | ✅ 通过 | — 未测 |
| Electron | screenshot | — 未测 | ✅ 通过 | — 未测 |
| Electron | click | — 未测 | ✅ 通过 | — 未测 |
| Electron | type | — 未测 | ❌ 失败 | — 未测 |
| Electron | scroll | — 未测 | ❌ 失败 | — 未测 |
| Electron | popup | — 未测 | ✅ 通过 | — 未测 |

**运行记录**

- background（Chrome（应用工具）, Chrome（扩展）, Finder, TextEdit）：2026-10-05 00:17，macOS 26.6.1，会话锁定=False，锁态采样 455 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 3 次；证据 `eval/results/compat-background-20261005-001726-fe299114e7`（本机，不入库）
- background（Preview）：2026-10-05 00:20，macOS 26.6.1，会话锁定=False，锁态采样 53 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 0 次；证据 `eval/results/compat-background-20261005-002035-0d9d91b611`（本机，不入库）
- background（Electron）：2026-10-05 00:22，macOS 26.6.1，会话锁定=False，锁态采样 101 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 1 次；证据 `eval/results/compat-background-20261005-002200-6071205215`（本机，不入库）
- locked（Chrome（应用工具）, Chrome（扩展）, Electron, Finder, Preview, TextEdit）：2026-10-05 00:22，macOS 26.6.1，会话锁定=False，锁态采样 1 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 0 次；证据 `eval/results/compat-locked-20261005-002245-1058da8312`（本机，不入库）
- front（Chrome（应用工具）, Chrome（扩展）, Electron, Finder, Preview, TextEdit）：2026-10-05 00:22，macOS 26.6.1，会话锁定=False，锁态采样 1 次（锁定 0，未知 0），前台被改变 0 次，测试窗口被压回下层 0 次；证据 `eval/results/compat-front-20261005-002245-a543ee33fa`（本机，不入库）

**失败、拒绝、跳过与未测的原因**

- Preview · popup · background：no sheet appeared; skfiy: menu item "Go to Page…" disabled in the background
- Finder · popup · background：no Get Info window; skfiy: menu item "Get Info" disabled in the background
- Electron · type · background：page input value ''
- Electron · scroll · background：page scrollY 0 -> 0
- front 未测：front mode brings apps forward; pass --allow-front (only while the user is away)
- locked 未测：the Mac is not locked
<!-- compat-table:end -->

## 基线发现（2026-10-05，macOS 26.6.1，单块 Retina 内置屏）

1. **Electron：后台启动、窗口从未成为 key window 时，键盘输入丢失。** 点输入框经辅助功能聚焦成功，但应用报告没有焦点元素，随后投递的按键全部丢失（单独运行 4/4 次）。Chrome for Testing 同样的步骤能输入。
2. **Electron：网页的辅助功能树不稳定。** 单独运行 4/4 次能拿到网页元素；整套连续运行时 2/2 次只有窗口按钮，没有网页元素，只能退回截图坐标，而 Chromium 丢弃发往后台窗口的指针事件，点击、输入、弹窗随之失败。滚动也有 1/4 次没有生效。
3. **按坐标滚动的“页”取的是坐标下那个元素的高度。** 在网页里坐标落在一行文字上，“2 页”只滚了 80 px；Finder 列表里 2 页只把滚动条从 0.40 移到 0.46。被判为通过，是因为确实滚动了，但滚动量与参数不符。
4. **作用于当前文档的菜单命令在后台被禁用**（TextEdit 打印、预览“前往页面…”、Finder“显示简介”）。skfiy 如实说明并指向 `run_in_front`，表中记为“拒绝”。TextEdit 的弹窗用后台可触发的“关闭未命名文档→保留确认表单”测到，表单出现在树里，按编号点“删除”可关闭。
5. **测试窗口出现在用户窗口之上。** Chrome for Testing 和 Electron 后台启动后，它们的窗口会排到最上层（不激活应用）。窗口守护在每次运行中把用户的窗口放回最上层 1–3 次；skfiy 自身工具调用期间则由 `keepingFront` 处理。

锁屏和前台两种状态尚未实测：锁屏须在 Mac 真正锁定时运行，前台须在用户离开时运行，两者都不由测试脚本触发。
