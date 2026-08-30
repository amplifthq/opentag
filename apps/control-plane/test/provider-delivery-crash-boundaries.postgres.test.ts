import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DeliveryIntentV2Schema, deliveryCurrentTruthDescriptor } from "@opentag/delivery-contract";
import { createPostgresDeliveryRepository } from "../src/modules/provider-delivery/repository.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL delivery crash boundaries", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeEach(async () => { fixture = await createIsolatedPostgres(); await fixture.migrate(); });
  afterEach(async () => fixture.close());
  it("installs immutable intent and attempt custody tables through migrations", async () => {
    const result = await fixture.pool.query<{ name: string | null }>(
      "SELECT to_regclass('cp_provider_delivery_intent')::text AS name");
    expect(result.rows[0]?.name).toBe("cp_provider_delivery_intent");
  });

  it("finalizes begin-before-side-effect restart as outcome_unknown", async () => {
    const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const intent = DeliveryIntentV2Schema.parse({ contractVersion: 2, organizationId: "org_test", sideEffectIntentId: "crash-intent",
      causalId: "cause", intentKind: "delivery", operation: "create", deliveryKind: "message",
      presentationDigest: digest("presentation"), provenance: { kind: "business",
        repositoryIdentityDigest: digest("repo"), runId: "run", authorityLineageDigest: digest("authority") },
      providerBinding: { bindingKind: "established", providerId: "slack", providerInstanceId: "workspace",
        providerPrincipalDigest: digest("principal"), principalAssurance: "provider_verified",
        providerConfigGeneration: 1, providerConfigGenerationDigest: digest("generation"), lifecycle: "active",
        bindingDigest: digest("binding") }, targetDigest: digest("target"), authorityKind: "run_authority",
      authoritySnapshotDigest: digest("snapshot"), evidencePolicy: "local_audit", idempotencyKey: "crash-key",
      scope: { kind: "local_repository", id: "repo" }, createdAt: "2026-08-28T00:00:00.000Z",
      initialAttemptSequence: 1 });
    let time = new Date("2026-08-28T00:00:01.000Z");
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool,
      owner: { runtimeOwnerId: "relay", runtimeGeneration: 1, schemaGeneration: 1 },
      leaseOwner: "worker", leaseSeconds: 30, now: () => time });
    await repository.recordIntent(intent, { envelopeVersion: 1, providerRequest: { text: "hello" },
      phase: "running", frozenDeadline: "2030-08-29T00:00:00.000Z",
      currentTruth: deliveryCurrentTruthDescriptor({ intent, owner: {
        organizationId: "org_test", providerId: "slack", providerInstanceId: "workspace",
        providerBindingDigest: digest("binding"), providerConfigGeneration: 1,
        providerConfigGenerationDigest: digest("generation"), runtimeOwnerId: "relay",
        runtimeGeneration: 1, schemaGeneration: 1 } }) });
    const claimed = (await repository.claimNext())!;
    const renewed = (await repository.renewLease(claimed))!;
    await expect(fixture.pool.query(`UPDATE cp_provider_delivery_intent
      SET revision=revision+1,lease_fence='tampered',lease_fence_digest=$1
      WHERE intent_id='crash-intent'`, [digest("tampered")]))
      .rejects.toThrow(/invalid transition|immutable/u);
    const marker = digest("marker");
    const begun = (await repository.markBegin({ ...renewed,
      installationBeginMarkerId: "installation-begin", installationBeginMarkerDigest: marker,
      scopeBeginMarkerId: "scope-begin", scopeBeginMarkerDigest: marker }))!;
    time = new Date("2026-08-28T00:01:00.000Z");
    await expect(repository.finalizeStrandedBegun({ before: time.toISOString(),
      evidenceDigest: digest("restart") })).resolves.toBe(1);
    const durable = await fixture.pool.query("SELECT state,error_code FROM cp_provider_delivery_intent WHERE intent_id='crash-intent'");
    expect(durable.rows[0]).toEqual({ state: "outcome_unknown", error_code: "delivery_restart_after_begin" });
    await expect(repository.settleOrReadTerminal({ ...begun, outcome: "accepted",
      evidenceDigest: digest("late-response") })).rejects.toThrow(/terminal replay conflict/u);
    await expect(repository.settleOrReadTerminal({ ...begun, runtimeGeneration: 99,
      outcome: "accepted", evidenceDigest: digest("late-response") }))
      .rejects.toThrow(/tuple conflict/u);
    await expect(fixture.pool.query(
      "DELETE FROM cp_provider_delivery_intent WHERE intent_id='crash-intent'"))
      .rejects.toThrow(/immutable/u);
    await expect(fixture.pool.query(`UPDATE cp_provider_delivery_intent
      SET revision=revision+1,evidence_digest=$1 WHERE intent_id='crash-intent'`,
    [digest("terminal-drift")])).rejects.toThrow(/invalid transition|immutable/u);
  });

  it("rejects a direct pending-to-begun transition that violates state shape", async () => {
    const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool,
      owner: { runtimeOwnerId: "relay", runtimeGeneration: 1, schemaGeneration: 1 },
      leaseOwner: "worker", leaseSeconds: 30 });
    const value = DeliveryIntentV2Schema.parse({ contractVersion: 2, organizationId: "org_test", sideEffectIntentId: "shape-intent",
      causalId: "cause", intentKind: "delivery", operation: "create", deliveryKind: "message",
      presentationDigest: digest("presentation"), provenance: { kind: "business",
        repositoryIdentityDigest: digest("repo"), runId: "run", authorityLineageDigest: digest("authority") },
      providerBinding: { bindingKind: "established", providerId: "slack", providerInstanceId: "workspace",
        providerPrincipalDigest: digest("principal"), principalAssurance: "provider_verified",
        providerConfigGeneration: 1, providerConfigGenerationDigest: digest("generation"), lifecycle: "active",
        bindingDigest: digest("binding") }, targetDigest: digest("target"), authorityKind: "run_authority",
      authoritySnapshotDigest: digest("snapshot"), evidencePolicy: "local_audit", idempotencyKey: "shape-key",
      scope: { kind: "local_repository", id: "repo" }, createdAt: "2026-08-28T00:00:00.000Z",
      initialAttemptSequence: 1 });
    await repository.recordIntent(value, { envelopeVersion: 1, providerRequest: {}, phase: "running",
      frozenDeadline: "2026-08-29T00:00:00.000Z",
      currentTruth: deliveryCurrentTruthDescriptor({ intent: value, owner: {
        organizationId: "org_test", providerId: "slack", providerInstanceId: "workspace",
        providerBindingDigest: digest("binding"), providerConfigGeneration: 1,
        providerConfigGenerationDigest: digest("generation"), runtimeOwnerId: "relay",
        runtimeGeneration: 1, schemaGeneration: 1 } }) });
    await expect(fixture.pool.query(`UPDATE cp_provider_delivery_intent
      SET state='provider_io_begun',revision=revision+1 WHERE intent_id='shape-intent'`))
      .rejects.toThrow(/transition|shape/u);
  });
});
