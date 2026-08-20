import { describe, expect, it } from "vitest";

import {
  redactSecrets,
  redactSecretsWithCount,
  SECRET_REDACTION_PATTERN_SOURCES
} from "./redaction";

describe("shared redaction", () => {
  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer abc123def456")).toBe(
      "Authorization: Bearer [redacted]"
    );
  });

  it("redacts key=value secrets", () => {
    expect(redactSecrets("password=hunter2")).toBe("password=[redacted]");
    expect(redactSecrets("token=abc123")).toBe("token=[redacted]");
    expect(redactSecrets("secret=topsecret")).toBe("secret=[redacted]");
    expect(redactSecrets("api_key=abc123")).toBe("api_key=[redacted]");
    expect(redactSecrets("api-key=abc123")).toBe("api-key=[redacted]");
  });

  it("redacts token-prefixed secrets", () => {
    expect(redactSecrets("token abcdefghijklmnop")).toBe("token [redacted]");
  });

  it("redacts sk- keys", () => {
    expect(redactSecrets("sk-test-1234567890abcdef")).toBe("[redacted]");
  });

  it("counts redactions", () => {
    const result = redactSecretsWithCount("Bearer aaa111bbb222 and sk-test-1234567890abcdef");
    expect(result.text).toBe("Bearer [redacted] and [redacted]");
    expect(result.count).toBe(2);
  });

  it("does not count when there is nothing to redact", () => {
    const result = redactSecretsWithCount("just a normal sentence");
    expect(result.count).toBe(0);
    expect(result.text).toBe("just a normal sentence");
  });

  it("exposes the applied pattern sources for inspectable exports", () => {
    expect(SECRET_REDACTION_PATTERN_SOURCES.length).toBeGreaterThan(0);
    expect(SECRET_REDACTION_PATTERN_SOURCES.every((s) => typeof s === "string")).toBe(true);
  });
});
