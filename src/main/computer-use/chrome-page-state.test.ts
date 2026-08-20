import { describe, expect, it } from "vitest";
import {
  CHROME_AUTH_WALL_FINDING_KINDS,
  classifyPageStateChange,
  detectAuthWall,
  detectDownload,
  detectNewTab,
  readDownloadUrlHost,
  type ChromeDownloadsStatus,
  type ChromePageSafetyState,
  type ChromePageTarget
} from "./chrome-page-state";

describe("classifyPageStateChange", () => {
  it("classifies a URL change as navigation", () => {
    expect(classifyPageStateChange(
      { url: "https://example.com/page-a", documentId: "doc-1" },
      { url: "https://example.com/page-b", documentId: "doc-2" }
    )).toEqual({
      kind: "navigation",
      fromUrl: "https://example.com/page-a",
      toUrl: "https://example.com/page-b"
    });
  });

  it("ignores fragment-only URL changes", () => {
    expect(classifyPageStateChange(
      { url: "https://example.com/page#section-1", documentId: "doc-1" },
      { url: "https://example.com/page#section-2", documentId: "doc-1" }
    )).toEqual({ kind: "unchanged" });
  });

  it("classifies a documentId change with the same URL as reload", () => {
    expect(classifyPageStateChange(
      { url: "https://example.com/page", documentId: "doc-1" },
      { url: "https://example.com/page", documentId: "doc-2" }
    )).toEqual({
      kind: "reload",
      url: "https://example.com/page"
    });
  });

  it("classifies an unchanged page as unchanged", () => {
    expect(classifyPageStateChange(
      { url: "https://example.com/page", documentId: "doc-1" },
      { url: "https://example.com/page", documentId: "doc-1" }
    )).toEqual({ kind: "unchanged" });
  });

  it("does not mutate its inputs", () => {
    const previous = { url: "https://example.com/a", documentId: "doc-1" };
    const current = { url: "https://example.com/b", documentId: "doc-2" };
    classifyPageStateChange(previous, current);
    expect(previous).toEqual({ url: "https://example.com/a", documentId: "doc-1" });
    expect(current).toEqual({ url: "https://example.com/b", documentId: "doc-2" });
  });
});

describe("detectAuthWall", () => {
  it("detects a credential prompt finding", () => {
    const safety: ChromePageSafetyState = {
      needsConfirmation: false,
      findings: [
        { kind: "credential_or_otp_prompt", severity: "high" },
        { kind: "form_field", severity: "info" }
      ]
    };

    expect(detectAuthWall(safety)).toEqual({
      detected: true,
      reason: "Chrome page shows an auth wall: credential_or_otp_prompt.",
      findings: [{ kind: "credential_or_otp_prompt", severity: "high" }]
    });
  });

  it("detects a payment flow finding", () => {
    const decision = detectAuthWall({
      needsConfirmation: false,
      findings: [{ kind: "payment_or_billing_flow", severity: "high" }]
    });

    expect(decision.detected).toBe(true);
    if (decision.detected) {
      expect(decision.reason).toContain("payment_or_billing_flow");
    }
  });

  it.each([...CHROME_AUTH_WALL_FINDING_KINDS])("detects the %s finding kind", (kind) => {
    const decision = detectAuthWall({
      needsConfirmation: false,
      findings: [{ kind, severity: "medium" }]
    });

    expect(decision.detected).toBe(true);
  });

  it("detects a page flagged needsConfirmation even without a matching finding", () => {
    const decision = detectAuthWall({
      needsConfirmation: true,
      findings: []
    });

    expect(decision).toEqual({
      detected: true,
      reason: "Chrome page requires confirmation for sensitive content.",
      findings: []
    });
  });

  it("does not flag a clean page", () => {
    expect(detectAuthWall({
      needsConfirmation: false,
      findings: [{ kind: "form_field", severity: "info" }]
    })).toEqual({ detected: false });
  });
});

describe("detectDownload", () => {
  it("detects a new download and reports only the host", () => {
    const previous: ChromeDownloadsStatus = {
      downloads: [{ id: "dl-1", url: "https://example.com/file-a.txt", state: "complete" }]
    };
    const current: ChromeDownloadsStatus = {
      downloads: [
        { id: "dl-1", url: "https://example.com/file-a.txt", state: "complete" },
        { id: "dl-2", url: "https://files.example.com/path/to/report.pdf?token=secret", state: "in_progress" }
      ]
    };

    const decision = detectDownload(previous, current);

    expect(decision).toEqual({
      detected: true,
      downloadHost: "files.example.com",
      reason: expect.stringContaining("1 download")
    });
    expect(JSON.stringify(decision)).not.toContain("report.pdf");
    expect(JSON.stringify(decision)).not.toContain("secret");
  });

  it("detects multiple new downloads", () => {
    const decision = detectDownload(
      { downloads: [] },
      {
        downloads: [
          { id: "dl-1", url: "https://a.example.com/1", state: "in_progress" },
          { id: "dl-2", url: "https://b.example.com/2", state: "in_progress" }
        ]
      }
    );

    expect(decision.detected).toBe(true);
    if (decision.detected) {
      expect(decision.reason).toContain("2 downloads");
    }
  });

  it("does not flag when no download appeared", () => {
    expect(detectDownload(
      { downloads: [{ id: "dl-1", url: "https://example.com/a", state: "complete" }] },
      { downloads: [{ id: "dl-1", url: "https://example.com/a", state: "complete" }] }
    )).toEqual({ detected: false });
  });

  it("falls back to an unknown host for unparseable URLs", () => {
    const decision = detectDownload(
      { downloads: [] },
      { downloads: [{ id: "dl-1", url: "not-a-url", state: "in_progress" }] }
    );

    expect(decision.detected).toBe(true);
    if (decision.detected) {
      expect(decision.downloadHost).toBe("unknown host");
    }
  });
});

describe("readDownloadUrlHost", () => {
  it("reads the host of an https URL", () => {
    expect(readDownloadUrlHost("https://files.example.com/path/file.zip")).toBe("files.example.com");
  });

  it("returns an unknown host for unparseable input", () => {
    expect(readDownloadUrlHost("")).toBe("unknown host");
  });
});

describe("detectNewTab", () => {
  it("detects a new page target", () => {
    const previous: ChromePageTarget[] = [
      { id: "tab-1", url: "https://example.com/original", type: "page" }
    ];
    const current: ChromePageTarget[] = [
      { id: "tab-1", url: "https://example.com/original", type: "page" },
      { id: "tab-2", url: "https://example.com/opened-by-click", type: "page" }
    ];

    expect(detectNewTab(previous, current)).toEqual({
      detected: true,
      tabUrl: "https://example.com/opened-by-click",
      reason: expect.stringContaining("1 new tab")
    });
  });

  it("does not flag when the target set is unchanged", () => {
    const targets: ChromePageTarget[] = [
      { id: "tab-1", url: "https://example.com/original", type: "page" }
    ];

    expect(detectNewTab(targets, targets)).toEqual({ detected: false });
  });

  it("does not mutate its inputs", () => {
    const previous: ChromePageTarget[] = [
      { id: "tab-1", url: "https://example.com/a", type: "page" }
    ];
    const current: ChromePageTarget[] = [
      { id: "tab-1", url: "https://example.com/a", type: "page" },
      { id: "tab-2", url: "https://example.com/b", type: "page" }
    ];

    detectNewTab(previous, current);

    expect(previous).toHaveLength(1);
    expect(current).toHaveLength(2);
  });
});
