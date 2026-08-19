import { existsSync } from "node:fs";
import path from "node:path";

interface HelperPathOptions {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  exists?: (candidate: string) => boolean;
}

export function resolveHelperPath({
  env,
  appPath,
  isPackaged,
  resourcesPath,
  exists = existsSync
}: HelperPathOptions): string {
  if (env.SKFIY_HELPER_PATH) {
    return env.SKFIY_HELPER_PATH;
  }

  const bundledHelperPath = path.join(resourcesPath, "..", "MacOS", "skfiy-helper");
  if (isPackaged || exists(bundledHelperPath)) {
    return bundledHelperPath;
  }

  return path.join(appPath, "dist", "skfiy-helper");
}
