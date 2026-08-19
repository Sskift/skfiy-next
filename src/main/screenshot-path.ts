import path from "node:path";

export interface ScreenshotPathInput {
  scope: string;
  serial: number;
  tempDir: string;
  timestamp: Date;
}

export interface ScreenshotPathFactoryOptions {
  initialSerial?: number;
  now?: () => Date;
  readTempDir: () => string;
}

export function formatScreenshotTimestamp(timestamp: Date): string {
  return timestamp.toISOString().replace(/[:.]/g, "-");
}

export function createScreenshotPath({
  scope,
  serial,
  tempDir,
  timestamp
}: ScreenshotPathInput): string {
  return path.join(
    tempDir,
    "skfiy",
    `${scope}-${formatScreenshotTimestamp(timestamp)}-${serial}.png`
  );
}

export function createScreenshotPathFactory({
  initialSerial = 0,
  now = () => new Date(),
  readTempDir
}: ScreenshotPathFactoryOptions): (scope: string) => string {
  let serial = initialSerial;

  return (scope) => {
    serial += 1;
    return createScreenshotPath({
      scope,
      serial,
      tempDir: readTempDir(),
      timestamp: now()
    });
  };
}
