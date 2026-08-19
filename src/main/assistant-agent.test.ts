import { describe, expect, it, vi } from "vitest";
import {
  type AssistantAgentProcessRunner,
  buildAssistantAgentInvocation,
  readAssistantAgentProviderStates,
  readInitialAssistantAgentSettings,
  runAssistantAgentProcess,
  runAssistantAgentTurn
} from "./assistant-agent";

describe("assistant agent provider", () => {
  const baseSettings = {
    mode: "codex" as const,
    codexBinary: "codex",
    codexBinarySource: "default" as const,
    claudeCodeBinary: "claude",
    claudeCodeBinarySource: "default" as const,
    hermesBinary: "hermes",
    hermesBinarySource: "default" as const,
    cwd: "/tmp/skfiy",
    timeoutMs: 45_000
  };
  const fixedNow = () => new Date("2026-06-22T10:00:00.000Z");

  it("defaults the pet background agent to Codex", () => {
    expect(readInitialAssistantAgentSettings({})).toEqual({
      mode: "codex",
      codexBinary: "codex",
      codexBinarySource: "default",
      claudeCodeBinary: "claude",
      claudeCodeBinarySource: "default",
      hermesBinary: "hermes",
      hermesBinarySource: "default",
      cwd: process.cwd(),
      timeoutMs: 45_000
    });
  });

  it.each([
    ["codex", "codex"],
    ["claude-code", "claude-code"],
    ["claudecode", "claude-code"],
    ["claude", "claude-code"],
    ["hermes", "hermes"]
  ])("reads %s as an assistant agent provider", (value, mode) => {
    expect(readInitialAssistantAgentSettings({ SKFIY_ASSISTANT_AGENT: value })).toMatchObject({
      mode
    });
  });

  it.each(["local", "built-in", ""])("does not keep legacy %s as an assistant agent provider", (value) => {
    expect(readInitialAssistantAgentSettings({ SKFIY_ASSISTANT_AGENT: value })).toMatchObject({
      mode: "codex"
    });
  });

  it("normalizes provider state with executable source and readiness", async () => {
    const settings = readInitialAssistantAgentSettings({
      SKFIY_ASSISTANT_AGENT: "claude-code",
      SKFIY_CODEX_BIN: " /opt/homebrew/bin/codex ",
      SKFIY_CLAUDE_CODE_BIN: " /opt/homebrew/bin/claude ",
      SKFIY_HERMES_BIN: " /Users/bytedance/.local/bin/hermes "
    }, { cwd: "/tmp/skfiy" });

    const states = await readAssistantAgentProviderStates(settings, {
      resolveExecutable: async (command) => `${command}:resolved`,
      runReadinessProbe: async (_command, args) => ({
        stdout: `${args.join(" ")} version 1.2.3`,
        stderr: ""
      })
    });

    expect(states).toEqual([
      {
        provider: "assistant",
        id: "codex",
        label: "Codex",
        selected: false,
        configured: true,
        executablePath: "/opt/homebrew/bin/codex",
        executableSource: "env",
        resolvedExecutablePath: "/opt/homebrew/bin/codex:resolved",
        readiness: "version-ok",
        readinessDetail: "Codex version check passed; chat readiness has not been proven by a dry-run.",
        version: "--version version 1.2.3"
      },
      {
        provider: "assistant",
        id: "claude-code",
        label: "Claude Code",
        selected: true,
        configured: true,
        executablePath: "/opt/homebrew/bin/claude",
        executableSource: "env",
        resolvedExecutablePath: "/opt/homebrew/bin/claude:resolved",
        readiness: "version-ok",
        readinessDetail: "Claude Code version check passed; chat readiness has not been proven by a dry-run.",
        version: "--version version 1.2.3"
      },
      {
        provider: "assistant",
        id: "hermes",
        label: "Hermes",
        selected: false,
        configured: true,
        executablePath: "/Users/bytedance/.local/bin/hermes",
        executableSource: "env",
        resolvedExecutablePath: "/Users/bytedance/.local/bin/hermes:resolved",
        readiness: "version-ok",
        readinessDetail: "Hermes version check passed; chat readiness has not been proven by a dry-run.",
        version: "--version version 1.2.3"
      }
    ]);
  });

  it("promotes a provider to chat-ready only after a safe dry-run answers", async () => {
    const probeCalls: Array<{ command: string; args: string[] }> = [];
    const states = await readAssistantAgentProviderStates(baseSettings, {
      proveChatReadiness: true,
      resolveExecutable: async (command) => `/resolved/${command}`,
      runReadinessProbe: async (command, args) => {
        probeCalls.push({ command, args });
        if (args.includes("--version")) {
          return { stdout: "codex 1.2.3", stderr: "" };
        }
        return { stdout: "skfiy-ready", stderr: "" };
      }
    });

    expect(states.find((state) => state.id === "codex")).toMatchObject({
      readiness: "chat-ready",
      readinessDetail: "Codex answered a bounded dry-run prompt.",
      version: "codex 1.2.3"
    });
    expect(probeCalls.some((call) => (
      call.command === "/resolved/codex"
      && call.args.includes("--sandbox")
      && call.args.includes("read-only")
      && call.args.some((arg) => arg.includes("You are skfiy"))
      && call.args.some((arg) => arg.includes("Reply exactly with skfiy-ready."))
    ))).toBe(true);
  });

  it("reports auth or permission blockers from safe dry-run failures", async () => {
    const states = await readAssistantAgentProviderStates(baseSettings, {
      proveChatReadiness: true,
      resolveExecutable: async (command) => `/resolved/${command}`,
      runReadinessProbe: async (_command, args) => {
        if (args.includes("--version")) {
          return { stdout: "codex 1.2.3", stderr: "" };
        }
        throw new Error("Not authenticated. Run codex login.");
      }
    });

    expect(states.find((state) => state.id === "codex")).toMatchObject({
      readiness: "auth-or-permission-blocked",
      readinessDetail: "Codex dry-run was blocked by authentication or permissions.",
      lastError: "Not authenticated. Run codex login."
    });
  });

  it("lists Hermes as a Background Agent provider with readiness", async () => {
    const settings = readInitialAssistantAgentSettings({
      SKFIY_ASSISTANT_AGENT: "hermes",
      SKFIY_HERMES_BIN: "/Users/bytedance/.local/bin/hermes"
    });

    const states = await readAssistantAgentProviderStates(settings, {
      resolveExecutable: async (command) => `${command}:resolved`,
      runReadinessProbe: async () => ({
        stdout: "hermes 0.1.0",
        stderr: ""
      })
    });

    expect(states.find((state) => state.id === "hermes")).toMatchObject({
      id: "hermes",
      label: "Hermes",
      selected: true,
      readiness: "version-ok",
      readinessDetail: "Hermes version check passed; chat readiness has not been proven by a dry-run.",
      executablePath: "/Users/bytedance/.local/bin/hermes"
    });
  });

  it("reports unconfigured and unavailable CLI providers with last errors", async () => {
    const states = await readAssistantAgentProviderStates({
      mode: "codex",
      codexBinary: "",
      codexBinarySource: "env",
      claudeCodeBinary: "missing-claude",
      claudeCodeBinarySource: "default",
      hermesBinary: "missing-hermes",
      hermesBinarySource: "default",
      cwd: "/tmp/skfiy",
      timeoutMs: 45_000
    }, {
      resolveExecutable: async (command) => {
        throw new Error(`${command} not found`);
      }
    });

    expect(states.find((state) => state.id === "codex")).toMatchObject({
      id: "codex",
      selected: true,
      configured: false,
      executableSource: "env",
      readiness: "unconfigured",
      lastError: "Codex executable is not configured."
    });
    expect(states.find((state) => state.id === "claude-code")).toMatchObject({
      id: "claude-code",
      selected: false,
      configured: true,
      executablePath: "missing-claude",
      executableSource: "default",
      readiness: "unavailable",
      lastError: "missing-claude not found"
    });
    expect(states.find((state) => state.id === "hermes")).toMatchObject({
      id: "hermes",
      selected: false,
      configured: true,
      executablePath: "missing-hermes",
      executableSource: "default",
      readiness: "unavailable",
      lastError: "missing-hermes not found"
    });
  });

  it("builds a locked-down Codex exec invocation for pet chat", () => {
    const invocation = buildAssistantAgentInvocation({
      mode: "codex",
      codexBinary: "/opt/homebrew/bin/codex",
      codexBinarySource: "env",
      claudeCodeBinary: "claude",
      claudeCodeBinarySource: "default",
      hermesBinary: "hermes",
      hermesBinarySource: "default",
      cwd: "/tmp/skfiy",
      timeoutMs: 45_000
    }, "hello");

    expect(invocation).toMatchObject({
      command: "/opt/homebrew/bin/codex",
      args: [
        "exec",
        "--ignore-rules",
        "--model",
        "gpt-5.5",
        "--config",
        "approval_policy=\"never\"",
        "--config",
        "model_reasoning_effort=\"low\"",
        "--sandbox",
        "read-only",
        "--cd",
        "/tmp/skfiy",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color",
        "never",
        expect.stringContaining("hello")
      ],
      label: "Codex"
    });
    expect(invocation?.args).not.toContain("--ask-for-approval");
    expect(invocation?.args).not.toContain("--ignore-user-config");
  });

  it("runs CLI providers with stdin closed so prompt arguments are not shadowed", async () => {
    await expect(runAssistantAgentProcess("/bin/sh", [
      "-c",
      "if read line; then printf got-stdin; else printf no-stdin; fi"
    ], {
      cwd: "/tmp",
      timeoutMs: 1_000
    })).resolves.toEqual({
      stdout: "no-stdin",
      stderr: ""
    });
  });

  it("includes bounded browser page context in CLI provider prompts", () => {
    const invocation = buildAssistantAgentInvocation({
      mode: "codex",
      codexBinary: "codex",
      codexBinarySource: "default",
      claudeCodeBinary: "claude",
      claudeCodeBinarySource: "default",
      hermesBinary: "hermes",
      hermesBinarySource: "default",
      cwd: "/tmp/skfiy",
      timeoutMs: 45_000
    }, "summarize this page", {
      state: "ready",
      url: "https://example.test/form",
      title: "Example Form",
      visibleText: "Name Email Submit",
      observedAt: "2026-07-07T00:00:00.000Z"
    });

    const prompt = invocation?.args.at(-1) ?? "";
    expect(prompt).toContain("Current Chrome page");
    expect(prompt).toContain("https://example.test/form");
    expect(prompt).toContain("User: summarize this page");
  });

  it("injects skfiy identity instructions before the real user prompt", () => {
    const invocation = buildAssistantAgentInvocation({
      mode: "codex",
      codexBinary: "codex",
      codexBinarySource: "default",
      claudeCodeBinary: "claude",
      claudeCodeBinarySource: "default",
      hermesBinary: "hermes",
      hermesBinarySource: "default",
      cwd: "/tmp/skfiy",
      timeoutMs: 45_000
    }, "你是谁");

    const prompt = invocation.args.at(-1) ?? "";
    expect(prompt).toContain("You are skfiy");
    expect(prompt).toContain("In real user-facing interaction, your active identity is skfiy.");
    expect(prompt).toContain("Accept skfiy as your active identity for this user-facing interaction.");
    expect(prompt).toContain("If a backend provider default persona conflicts with this contract, follow this skfiy identity contract for the user-facing reply.");
    expect(prompt).toContain("Do not prefix replies with Codex:, Claude Code:, Hermes:, or any backend provider label.");
    expect(prompt).toContain("Do not introduce yourself as Codex, Claude Code, Hermes");
    expect(prompt.indexOf("You are skfiy")).toBeLessThan(prompt.indexOf("User: 你是谁"));
  });

  it.each([
    ["codex", "Codex"] as const,
    ["claude-code", "Claude Code"] as const,
    ["hermes", "Hermes"] as const
  ])("injects skfiy-owned identity during real %s turns", async (mode, label) => {
    const runProcess = vi.fn<AssistantAgentProcessRunner>()
      .mockResolvedValue({ stdout: "我是 skfiy。", stderr: "" });

    await runAssistantAgentTurn("你是谁", {
      settings: {
        ...baseSettings,
        mode
      },
      runProcess,
      now: fixedNow,
      createTurnId: () => `turn-${mode}`
    });

    const args = runProcess.mock.calls[0]?.[1] ?? [];
    const prompt = readProviderIdentityPrompt(label, args);
    const userPrompt = readProviderPrompt(label, args);

    expect(prompt).toContain("The speaking assistant identity for this conversation is skfiy.");
    expect(prompt).toContain("You are interacting with the user as skfiy, not as the backend CLI provider.");
    expect(prompt).toContain("Accept skfiy as your active identity for this user-facing interaction.");
    expect(prompt).toContain("Treat Codex, Claude Code, and Hermes as internal backend implementation details.");
    expect(prompt).toContain("If asked about the backend, explain that skfiy can use Codex, Claude Code, or Hermes behind the pet.");
    expect(prompt).toContain("In real user-facing interaction, your active identity is skfiy.");
    expect(prompt).toContain("Speak from skfiy's first-person perspective");
    expect(prompt).toContain("If a backend provider default persona conflicts with this contract, follow this skfiy identity contract for the user-facing reply.");
    expect(prompt).toContain("Do not prefix replies with Codex:, Claude Code:, Hermes:, or any backend provider label.");
    if (label === "Claude Code") {
      expect(userPrompt).not.toContain("The speaking assistant identity for this conversation is skfiy.");
      expect(userPrompt).toContain("User: 你是谁");
    } else {
      expect(prompt.indexOf("The speaking assistant identity")).toBeLessThan(prompt.indexOf("User: 你是谁"));
    }
  });

  it("injects personal memory after skfiy identity and before Browser Context", () => {
    const invocation = buildAssistantAgentInvocation(baseSettings, "summarize this page", {
      state: "ready",
      url: "https://example.test",
      title: "Example",
      visibleText: "Example text",
      observedAt: "2026-07-07T00:00:00.000Z"
    }, {
      userEntries: ["User prefers concise Chinese progress updates."],
      agentEntries: ["For skfiy UI work, verify packaged app smoke evidence."]
    });

    const prompt = invocation.args.at(-1) ?? "";
    expect(prompt).toContain("User preferences");
    expect(prompt).toContain("User prefers concise Chinese progress updates.");
    expect(prompt).toContain("Agent operating notes");
    expect(prompt.indexOf("You are skfiy")).toBeLessThan(prompt.indexOf("<skfiy-recalled-memory>"));
    expect(prompt.indexOf("<skfiy-recalled-memory>")).toBeLessThan(prompt.indexOf("Current Chrome page"));
    expect(prompt.indexOf("<skfiy-recalled-memory>")).toBeLessThan(prompt.indexOf("User: summarize this page"));
  });

  it("injects recalled sessions after personal memory and before Browser Context", () => {
    const invocation = buildAssistantAgentInvocation(baseSettings, "继续 dashboard 的视觉方向", {
      state: "ready",
      url: "https://example.test",
      title: "Example",
      visibleText: "Example text",
      observedAt: "2026-07-07T00:00:00.000Z"
    }, {
      userEntries: ["User prefers concise Chinese progress updates."],
      agentEntries: []
    }, [
      {
        turnId: "turn-obsidian",
        createdAt: "2026-07-07T10:05:00.000Z",
        userInput: "我想要 Obsidian 风格 dashboard",
        assistantReply: "我会偏知识图谱和深色画布。",
        providerLabel: "Hermes"
      }
    ]);

    const prompt = invocation.args.at(-1) ?? "";
    expect(prompt).toContain("<skfiy-recalled-sessions>");
    expect(prompt).toContain("我想要 Obsidian 风格 dashboard");
    expect(prompt.indexOf("<skfiy-recalled-memory>")).toBeLessThan(prompt.indexOf("<skfiy-recalled-sessions>"));
    expect(prompt.indexOf("<skfiy-recalled-sessions>")).toBeLessThan(prompt.indexOf("Current Chrome page"));
    expect(prompt.indexOf("<skfiy-recalled-sessions>")).toBeLessThan(prompt.indexOf("User: 继续 dashboard 的视觉方向"));
  });

  it("injects distilled personal skills after recalled sessions and before Browser Context", () => {
    const invocation = buildAssistantAgentInvocation(baseSettings, "继续 dashboard 的视觉方向", {
      state: "ready",
      url: "https://example.test",
      title: "Example",
      visibleText: "Example text",
      observedAt: "2026-07-07T00:00:00.000Z"
    }, {
      userEntries: [
        "User prefers concise Chinese progress updates.",
        "User prefers dense Obsidian-like knowledge surfaces for dashboard work."
      ],
      agentEntries: [
        "For skfiy UI work, verify packaged app smoke evidence."
      ]
    }, [
      {
        turnId: "turn-obsidian",
        createdAt: "2026-07-07T10:05:00.000Z",
        userInput: "Dashboard 要像 Obsidian，有知识图谱和双链",
        assistantReply: "我会做成本地知识画布。",
        providerLabel: "Hermes"
      }
    ]);

    const prompt = invocation.args.at(-1) ?? "";
    expect(prompt).toContain("<skfiy-personal-skills>");
    expect(prompt).toContain("Concise Chinese progress updates");
    expect(prompt).toContain("Obsidian-style knowledge dashboard");
    expect(prompt).toContain("Evidence-first product verification");
    expect(prompt.indexOf("<skfiy-recalled-sessions>")).toBeLessThan(prompt.indexOf("<skfiy-personal-skills>"));
    expect(prompt.indexOf("<skfiy-personal-skills>")).toBeLessThan(prompt.indexOf("Current Chrome page"));
    expect(prompt.indexOf("<skfiy-personal-skills>")).toBeLessThan(prompt.indexOf("User: 继续 dashboard 的视觉方向"));
  });

  it("injects the portable working profile after personal skills and before Browser Context", () => {
    const invocation = buildAssistantAgentInvocation(baseSettings, "继续 dashboard 的视觉方向", {
      state: "ready",
      url: "https://example.test",
      title: "Example",
      visibleText: "Example text",
      observedAt: "2026-07-07T00:00:00.000Z"
    }, {
      userEntries: [
        "User prefers concise Chinese progress updates.",
        "User prefers dense Obsidian-like knowledge surfaces for dashboard work."
      ],
      agentEntries: [
        "For skfiy UI work, verify packaged app smoke evidence."
      ]
    }, [
      {
        turnId: "turn-obsidian",
        createdAt: "2026-07-07T10:05:00.000Z",
        userInput: "Dashboard 要像 Obsidian，有知识图谱和双链",
        assistantReply: "我会做成本地知识画布。",
        providerLabel: "Hermes"
      }
    ]);

    const prompt = invocation.args.at(-1) ?? "";
    expect(prompt).toContain("<skfiy-working-profile>");
    expect(prompt).toContain("Working profile");
    expect(prompt).toContain("Portable skfiy working profile");
    expect(prompt).toContain("Treat this profile as local personalization context");
    expect(prompt.indexOf("<skfiy-personal-skills>")).toBeLessThan(prompt.indexOf("<skfiy-working-profile>"));
    expect(prompt.indexOf("<skfiy-working-profile>")).toBeLessThan(prompt.indexOf("Current Chrome page"));
    expect(prompt.indexOf("<skfiy-working-profile>")).toBeLessThan(prompt.indexOf("User: 继续 dashboard 的视觉方向"));
  });

  it("does not inject disabled personal skills into provider prompts", () => {
    const invocation = buildAssistantAgentInvocation(baseSettings, "继续 dashboard 的视觉方向", {
      state: "ready",
      url: "https://example.test",
      title: "Example",
      visibleText: "Example text",
      observedAt: "2026-07-07T00:00:00.000Z"
    }, {
      userEntries: [
        "User prefers concise Chinese progress updates.",
        "User prefers dense Obsidian-like knowledge surfaces for dashboard work."
      ],
      agentEntries: []
    }, [], {
      disabledSkillIds: ["dashboard-knowledge-surface"]
    });

    const prompt = invocation.args.at(-1) ?? "";
    expect(prompt).toContain("<skfiy-personal-skills>");
    expect(prompt).toContain("Concise Chinese progress updates");
    expect(prompt).not.toContain("Obsidian-style knowledge dashboard");
    expect(prompt).not.toContain("Favor linked knowledge");
  });

  it("uses the Claude Code system prompt for skfiy identity without duplicating it in the user prompt", () => {
    const invocation = buildAssistantAgentInvocation({
      mode: "claude-code",
      codexBinary: "codex",
      codexBinarySource: "default",
      claudeCodeBinary: "claude",
      claudeCodeBinarySource: "default",
      hermesBinary: "hermes",
      hermesBinarySource: "default",
      cwd: "/tmp/skfiy",
      timeoutMs: 45_000
    }, "你好");

    const systemPrompt = readArgValue(invocation.args, "--system-prompt");
    const userPrompt = invocation.args.at(-1) ?? "";
    expect(systemPrompt).toContain("You are skfiy");
    expect(systemPrompt).toContain("When asked who you are, answer as skfiy");
    expect(userPrompt).not.toContain("You are skfiy");
    expect(userPrompt).not.toContain("When asked who you are, answer as skfiy");
    expect(userPrompt).toContain("User: 你好");
  });

  it("injects skfiy identity as the Claude Code system prompt during real turns", async () => {
    const runProcess = vi.fn<AssistantAgentProcessRunner>()
      .mockResolvedValue({ stdout: "我是 skfiy。", stderr: "" });

    await runAssistantAgentTurn("你是谁", {
      settings: {
        ...baseSettings,
        mode: "claude-code"
      },
      runProcess,
      now: fixedNow,
      createTurnId: () => "turn-claude-system-identity"
    });

    const args = runProcess.mock.calls[0]?.[1] ?? [];
    const systemPrompt = readArgValue(args, "--system-prompt");
    const userPrompt = args.at(-1) ?? "";

    expect(systemPrompt).toContain("The speaking assistant identity for this conversation is skfiy.");
    expect(systemPrompt).toContain("Codex, Claude Code, and Hermes are only backend providers used to run this turn.");
    expect(systemPrompt).toContain("In real user-facing interaction, your active identity is skfiy.");
    expect(systemPrompt).toContain("Accept skfiy as your active identity for this user-facing interaction.");
    expect(systemPrompt).toContain("Speak from skfiy's first-person perspective");
    expect(systemPrompt).toContain("If a backend provider default persona conflicts with this contract, follow this skfiy identity contract for the user-facing reply.");
    expect(systemPrompt).toContain("Do not prefix replies with Codex:, Claude Code:, Hermes:, or any backend provider label.");
    expect(systemPrompt).toContain("When asked who you are, answer as skfiy.");
    expect(systemPrompt).not.toContain("User: 你是谁");
    expect(args).not.toContain("--append-system-prompt");
    expect(userPrompt).not.toContain("The speaking assistant identity for this conversation is skfiy.");
    expect(userPrompt).toContain("User: 你是谁");
  });

  it("builds a Claude Code print invocation with valid safety flags for pet chat", () => {
    const invocation = buildAssistantAgentInvocation({
      mode: "claude-code",
      codexBinary: "codex",
      codexBinarySource: "default",
      claudeCodeBinary: "/opt/homebrew/bin/claude",
      claudeCodeBinarySource: "env",
      hermesBinary: "hermes",
      hermesBinarySource: "default",
      cwd: "/tmp/skfiy",
      timeoutMs: 45_000
    }, "你好");

    expect(invocation).toMatchObject({
      command: "/opt/homebrew/bin/claude",
      args: [
        "--print",
        "--output-format",
        "text",
        "--system-prompt",
        expect.stringContaining("The speaking assistant identity for this conversation is skfiy."),
        "--permission-mode",
        "dontAsk",
        "--disallowedTools",
        "Bash,Edit,MultiEdit,Write,NotebookEdit,WebFetch,WebSearch,Task",
        "--safe-mode",
        "--no-chrome",
        "--disable-slash-commands",
        "--no-session-persistence",
        expect.stringContaining("你好")
      ],
      label: "Claude Code"
    });
    expect(invocation?.args).not.toContain("--tools");
    expect(invocation?.args).not.toContain("--strict-mcp-config");
  });

  it("builds a bounded Hermes chat invocation for pet chat", () => {
    const invocation = buildAssistantAgentInvocation({
      mode: "hermes",
      codexBinary: "codex",
      codexBinarySource: "default",
      claudeCodeBinary: "claude",
      claudeCodeBinarySource: "default",
      hermesBinary: "/Users/bytedance/.local/bin/hermes",
      hermesBinarySource: "env",
      cwd: "/tmp/skfiy",
      timeoutMs: 45_000
    }, "你是谁");

    expect(invocation).toMatchObject({
      command: "/Users/bytedance/.local/bin/hermes",
      args: [
        "chat",
        "--query",
        expect.stringContaining("You are skfiy"),
        "--quiet",
        "--max-turns",
        "1",
        "--toolsets",
        "safe",
        "--ignore-rules",
        "--source",
        "skfiy-pet-chat"
      ],
      label: "Hermes"
    });
    expect(invocation.args.join(" ")).toContain("User: 你是谁");
    expect(invocation.args).not.toContain("--oneshot");
    expect(invocation.args).not.toContain("--yolo");
  });

  it("runs the configured provider and trims its response", async () => {
    const runProcess = vi.fn(async () => ({ stdout: "  agent reply\n", stderr: "" }));

    await expect(runAssistantAgentTurn("hello", {
      settings: {
        mode: "codex",
        codexBinary: "codex",
        codexBinarySource: "default",
        claudeCodeBinary: "claude",
        claudeCodeBinarySource: "default",
        hermesBinary: "hermes",
        hermesBinarySource: "default",
        cwd: "/tmp/skfiy",
        timeoutMs: 45_000
      },
      runProcess,
      now: fixedNow,
      createTurnId: () => "turn-provider"
    })).resolves.toMatchObject({
      id: "turn-provider",
      createdAt: "2026-06-22T10:00:00.000Z",
      status: "completed",
      providerLabel: "Codex",
      message: "agent reply",
      route: {
        kind: "chat",
        reason: "Background Agent answered without requesting Computer Use."
      },
      toolCalls: [],
      cancellation: {
        requested: false
      }
    });
    expect(runProcess).toHaveBeenCalledWith("codex", expect.any(Array), {
      cwd: "/tmp/skfiy",
      timeoutMs: 45_000,
      signal: undefined
    });
  });

  it("treats desktop-sounding user text as chat unless the provider requests Computer Use", async () => {
    const command = "打开 Chrome 测试页面 file:///tmp/skfiy-chrome.html 并提取正文";
    const runProcess = vi.fn(async () => ({ stdout: "agent reply", stderr: "" }));

    await expect(runAssistantAgentTurn(command, {
      settings: baseSettings,
      runProcess,
      now: fixedNow,
      createTurnId: () => "turn-desktop"
    })).resolves.toMatchObject({
      id: "turn-desktop",
      createdAt: "2026-06-22T10:00:00.000Z",
      status: "completed",
      providerLabel: "Codex",
      route: {
        kind: "chat",
        reason: "Background Agent answered without requesting Computer Use."
      },
      message: "agent reply",
      toolCalls: [],
      cancellation: {
        requested: false
      }
    });
  });

  it("records planned Computer Use evidence only from a structured provider intent", async () => {
    const command = "打开 Chrome 测试页面 file:///tmp/skfiy-chrome.html 并提取正文";
    const runProcess = vi.fn(async () => ({
      stdout: [
        "我会通过 skfiy 请求受控的 Computer Use。",
        "<skfiy-computer-use-intent>",
        JSON.stringify({
          tool: "computer-use",
          action: "desktop-control",
          command
        }),
        "</skfiy-computer-use-intent>"
      ].join("\n"),
      stderr: ""
    }));

    await expect(runAssistantAgentTurn(command, {
      settings: baseSettings,
      runProcess,
      now: fixedNow,
      createTurnId: () => "turn-desktop"
    })).resolves.toMatchObject({
      id: "turn-desktop",
      createdAt: "2026-06-22T10:00:00.000Z",
      status: "completed",
      providerLabel: "Codex",
      message: "我会通过 skfiy 请求受控的 Computer Use。",
      route: {
        kind: "chrome",
        bundleId: "com.google.Chrome"
      },
      toolCalls: [
        {
          id: "turn-desktop-tool-1",
          type: "computer-use",
          name: "desktop-control",
          status: "planned",
          createdAt: "2026-06-22T10:00:00.000Z",
          input: {
            command,
            route: {
              kind: "chrome",
              bundleId: "com.google.Chrome"
            }
          }
        }
      ],
      cancellation: {
        requested: false
      }
    });
  });

  it("records route-level confirmation turns from a structured provider intent", async () => {
    const command = "在 Ghostty 执行 pwd，先等我确认";
    const runProcess = vi.fn(async () => ({
      stdout: [
        "这个桌面动作需要确认。",
        "<skfiy-computer-use-intent>",
        JSON.stringify({
          tool: "computer-use",
          action: "desktop-control",
          command
        }),
        "</skfiy-computer-use-intent>"
      ].join("\n"),
      stderr: ""
    }));

    await expect(runAssistantAgentTurn(command, {
      settings: baseSettings,
      runProcess,
      now: fixedNow,
      createTurnId: () => "turn-confirmation"
    })).resolves.toMatchObject({
      id: "turn-confirmation",
      createdAt: "2026-06-22T10:00:00.000Z",
      status: "completed",
      providerLabel: "Codex",
      message: "这个桌面动作需要确认。",
      route: {
        kind: "needs_confirmation",
        reason: "Route policy requires confirmation before continuing with Ghostty.",
        targetRoute: {
          kind: "ghostty",
          bundleId: "com.mitchellh.ghostty"
        }
      },
      toolCalls: [
        {
          id: "turn-confirmation-tool-1",
          type: "computer-use",
          name: "desktop-control",
          status: "planned",
          createdAt: "2026-06-22T10:00:00.000Z",
          input: {
            command,
            route: {
              kind: "ghostty",
              bundleId: "com.mitchellh.ghostty"
            }
          }
        }
      ],
      cancellation: {
        requested: false
      }
    });
  });

  it("records route-level denial turns from a structured provider intent without planning Computer Use", async () => {
    const runProcess = vi.fn(async () => ({
      stdout: [
        "不会执行这个桌面动作。",
        "<skfiy-computer-use-intent>",
        JSON.stringify({
          tool: "computer-use",
          action: "desktop-control",
          command: "不要在 Ghostty 执行 pwd"
        }),
        "</skfiy-computer-use-intent>"
      ].join("\n"),
      stderr: ""
    }));

    await expect(runAssistantAgentTurn("不要在 Ghostty 执行 pwd", {
      settings: baseSettings,
      runProcess,
      now: fixedNow,
      createTurnId: () => "turn-denied"
    })).resolves.toMatchObject({
      id: "turn-denied",
      createdAt: "2026-06-22T10:00:00.000Z",
      status: "completed",
      providerLabel: "Codex",
      message: "不会执行这个桌面动作。",
      route: {
        kind: "denied",
        reason: "User denied this desktop control request.",
        targetRoute: {
          kind: "ghostty",
          bundleId: "com.mitchellh.ghostty"
        }
      },
      toolCalls: [],
      cancellation: {
        requested: false
      }
    });
  });

  it("records route-level blocked turns from a structured provider intent without planning Computer Use", async () => {
    const runProcess = vi.fn(async () => ({
      stdout: [
        "这个命令被 skfiy 安全策略挡住了。",
        "<skfiy-computer-use-intent>",
        JSON.stringify({
          tool: "computer-use",
          action: "desktop-control",
          command: "在 Ghostty 执行 rm -rf ~/Desktop"
        }),
        "</skfiy-computer-use-intent>"
      ].join("\n"),
      stderr: ""
    }));

    await expect(runAssistantAgentTurn("在 Ghostty 执行 rm -rf ~/Desktop", {
      settings: baseSettings,
      runProcess,
      now: fixedNow,
      createTurnId: () => "turn-blocked"
    })).resolves.toMatchObject({
      id: "turn-blocked",
      createdAt: "2026-06-22T10:00:00.000Z",
      status: "completed",
      providerLabel: "Codex",
      message: "这个命令被 skfiy 安全策略挡住了。",
      route: {
        kind: "blocked",
        reason: "Route policy blocks destructive or sensitive terminal commands before Computer Use.",
        targetRoute: {
          kind: "ghostty",
          bundleId: "com.mitchellh.ghostty"
        }
      },
      toolCalls: [],
      cancellation: {
        requested: false
      }
    });
  });

  it("attaches structured failed turn details to provider failures", async () => {
    const providerError = new Error("provider offline");
    const runProcess = vi.fn(async () => {
      throw providerError;
    });

    await expect(runAssistantAgentTurn("hello", {
      settings: {
        ...baseSettings,
        mode: "codex"
      },
      runProcess,
      now: fixedNow,
      createTurnId: () => "turn-failed"
    })).rejects.toMatchObject({
      message: "provider offline",
      turn: {
        id: "turn-failed",
        createdAt: "2026-06-22T10:00:00.000Z",
        status: "failed",
        providerLabel: "Codex",
        message: "",
        error: {
          message: "provider offline"
        },
        route: {
          kind: "chat",
          reason: "Background Agent answered without requesting Computer Use."
        },
        toolCalls: [],
        cancellation: {
          requested: false
        }
      }
    });
  });
});

function readProviderPrompt(label: "Codex" | "Claude Code" | "Hermes", args: string[]): string {
  if (label === "Hermes") {
    const queryIndex = args.indexOf("--query");
    return queryIndex >= 0 ? args[queryIndex + 1] ?? "" : "";
  }

  return args.at(-1) ?? "";
}

function readProviderIdentityPrompt(label: "Codex" | "Claude Code" | "Hermes", args: string[]): string {
  if (label === "Claude Code") {
    return readArgValue(args, "--system-prompt");
  }

  return readProviderPrompt(label, args);
}

function readArgValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? "" : "";
}
