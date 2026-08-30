import { describe, expect, it } from "vitest";
import { DELIVERY_ERROR_CODES, ProviderDeliveryResultSchema,
  type DeliveryBegin, type DeliverySettlement } from "../src/observation.js";

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

  it("owns the provider-neutral delivery lifecycle vocabulary", () => {
    expect(DELIVERY_ERROR_CODES).toContain("delivery_restart_after_begin");
    const begin: DeliveryBegin = { attemptId: "attempt", intentId: "intent", sequence: 1,
      leaseFence: "fence", revision: 3, providerId: "slack", providerInstanceId: "workspace",
      providerBindingDigest: `sha256:${"1".repeat(64)}`, providerConfigGeneration: 1,
      providerConfigGenerationDigest: `sha256:${"2".repeat(64)}`, runtimeOwnerId: "runtime",
      runtimeGeneration: 1, schemaGeneration: 1, authoritySnapshotDigest: `sha256:${"3".repeat(64)}`,
      journalIntentDigest: `sha256:${"4".repeat(64)}`, installationBeginMarkerId: "installation",
      installationBeginMarkerDigest: `sha256:${"5".repeat(64)}`, scopeBeginMarkerId: "scope",
      scopeBeginMarkerDigest: `sha256:${"6".repeat(64)}` };
    const settlement: DeliverySettlement = { ...begin, outcome: "accepted",
      evidenceDigest: `sha256:${"7".repeat(64)}`, externalResourceId: "native-id",
      externalResourceDigest: `sha256:${"8".repeat(64)}` };
    expect(settlement.outcome).toBe("accepted");
  });

  it("requires accepted external resource identities to carry a canonical digest", () => {
    expect(() => ProviderDeliveryResultSchema.parse({ outcome: "accepted",
      evidenceDigest: `sha256:${"a".repeat(64)}`, externalResourceId: "native-id" })).toThrow();
    expect(ProviderDeliveryResultSchema.parse({ outcome: "accepted",
      evidenceDigest: `sha256:${"a".repeat(64)}`, externalResourceId: "native-id",
      externalResourceDigest: `sha256:${"b".repeat(64)}` })).toMatchObject({
        externalResourceId: "native-id", externalResourceDigest: `sha256:${"b".repeat(64)}` });
  });
});
