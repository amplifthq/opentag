import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveryIntentV2Schema } from "@opentag/delivery-contract";
import { createPostgresDeliveryRepository } from "../src/modules/provider-delivery/repository.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const intent = DeliveryIntentV2Schema.parse({ contractVersion: 2, sideEffectIntentId: "intent-1",
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

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL provider delivery repository", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeEach(async () => { fixture = await createIsolatedPostgres(); await fixture.migrate(); });
  afterEach(async () => fixture.close());
  it("preserves immutable idempotency and exclusive fenced claims", async () => {
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool,
      owner: { runtimeOwnerId: "relay-1", runtimeGeneration: 1, schemaGeneration: 1 },
      leaseOwner: "worker-1", leaseSeconds: 30 });
    await repository.recordIntent(intent, { text: "hello" });
    await repository.recordIntent(intent, { text: "hello" });
    const [first, second] = await Promise.all([repository.claimNext(), repository.claimNext()]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    await expect(repository.recordIntent({ ...intent, presentationDigest: digest("changed") }, {}))
      .rejects.toThrow(/conflict/u);
  });

  it("reclaims expired leases and fences the stale claimant", async () => {
    let time = new Date("2026-08-28T00:00:01.000Z");
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool,
      owner: { runtimeOwnerId: "relay-1", runtimeGeneration: 1, schemaGeneration: 1 },
      leaseOwner: "worker-1", leaseSeconds: 1, now: () => time });
    await repository.recordIntent(intent, { text: "hello" });
    const first = await repository.claimNext(); expect(first).not.toBeNull();
    time = new Date("2026-08-28T00:00:03.000Z");
    const second = await repository.claimNext(); expect(second).not.toBeNull();
    expect(second!.leaseFence).not.toBe(first!.leaseFence);
    await expect(repository.renewLease(first!)).resolves.toBeNull();
  });

  it("supersedes stale current-truth presentations without changing run truth", async () => {
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool,
      owner: { runtimeOwnerId: "relay-1", runtimeGeneration: 1, schemaGeneration: 1 },
      leaseOwner: "worker-1", leaseSeconds: 30 });
    await repository.recordIntent(intent, { phase: "running" });
    const terminal = DeliveryIntentV2Schema.parse({ ...intent, sideEffectIntentId: "intent-final",
      idempotencyKey: "key-final", presentationDigest: digest("final") });
    await repository.recordIntent(terminal, { phase: "final" });
    const rows = await fixture.pool.query("SELECT intent_id,state,superseded_by_intent_id FROM cp_provider_delivery_intent ORDER BY intent_id");
    expect(rows.rows).toEqual([
      { intent_id: "intent-1", state: "superseded", superseded_by_intent_id: "intent-final" },
      { intent_id: "intent-final", state: "pending", superseded_by_intent_id: null },
    ]);
  });
});
