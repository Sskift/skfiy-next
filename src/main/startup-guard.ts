import { existsSync } from "node:fs";
import path from "node:path";

export interface StartupWarning {
  id: "tmux-launch" | "dev-server" | "unbundled-electron";
  title: string;
  message: string;
}

interface StartupWarningOptions {
  appPath: string;
  devServerUrl?: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  isPackaged: boolean;
  resourcesPath: string;
  exists?: (candidate: string) => boolean;
}

export function readStartupWarnings({
  appPath,
  devServerUrl,
  env,
  isPackaged,
  resourcesPath,
  exists = existsSync
}: StartupWarningOptions): StartupWarning[] {
  const warnings: StartupWarning[] = [];
  const hasBundledHelper = exists(path.join(resourcesPath, "..", "MacOS", "skfiy-helper"));

  if (env.TMUX || env.TMUX_PANE) {
    warnings.push({
      id: "tmux-launch",
      title: "tmux 启动会影响权限归属",
      message: "用户可见测试请通过 open -na dist/skfiy.app 启动，避免 macOS 把权限记到终端或 tmux。"
    });
  }

  if (devServerUrl) {
    warnings.push({
      id: "dev-server",
      title: "正在使用开发入口",
      message: "Vite/Electron 调试入口只适合工程调试，用户验收需要使用打包后的 skfiy.app。"
    });
  }

  if (!isPackaged && !hasBundledHelper) {
    warnings.push({
      id: "unbundled-electron",
      title: "未使用打包 app bundle",
      message: `当前入口来自 ${appPath}，权限、截图和点击验收需要切到 dist/skfiy.app。`
    });
  }

  return warnings;
}
