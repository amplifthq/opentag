import { DeliveryIntentV2Schema } from "@opentag/delivery-contract";
import { describe, expect, it, vi } from "vitest";
import { UnifiedDeliveryProducer } from "../src/index.js";

const digest = `sha256:${"b".repeat(64)}`;
const intent = DeliveryIntentV2Schema.parse({
  contractVersion: 2, organizationId: "org_test", sideEffectIntentId: "intent-1", causalId: "cause-1",
  intentKind: "delivery", operation: "control_reply", deliveryKind: "message",
  presentationDigest: digest, provenance: { kind: "source_thread_control",
    providerInstanceId: "install-1", inboundEventDigest: digest,
    sourceThreadDigest: digest, providerBindingDigest: digest,
    installationId: "install-1", runtimeGeneration: 1, scopeId: "install-1" },
  providerBinding: { bindingKind: "established", providerId: "slack",
    providerInstanceId: "install-1", providerPrincipalDigest: digest,
    principalAssurance: "provider_verified", providerConfigGeneration: 1,
    providerConfigGenerationDigest: digest, lifecycle: "active", bindingDigest: digest },
  targetDigest: digest, authorityKind: "local_source_thread_control",
  authoritySnapshotDigest: digest, evidencePolicy: "local_audit", idempotencyKey: "key-1",
  scope: { kind: "provider_instance", id: "install-1" },
  createdAt: "2026-08-28T00:00:00.000Z", initialAttemptSequence: 1,
  installationId: "install-1", runtimeGeneration: 1,
});

describe("UnifiedDeliveryProducer", () => {
  it("acknowledges only a validated, durably recorded intent", async () => {
    const enqueue = vi.fn(async () => ({ outcome: "queued" as const }));
    const producer = new UnifiedDeliveryProducer({
      resolveIntent: async () => ({ intent, persistedPayload: { body: "hello" } }),
      submitter: { enqueue },
    });
    await expect(producer.enqueue({ body: "hello" })).resolves.toEqual({
      outcome: "queued", sideEffectIntentId: "intent-1",
    });
    expect(enqueue).toHaveBeenCalledWith(intent, { body: "hello" });
  });
});
