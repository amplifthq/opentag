import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveryIntentV2Schema, deliveryCurrentTruthDescriptor } from "@opentag/delivery-contract";
import { createPostgresDeliveryRepository } from "../src/modules/provider-delivery/repository.js";
import { createTeamRelayProjectionService } from "../src/modules/provider-delivery/team-relay-projection.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const now = new Date("2026-09-01T00:00:00.000Z");
const owner = { runtimeOwnerId: "control-plane", runtimeGeneration: 1, schemaGeneration: 1 } as const;

describe.skipIf(!TEST_DATABASE_URL)("team relay projection outbox", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  beforeEach(async () => { fixture = await createIsolatedPostgres(); await fixture.migrate();
    await fixture.pool.query("INSERT INTO cp_organization(organization_id,display_name) VALUES('org_projection','Projection')");
    await fixture.pool.query(`INSERT INTO cp_runner(organization_id,runner_id,registration_generation,
      credential_generation,current_credential_id,capabilities,created_at,updated_at)
      VALUES('org_projection','runner_projection',1,1,'credential_projection','[]',$1,$1)`, [now]);
  });
  afterEach(async () => fixture.close());

  async function insertRun() {
    await fixture.pool.query(`INSERT INTO cp_hosted_run(organization_id,run_id,admission_id,
      admission_operation_id,admission_digest,source_identity_digest,runner_id,executor_id,
      source_version_ref,source_content_ids,source_context_digest,queue_claim_deadline,
      permission_ceiling_digest,publication_mode,publication_policy_digest,completion_mode,
      completion_contract_digest,state,current_attempt_number,hosted_admission,
      admission_policy_snapshot,created_at,updated_at)
      VALUES('org_projection','run_projection','admission_projection','operation_projection',$1,$2,
      'runner_projection','executor_projection','slack:T1:C1:1700000000.1',ARRAY['content_projection'],
      $3,$4,$5,'proposal_only',$6,'proposal_ready',$7,'queued',1,'{}','{}',$8,$8)`,
    [digest("admission"), digest("source"), digest("context"),
      new Date(now.getTime() + 300_000), digest("ceiling"), digest("policy"),
      digest("completion"), now]);
    await fixture.pool.query(`INSERT INTO cp_hosted_attempt(organization_id,run_id,attempt_number,
      attempt_id,runner_id,credential_id,fencing_token_digest,lease_expires_at,material_start_state,
      state,claimed_at,updated_at) VALUES('org_projection','run_projection',1,'attempt_projection',
      'runner_projection','credential_projection',$1,$2,'open','claimed',$3,$3)`,
    [digest("fence"), new Date(now.getTime() + 60_000), now]);
  }

  it("writes monotonic projection jobs in the same transaction as Run transitions", async () => {
    await insertRun();
    await fixture.pool.query("UPDATE cp_hosted_run SET state='running',updated_at=$1 WHERE run_id='run_projection'", [new Date(now.getTime()+1)]);
    await fixture.pool.query(`UPDATE cp_hosted_run SET state='failed',terminal_kind='failed',
      terminal_reason='test_failure',terminal_receipt=$2,updated_at=$1 WHERE run_id='run_projection'`,
    [new Date(now.getTime()+2), { kind: "test_failure" }]);
    const run = await fixture.pool.query("SELECT projection_revision FROM cp_hosted_run WHERE run_id='run_projection'");
    expect(run.rows[0]).toEqual({ projection_revision: 3 });
    const jobs = await fixture.pool.query(`SELECT (payload->>'projectionRevision')::bigint revision
      FROM cp_job WHERE job_kind='team-relay.project' ORDER BY revision`);
    expect(jobs.rows).toEqual([{ revision: "1" }, { revision: "2" }, { revision: "3" }]);
  });

  it("rejects a delayed older running projection after terminal revision commits", async () => {
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "projection-worker", leaseSeconds: 30, now: () => now });
    const intent = (revision: number, phase: "running" | "terminal") => DeliveryIntentV2Schema.parse({
      contractVersion: 2, organizationId: "org_projection", sideEffectIntentId: `intent_${phase}_${revision}`,
      causalId: "run_projection", intentKind: "delivery", operation: "create", deliveryKind: "message",
      presentationDigest: digest(`${phase}:${revision}`), projectionRevision: revision,
      provenance: { kind: "business", repositoryIdentityDigest: digest("repo"), runId: "run_projection",
        authorityLineageDigest: digest("authority") }, providerBinding: { bindingKind: "established",
        providerId: "slack", providerInstanceId: "A1", providerPrincipalDigest: digest("principal"),
        principalAssurance: "provider_verified", providerConfigGeneration: 1,
        providerConfigGenerationDigest: digest("generation"), lifecycle: "active", bindingDigest: digest("binding") },
      targetDigest: digest("target"), authorityKind: "run_authority", authoritySnapshotDigest: digest("snapshot"),
      evidencePolicy: "local_audit", idempotencyKey: `delivery_${phase}_${revision}`,
      statusMessageId: "run_projection:status", scope: { kind: "local_repository", id: "repo" },
      createdAt: new Date(now.getTime()+revision).toISOString(), initialAttemptSequence: 1 });
    const payload = (value: ReturnType<typeof intent>, phase: "running" | "terminal") => ({
      envelopeVersion: 1 as const, providerRequest: {}, phase,
      frozenDeadline: new Date(now.getTime()+300_000).toISOString(),
      currentTruth: deliveryCurrentTruthDescriptor({ intent: value, owner: {
        organizationId: value.organizationId, providerId: value.providerBinding.providerId,
        providerInstanceId: value.providerBinding.providerInstanceId,
        providerBindingDigest: value.providerBinding.bindingDigest,
        providerConfigGeneration: value.providerBinding.providerConfigGeneration,
        providerConfigGenerationDigest: value.providerBinding.providerConfigGenerationDigest, ...owner } }) });
    const terminal = intent(3, "terminal"); await repository.recordIntent(terminal, payload(terminal, "terminal"));
    const old = intent(2, "running");
    await expect(repository.recordIntent(old, payload(old, "running")))
      .rejects.toThrow("delivery_projection_revision_stale");
  });

  it("creates one Slack anchor and uses update_message for later projections", async () => {
    await insertRun();
    const requests: any[] = [];
    const baseline = DeliveryIntentV2Schema.parse({ contractVersion: 2, organizationId: "org_projection",
      sideEffectIntentId: "intent_baseline", causalId: "run_projection", intentKind: "delivery",
      operation: "create", deliveryKind: "message", presentationDigest: digest("baseline"),
      provenance: { kind: "business", repositoryIdentityDigest: digest("repo"), runId: "run_projection",
        authorityLineageDigest: digest("authority") }, providerBinding: { bindingKind: "established",
        providerId: "slack", providerInstanceId: "A1", providerPrincipalDigest: digest("principal"),
        principalAssurance: "provider_verified", providerConfigGeneration: 1,
        providerConfigGenerationDigest: digest("generation"), lifecycle: "active", bindingDigest: digest("binding") },
      targetDigest: digest("target"), authorityKind: "run_authority", authoritySnapshotDigest: digest("snapshot"),
      evidencePolicy: "local_audit", idempotencyKey: "baseline", statusMessageId: "run_projection:status",
      scope: { kind: "local_repository", id: "repo" }, createdAt: now.toISOString(), initialAttemptSequence: 1 });
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "anchor-worker", leaseSeconds: 30, now: () => now });
    const payload = { envelopeVersion: 1 as const, providerRequest: { operation: {
      kind: "create_message", channelId: "C1", threadTs: "1700000000.1" },
      presentation: { kind: "message", text: "old" } }, phase: "received" as const,
      frozenDeadline: new Date(now.getTime()+300_000).toISOString(),
      currentTruth: deliveryCurrentTruthDescriptor({ intent: baseline, owner: {
        organizationId: baseline.organizationId, providerId: baseline.providerBinding.providerId,
        providerInstanceId: baseline.providerBinding.providerInstanceId,
        providerBindingDigest: baseline.providerBinding.bindingDigest,
        providerConfigGeneration: baseline.providerBinding.providerConfigGeneration,
        providerConfigGenerationDigest: baseline.providerBinding.providerConfigGenerationDigest, ...owner } }) };
    await repository.recordIntent(baseline, payload);
    const claimed = (await repository.claimNext())!;
    const renewed = (await repository.renewLease(claimed))!;
    const begun = (await repository.markBegin({ ...renewed,
      installationBeginMarkerId: "installation", installationBeginMarkerDigest: digest("marker"),
      scopeBeginMarkerId: "scope", scopeBeginMarkerDigest: digest("marker") }))!;
    await repository.settleOrReadTerminal({ ...begun, outcome: "accepted",
      evidenceDigest: digest("evidence"), externalResourceId: "171.001",
      externalResourceDigest: digest("resource") });
    const service = createTeamRelayProjectionService({ pool: fixture.pool,
      hosted: { inspect: async () => ({ state: "queued", canonicalStatus: "queued",
        status: "waiting_for_runner", queueClaimDeadline: new Date(now.getTime()+300_000).toISOString(),
        outcome: null, terminalKind: null, terminalReason: null }) } as any,
      producer: { async enqueue(value) { requests.push(value); } }, clock: { now: () => now } });
    await service.projectRun({ organizationId: "org_projection", runId: "run_projection" });
    expect(requests).toHaveLength(1);
    expect(requests[0].intent.operation).toBe("update");
    expect(requests[0].providerRequest.operation).toEqual({ kind: "update_message",
      channelId: "C1", messageTs: "171.001" });
  });
});
