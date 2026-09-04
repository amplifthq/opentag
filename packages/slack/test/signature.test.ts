import { describe, expect, it } from "vitest";
import {
  computeSlackSignature,
  verifySlackSignature,
  verifySlackTimestamp,
} from "../src/signature.js";

const request = {
  signingSecret: "test-signing-secret",
  timestamp: "1700000000",
  rawBody: '{"type":"event_callback"}',
};

describe("Slack request signature", () => {
  it("computes the exact v0 HMAC over timestamp and raw body", () => {
    expect(computeSlackSignature(request)).toBe(
      "v0=a0c625131c61101f5568ce01cd6c951e36fa4b0c50f46b25feafb898b0ea4250",
    );
  });

  it("accepts only an exact constant-time comparable signature", () => {
    const signature = computeSlackSignature(request);
    expect(verifySlackSignature({ ...request, signature })).toBe(true);
    expect(verifySlackSignature({
      ...request,
      rawBody: `${request.rawBody}\n`,
      signature,
    })).toBe(false);
    expect(verifySlackSignature({ ...request, signature: "v0=short" })).toBe(false);
  });

  it("accepts the configured replay-window boundary and rejects stale timestamps", () => {
    const nowMs = 1_700_000_300_000;
    expect(verifySlackTimestamp({
      timestamp: request.timestamp,
      nowMs,
    })).toBe(true);
    expect(verifySlackTimestamp({
      timestamp: request.timestamp,
      nowMs: nowMs + 1_000,
    })).toBe(false);
    expect(verifySlackTimestamp({ timestamp: "invalid", nowMs })).toBe(false);
  });
});
