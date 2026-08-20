/**
 * macOS release plan — Developer ID signing and Apple notarization.
 *
 * Restored from the old repo's sign-notarize-macos-plan.mjs and adapted to
 * skfiy-next: the working directory is .skfiy-release/ (gitignored) instead
 * of .skfiy-alpha/. Pure planning functions only; the CLI wrapper lives in
 * sign-notarize-macos.mjs and is dry-run by default.
 */
import path from "node:path";

const BUNDLE_IDENTIFIER = "com.sskift.skfiy";
const DEFAULT_NOTARY_ZIP_NAME = "skfiy-macos-notarization.zip";

export function createMacReleasePlan({
  rootDir,
  appPath = path.join(rootDir, "dist", "skfiy.app"),
  outputDir = path.join(rootDir, ".skfiy-release"),
  zipPath = path.join(outputDir, DEFAULT_NOTARY_ZIP_NAME),
  entitlementsPath = path.join(rootDir, "release", "skfiy.entitlements.plist")
}) {
  return {
    appPath,
    outputDir,
    zipPath,
    entitlementsPath,
    bundleIdentifier: BUNDLE_IDENTIFIER
  };
}

export function createDefaultMacReleaseOptions({ rootDir, env }) {
  return {
    plan: createMacReleasePlan({ rootDir }),
    signingIdentity: normalizeOptional(env.SKFIY_DEVELOPER_ID_APPLICATION),
    appleId: normalizeOptional(env.APPLE_ID),
    appleTeamId: normalizeOptional(env.APPLE_TEAM_ID),
    applePassword: normalizeOptional(env.APPLE_APP_SPECIFIC_PASSWORD),
    keychainProfile: normalizeOptional(env.APPLE_KEYCHAIN_PROFILE),
    dryRun: true,
    sign: false,
    notarize: false,
    jsonOutputPath: undefined
  };
}

export function parseMacReleaseArgs(argv, defaults) {
  const options = {
    ...defaults,
    plan: { ...defaults.plan }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--app":
        options.plan.appPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--output-dir":
        options.plan.outputDir = path.resolve(readValue(argv, index, arg));
        options.plan.zipPath = path.join(options.plan.outputDir, DEFAULT_NOTARY_ZIP_NAME);
        index += 1;
        break;
      case "--zip":
        options.plan.zipPath = path.resolve(readValue(argv, index, arg));
        options.plan.outputDir = path.dirname(options.plan.zipPath);
        index += 1;
        break;
      case "--json-output":
        options.jsonOutputPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--identity":
        options.signingIdentity = readValue(argv, index, arg);
        index += 1;
        break;
      case "--apple-id":
        options.appleId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--team-id":
        options.appleTeamId = readValue(argv, index, arg);
        index += 1;
        break;
      case "--password":
        options.applePassword = readValue(argv, index, arg);
        index += 1;
        break;
      case "--keychain-profile":
        options.keychainProfile = readValue(argv, index, arg);
        index += 1;
        break;
      case "--sign":
        options.sign = true;
        break;
      case "--notarize":
        options.notarize = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--execute":
        options.dryRun = false;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.notarize) {
    options.sign = true;
  }

  return options;
}

export function createCodeSignCommand({ appPath, identity, entitlementsPath }) {
  return {
    command: "codesign",
    args: [
      "--force",
      "--deep",
      "--options",
      "runtime",
      "--timestamp",
      ...(entitlementsPath ? ["--entitlements", entitlementsPath] : []),
      "--sign",
      identity,
      appPath
    ]
  };
}

export function createZipCommand({ appPath, zipPath }) {
  return {
    command: "ditto",
    args: ["-c", "-k", "--keepParent", appPath, zipPath]
  };
}

export function createSignatureVerificationCommands({ appPath }) {
  return [
    {
      command: "codesign",
      args: ["--verify", "--deep", "--strict", "--verbose=2", appPath]
    },
    {
      command: "spctl",
      args: ["--assess", "--type", "execute", "--verbose", appPath]
    }
  ];
}

export function createNotarySubmitCommand({
  zipPath,
  appleId,
  appleTeamId,
  applePassword,
  keychainProfile
}) {
  if (keychainProfile) {
    return {
      command: "xcrun",
      args: ["notarytool", "submit", zipPath, "--wait", "--keychain-profile", keychainProfile]
    };
  }

  return {
    command: "xcrun",
    args: [
      "notarytool",
      "submit",
      zipPath,
      "--wait",
      "--apple-id",
      appleId,
      "--team-id",
      appleTeamId,
      "--password",
      applePassword
    ]
  };
}

export function createStapleCommand({ appPath }) {
  return {
    command: "xcrun",
    args: ["stapler", "staple", appPath]
  };
}

export function createMacReleaseReadinessReport({
  signingIdentity,
  appleId,
  appleTeamId,
  applePassword,
  keychainProfile
}) {
  const signingMissing = signingIdentity ? [] : ["SKFIY_DEVELOPER_ID_APPLICATION"];
  const notarizationMissing = [];

  if (!keychainProfile) {
    if (!appleId) {
      notarizationMissing.push("APPLE_ID");
    }
    if (!appleTeamId) {
      notarizationMissing.push("APPLE_TEAM_ID");
    }
    if (!applePassword) {
      notarizationMissing.push("APPLE_APP_SPECIFIC_PASSWORD or APPLE_KEYCHAIN_PROFILE");
    }
  }

  const missing = [...signingMissing, ...notarizationMissing];

  return {
    ready: missing.length === 0,
    missing,
    signing: {
      ready: signingMissing.length === 0,
      missing: signingMissing
    },
    notarization: {
      ready: notarizationMissing.length === 0,
      missing: notarizationMissing
    }
  };
}

export function createMacReleaseSteps(options) {
  const steps = [];

  if (options.sign) {
    steps.push({
      name: "codesign-app",
      command: createCodeSignCommand({
        appPath: options.plan.appPath,
        identity: options.signingIdentity ?? "<SKFIY_DEVELOPER_ID_APPLICATION>",
        entitlementsPath: options.plan.entitlementsPath
      })
    });
    for (const command of createSignatureVerificationCommands({ appPath: options.plan.appPath })) {
      steps.push({ name: `verify-${command.command}`, command });
    }
  }

  if (options.notarize) {
    steps.push({
      name: "zip-for-notary",
      command: createZipCommand({
        appPath: options.plan.appPath,
        zipPath: options.plan.zipPath
      })
    });
    steps.push({
      name: "submit-notary",
      command: createNotarySubmitCommand({
        zipPath: options.plan.zipPath,
        appleId: options.appleId ?? "<APPLE_ID>",
        appleTeamId: options.appleTeamId ?? "<APPLE_TEAM_ID>",
        applePassword: options.applePassword ?? "<APPLE_APP_SPECIFIC_PASSWORD>",
        keychainProfile: options.keychainProfile
      })
    });
    steps.push({
      name: "staple-ticket",
      command: createStapleCommand({ appPath: options.plan.appPath })
    });
  }

  return steps;
}

export function createHelpText(defaults) {
  return `Usage: npm run release:mac:check -- [options]

Checks or executes Developer ID signing and Apple notarization for the packaged skfiy.app.

Environment:
  SKFIY_DEVELOPER_ID_APPLICATION  Developer ID Application signing identity.
  APPLE_KEYCHAIN_PROFILE          notarytool keychain profile.
  APPLE_ID                        Apple ID email when no keychain profile is used.
  APPLE_TEAM_ID                   Apple developer team ID when no keychain profile is used.
  APPLE_APP_SPECIFIC_PASSWORD     App-specific password when no keychain profile is used.

Options:
  --sign                          Include Developer ID signing.
  --notarize                      Include notary zip, submit, and stapling.
  --execute                       Run commands. Without this, the script is read-only.
  --dry-run                       Print readiness and planned commands only.
  --app <path>                    App bundle path. Default: ${defaults.plan.appPath}
  --zip <path>                    Notarization zip path. Default: ${defaults.plan.zipPath}
  --output-dir <path>             Output directory for default notary zip.
  --json-output <path>            Write the readiness report as machine-readable JSON.
  --identity <name>               Override SKFIY_DEVELOPER_ID_APPLICATION.
  --keychain-profile <name>       Override APPLE_KEYCHAIN_PROFILE.
  --apple-id <email>              Override APPLE_ID.
  --team-id <id>                  Override APPLE_TEAM_ID.
  --password <password>           Override APPLE_APP_SPECIFIC_PASSWORD.
  -h, --help                      Show this help.
`;
}

function readValue(argv, index, arg) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function normalizeOptional(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
