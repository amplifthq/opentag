import { describe, expect, it } from "vitest";
import { ProviderDeliveryResultSchema } from "../src/observation.js";

describe("provider delivery result", () => {
  it("preserves outcome_unknown as a first-class provider outcome", () => {
    expect(ProviderDeliveryResultSchema.parse({
      outcome: "outcome_unknown",
      evidenceDigest: `sha256:${"a".repeat(64)}`,
      errorCode: "provider_timeout_after_start"
    })).toEqual({
      outcome: "outcome_unknown",
      evidenceDigest: `sha256:${"a".repeat(64)}`,
      errorCode: "provider_timeout_after_start"
    });
  });

  it("rejects provider-specific observation fields", () => {
    expect(() => ProviderDeliveryResultSchema.parse({
      outcome: "accepted",
      evidenceDigest: `sha256:${"b".repeat(64)}`,
      slackTimestamp: "1700000000.000100"
    })).toThrow();
  });
});
