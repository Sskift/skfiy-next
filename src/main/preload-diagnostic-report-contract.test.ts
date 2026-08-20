import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_REPORT_SCHEMA_VERSION,
  type DiagnosticComponentName,
  type DiagnosticReportBlockerType,
  type DiagnosticReportSectionId
} from "../shared/diagnostic-report";

const PRELOAD_SOURCE = readFileSync(
  path.join(process.cwd(), "src/main/preload.cts"),
  "utf8"
);

const ALL_BLOCKER_TYPES: DiagnosticReportBlockerType[] = [
  "desktop-session-locked",
  "desktop-session-asleep",
  "desktop-session-not-controllable",
  "desktop-session-unknown",
  "screen-recording-denied",
  "screen-recording-not-determined",
  "screen-recording-unknown",
  "accessibility-denied",
  "accessibility-not-determined",
  "accessibility-unknown",
  "permission-mismatch",
  "provider-unconfigured",
  "provider-unavailable",
  "provider-auth-blocked",
  "provider-not-proven",
  "provider-unknown",
  "chrome-native-host-missing",
  "chrome-native-host-mismatched",
  "chrome-native-host-cli-missing",
  "chrome-native-host-invalid",
  "chrome-host-policy-invalid",
  "chrome-extension-disconnected",
  "chrome-extension-stale",
  "chrome-extension-invalid",
  "browser-context-blocked",
  "browser-context-partial",
  "browser-context-not-probed",
  "browser-context-unknown",
  "finder-automation-denied",
  "finder-automation-not-tested",
  "finder-automation-test-failed"
];

const ALL_SECTION_IDS: DiagnosticReportSectionId[] = [
  "desktop-session",
  "permissions",
  "provider",
  "chrome",
  "browser-context",
  "finder-automation",
  "startup"
];

const ALL_COMPONENT_NAMES: DiagnosticComponentName[] = [
  "app",
  "cli",
  "helper",
  "provider",
  "chrome-extension",
  "native-host"
];

describe("preload diagnostic report contract", () => {
  it("imports the DiagnosticReport type from the shared contract", () => {
    expect(PRELOAD_SOURCE).toContain("from \"../shared/diagnostic-report.js\"");
  });

  it("exposes the getDiagnosticReport API through the desktop bridge", () => {
    expect(PRELOAD_SOURCE).toContain("getDiagnosticReport");
    expect(PRELOAD_SOURCE).toContain("skfiy:get-diagnostic-report");
  });

  it("validates schemaVersion === 1", () => {
    // isDiagnosticReport is the last validator function; slice from its start
    // to the next function definition or the end of the validator block.
    const funcStart = PRELOAD_SOURCE.indexOf("function isDiagnosticReport(");
    expect(funcStart).toBeGreaterThan(0);
    const afterFunc = PRELOAD_SOURCE.indexOf("function ", funcStart + 10);
    const validator = PRELOAD_SOURCE.slice(
      funcStart,
      afterFunc > funcStart ? afterFunc : funcStart + 2000
    );
    expect(validator).toContain("schemaVersion === 1");
    expect(DIAGNOSTIC_REPORT_SCHEMA_VERSION).toBe(1);
  });

  it("accepts every blocker type emitted by the main process", () => {
    // The blocker type validator lives between the isDiagnosticReport function
    // and the isDiagnosticReportSection function.
    const validatorStart = PRELOAD_SOURCE.indexOf(
      "DIAGNOSTIC_REPORT_BLOCKER_TYPES"
    );
    const validatorEnd = PRELOAD_SOURCE.indexOf(
      "function isDiagnosticReportSection("
    );
    const validator = PRELOAD_SOURCE.slice(validatorStart, validatorEnd);

    for (const type of ALL_BLOCKER_TYPES) {
      expect(validator).toContain(`"${type}"`);
    }
  });

  it("accepts every section id emitted by the main process", () => {
    const validatorStart = PRELOAD_SOURCE.indexOf(
      "DIAGNOSTIC_REPORT_SECTION_IDS"
    );
    const validatorEnd = PRELOAD_SOURCE.indexOf(
      "function isDiagnosticReportBlocker("
    );
    const validator = PRELOAD_SOURCE.slice(validatorStart, validatorEnd);

    for (const id of ALL_SECTION_IDS) {
      expect(validator).toContain(`"${id}"`);
    }
  });

  it("accepts every component name emitted by the main process", () => {
    const validatorStart = PRELOAD_SOURCE.indexOf(
      "DIAGNOSTIC_COMPONENT_NAMES"
    );
    const validatorEnd = PRELOAD_SOURCE.indexOf(
      "function isDiagnosticReportRedaction("
    );
    const validator = PRELOAD_SOURCE.slice(validatorStart, validatorEnd);

    for (const name of ALL_COMPONENT_NAMES) {
      expect(validator).toContain(`"${name}"`);
    }
  });

  it("validates the blocker shape with id, type, severity, title, detail, nextAction, copyable", () => {
    const validator = PRELOAD_SOURCE.slice(
      PRELOAD_SOURCE.indexOf("function isDiagnosticReportBlocker("),
      PRELOAD_SOURCE.indexOf("function isDiagnosticReportSection(")
    );
    expect(validator).toContain("typeof blocker.id === \"string\"");
    expect(validator).toContain("isDiagnosticReportBlockerType");
    expect(validator).toContain("typeof blocker.title === \"string\"");
    expect(validator).toContain("typeof blocker.detail === \"string\"");
    expect(validator).toContain("typeof blocker.nextAction === \"string\"");
    expect(validator).toContain("typeof blocker.copyable === \"string\"");
  });

  it("validates the section shape with id, state, summary, blockers", () => {
    const validator = PRELOAD_SOURCE.slice(
      PRELOAD_SOURCE.indexOf("function isDiagnosticReportSection("),
      PRELOAD_SOURCE.indexOf("function isDiagnosticComponentVersion(")
    );
    expect(validator).toContain("isDiagnosticReportSectionId");
    expect(validator).toContain("typeof section.summary === \"string\"");
    expect(validator).toContain("Array.isArray(section.blockers)");
  });

  it("validates the component version shape", () => {
    const validator = PRELOAD_SOURCE.slice(
      PRELOAD_SOURCE.indexOf("function isDiagnosticComponentVersion("),
      PRELOAD_SOURCE.indexOf("function isDiagnosticReportRedaction(")
    );
    expect(validator).toContain("isDiagnosticComponentName");
    expect(validator).toContain("component.version === null");
    expect(validator).toContain("typeof component.version === \"string\"");
    expect(validator).toContain("typeof component.source === \"string\"");
  });

  it("validates the redaction summary shape", () => {
    const validator = PRELOAD_SOURCE.slice(
      PRELOAD_SOURCE.indexOf("function isDiagnosticReportRedaction("),
      PRELOAD_SOURCE.indexOf("function createUnknownDiagnosticReport(")
    );
    expect(validator).toContain("typeof redaction.rule === \"string\"");
    expect(validator).toContain("typeof redaction.count === \"number\"");
  });

  it("provides an unknown fallback when validation fails", () => {
    expect(PRELOAD_SOURCE).toContain("createUnknownDiagnosticReport()");
    expect(PRELOAD_SOURCE).toContain("isDiagnosticReport(payload)");
  });

  it("rejects unknown blocker types", () => {
    // The validator should use Set membership (.has(value)) so only known
    // blocker types are accepted, not arbitrary strings.
    const validator = PRELOAD_SOURCE.slice(
      PRELOAD_SOURCE.indexOf("DIAGNOSTIC_REPORT_BLOCKER_TYPES"),
      PRELOAD_SOURCE.indexOf("function isDiagnosticReportSection(")
    );
    expect(validator).toContain(".has(value)");
    // Should not have a catch-all that accepts any string without Set check
    expect(validator).not.toContain("typeof value === \"string\" && true");
  });
});
