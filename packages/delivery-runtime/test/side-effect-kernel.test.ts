import { createHash } from "node:crypto";
import { DeliveryIntentV2Schema, type DeliveryClaim,
  type DeliverySettlement } from "@opentag/delivery-contract";
import { SourceAppRegistry, type SourceAppDefinition } from "@opentag/source-app-runtime";
import { describe, expect, it, vi } from "vitest";
import { ProviderAdapterRegistry, ProviderSideEffectKernel,
  type DeliveryKernelRepository } from "../src/index.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const intent = DeliveryIntentV2Schema.parse({ contractVersion: 2, organizationId: "org_test", sideEffectIntentId: "intent-1",
  causalId: "cause-1", intentKind: "delivery", operation: "create", deliveryKind: "message",
  presentationDigest: digest("presentation"), provenance: { kind: "business",
    repositoryIdentityDigest: digest("repo"), runId: "run-1", authorityLineageDigest: digest("authority") },
  providerBinding: { bindingKind: "established", providerId: "slack", providerInstanceId: "workspace-a",
    providerPrincipalDigest: digest("principal"), principalAssurance: "provider_verified",
    providerConfigGeneration: 1, providerConfigGenerationDigest: digest("generation"), lifecycle: "active",
    bindingDigest: digest("binding") }, targetDigest: digest("target"), authorityKind: "run_authority",
  authoritySnapshotDigest: digest("snapshot"), evidencePolicy: "local_audit", idempotencyKey: "key-1",
  scope: { kind: "local_repository", id: "repo-1" }, createdAt: "2026-08-28T00:00:00.000Z",
  initialAttemptSequence: 1 });
const claim: DeliveryClaim = { organizationId: "org_test", attemptId: "attempt-1", intentId: intent.sideEffectIntentId,
  sequence: 1, leaseFence: "fence", revision: 2, providerId: "slack",
  providerInstanceId: "workspace-a", providerBindingDigest: digest("binding"),
  providerConfigGeneration: 1, providerConfigGenerationDigest: digest("generation"),
  runtimeOwnerId: "runtime", runtimeGeneration: 1, schemaGeneration: 1,
  authoritySnapshotDigest: digest("snapshot"), journalIntentDigest: digest("journal") };

function repository() {
  const settlements: DeliverySettlement[] = [];
  const value: DeliveryKernelRepository = { recordIntent: () => undefined,
    claimNext: () => claim, renewLease: (input) => input,
    getIntent: () => ({ outcome: "hydrated", intent, journalIntentDigest: claim.journalIntentDigest,
      persistedPayload: { text: "hello" } }), releaseUnusedClaim: () => false,
    markBegin: (input) => ({ ...input, revision: input.revision + 1 }),
    settleOrReadTerminal: (input) => { const result = input as DeliverySettlement;
      settlements.push(result); return result; }, finalizeStrandedBegun: () => 0,
    findAcceptedExternalResource: () => ({ outcome: "none" }) };
  return { value, settlements };
}

function sourceApp(deliver: SourceAppDefinition<unknown, unknown, { text: string }>["delivery"]["deliver"],
  reconcile: SourceAppDefinition<unknown, unknown, { text: string }>["delivery"]["reconcile"]):
  SourceAppDefinition<unknown, unknown, { text: string }> {
  return { appId: "slack", protocol: "opentag.channel.v1",
    capabilities: { threads: true, messageUpdate: true, reactions: true, interactiveActions: false,
      attachments: "metadata", authenticatedDeletion: true, stableSourceVersions: true },
    installation: { organizationId: "org_test", appInstanceId: "workspace-a", bindingDigest: digest("binding"),
      credentialGeneration: 1, credentialGenerationDigest: digest("generation") },
    ingress: { verify: async (input) => input, normalize: () => null },
    context: { readThread: async () => ({ messages: [], truncated: false, decodedBytes: 0 }) },
    presentation: { render: () => ({}) }, delivery: { prepare: () => ({ text: "hello" }),
      deliver, reconcile } };
}

describe("ProviderSideEffectKernel reconciliation", () => {
  it("reconciles one ambiguous post-begin response and settles exact authoritative identity", async () => {
    const deliver = vi.fn(async () => ({ outcome: "outcome_unknown" as const,
      evidenceDigest: digest("ambiguous"), errorCode: "ambiguous_response" }));
    const reconcile = vi.fn(async () => ({ outcome: "accepted" as const,
      evidenceDigest: digest("reconciled"), externalResourceId: "171.002",
      externalResourceDigest: digest("resource") }));
    const repo = repository(); const sources = new SourceAppRegistry().register(sourceApp(deliver, reconcile));
    const kernel = new ProviderSideEffectKernel({ repository: repo.value,
      registry: new ProviderAdapterRegistry<{ text: string }>(sources),
      prepareRequest: () => ({ request: { text: "hello" }, operation: "create",
        presentationDigest: intent.presentationDigest, targetDigest: intent.targetDigest }) });
    await expect(kernel.deliverNext()).resolves.toMatchObject({ outcome: "accepted",
      externalResourceId: "171.002", externalResourceDigest: digest("resource") });
    expect(deliver).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledOnce();
  });

  it("never writes twice when reconciliation is unavailable", async () => {
    const deliver = vi.fn(async () => { throw new Error("response lost"); });
    const reconcile = vi.fn(async () => { throw new Error("probe unavailable"); });
    const repo = repository(); const sources = new SourceAppRegistry().register(sourceApp(deliver, reconcile));
    const kernel = new ProviderSideEffectKernel({ repository: repo.value,
      registry: new ProviderAdapterRegistry<{ text: string }>(sources),
      prepareRequest: () => ({ request: { text: "hello" }, operation: "create",
        presentationDigest: intent.presentationDigest, targetDigest: intent.targetDigest }) });
    await expect(kernel.deliverNext()).resolves.toMatchObject({ outcome: "outcome_unknown",
      errorCode: "provider_delivery_exception" });
    expect(deliver).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledOnce();
  });

  it("settles outcome_unknown when the one reconciliation probe remains ambiguous", async () => {
    const deliver = vi.fn(async () => ({ outcome: "outcome_unknown" as const,
      evidenceDigest: digest("ambiguous"), errorCode: "ambiguous_response" }));
    const reconcile = vi.fn(async () => ({ outcome: "outcome_unknown" as const,
      evidenceDigest: digest("still-ambiguous"), errorCode: "ambiguous_response" }));
    const repo = repository(); const sources = new SourceAppRegistry().register(sourceApp(deliver, reconcile));
    const kernel = new ProviderSideEffectKernel({ repository: repo.value,
      registry: new ProviderAdapterRegistry<{ text: string }>(sources),
      prepareRequest: () => ({ request: { text: "hello" }, operation: "create",
        presentationDigest: intent.presentationDigest, targetDigest: intent.targetDigest }) });
    await expect(kernel.deliverNext()).resolves.toMatchObject({ outcome: "outcome_unknown",
      errorCode: "ambiguous_response" });
    expect(deliver).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledOnce();
  });
});
