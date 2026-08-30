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
const owner = { runtimeOwnerId: "relay-1", runtimeGeneration: 1, schemaGeneration: 1 } as const;
function envelope(value = intent, phase: "received" | "running" | "terminal" = "running",
  request: unknown = { text: "hello" }) {
  return { envelopeVersion: 1 as const, providerRequest: request, phase,
    frozenDeadline: "2030-08-29T00:00:00.000Z", currentTruth: {
      runId: value.provenance.kind === "business" ? value.provenance.runId : "",
      scopeKind: value.scope.kind, scopeId: value.scope.id, targetDigest: value.targetDigest,
      providerInstanceId: value.providerBinding.providerInstanceId,
      statusMessageId: "statusMessageId" in value ? value.statusMessageId ?? null : null,
      ...owner, providerConfigGeneration: value.providerBinding.providerConfigGeneration,
      providerConfigGenerationDigest: value.providerBinding.providerConfigGenerationDigest } };
}

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL provider delivery repository", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeEach(async () => { fixture = await createIsolatedPostgres(); await fixture.migrate(); });
  afterEach(async () => fixture.close());
  it("preserves immutable idempotency and exclusive fenced claims", async () => {
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool,
      owner,
      leaseOwner: "worker-1", leaseSeconds: 30 });
    await Promise.all([repository.recordIntent(intent, envelope()),
      repository.recordIntent(intent, envelope())]);
    const [first, second] = await Promise.all([repository.claimNext(), repository.claimNext()]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    await expect(repository.recordIntent({ ...intent, presentationDigest: digest("changed") }, {}))
      .rejects.toThrow(/conflict/u);
  });

  it("conflicts on the same intent with different payload or runtime owner", async () => {
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "worker-1", leaseSeconds: 30 });
    await repository.recordIntent(intent, envelope());
    await expect(repository.recordIntent(intent, envelope(intent, "running", { text: "changed" })))
      .rejects.toThrow(/conflict/u);
    const otherOwner = createPostgresDeliveryRepository({ pool: fixture.pool,
      owner: { ...owner, runtimeGeneration: 2 }, leaseOwner: "worker-2", leaseSeconds: 30 });
    await expect(otherOwner.recordIntent(intent, envelope())).rejects.toThrow(/conflict/u);
  });

  it("reclaims expired leases and fences the stale claimant", async () => {
    let time = new Date("2026-08-28T00:00:01.000Z");
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool,
      owner,
      leaseOwner: "worker-1", leaseSeconds: 1, now: () => time });
    await repository.recordIntent(intent, envelope());
    const first = await repository.claimNext(); expect(first).not.toBeNull();
    time = new Date("2026-08-28T00:00:03.000Z");
    const second = await repository.claimNext(); expect(second).not.toBeNull();
    expect(second!.leaseFence).not.toBe(first!.leaseFence);
    await expect(repository.renewLease(first!)).resolves.toBeNull();
  });

  it("supersedes stale current-truth presentations without changing run truth", async () => {
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool,
      owner,
      leaseOwner: "worker-1", leaseSeconds: 30 });
    await repository.recordIntent(intent, envelope(intent, "running"));
    const terminal = DeliveryIntentV2Schema.parse({ ...intent, sideEffectIntentId: "intent-final",
      idempotencyKey: "key-final", presentationDigest: digest("final") });
    await repository.recordIntent(terminal, envelope(terminal, "terminal"));
    const rows = await fixture.pool.query("SELECT intent_id,state,superseded_by_intent_id FROM cp_provider_delivery_intent ORDER BY intent_id");
    expect(rows.rows).toEqual([
      { intent_id: "intent-1", state: "superseded", superseded_by_intent_id: "intent-final" },
      { intent_id: "intent-final", state: "pending", superseded_by_intent_id: null },
    ]);
  });

  it("coalesces only the exact current-truth key", async () => {
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "worker-1", leaseSeconds: 30 });
    await repository.recordIntent(intent, envelope(intent, "running"));
    const otherScope = DeliveryIntentV2Schema.parse({ ...intent, sideEffectIntentId: "intent-other",
      idempotencyKey: "key-other", scope: { kind: "local_repository", id: "repo-2" } });
    await repository.recordIntent(otherScope, envelope(otherScope, "running"));
    const terminal = DeliveryIntentV2Schema.parse({ ...intent, sideEffectIntentId: "intent-terminal",
      idempotencyKey: "key-terminal", presentationDigest: digest("terminal") });
    await repository.recordIntent(terminal, envelope(terminal, "terminal"));
    const rows = await fixture.pool.query("SELECT intent_id,state FROM cp_provider_delivery_intent ORDER BY intent_id");
    expect(rows.rows).toEqual([{ intent_id: "intent-1", state: "superseded" },
      { intent_id: "intent-other", state: "pending" },
      { intent_id: "intent-terminal", state: "pending" }]);
  });

  it("looks up accepted external resources only across the complete SQLite identity", async () => {
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "worker-1", leaseSeconds: 30 });
    const accepted = DeliveryIntentV2Schema.parse({ ...intent, sideEffectIntentId: "accepted-1",
      idempotencyKey: "accepted-key-1", statusMessageId: "run-1:status" });
    const otherScope = DeliveryIntentV2Schema.parse({ ...accepted, sideEffectIntentId: "accepted-2",
      idempotencyKey: "accepted-key-2", scope: { kind: "local_repository", id: "repo-2" } });
    for (const [value, resource] of [[accepted, "native-1"], [otherScope, "native-2"]] as const) {
      await repository.recordIntent(value, envelope(value, "running"));
      const claimed = (await repository.claimNext())!; const renewed = (await repository.renewLease(claimed))!;
      const marker = digest(`marker-${resource}`); const begun = (await repository.markBegin({ ...renewed,
        installationBeginMarkerId: `installation-${resource}`, installationBeginMarkerDigest: marker,
        scopeBeginMarkerId: `scope-${resource}`, scopeBeginMarkerDigest: marker }))!;
      await repository.settleOrReadTerminal({ ...begun, outcome: "accepted",
        evidenceDigest: digest(`evidence-${resource}`), externalResourceId: resource,
        externalResourceDigest: digest(`resource-${resource}`) });
    }
    await expect(repository.findAcceptedExternalResource({ intent: accepted,
      statusMessageId: "run-1:status" })).resolves.toEqual({ outcome: "exact",
        externalResourceId: "native-1", externalResourceDigest: digest("resource-native-1") });
  });

  it("abandons at the frozen deadline and never begins provider I/O", async () => {
    let time = new Date("2026-08-28T00:00:00.000Z");
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "worker-1", leaseSeconds: 30, now: () => time });
    const deadlinePayload = { ...envelope(), frozenDeadline: "2026-08-28T00:00:10.000Z" };
    await repository.recordIntent(intent, deadlinePayload);
    const claimed = (await repository.claimNext())!; const renewed = (await repository.renewLease(claimed))!;
    time = new Date("2026-08-28T00:00:10.000Z");
    await expect(repository.markBegin({ ...renewed, installationBeginMarkerId: "installation",
      installationBeginMarkerDigest: digest("marker"), scopeBeginMarkerId: "scope",
      scopeBeginMarkerDigest: digest("marker") })).resolves.toBeNull();
    const row = await fixture.pool.query("SELECT state,error_code,begun_at FROM cp_provider_delivery_intent");
    expect(row.rows[0]).toEqual({ state: "attention", error_code: "delivery_deadline_exceeded",
      begun_at: null });
  });

  it("enforces one terminal presentation for an exact current-truth key", async () => {
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "worker-1", leaseSeconds: 30 });
    const first = DeliveryIntentV2Schema.parse({ ...intent, sideEffectIntentId: "terminal-1",
      idempotencyKey: "terminal-key-1" });
    const second = DeliveryIntentV2Schema.parse({ ...intent, sideEffectIntentId: "terminal-2",
      idempotencyKey: "terminal-key-2", presentationDigest: digest("terminal-2") });
    await repository.recordIntent(first, envelope(first, "terminal"));
    await expect(repository.recordIntent(second, envelope(second, "terminal")))
      .rejects.toThrow(/conflict/u);
    expect((await fixture.pool.query("SELECT count(*)::int AS count FROM cp_provider_delivery_intent")).rows)
      .toEqual([{ count: 1 }]);
  });

  it("rejects unsupported terminal error codes", async () => {
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "worker-1", leaseSeconds: 30 });
    await repository.recordIntent(intent, envelope());
    const claimed = (await repository.claimNext())!; const renewed = (await repository.renewLease(claimed))!;
    const begun = (await repository.markBegin({ ...renewed, installationBeginMarkerId: "installation",
      installationBeginMarkerDigest: digest("marker"), scopeBeginMarkerId: "scope",
      scopeBeginMarkerDigest: digest("marker") }))!;
    await expect(repository.settleOrReadTerminal({ ...begun, outcome: "attention",
      evidenceDigest: digest("attention"), errorCode: "unsupported" as never }))
      .rejects.toThrow(/unsupported delivery error/u);
  });
});
