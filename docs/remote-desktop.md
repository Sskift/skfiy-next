# 通过 SSH 控制 Windows 桌面

`remote_desktop` 在远端 Windows 的已登录会话中截图和输入。本机 RustDesk 可以被遮挡、保持后台；skfiy 不激活本机窗口、不改变本机焦点、不移动本机鼠标，也不使用剪贴板。远端的鼠标和前台窗口会随操作变化。

这是独立的 SSH 控制通道。RustDesk 可以同时用来观看画面；这项功能不向 RustDesk 客户端注入事件。

## 配置一次

前提：Windows 10/11 已登录，现有 SSH 密钥连接可用，Mac 已信任该 SSH 主机的 host key。先确保 `ssh lil-win` 能正常连接，再执行：

```bash
skfiy remote add lil-win lil-win
skfiy remote list
```

第一个 `lil-win` 是 skfiy 内的名称，第二个是 `~/.ssh/config` 中的主机别名。支持现有 SSH 配置里的端口和跳板机设置；不会自动接受新主机密钥或弹出密码询问。

安装只写入远端 `%LOCALAPPDATA%\skfiy\desktop`，注册当前 SSH 用户的 `Skfiy Desktop <用户 SID>` 计划任务。任务没有定时或开机触发器：请求到来时按需启动，以已登录用户的普通权限运行，空闲两分钟后退出。没有新增监听端口。Windows 自带的 PowerShell、.NET 和任务计划程序足够，不需要 Python。

Mac 的绑定保存在 `~/Library/Application Support/skfiy/remote-desktops.json`，包含 SSH 别名、电脑名和用户名，不存密码。主机身份变化时拒绝发送输入，需要先检查 SSH 配置。

## 模型调用

先发现绑定，再获取远端截图：

```json
{"action":"list"}
{"host":"lil-win","action":"state"}
```

把上面的参数交给 MCP 工具 `remote_desktop`。也可以在终端读取状态：

```bash
skfiy call remote_desktop '{"host":"lil-win","action":"state"}'
```

返回截图和 `frame_id`。后续点击、输入、按键、滚动、拖拽都必须带这个编号：

```json
{"host":"lil-win","action":"click","frame_id":"上次返回的编号","x":320,"y":220}
{"host":"lil-win","action":"type","frame_id":"点击后返回的新编号","text":"Hello 中文"}
{"host":"lil-win","action":"key","frame_id":"输入后返回的新编号","key":"ctrl+a"}
```

- 每个 `frame_id` 在 30 秒内接受一次输入，执行后返回新截图和新编号；失败时也应重新获取状态。
- 坐标是 **`remote_desktop` 返回图片的像素**。不能使用 RustDesk 窗口截图的坐标。多屏时图片覆盖整个 Windows 虚拟桌面，宽度最多 1600 像素，内部映射回实际屏幕。
- `click`：`x/y`；`button: left|right`，`count: 1|2`。
- `type`：`text`，支持 Unicode、空格、换行、制表符，最多 2000 个 UTF-16 单元。
- `key`：Windows 快捷键，如 `ctrl+a`、`shift+left`、`enter`、`backspace`、`win+d`。文字用 `type`。
- `scroll`：`x/y`、`direction: up|down|left|right`、`amount: 1..10`（滚轮刻度，默认 3）。
- `drag`：起点 `x/y`，终点 `to_x/to_y`。

Windows 显示布局变化、鼠标目标窗口变化、键盘目标窗口变化或截图过期时，会要求重新查看。输入“已发送”只说明系统接受了事件，仍需检查返回截图里的实际结果。网络中断或超时后不自动重发输入，应先重新查看。

## 限制与数据

Windows 必须已有该 SSH 用户的交互式桌面；SSH 自己所在的会话 0 不能直接控制桌面。锁屏、登录页、UAC 安全桌面和高权限应用不在支持范围内。组件不会解锁、提权或关闭 UAC。

工具使用 SSH 传输。短暂的请求/回复文件仅当前 Windows 用户、SYSTEM 和管理员可访问；正常请求结束即删除，异常遗留文件在工作进程运行时按 60 秒期限清理。工作进程内存里的截图编号 30 秒过期。截图不写入 skfiy 操作日志；远程文字和按键参数始终脱敏。`skfiy call` 和 MCP 客户端可能各自保存返回截图，沿用它们自己的存储行为。

本机急停会阻止新的工具调用；已交给 Windows 执行的输入无法撤回。远端也有人操作时，仍可能在同一窗口内干扰光标和选区，应避免同时编辑同一控件。

## 卸载这个通道

```bash
skfiy remote remove lil-win
```

删除远端组件、它的计划任务和本机绑定；不会改 SSH 配置或 RustDesk。卸载整个本机 skfiy 前，应先移除不再需要的远端通道。

## 开发验收

源码在 `remote-windows/`；修改后运行 `python3 scripts/embed_remote.py` 更新内嵌副本，单元测试会检查两者一致。随后重新执行 `remote add` 部署（运行中的组件需先等待两分钟空闲退出）。

在用户授权远端测试后运行：

```bash
python3 scripts/test_remote_desktop.py .build/debug/skfiy --host lil-win --ssh lil-win --accept
```

脚本只在远端创建独立测试窗，用控件自己的文本、按钮计数、滚动位置和鼠标事件作为回执，并独立 OCR 截图。持续采样本机前台和最上层窗口；最后移除测试窗、临时文件及测试任务。结果仅保留检查布尔值和采样数量，位于 `eval/results/remote-desktop-*`。
