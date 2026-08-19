import { describe, expect, it } from "vitest";
import { selectCommandRoute } from "./task-routing";

describe("selectCommandRoute", () => {
  it("routes explicit Chrome test-page commands to Chrome", () => {
    expect(selectCommandRoute("打开 Chrome 测试页面 file:///tmp/skfiy-chrome.html 并提取正文")).toEqual({
      kind: "chrome",
      bundleId: "com.google.Chrome"
    });
  });

  it("routes provider-normalized Chrome page intents to Chrome", () => {
    for (const command of [
      "打开 Chrome 访问 file:///tmp/skfiy-chrome.html，并提取页面正文内容",
      "用 Chromium 打开 https://example.test/skfiy 并读取正文内容"
    ]) {
      expect(selectCommandRoute(command)).toEqual({
        kind: "chrome",
        bundleId: "com.google.Chrome"
      });
    }
  });

  it("routes explicit Chrome test-form commands to Chrome", () => {
    expect(selectCommandRoute(
      "填写 Chrome 测试表单 file:///tmp/skfiy-form.html 字段 #name=skfiy; #email=agent@skfiy.test; #role=operator 点击 #submit 并提取正文"
    )).toEqual({
      kind: "chrome",
      bundleId: "com.google.Chrome"
    });
  });

  it("routes current Chrome page observation commands to Chrome", () => {
    expect(selectCommandRoute("观察 Chrome 当前页面并提取正文")).toEqual({
      kind: "chrome",
      bundleId: "com.google.Chrome"
    });
  });

  it("routes explicit Finder test-folder organization commands to Finder", () => {
    expect(selectCommandRoute("整理 Finder 测试文件夹 /tmp/skfiy-demo")).toEqual({
      kind: "finder",
      bundleId: "com.apple.finder"
    });
  });

  it("routes current Finder folder organization commands to Finder", () => {
    expect(selectCommandRoute("整理 Finder 当前文件夹")).toEqual({
      kind: "finder",
      bundleId: "com.apple.finder"
    });
  });

  it("routes selected Finder folder organization commands to Finder", () => {
    expect(selectCommandRoute("整理 Finder 选中文件夹")).toEqual({
      kind: "finder",
      bundleId: "com.apple.finder"
    });
  });

  it("routes Finder drag probe commands to Finder", () => {
    expect(selectCommandRoute("探测 Finder 拖拽测试文件夹 /tmp/skfiy-demo")).toEqual({
      kind: "finder",
      bundleId: "com.apple.finder"
    });
  });

  it("routes Finder item drag/drop commands to Finder", () => {
    expect(selectCommandRoute("拖放 Finder 测试文件夹 /tmp/skfiy-demo")).toEqual({
      kind: "finder",
      bundleId: "com.apple.finder"
    });
  });

  it("routes money-run supervision commands to tmux supervision", () => {
    expect(selectCommandRoute("监督 tmux money-run 这个 session")).toEqual({
      kind: "tmux_supervision",
      sessionName: "money-run"
    });
  });

  it("preserves the requested money-run tmux session name", () => {
    expect(selectCommandRoute("监督 tmux money-run-goal 这个 session")).toEqual({
      kind: "tmux_supervision",
      sessionName: "money-run-goal"
    });
  });

  it("asks for clarification instead of routing unsupported visible-app requests", () => {
    for (const command of [
      "用 TextEdit 输入 hello",
      "在 Safari 点击登录按钮",
      "在 Slack 点击发送按钮",
      "点当前屏幕可见按钮",
      "观察当前可见 app",
      "在当前窗口点击提交按钮",
      "观察前台应用",
      "click the current window button",
      "inspect the frontmost app"
    ]) {
      expect(selectCommandRoute(command)).toEqual({
        kind: "needs_clarification",
        reason: "Generic visible-app control is not a supported product route yet. Name Ghostty, Chrome/Chromium, Finder, or money-run supervision."
      });
    }
  });

  it("routes explicit confirmation-gated desktop requests to confirmation without losing the target route", () => {
    expect(selectCommandRoute("在 Ghostty 执行 pwd，先等我确认")).toEqual({
      kind: "needs_confirmation",
      reason: "Route policy requires confirmation before continuing with Ghostty.",
      targetRoute: {
        kind: "ghostty",
        bundleId: "com.mitchellh.ghostty"
      }
    });
  });

  it("keeps unsupported confirmation-gated visible-app requests as clarification", () => {
    expect(selectCommandRoute("在 Safari 点击登录按钮，先等我确认")).toEqual({
      kind: "needs_clarification",
      reason: "Generic visible-app control is not a supported product route yet. Name Ghostty, Chrome/Chromium, Finder, or money-run supervision."
    });
  });

  it("routes explicit user cancellation of desktop control to denial", () => {
    expect(selectCommandRoute("不要在 Ghostty 执行 pwd")).toEqual({
      kind: "denied",
      reason: "User denied this desktop control request.",
      targetRoute: {
        kind: "ghostty",
        bundleId: "com.mitchellh.ghostty"
      }
    });
  });

  it("routes explicit user cancellation of unsupported visible-app control to denial instead of clarification", () => {
    expect(selectCommandRoute("不要在 Safari 点击登录按钮")).toEqual({
      kind: "denied",
      reason: "User denied this desktop control request."
    });
  });

  it("routes route-policy-prohibited destructive terminal control to blocked", () => {
    expect(selectCommandRoute("在 Ghostty 执行 rm -rf ~/Desktop")).toEqual({
      kind: "blocked",
      reason: "Route policy blocks destructive or sensitive terminal commands before Computer Use.",
      targetRoute: {
        kind: "ghostty",
        bundleId: "com.mitchellh.ghostty"
      }
    });
  });

  it("keeps terminal commands on the Ghostty route", () => {
    expect(selectCommandRoute("打开 Ghostty 执行 pwd 并截图")).toEqual({
      kind: "ghostty",
      bundleId: "com.mitchellh.ghostty"
    });
  });

  it("does not treat bare shell text from the pet as a Ghostty task", () => {
    for (const command of ["pbpaste", "pwd", "执行 pwd"]) {
      expect(selectCommandRoute(command)).toEqual({
        kind: "needs_clarification",
        reason: "No supported desktop control route matched this request."
      });
    }
  });

  it("still routes terminal work to Ghostty when the target app is explicit", () => {
    expect(selectCommandRoute("在 Ghostty 执行 pwd")).toEqual({
      kind: "ghostty",
      bundleId: "com.mitchellh.ghostty"
    });
  });

  it("does not create files through shell when no target app is named", () => {
    expect(selectCommandRoute("创建 skfiy-demo 文件夹")).toEqual({
      kind: "needs_clarification",
      reason: "No supported desktop control route matched this request."
    });
  });

  it("routes conversational questions away from Ghostty", () => {
    expect(selectCommandRoute("你是谁，能做什么")).toEqual({
      kind: "chat",
      reason: "Conversational prompt should be answered by the assistant instead of typed into Ghostty."
    });
  });

  it("routes short greetings away from the direct terminal command path", () => {
    for (const greeting of ["hello", "hi", "你好", "哈喽"]) {
      expect(selectCommandRoute(greeting)).toEqual({
        kind: "chat",
        reason: "Conversational prompt should be answered by the assistant instead of typed into Ghostty."
      });
    }
  });

  it("routes natural greeting and reply prompts to chat", () => {
    for (const prompt of [
      "你好 skfiy，请用一句话回复。",
      "请回答：你好 skfiy",
      "帮我解释一下你能做什么"
    ]) {
      expect(selectCommandRoute(prompt)).toEqual({
        kind: "chat",
        reason: "Conversational prompt should be answered by the assistant instead of typed into Ghostty."
      });
    }
  });

  it("routes normal assistant questions to chat by default", () => {
    for (const prompt of [
      "现在整体项目完成得怎么样了？",
      "帮我写一段简短的自我介绍",
      "今天适合先做哪件事？"
    ]) {
      expect(selectCommandRoute(prompt)).toEqual({
        kind: "chat",
        reason: "Conversational prompt should be answered by the assistant instead of typed into Ghostty."
      });
    }
  });

  it("keeps desktop control requests out of chat even when phrased conversationally", () => {
    expect(selectCommandRoute("你好 skfiy，在 Ghostty 执行 pwd")).toEqual({
      kind: "ghostty",
      bundleId: "com.mitchellh.ghostty"
    });
  });

  it("asks for clarification when the requested app or action is not supported yet", () => {
    expect(selectCommandRoute("帮我整理一下桌面")).toEqual({
      kind: "needs_clarification",
      reason: "No supported desktop control route matched this request."
    });
  });
});
