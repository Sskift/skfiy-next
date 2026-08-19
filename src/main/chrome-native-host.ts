import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { normalizeChromeBrowserMessage } from "./chrome-browser-action-schema.js";
import {
  readChromeHostPolicyState,
  type ChromeHostPolicyIo
} from "./chrome-host-policy.js";
import { readRecord } from "./record-utils.js";

export const CHROME_NATIVE_HOST_NAME = "com.sskift.skfiy";
export const CHROME_NATIVE_MESSAGE_SCHEMA_VERSION = 1;
export const CHROME_NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024;
export const CHROME_NATIVE_RESPONSE_TYPE = "skfiy.native.response";
export const CHROME_EXTENSION_CONNECTION_TTL_SECONDS = 300;

const CHROME_NATIVE_BRIDGE_MESSAGE_TYPES = new Set([
  "skfiy.page.observe",
  "skfiy.page.action",
  "skfiy.page.screenshot",
  "skfiy.tabs.discover",
  "skfiy.downloads.status",
  "skfiy.host_policy.request",
  "skfiy.host_policy.response"
]);

export interface ChromeNativeHostManifestInput {
  cliShimPath: string;
  extensionIds: string[];
}

export interface ChromeNativeHostManifest {
  name: typeof CHROME_NATIVE_HOST_NAME;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

export interface ChromeNativeHostInstallPlanInput extends ChromeNativeHostManifestInput {
  homeDir: string;
}

export interface ChromeNativeHostInstallPlan {
  hostName: typeof CHROME_NATIVE_HOST_NAME;
  manifestPath: string;
  manifest: ChromeNativeHostManifest;
}

export interface ChromeNativeHostIo {
  exists: (targetPath: string) => boolean | Promise<boolean>;
  mkdir: (targetPath: string) => Promise<void>;
  readFile: (targetPath: string) => Promise<string>;
  writeFile: (targetPath: string, content: string) => Promise<void>;
  rename?: (sourcePath: string, targetPath: string) => Promise<void>;
  rm: (targetPath: string) => Promise<void>;
}

export interface ChromeNativeHostCommandInput extends ChromeNativeHostInstallPlanInput {
  io?: ChromeNativeHostIo;
}

export interface ChromeNativeHostMutationResult {
  result: "installed" | "uninstalled";
  hostName: typeof CHROME_NATIVE_HOST_NAME;
  manifestPath: string;
  cliShimPath?: string;
  allowedOrigins?: string[];
}

export interface ChromeNativeHostStatus {
  state: "installed" | "missing" | "mismatched" | "cli-missing" | "invalid";
  hostName: typeof CHROME_NATIVE_HOST_NAME;
  manifestPath: string;
  cliShimPath: string;
  extensionIds: string[];
  expectedAllowedOrigins: string[];
  allowedOrigins: string[];
  installedCliShimPath?: string;
  installedAllowedOrigins?: string[];
  manifestDiagnostics: ChromeNativeHostManifestDiagnostics;
  reason: string;
}

export interface ChromeNativeHostManifestDiagnostics {
  cliShimExists: boolean;
  manifestExists: boolean;
  manifestValidJson: boolean;
  manifestMatches: boolean;
  expectedPath: string;
  expectedAllowedOrigins: string[];
  extensionIds: string[];
  installedPath?: string;
  installedAllowedOrigins?: string[];
  missingAllowedOrigins: string[];
  extraAllowedOrigins: string[];
  missingExtensionIds: string[];
  mismatchedFields: string[];
}

export interface ChromeNativeBridgeMessage {
  schemaVersion: typeof CHROME_NATIVE_MESSAGE_SCHEMA_VERSION;
  type: string;
  requestId: string;
  payload?: unknown;
}

export interface ChromeNativeBridgePolicy {
  state: "allowed" | "blocked";
  reason?: string;
  details?: Record<string, unknown>;
}

export type ChromeNativeBridgeDispatch = (
  message: ChromeNativeBridgeMessage
) => Promise<Record<string, unknown>>;

export interface ChromeNativeBridgeDispatchInput {
  homeDir: string;
  launchOrigin?: string;
  io?: ChromeHostPolicyIo;
}

export interface ChromeNativeBridgeInput {
  payloadByteLength: number;
  policy: ChromeNativeBridgePolicy;
  dispatch: ChromeNativeBridgeDispatch;
}

export interface ChromeNativeBridgeResponse {
  schemaVersion: typeof CHROME_NATIVE_MESSAGE_SCHEMA_VERSION;
  type: typeof CHROME_NATIVE_RESPONSE_TYPE;
  requestId: string;
  result: "accepted" | "blocked" | "invalid" | "error";
  reason?: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ChromeExtensionConnectionHeartbeatInput {
  observedAt?: string;
  launchOrigin?: string;
  messageType: string;
  requestId: string;
  result?: ChromeNativeBridgeResponse["result"];
  pageControl?: Record<string, unknown>;
  pageObservation?: Record<string, unknown>;
  pageActionResult?: Record<string, unknown>;
  pageScreenshot?: Record<string, unknown>;
  pageTabs?: Record<string, unknown>;
}

export interface ChromeExtensionCommandEvidence {
  observedAt?: string;
  launchOrigin?: string;
  messageType?: string;
  requestId?: string;
  pageObservation?: Record<string, unknown>;
  pageActionResult?: Record<string, unknown>;
  pageScreenshot?: Record<string, unknown>;
  pageTabs?: Record<string, unknown>;
}

export interface ChromeExtensionConnectionStatus {
  state: "connected" | "stale" | "unknown" | "invalid";
  liveConnection: "connected" | "stale" | "unknown";
  path: string;
  reason?: string;
  ageSeconds?: number;
  observedAt?: string;
  launchOrigin?: string;
  messageType?: string;
  requestId?: string;
  pageControl?: Record<string, unknown>;
  pageObservation?: Record<string, unknown>;
  pageActionResult?: Record<string, unknown>;
  pageScreenshot?: Record<string, unknown>;
  pageTabs?: Record<string, unknown>;
  latestCommand?: ChromeExtensionCommandEvidence;
}

export interface ChromeNativeMessagingHostIo {
  stdin: AsyncIterable<Buffer | Uint8Array | string>;
  stdout: {
    write: (chunk: Buffer) => unknown;
  };
  stderr: {
    write: (chunk: string) => unknown;
  };
  policy: ChromeNativeBridgePolicy | (() => ChromeNativeBridgePolicy | Promise<ChromeNativeBridgePolicy>);
  dispatch: ChromeNativeBridgeDispatch;
  connectionHeartbeat?: (input: Required<Pick<
    ChromeExtensionConnectionHeartbeatInput,
    "observedAt" | "messageType" | "requestId"
  >> & {
    result: ChromeNativeBridgeResponse["result"];
    pageControl?: Record<string, unknown>;
    pageObservation?: Record<string, unknown>;
    pageActionResult?: Record<string, unknown>;
    pageScreenshot?: Record<string, unknown>;
    pageTabs?: Record<string, unknown>;
  }) => Promise<void>;
}

export function createChromeNativeHostManifest({
  cliShimPath,
  extensionIds
}: ChromeNativeHostManifestInput): ChromeNativeHostManifest {
  if (!path.isAbsolute(cliShimPath)) {
    throw new Error("Chrome native messaging host path must be absolute.");
  }

  return {
    name: CHROME_NATIVE_HOST_NAME,
    description: "skfiy desktop Computer Use bridge",
    path: cliShimPath,
    type: "stdio",
    allowed_origins: extensionIds.map((extensionId) => `chrome-extension://${extensionId}/`)
  };
}

export function createChromeNativeHostInstallPlan({
  homeDir,
  cliShimPath,
  extensionIds
}: ChromeNativeHostInstallPlanInput): ChromeNativeHostInstallPlan {
  return {
    hostName: CHROME_NATIVE_HOST_NAME,
    manifestPath: path.join(
      homeDir,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
      `${CHROME_NATIVE_HOST_NAME}.json`
    ),
    manifest: createChromeNativeHostManifest({
      cliShimPath,
      extensionIds
    })
  };
}

export async function installChromeNativeHost({
  homeDir,
  cliShimPath,
  extensionIds,
  io = createDefaultChromeNativeHostIo()
}: ChromeNativeHostCommandInput): Promise<ChromeNativeHostMutationResult> {
  const plan = createChromeNativeHostInstallPlan({
    homeDir,
    cliShimPath,
    extensionIds
  });

  if (!(await io.exists(cliShimPath))) {
    throw new Error(`skfiy CLI shim is missing at ${cliShimPath}. Run npm run build first.`);
  }

  await io.mkdir(path.dirname(plan.manifestPath));
  await io.writeFile(plan.manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`);

  return {
    result: "installed",
    hostName: plan.hostName,
    manifestPath: plan.manifestPath,
    cliShimPath,
    allowedOrigins: plan.manifest.allowed_origins
  };
}

export async function uninstallChromeNativeHost({
  homeDir,
  cliShimPath,
  extensionIds,
  io = createDefaultChromeNativeHostIo()
}: ChromeNativeHostCommandInput): Promise<ChromeNativeHostMutationResult> {
  const plan = createChromeNativeHostInstallPlan({
    homeDir,
    cliShimPath,
    extensionIds
  });

  await io.rm(plan.manifestPath);

  return {
    result: "uninstalled",
    hostName: plan.hostName,
    manifestPath: plan.manifestPath
  };
}

export async function readChromeNativeHostStatus({
  homeDir,
  cliShimPath,
  extensionIds,
  io = createDefaultChromeNativeHostIo()
}: ChromeNativeHostCommandInput): Promise<ChromeNativeHostStatus> {
  const plan = createChromeNativeHostInstallPlan({
    homeDir,
    cliShimPath,
    extensionIds
  });

  if (!(await io.exists(cliShimPath))) {
    return createStatus(plan, "cli-missing", `skfiy CLI shim is missing at ${cliShimPath}.`, {
      cliShimExists: false,
      manifestExists: false
    });
  }

  if (!(await io.exists(plan.manifestPath))) {
    return createStatus(plan, "missing", "Chrome Native Messaging host manifest is not installed.", {
      cliShimExists: true,
      manifestExists: false
    });
  }

  let installedManifest: ChromeNativeHostManifest;
  try {
    installedManifest = JSON.parse(await io.readFile(plan.manifestPath)) as ChromeNativeHostManifest;
  } catch {
    return createStatus(plan, "invalid", "Chrome Native Messaging host manifest is not valid JSON.", {
      cliShimExists: true,
      manifestExists: true,
      manifestValidJson: false
    });
  }

  const diagnostics = createManifestDiagnostics(plan, {
    cliShimExists: true,
    manifestExists: true,
    manifestValidJson: true,
    installedManifest
  });

  if (!diagnostics.manifestMatches) {
    return createStatus(
      plan,
      "mismatched",
      "Chrome Native Messaging host manifest does not match the current skfiy CLI.",
      {
        cliShimExists: true,
        manifestExists: true,
        manifestValidJson: true,
        installedManifest,
        diagnostics
      }
    );
  }

  return createStatus(plan, "installed", "Chrome Native Messaging host is installed.", {
    cliShimExists: true,
    manifestExists: true,
    manifestValidJson: true,
    installedManifest,
    diagnostics
  });
}

export function createChromeExtensionConnectionStatePath(homeDir: string): string {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "skfiy",
    "chrome-extension-connection.json"
  );
}

export async function writeChromeExtensionConnectionHeartbeat({
  homeDir,
  observedAt = new Date().toISOString(),
  launchOrigin,
  messageType,
  requestId,
  pageControl,
  pageObservation,
  pageActionResult,
  pageScreenshot,
  pageTabs,
  io = createDefaultChromeNativeHostIo()
}: ChromeExtensionConnectionHeartbeatInput & {
  homeDir: string;
  io?: ChromeNativeHostIo;
}): Promise<Record<string, unknown>> {
  const statePath = createChromeExtensionConnectionStatePath(homeDir);
  const boundedPageActionResult = summarizePageActionResultForHeartbeat(pageActionResult);
  const boundedPageScreenshot = summarizePageScreenshotForHeartbeat(pageScreenshot);
  const boundedPageTabs = summarizePageTabsForHeartbeat(pageTabs);
  const latestCommand = await createLatestCommandEvidence({
    io,
    statePath,
    observedAt,
    launchOrigin,
    messageType,
    requestId,
    pageObservation,
    pageActionResult: boundedPageActionResult,
    pageScreenshot: boundedPageScreenshot,
    pageTabs: boundedPageTabs
  });
  const heartbeat = {
    schemaVersion: 1,
    hostName: CHROME_NATIVE_HOST_NAME,
    observedAt,
    ...(launchOrigin ? { launchOrigin } : {}),
    messageType,
    requestId,
    ...(pageControl ? { pageControl } : {}),
    ...(pageObservation ? { pageObservation } : {}),
    ...(boundedPageActionResult ? { pageActionResult: boundedPageActionResult } : {}),
    ...(boundedPageScreenshot ? { pageScreenshot: boundedPageScreenshot } : {}),
    ...(boundedPageTabs ? { pageTabs: boundedPageTabs } : {}),
    ...(latestCommand ? { latestCommand } : {})
  };

  await io.mkdir(path.dirname(statePath));
  await writeChromeExtensionConnectionHeartbeatFile(
    io,
    statePath,
    `${JSON.stringify(heartbeat, null, 2)}\n`
  );

  return heartbeat;
}

async function createLatestCommandEvidence({
  io,
  statePath,
  observedAt,
  launchOrigin,
  messageType,
  requestId,
  pageObservation,
  pageActionResult,
  pageScreenshot,
  pageTabs
}: {
  io: ChromeNativeHostIo;
  statePath: string;
  observedAt: string;
  launchOrigin?: string;
  messageType: string;
  requestId: string;
  pageObservation?: Record<string, unknown>;
  pageActionResult?: Record<string, unknown>;
  pageScreenshot?: Record<string, unknown>;
  pageTabs?: Record<string, unknown>;
}): Promise<ChromeExtensionCommandEvidence | undefined> {
  if (pageObservation || pageActionResult || pageScreenshot || pageTabs) {
    return {
      observedAt,
      ...(launchOrigin ? { launchOrigin } : {}),
      messageType,
      requestId,
      ...(pageObservation ? { pageObservation } : {}),
      ...(pageActionResult ? { pageActionResult } : {}),
      ...(pageScreenshot ? { pageScreenshot } : {}),
      ...(pageTabs ? { pageTabs } : {})
    };
  }

  try {
    if (!(await io.exists(statePath))) {
      return undefined;
    }
    const existing = readRecord(JSON.parse(await io.readFile(statePath)) as unknown);
    return summarizeLatestCommandEvidence(existing?.latestCommand);
  } catch {
    return undefined;
  }
}

async function writeChromeExtensionConnectionHeartbeatFile(
  io: ChromeNativeHostIo,
  statePath: string,
  content: string
): Promise<void> {
  if (io.rename) {
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await io.writeFile(tempPath, content);
    await io.rename(tempPath, statePath);
    return;
  }

  await io.writeFile(statePath, content);
}

export async function readChromeExtensionConnectionStatus({
  homeDir,
  generatedAt = new Date().toISOString(),
  io = createDefaultChromeNativeHostIo()
}: {
  homeDir: string;
  generatedAt?: string;
  io?: ChromeNativeHostIo;
}): Promise<ChromeExtensionConnectionStatus> {
  const statePath = createChromeExtensionConnectionStatePath(homeDir);

  if (!(await io.exists(statePath))) {
    return {
      state: "unknown",
      liveConnection: "unknown",
      path: statePath,
      reason: "No Chrome extension connection heartbeat has been recorded."
    };
  }

  let heartbeat: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await io.readFile(statePath)) as unknown;
    const record = readRecord(parsed);
    if (!record) {
      return {
        state: "invalid",
        liveConnection: "unknown",
        path: statePath,
        reason: "Chrome extension connection heartbeat is not an object."
      };
    }
    heartbeat = record;
  } catch {
    return {
      state: "invalid",
      liveConnection: "unknown",
      path: statePath,
      reason: "Chrome extension connection heartbeat is not valid JSON."
    };
  }

  const observedAt = typeof heartbeat.observedAt === "string" ? heartbeat.observedAt : undefined;
  const observedAtMs = observedAt ? Date.parse(observedAt) : NaN;
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(generatedAtMs)) {
    return {
      state: "invalid",
      liveConnection: "unknown",
      path: statePath,
      reason: "Chrome extension connection heartbeat has invalid timestamps."
    };
  }

  const ageSeconds = Math.max(0, Math.floor((generatedAtMs - observedAtMs) / 1000));
  const connected = ageSeconds <= CHROME_EXTENSION_CONNECTION_TTL_SECONDS;

  return {
    state: connected ? "connected" : "stale",
    liveConnection: connected ? "connected" : "stale",
    path: statePath,
    ageSeconds,
    observedAt,
    ...(typeof heartbeat.launchOrigin === "string" ? { launchOrigin: heartbeat.launchOrigin } : {}),
    ...(typeof heartbeat.messageType === "string" ? { messageType: heartbeat.messageType } : {}),
    ...(typeof heartbeat.requestId === "string" ? { requestId: heartbeat.requestId } : {}),
    ...(readRecord(heartbeat.pageControl) ? { pageControl: readRecord(heartbeat.pageControl) } : {}),
    ...(readRecord(heartbeat.pageObservation) ? { pageObservation: readRecord(heartbeat.pageObservation) } : {}),
    ...(summarizePageActionResultForHeartbeat(heartbeat.pageActionResult)
      ? { pageActionResult: summarizePageActionResultForHeartbeat(heartbeat.pageActionResult) }
      : {}),
    ...(summarizePageScreenshotForHeartbeat(heartbeat.pageScreenshot)
      ? { pageScreenshot: summarizePageScreenshotForHeartbeat(heartbeat.pageScreenshot) }
      : {}),
    ...(summarizePageTabsForHeartbeat(heartbeat.pageTabs)
      ? { pageTabs: summarizePageTabsForHeartbeat(heartbeat.pageTabs) }
      : {}),
    ...(summarizeLatestCommandEvidence(heartbeat.latestCommand)
      ? { latestCommand: summarizeLatestCommandEvidence(heartbeat.latestCommand) }
      : {})
  };
}

export function encodeChromeNativeMessageFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > CHROME_NATIVE_MESSAGE_MAX_BYTES) {
    throw new Error("Chrome native messaging payload exceeds 1 MiB.");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export function decodeChromeNativeMessageFrame(frame: Buffer): unknown {
  if (frame.byteLength < 4) {
    throw new Error("Chrome native messaging frame is missing its length prefix.");
  }

  const payloadByteLength = frame.readUInt32LE(0);
  if (payloadByteLength > CHROME_NATIVE_MESSAGE_MAX_BYTES) {
    throw new Error("Chrome native messaging payload exceeds 1 MiB.");
  }
  if (frame.byteLength - 4 < payloadByteLength) {
    throw new Error("Chrome native messaging frame is incomplete.");
  }

  return JSON.parse(frame.subarray(4, 4 + payloadByteLength).toString("utf8"));
}

export function createChromeNativeBridgeDispatch({
  homeDir,
  launchOrigin,
  io
}: ChromeNativeBridgeDispatchInput): ChromeNativeBridgeDispatch {
  return async (message) => {
    const common = {
      bridgeState: "connected",
      ...(launchOrigin ? { launchOrigin } : {}),
      messageType: message.type
    };

    if (message.type === "skfiy.host_policy.request") {
      return {
        result: "accepted",
        ...common,
        hostPolicy: await readChromeHostPolicyState({
          homeDir,
          io
        })
      };
    }

    return {
      result: "accepted",
      ...common
    };
  };
}

export async function runChromeNativeMessagingHost({
  stdin,
  stdout,
  stderr,
  policy,
  dispatch,
  connectionHeartbeat
}: ChromeNativeMessagingHostIo): Promise<number> {
  let buffer = Buffer.alloc(0);

  try {
    for await (const chunk of stdin) {
      buffer = Buffer.concat([buffer, toBuffer(chunk)]);

      while (buffer.byteLength >= 4) {
        const payloadByteLength = buffer.readUInt32LE(0);
        if (payloadByteLength > CHROME_NATIVE_MESSAGE_MAX_BYTES) {
          stdout.write(encodeChromeNativeMessageFrame(createNativeBridgeResponse({
            requestId: "unknown",
            result: "invalid",
            reason: "payload_too_large"
          })));
          return 1;
        }

        if (buffer.byteLength < payloadByteLength + 4) {
          break;
        }

        const frame = buffer.subarray(0, payloadByteLength + 4);
        buffer = buffer.subarray(payloadByteLength + 4);

        let message: unknown;
        try {
          message = decodeChromeNativeMessageFrame(frame);
        } catch (error) {
          stdout.write(encodeChromeNativeMessageFrame(createNativeBridgeResponse({
            requestId: "unknown",
            result: "invalid",
            reason: readErrorMessage(error)
          })));
          continue;
        }

        const resolvedPolicy = typeof policy === "function" ? await policy() : policy;
        const response = await handleChromeNativeBridgeMessage(message, {
          payloadByteLength,
          policy: resolvedPolicy,
          dispatch
        });
        await recordConnectionHeartbeat({
          message,
          response,
          connectionHeartbeat,
          stderr
        });
        stdout.write(encodeChromeNativeMessageFrame(response));
      }
    }

    if (buffer.byteLength > 0) {
      stdout.write(encodeChromeNativeMessageFrame(createNativeBridgeResponse({
        requestId: "unknown",
        result: "invalid",
        reason: "incomplete_frame"
      })));
      return 1;
    }

    return 0;
  } catch (error) {
    stderr.write(`${readErrorMessage(error)}\n`);
    return 1;
  }
}

async function recordConnectionHeartbeat({
  message,
  response,
  connectionHeartbeat,
  stderr
}: {
  message: unknown;
  response: ChromeNativeBridgeResponse;
  connectionHeartbeat?: ChromeNativeMessagingHostIo["connectionHeartbeat"];
  stderr: ChromeNativeMessagingHostIo["stderr"];
}): Promise<void> {
  if (!connectionHeartbeat || response.result === "invalid") {
    return;
  }

  const record = readRecord(message);
  if (typeof record?.type !== "string" || typeof record.requestId !== "string") {
    return;
  }
  const payload = readRecord(record.payload);
  const pageControl = readRecord(payload?.pageControl);
  const pageObservation = readRecord(payload?.pageObservation);
  const pageActionResult = summarizePageActionResultForHeartbeat(payload?.pageActionResult);
  const pageScreenshot = summarizePageScreenshotForHeartbeat(payload?.pageScreenshot);
  const pageTabs = summarizePageTabsForHeartbeat(payload?.pageTabs);

  try {
    await connectionHeartbeat({
      observedAt: new Date().toISOString(),
      messageType: record.type,
      requestId: record.requestId,
      result: response.result,
      ...(pageControl ? { pageControl } : {}),
      ...(pageObservation ? { pageObservation } : {}),
      ...(pageActionResult ? { pageActionResult } : {}),
      ...(pageScreenshot ? { pageScreenshot } : {}),
      ...(pageTabs ? { pageTabs } : {})
    });
  } catch (error) {
    stderr.write(`Chrome extension heartbeat failed: ${readErrorMessage(error)}\n`);
  }
}

export async function handleChromeNativeBridgeMessage(
  message: unknown,
  input: ChromeNativeBridgeInput
): Promise<ChromeNativeBridgeResponse> {
  const requestId = readNativeRequestId(message);

  if (input.payloadByteLength > CHROME_NATIVE_MESSAGE_MAX_BYTES) {
    return createNativeBridgeResponse({
      requestId,
      result: "invalid",
      reason: "payload_too_large"
    });
  }

  const normalized = normalizeChromeNativeBridgeMessage(message);
  if (!normalized.ok) {
    return createNativeBridgeResponse({
      requestId,
      result: "invalid",
      reason: normalized.reason
    });
  }

  if (input.policy.state === "blocked") {
    return createNativeBridgeResponse({
      requestId: normalized.message.requestId,
      result: "blocked",
      reason: input.policy.reason ?? "app_policy_blocked",
      details: input.policy.details
    });
  }

  const browserMessage = normalizeChromeBrowserMessage(normalized.message);
  if (!browserMessage.ok) {
    return createNativeBridgeResponse({
      requestId: normalized.message.requestId,
      result: browserMessage.result,
      reason: browserMessage.reason
    });
  }

  try {
    return createNativeBridgeResponse({
      requestId: normalized.message.requestId,
      result: "accepted",
      ...(await input.dispatch(browserMessage.message))
    });
  } catch (error) {
    return createNativeBridgeResponse({
      requestId: normalized.message.requestId,
      result: "error",
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function createStatus(
  plan: ChromeNativeHostInstallPlan,
  state: ChromeNativeHostStatus["state"],
  reason: string,
  input: {
    cliShimExists: boolean;
    manifestExists: boolean;
    manifestValidJson?: boolean;
    installedManifest?: Partial<ChromeNativeHostManifest>;
    diagnostics?: ChromeNativeHostManifestDiagnostics;
  }
): ChromeNativeHostStatus {
  const diagnostics = input.diagnostics ?? createManifestDiagnostics(plan, input);

  return {
    state,
    hostName: plan.hostName,
    manifestPath: plan.manifestPath,
    cliShimPath: plan.manifest.path,
    extensionIds: diagnostics.extensionIds,
    expectedAllowedOrigins: diagnostics.expectedAllowedOrigins,
    allowedOrigins: plan.manifest.allowed_origins,
    ...(diagnostics.installedPath ? { installedCliShimPath: diagnostics.installedPath } : {}),
    ...(diagnostics.installedAllowedOrigins ? { installedAllowedOrigins: diagnostics.installedAllowedOrigins } : {}),
    manifestDiagnostics: diagnostics,
    reason
  };
}

function createManifestDiagnostics(
  plan: ChromeNativeHostInstallPlan,
  input: {
    cliShimExists: boolean;
    manifestExists: boolean;
    manifestValidJson?: boolean;
    installedManifest?: Partial<ChromeNativeHostManifest>;
  }
): ChromeNativeHostManifestDiagnostics {
  const expectedAllowedOrigins = plan.manifest.allowed_origins;
  const installedAllowedOrigins = Array.isArray(input.installedManifest?.allowed_origins)
    ? input.installedManifest.allowed_origins.filter((origin): origin is string => typeof origin === "string")
    : undefined;
  const missingAllowedOrigins = installedAllowedOrigins
    ? expectedAllowedOrigins.filter((origin) => !installedAllowedOrigins.includes(origin))
    : [...expectedAllowedOrigins];
  const extraAllowedOrigins = installedAllowedOrigins
    ? installedAllowedOrigins.filter((origin) => !expectedAllowedOrigins.includes(origin))
    : [];
  const mismatchedFields = collectManifestMismatches(plan.manifest, input.installedManifest, {
    installedAllowedOrigins,
    missingAllowedOrigins,
    extraAllowedOrigins
  });

  return {
    cliShimExists: input.cliShimExists,
    manifestExists: input.manifestExists,
    manifestValidJson: input.manifestValidJson ?? input.manifestExists,
    manifestMatches: mismatchedFields.length === 0,
    expectedPath: plan.manifest.path,
    expectedAllowedOrigins,
    extensionIds: expectedAllowedOrigins.map(readExtensionIdFromAllowedOrigin).filter(Boolean),
    ...(typeof input.installedManifest?.path === "string" ? { installedPath: input.installedManifest.path } : {}),
    ...(installedAllowedOrigins ? { installedAllowedOrigins } : {}),
    missingAllowedOrigins,
    extraAllowedOrigins,
    missingExtensionIds: missingAllowedOrigins.map(readExtensionIdFromAllowedOrigin).filter(Boolean),
    mismatchedFields
  };
}

function collectManifestMismatches(
  expected: ChromeNativeHostManifest,
  installed: Partial<ChromeNativeHostManifest> | undefined,
  origins: {
    installedAllowedOrigins?: string[];
    missingAllowedOrigins: string[];
    extraAllowedOrigins: string[];
  }
): string[] {
  if (!installed) {
    return ["manifest"];
  }

  return [
    installed.name === expected.name ? "" : "name",
    installed.description === expected.description ? "" : "description",
    installed.path === expected.path ? "" : "path",
    installed.type === expected.type ? "" : "type",
    Array.isArray(origins.installedAllowedOrigins)
      && origins.missingAllowedOrigins.length === 0
      && origins.extraAllowedOrigins.length === 0
      ? ""
      : "allowed_origins"
  ].filter(Boolean);
}

function readExtensionIdFromAllowedOrigin(origin: string): string {
  const matched = origin.match(/^chrome-extension:\/\/([a-p]{32})\/$/);
  return matched?.[1] ?? "";
}

function normalizeChromeNativeBridgeMessage(message: unknown):
  | { ok: true; message: ChromeNativeBridgeMessage }
  | { ok: false; reason: string } {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, reason: "message_not_object" };
  }

  const record = message as Record<string, unknown>;
  if (record.schemaVersion !== CHROME_NATIVE_MESSAGE_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema_version" };
  }

  if (typeof record.requestId !== "string" || record.requestId.trim().length === 0) {
    return { ok: false, reason: "missing_request_id" };
  }

  if (typeof record.type !== "string" || !CHROME_NATIVE_BRIDGE_MESSAGE_TYPES.has(record.type)) {
    return { ok: false, reason: "unsupported_message_type" };
  }

  return {
    ok: true,
    message: {
      schemaVersion: CHROME_NATIVE_MESSAGE_SCHEMA_VERSION,
      type: record.type,
      requestId: record.requestId,
      ...(Object.hasOwn(record, "payload") ? { payload: record.payload } : {})
    }
  };
}

function readNativeRequestId(message: unknown): string {
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const requestId = (message as Record<string, unknown>).requestId;
    if (typeof requestId === "string" && requestId.trim().length > 0) {
      return requestId;
    }
  }
  return "unknown";
}

function createNativeBridgeResponse({
  requestId,
  result,
  reason,
  details,
  ...extra
}: {
  requestId: string;
  result: ChromeNativeBridgeResponse["result"];
  reason?: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}): ChromeNativeBridgeResponse {
  return {
    schemaVersion: CHROME_NATIVE_MESSAGE_SCHEMA_VERSION,
    type: CHROME_NATIVE_RESPONSE_TYPE,
    requestId,
    result,
    ...(reason ? { reason } : {}),
    ...(details ? { details } : {}),
    ...extra
  };
}

function toBuffer(chunk: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "binary");
  }
  return Buffer.from(chunk);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBoundedString(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function summarizePageActionResultForHeartbeat(value: unknown): Record<string, unknown> | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  const actionRecord = readRecord(record.action);
  const action = readBoundedString(record.action)
    ?? readBoundedString(record.kind)
    ?? readBoundedString(actionRecord?.kind);
  const selector = readBoundedString(record.selector)
    ?? readBoundedString(actionRecord?.selector);
  const deltaY = readFiniteNumber(record.deltaY)
    ?? readFiniteNumber(actionRecord?.deltaY);
  const deltaX = readFiniteNumber(record.deltaX)
    ?? readFiniteNumber(actionRecord?.deltaX);
  const chromeHostPermissionRecord = readRecord(record.chromeHostPermission);
  const chromeHostPermissionOrigins = Array.isArray(chromeHostPermissionRecord?.origins)
    ? chromeHostPermissionRecord.origins
      .map((origin) => readBoundedString(origin))
      .filter((origin): origin is string => Boolean(origin))
    : [];
  const chromeHostPermission = chromeHostPermissionRecord
    ? {
        ...(readBoundedString(chromeHostPermissionRecord.state) ? { state: readBoundedString(chromeHostPermissionRecord.state) } : {}),
        ...(chromeHostPermissionOrigins.length > 0 ? { origins: chromeHostPermissionOrigins } : {}),
        ...(readBoundedString(chromeHostPermissionRecord.reason) ? { reason: readBoundedString(chromeHostPermissionRecord.reason) } : {}),
        ...(readBoundedString(chromeHostPermissionRecord.code) ? { code: readBoundedString(chromeHostPermissionRecord.code) } : {}),
        ...(readBoundedString(chromeHostPermissionRecord.message) ? { message: readBoundedString(chromeHostPermissionRecord.message) } : {})
      }
    : undefined;
  const summary: Record<string, unknown> = {
    ...(readBoundedString(record.type) ? { type: readBoundedString(record.type) } : {}),
    ...(readBoundedString(record.requestId) ? { requestId: readBoundedString(record.requestId) } : {}),
    ...(readBoundedString(record.result) ? { result: readBoundedString(record.result) } : {}),
    ...(action ? { action } : {}),
    ...(readBoundedString(record.reason) ? { reason: readBoundedString(record.reason) } : {}),
    ...(readBoundedString(record.code) ? { code: readBoundedString(record.code) } : {}),
    ...(readBoundedString(record.message) ? { message: readBoundedString(record.message) } : {}),
    ...(readFiniteNumber(record.targetTabId) !== undefined ? { targetTabId: readFiniteNumber(record.targetTabId) } : {}),
    ...(readFiniteNumber(record.tabId) !== undefined ? { tabId: readFiniteNumber(record.tabId) } : {}),
    ...(selector ? { selector } : {}),
    ...(deltaY !== undefined ? { deltaY } : {}),
    ...(deltaX !== undefined ? { deltaX } : {}),
    ...(readBoolean(record.confirmed) !== undefined ? { confirmed: readBoolean(record.confirmed) } : {}),
    ...(chromeHostPermission && Object.keys(chromeHostPermission).length > 0 ? { chromeHostPermission } : {})
  };

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function summarizePageScreenshotForHeartbeat(value: unknown): Record<string, unknown> | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  const dataUrl = typeof record.dataUrl === "string" ? record.dataUrl : undefined;
  const dataUrlBytes = readFiniteNumber(record.dataUrlBytes)
    ?? (dataUrl ? Buffer.byteLength(dataUrl, "utf8") : undefined);
  const hasDataUrl = readBoolean(record.hasDataUrl) ?? Boolean(dataUrl);
  const summary: Record<string, unknown> = {
    ...(readBoundedString(record.type) ? { type: readBoundedString(record.type) } : {}),
    ...(readBoundedString(record.messageType) ? { messageType: readBoundedString(record.messageType) } : {}),
    ...(readBoundedString(record.requestId) ? { requestId: readBoundedString(record.requestId) } : {}),
    ...(readBoundedString(record.result) ? { result: readBoundedString(record.result) } : {}),
    ...(readBoundedString(record.reason) ? { reason: readBoundedString(record.reason) } : {}),
    ...(readFiniteNumber(record.tabId) !== undefined ? { tabId: readFiniteNumber(record.tabId) } : {}),
    ...(readFiniteNumber(record.targetTabId) !== undefined ? { targetTabId: readFiniteNumber(record.targetTabId) } : {}),
    ...(readBoundedString(record.host) ? { host: readBoundedString(record.host) } : {}),
    ...(readBoundedString(record.format) ? { format: readBoundedString(record.format) } : {}),
    hasDataUrl,
    ...(dataUrlBytes !== undefined ? { dataUrlBytes } : {})
  };

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function summarizePageTabsForHeartbeat(value: unknown): Record<string, unknown> | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  const rawTabs = Array.isArray(record.tabs) ? record.tabs : [];
  const tabs = rawTabs
    .map((entry) => {
      const tab = readRecord(entry);
      if (!tab) {
        return undefined;
      }
      const summary: Record<string, unknown> = {
        ...(readFiniteNumber(tab.id) !== undefined ? { id: readFiniteNumber(tab.id) } : {}),
        ...(readFiniteNumber(tab.windowId) !== undefined ? { windowId: readFiniteNumber(tab.windowId) } : {}),
        ...(readBoolean(tab.active) !== undefined ? { active: readBoolean(tab.active) } : {}),
        ...(readBoundedString(tab.title) ? { title: readBoundedString(tab.title) } : {}),
        ...(readBoundedString(tab.url) ? { url: readBoundedString(tab.url) } : {}),
        ...(readBoundedString(tab.host) ? { host: readBoundedString(tab.host) } : {}),
        ...(readBoundedString(tab.scheme) ? { scheme: readBoundedString(tab.scheme) } : {}),
        ...(readBoundedString(tab.state) ? { state: readBoundedString(tab.state) } : {}),
        ...(readBoolean(tab.eligible) !== undefined ? { eligible: readBoolean(tab.eligible) } : {}),
        ...(readBoundedString(tab.blocker) ? { blocker: readBoundedString(tab.blocker) } : {}),
        ...(readBoundedString(tab.nextAction) ? { nextAction: readBoundedString(tab.nextAction) } : {})
      };
      return Object.keys(summary).length > 0 ? summary : undefined;
    })
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));

  const summary: Record<string, unknown> = {
    ...(readBoundedString(record.result) ? { result: readBoundedString(record.result) } : {}),
    tabs
  };

  return tabs.length > 0 || summary.result
    ? summary
    : undefined;
}

function summarizeLatestCommandEvidence(value: unknown): ChromeExtensionCommandEvidence | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  const pageObservation = readRecord(record.pageObservation);
  const pageActionResult = summarizePageActionResultForHeartbeat(record.pageActionResult);
  const pageScreenshot = summarizePageScreenshotForHeartbeat(record.pageScreenshot);
  const pageTabs = summarizePageTabsForHeartbeat(record.pageTabs);
  const summary: ChromeExtensionCommandEvidence = {
    ...(readBoundedString(record.observedAt) ? { observedAt: readBoundedString(record.observedAt) } : {}),
    ...(readBoundedString(record.launchOrigin) ? { launchOrigin: readBoundedString(record.launchOrigin) } : {}),
    ...(readBoundedString(record.messageType) ? { messageType: readBoundedString(record.messageType) } : {}),
    ...(readBoundedString(record.requestId) ? { requestId: readBoundedString(record.requestId) } : {}),
    ...(pageObservation ? { pageObservation } : {}),
    ...(pageActionResult ? { pageActionResult } : {}),
    ...(pageScreenshot ? { pageScreenshot } : {}),
    ...(pageTabs ? { pageTabs } : {})
  };

  return summary.messageType && summary.requestId
    ? summary
    : undefined;
}

function createDefaultChromeNativeHostIo(): ChromeNativeHostIo {
  return {
    exists: (targetPath) => existsSync(targetPath),
    mkdir: async (targetPath) => {
      await mkdir(targetPath, { recursive: true });
    },
    readFile: async (targetPath) => readFile(targetPath, "utf8"),
    writeFile,
    rename,
    rm: async (targetPath) => {
      await rm(targetPath, { force: true });
    }
  };
}
