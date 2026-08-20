#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createBuildInfo } from "./generate-build-info.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const APP_BUNDLE_NAME = "skfiy.app";
const BUNDLE_IDENTIFIER = "com.sskift.skfiy";
const APPLE_EVENTS_USAGE_DESCRIPTION = "skfiy needs permission to control Finder when you approve Computer Use file organization tasks.";
export const ELECTRON_APP_COPY_OPTIONS = {
  recursive: true,
  verbatimSymlinks: true
};

export function createPackagePlan({
  rootDir,
  electronAppPath = path.join(rootDir, "node_modules/electron/dist/Electron.app")
}) {
  const appBundlePath = path.join(rootDir, "dist", APP_BUNDLE_NAME);
  const frameworksPath = path.join(appBundlePath, "Contents", "Frameworks");
  const resourcesPath = path.join(appBundlePath, "Contents", "Resources");

  return {
    appBundlePath,
    adhocSignCommand: createAdhocCodeSignCommand(appBundlePath),
    verifyCodeSignCommand: createVerifyCodeSignCommand(appBundlePath),
    bundleIdentifier: BUNDLE_IDENTIFIER,
    electronAppPath,
    nestedCodePaths: createNestedCodePaths(appBundlePath),
    infoPlistPath: path.join(appBundlePath, "Contents", "Info.plist"),
    frameworksPath,
    resourcesPath,
    bundledAppPath: path.join(resourcesPath, "app"),
    bundledExecutablePath: path.join(appBundlePath, "Contents", "MacOS", "skfiy"),
    bundledHelperPath: path.join(appBundlePath, "Contents", "MacOS", "skfiy-helper"),
    appPackageJsonPath: path.join(resourcesPath, "app", "package.json"),
    buildInfoPath: path.join(resourcesPath, "build-info.json"),
    sourceHelperPath: path.join(rootDir, "dist", "skfiy-helper"),
    sourceMainPath: path.join(rootDir, "dist", "main"),
    sourceRendererPath: path.join(rootDir, "dist", "renderer"),
    sourceSharedPath: path.join(rootDir, "dist", "shared")
  };
}

export async function packageMacosApp({
  rootDir = DEFAULT_ROOT_DIR,
  electronAppPath,
  io
} = {}) {
  const resolvedIo = resolvePackageIo(io);
  const plan = createPackagePlan({ rootDir, electronAppPath });

  assertPathExists(plan.electronAppPath, "Electron.app");
  assertPathExists(plan.sourceMainPath, "compiled main process");
  assertPathExists(plan.sourceRendererPath, "compiled renderer");
  assertPathExists(plan.sourceSharedPath, "compiled shared modules");
  assertPathExists(plan.sourceHelperPath, "compiled skfiy helper");

  await fs.rm(plan.appBundlePath, { force: true, recursive: true });
  await fs.cp(plan.electronAppPath, plan.appBundlePath, ELECTRON_APP_COPY_OPTIONS);
  const electronExecutablePath = path.join(plan.appBundlePath, "Contents", "MacOS", "Electron");
  await fs.rename(electronExecutablePath, plan.bundledExecutablePath);
  await rewriteInfoPlist(plan.infoPlistPath);
  await fs.rm(plan.bundledAppPath, { force: true, recursive: true });
  await fs.mkdir(path.join(plan.bundledAppPath, "dist"), { recursive: true });
  await fs.cp(plan.sourceMainPath, path.join(plan.bundledAppPath, "dist", "main"), {
    recursive: true
  });
  await fs.cp(plan.sourceRendererPath, path.join(plan.bundledAppPath, "dist", "renderer"), {
    recursive: true
  });
  await fs.cp(plan.sourceSharedPath, path.join(plan.bundledAppPath, "dist", "shared"), {
    recursive: true
  });
  await fs.writeFile(
    plan.appPackageJsonPath,
    `${JSON.stringify(createRuntimePackageJson(rootDir), null, 2)}\n`
  );
  await fs.copyFile(plan.sourceHelperPath, plan.bundledHelperPath);
  await fs.chmod(plan.bundledHelperPath, 0o755);
  // Embed build provenance BEFORE signing so the signature covers it. The
  // commit is captured from this live checkout; a pre-existing app cannot be
  // relabeled without rebuilding. Degrades gracefully without git.
  const buildInfo = await createBuildInfo({ rootDir });
  await fs.writeFile(plan.buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  await clearMacosExtendedAttributes(plan.appBundlePath, resolvedIo);
  await signNestedCode(plan.nestedCodePaths, resolvedIo);
  await resolvedIo.execFile(plan.adhocSignCommand.command, plan.adhocSignCommand.args);
  await resolvedIo.execFile(plan.verifyCodeSignCommand.command, plan.verifyCodeSignCommand.args);

  return plan;
}

/**
 * Normalizes the injectable io. Tests pass a fake execFile so packaging runs
 * without codesign, xattr, or a Mac.
 */
export function resolvePackageIo(io) {
  return {
    execFile: io?.execFile ?? execFileAsync
  };
}

export function createAdhocCodeSignCommand(appPath) {
  return {
    command: "codesign",
    args: [
      "--force",
      "--sign",
      "-",
      "--requirements",
      `=designated => identifier "${BUNDLE_IDENTIFIER}"`,
      appPath
    ]
  };
}

export function createVerifyCodeSignCommand(appPath) {
  return {
    command: "codesign",
    args: [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=4",
      appPath
    ]
  };
}

function createNestedCodePaths(appBundlePath) {
  const frameworksPath = path.join(appBundlePath, "Contents", "Frameworks");
  const electronFrameworkPath = path.join(frameworksPath, "Electron Framework.framework");

  return [
    path.join(electronFrameworkPath, "Versions", "A", "Libraries", "libEGL.dylib"),
    path.join(electronFrameworkPath, "Versions", "A", "Libraries", "libvk_swiftshader.dylib"),
    path.join(electronFrameworkPath, "Versions", "A", "Libraries", "libGLESv2.dylib"),
    path.join(electronFrameworkPath, "Versions", "A", "Libraries", "libffmpeg.dylib"),
    path.join(electronFrameworkPath, "Versions", "A", "Helpers", "chrome_crashpad_handler"),
    electronFrameworkPath,
    path.join(frameworksPath, "ReactiveObjC.framework"),
    path.join(frameworksPath, "Squirrel.framework"),
    path.join(frameworksPath, "Mantle.framework"),
    path.join(frameworksPath, "Electron Helper (Plugin).app"),
    path.join(frameworksPath, "Electron Helper (GPU).app"),
    path.join(frameworksPath, "Electron Helper (Renderer).app"),
    path.join(frameworksPath, "Electron Helper.app"),
    path.join(appBundlePath, "Contents", "MacOS", "skfiy-helper")
  ];
}

async function signNestedCode(nestedCodePaths, io) {
  for (const nestedCodePath of nestedCodePaths) {
    await io.execFile("codesign", [
      "--force",
      "--sign",
      "-",
      nestedCodePath
    ]);
  }
}

function createRuntimePackageJson(rootDir) {
  const packageJson = JSON.parse(
    existsSync(path.join(rootDir, "package.json"))
      ? readTextSync(path.join(rootDir, "package.json"))
      : "{}"
  );

  return {
    name: "skfiy",
    version: typeof packageJson.version === "string" ? packageJson.version : "0.0.0",
    private: true,
    type: "module",
    main: "dist/main/main.js"
  };
}

async function rewriteInfoPlist(infoPlistPath) {
  const current = await fs.readFile(infoPlistPath, "utf8");
  const withoutObsoleteAudioPermissions = removeInfoPlistString(
    removeInfoPlistString(current, "NSMicrophoneUsageDescription"),
    "NSSpeechRecognitionUsageDescription"
  );
  const withExecutable = setInfoPlistString(withoutObsoleteAudioPermissions, "CFBundleExecutable", "skfiy");
  const withAppleEventsUsage = setInfoPlistString(
    withExecutable,
    "NSAppleEventsUsageDescription",
    APPLE_EVENTS_USAGE_DESCRIPTION
  );
  const next = setInfoPlistString(
    setInfoPlistString(
      setInfoPlistString(withAppleEventsUsage, "CFBundleIdentifier", BUNDLE_IDENTIFIER),
      "CFBundleName",
      "skfiy"
    ),
    "CFBundleDisplayName",
    "skfiy"
  );

  await fs.writeFile(infoPlistPath, next);
}

export function setInfoPlistString(plist, key, value) {
  const escapedKey = escapeRegExp(key);
  const pattern = new RegExp(`(<key>${escapedKey}</key>\\s*<string>)[^<]*(</string>)`);

  if (pattern.test(plist)) {
    return plist.replace(pattern, `$1${escapeXml(value)}$2`);
  }

  return plist.replace(
    /<\/dict>\s*<\/plist>\s*$/,
    `\t<key>${key}</key>\n\t<string>${escapeXml(value)}</string>\n</dict>\n</plist>\n`
  );
}

export function removeInfoPlistString(plist, key) {
  const escapedKey = escapeRegExp(key);
  const pattern = new RegExp(`\\s*<key>${escapedKey}</key>\\s*<string>[^<]*</string>`, "g");
  return plist.replace(pattern, "");
}

function assertPathExists(targetPath, label) {
  if (!existsSync(targetPath)) {
    throw new Error(`${label} is missing at ${targetPath}. Run npm run build first.`);
  }
}

export function createNativeMessagingSafeCliShim(source, nodePath = process.execPath) {
  const checkedNodePath = String(nodePath || "").trim();
  if (!path.isAbsolute(checkedNodePath)) {
    throw new Error("Packaged skfiy CLI shim requires an absolute Node.js path.");
  }

  return source.replace(/^#![^\n]*(\n|$)/, `#!${checkedNodePath}\n`);
}

async function clearMacosExtendedAttributes(targetPath, io) {
  try {
    await io.execFile("xattr", ["-cr", targetPath]);
  } catch {
    // xattr is macOS-specific cleanup. Packaging can continue on filesystems
    // where extended attributes are unavailable.
  }
}

function readTextSync(targetPath) {
  return Buffer.from(readFileSync(targetPath)).toString("utf8");
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const plan = await packageMacosApp();
    console.log(`Packaged app: ${plan.appBundlePath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
