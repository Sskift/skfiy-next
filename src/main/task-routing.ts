import { parseChromePageIntent } from "./orchestrator/chrome-task.js";
import { parseFinderOrganizationIntent } from "./orchestrator/finder-task.js";
import { parseTerminalIntent } from "../shared/terminal-intent.js";

export const GHOSTTY_BUNDLE_ID = "com.mitchellh.ghostty";
export const CHROME_BUNDLE_ID = "com.google.Chrome";
export const FINDER_BUNDLE_ID = "com.apple.finder";
const GENERIC_VISIBLE_APP_CLARIFICATION_REASON =
  "Generic visible-app control is not a supported product route yet. Name Ghostty, Chrome/Chromium, Finder, or money-run supervision.";

export type ExecutableCommandRoute =
  | { kind: "ghostty"; bundleId: typeof GHOSTTY_BUNDLE_ID }
  | { kind: "chrome"; bundleId: typeof CHROME_BUNDLE_ID }
  | { kind: "finder"; bundleId: typeof FINDER_BUNDLE_ID }
  | { kind: "tmux_supervision"; sessionName: string };

export type CommandRoute =
  | ExecutableCommandRoute
  | { kind: "chat"; reason: string }
  | { kind: "needs_clarification"; reason: string }
  | { kind: "needs_confirmation"; reason: string; targetRoute: ExecutableCommandRoute }
  | { kind: "denied"; reason: string; targetRoute?: ExecutableCommandRoute }
  | { kind: "blocked"; reason: string; targetRoute?: ExecutableCommandRoute };

export function selectCommandRoute(command: string): CommandRoute {
  const route = selectBaseCommandRoute(command);

  if (isRouteLevelDenialRequest(command) && (isExecutableCommandRoute(route) || isDesktopControlRequest(command))) {
    return {
      kind: "denied",
      reason: "User denied this desktop control request.",
      ...(isExecutableCommandRoute(route) ? { targetRoute: route } : {})
    };
  }

  if (isExecutableCommandRoute(route) && isRoutePolicyBlockedRequest(command, route)) {
    return {
      kind: "blocked",
      reason: "Route policy blocks destructive or sensitive terminal commands before Computer Use.",
      targetRoute: route
    };
  }

  if (isRouteLevelConfirmationRequest(command) && isExecutableCommandRoute(route)) {
    return {
      kind: "needs_confirmation",
      reason: createRouteConfirmationReason(route),
      targetRoute: route
    };
  }

  return route;
}

function selectBaseCommandRoute(command: string): CommandRoute {
  const moneyRunSessionName = readMoneyRunSupervisionSessionName(command);
  if (moneyRunSessionName) {
    return {
      kind: "tmux_supervision",
      sessionName: moneyRunSessionName
    };
  }

  const chromeIntent = parseChromePageIntent(command);
  if (chromeIntent.ok) {
    return {
      kind: "chrome",
      bundleId: CHROME_BUNDLE_ID
    };
  }

  const finderIntent = parseFinderOrganizationIntent(command);

  if (finderIntent.ok) {
    return {
      kind: "finder",
      bundleId: FINDER_BUNDLE_ID
    };
  }

  if (isUnsupportedVisibleAppControlRequest(command)) {
    return {
      kind: "needs_clarification",
      reason: GENERIC_VISIBLE_APP_CLARIFICATION_REASON
    };
  }

  if (isShortGreetingPrompt(command)) {
    return createChatRoute();
  }

  const terminalIntent = parseTerminalIntent(command);

  if (terminalIntent.ok) {
    if (isExplicitTerminalControlRequest(command)) {
      return {
        kind: "ghostty",
        bundleId: GHOSTTY_BUNDLE_ID
      };
    }

    return {
      kind: "needs_clarification",
      reason: "No supported desktop control route matched this request."
    };
  }

  if (isConversationalPrompt(command)) {
    return createChatRoute();
  }

  if (isDesktopControlRequest(command)) {
    return {
      kind: "needs_clarification",
      reason: "No supported desktop control route matched this request."
    };
  }

  return createChatRoute();
}

function isExecutableCommandRoute(route: CommandRoute): route is ExecutableCommandRoute {
  return route.kind === "ghostty"
    || route.kind === "chrome"
    || route.kind === "finder"
    || route.kind === "tmux_supervision";
}

function createRouteConfirmationReason(route: ExecutableCommandRoute): string {
  switch (route.kind) {
    case "ghostty":
      return "Route policy requires confirmation before continuing with Ghostty.";
    case "chrome":
      return "Route policy requires confirmation before continuing with Chrome.";
    case "finder":
      return "Route policy requires confirmation before continuing with Finder.";
    case "tmux_supervision":
      return "Route policy requires confirmation before continuing with money-run supervision.";
  }
}

function createChatRoute(): CommandRoute {
  return {
    kind: "chat",
    reason: "Conversational prompt should be answered by the assistant instead of typed into Ghostty."
  };
}

function isShortGreetingPrompt(command: string): boolean {
  const normalized = normalizeConversationalPrompt(command);

  return /^(hello|hi|hey|yo|你好|哈喽|哈啰|嗨)(\s+(skfiy|assistant|bot))?$/.test(normalized);
}

function isConversationalPrompt(command: string): boolean {
  if (isDesktopControlRequest(command)) {
    return false;
  }

  const normalized = normalizeConversationalPrompt(command);

  const asksForDirectReply =
    /^(hello|hi|hey|yo|你好|哈喽|哈啰|嗨)(\s+(skfiy|assistant|bot))?[\s,，。.!！?？、:：].+/u
      .test(normalized)
    || /(?:请|帮我)?(?:回答|回复|解释|总结|介绍)(?:一下|下)?/u.test(normalized);

  return asksForDirectReply || [
    "你是谁",
    "你叫什么",
    "你能做什么",
    "介绍一下"
  ].some((phrase) => normalized.includes(phrase));
}

function normalizeConversationalPrompt(command: string): string {
  return command
    .trim()
    .toLowerCase()
    .replace(/^[\s,，。.!！?？、]+|[\s,，。.!！?？、]+$/g, "")
    .replace(/\s+/g, " ");
}

function isExplicitTerminalControlRequest(command: string): boolean {
  const normalized = command.trim().toLowerCase();

  return /\b(ghostty|terminal|shell|term)\b|终端|命令行/u.test(normalized);
}

function readMoneyRunSupervisionSessionName(command: string): string | undefined {
  const normalized = command.trim().toLowerCase();

  if (!normalized.includes("money-run")) {
    return undefined;
  }

  const mentionsTmuxContext = /\btmux\b|\bsession\b|会话/u.test(normalized);
  const asksForSupervision = [
    "监督",
    "观察",
    "监控",
    "看着",
    "盯着",
    "supervise",
    "monitor",
    "watch",
    "observe"
  ].some((phrase) => normalized.includes(phrase));

  if (!mentionsTmuxContext || !asksForSupervision) {
    return undefined;
  }

  return command.match(/\b[A-Za-z0-9_.-]*money-run[A-Za-z0-9_.-]*\b/iu)?.[0] ?? "money-run";
}

function isRouteLevelConfirmationRequest(command: string): boolean {
  const normalized = command.trim().toLowerCase();

  return /(?:先|等|待|需要).{0,12}(?:确认|批准|审批)|(?:确认|批准|审批).{0,12}(?:后|以后|再继续|再执行)|\b(?:wait for|ask for|after|before)\b.{0,24}\b(?:confirm|confirmation|approve|approval)\b/u
    .test(normalized);
}

function isRouteLevelDenialRequest(command: string): boolean {
  const normalized = command.trim().toLowerCase();

  return /(?:不要|别|取消|拒绝|停止|不用).{0,24}(?:执行|运行|输入|点击|打开|整理|监督|观察|查看|拖|滚动|控制|ghostty|chrome|chromium|finder|app|应用|桌面)|\b(?:do\s+not|don't|dont|cancel|deny|decline|stop)\b.{0,32}\b(?:type|click|open|run|execute|control|ghostty|chrome|chromium|finder|terminal|app|desktop)\b/u
    .test(normalized);
}

function isDesktopControlRequest(command: string): boolean {
  const normalized = command.trim().toLowerCase();

  const hasControlVerb =
    /\b(type|click|open|run|execute|control|observe|watch|read|inspect|capture|press|drag|scroll)\b|执行|运行|输入|点击|点|打开|整理|监督|观察|查看|拖|滚动|截图|按|创建/u
      .test(normalized);
  const namesControlTarget =
    /\b(ghostty|chrome|chromium|finder|terminal|shell|app|desktop|window|button|file|folder)\b|终端|命令行|桌面|应用|程序|窗口|按钮|文件夹|目录|文件|当前页面|当前文件夹|选中文件/u
      .test(normalized);

  return hasControlVerb && namesControlTarget;
}

function isRoutePolicyBlockedRequest(command: string, route: ExecutableCommandRoute): boolean {
  if (route.kind !== "ghostty") {
    return false;
  }

  const terminalIntent = parseTerminalIntent(command);
  const terminalCommand = terminalIntent.ok ? terminalIntent.command : command;

  return [
    /\brm\s+-[^\n;|&]*r/i,
    /\bsecurity\s+find-(generic|internet)-password\b/i,
    /(~\/)?\.(ssh|aws|gnupg)(\/|\b)/i,
    /\b(id_rsa|id_ed25519|\.pem|\.p12|\.key|\.npmrc|\.netrc)\b/i
  ].some((pattern) => pattern.test(terminalCommand));
}

function isUnsupportedVisibleAppControlRequest(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  const asksForDesktopControl = /输入|点击|点|观察|查看|读取|截图|按|拖|滚动|\b(type|click|observe|watch|read|inspect|capture|press|drag|scroll)\b/u
    .test(normalized);

  if (!asksForDesktopControl) {
    return false;
  }

  const namesSupportedApp = /\b(ghostty|chrome|chromium|finder)\b/u.test(normalized);
  const namesUnsupportedApp = !namesSupportedApp
    && /(?:用|在)\s+[a-z][a-z0-9 ._-]*\s*(?:输入|点击|点|观察|查看|读取|截图|按|拖|滚动)/u
      .test(normalized);
  const namesGenericVisibleTarget =
    /\b(any|current|frontmost)\s+visible\s+(app|application|window|button)\b|\b(current|frontmost)\s+(app|application|window|button)\b|\bvisible\s+(app|application)\b|当前屏幕可见|屏幕可见|当前可见\s*(app|应用|程序|窗口|按钮)?|可见\s*(app|应用|程序|窗口|按钮)|当前\s*(app|应用|程序|窗口|按钮)|前台\s*(app|应用|程序|窗口|按钮)|任意.*(app|应用|程序)/u
      .test(normalized);

  return namesUnsupportedApp || namesGenericVisibleTarget;
}
