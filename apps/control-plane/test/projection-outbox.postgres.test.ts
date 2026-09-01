import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveryIntentV2Schema, deliveryCurrentTruthDescriptor,
  deliveryExternalResourceLookupDescriptor } from "@opentag/delivery-contract";
import { createPostgresDeliveryRepository,
  readExactDeliveryAnchor } from "../src/modules/provider-delivery/repository.js";
import { createTeamRelayProjectionJobHandler,
  createTeamRelayProjectionService } from "../src/modules/provider-delivery/team-relay-projection.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";
import { checkProjectionSchemaReadiness, runMigrations } from "../src/database/migrations.js";
import { createDurableJobQueue } from "../src/modules/jobs/index.js";
import { runOneJob } from "../src/modules/jobs/worker.js";

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

  it("upgrades pre-0019 delivery jobs, seeds the cursor, and projects the exact legacy event once", async () => {
    await fixture.close();
    fixture = await createIsolatedPostgres();
    const firstNewMigration = fixture.migrations.findIndex((migration) =>
      migration.name === "0019_projection_event_sequence.sql");
    expect(firstNewMigration).toBeGreaterThan(0);
    await runMigrations(fixture.pool, fixture.migrations.slice(0, firstNewMigration));
    await fixture.pool.query("INSERT INTO cp_organization(organization_id,display_name) VALUES('org_projection','Projection')");
    await fixture.pool.query(`INSERT INTO cp_runner(organization_id,runner_id,registration_generation,
      credential_generation,current_credential_id,capabilities,created_at,updated_at)
      VALUES('org_projection','runner_projection',1,1,'credential_projection','[]',$1,$1)`, [now]);
    await insertRun();
    const legacyIntent = DeliveryIntentV2Schema.parse({ contractVersion: 2,
      organizationId: "org_projection", sideEffectIntentId: "intent_legacy_event",
      causalId: "legacy-event", intentKind: "delivery", operation: "update", deliveryKind: "message",
      presentationDigest: digest("legacy-event"), provenance: { kind: "business",
        repositoryIdentityDigest: digest("repo"), runId: "run_projection",
        authorityLineageDigest: digest("authority") }, providerBinding: { bindingKind: "established",
        providerId: "slack", providerInstanceId: "A1", providerPrincipalDigest: digest("principal"),
        principalAssurance: "provider_verified", providerConfigGeneration: 1,
        providerConfigGenerationDigest: digest("generation"), lifecycle: "active",
        bindingDigest: digest("binding") }, targetDigest: digest("target"),
      authorityKind: "run_authority", authoritySnapshotDigest: digest("snapshot"),
      evidencePolicy: "local_audit", idempotencyKey: "legacy-event", statusMessageId: "external:status",
      scope: { kind: "local_repository", id: "repo" }, createdAt: now.toISOString(),
      initialAttemptSequence: 1 });
    await fixture.pool.query(`INSERT INTO cp_provider_delivery_intent(intent_id,organization_id,
      journal_intent_digest,intent,payload,payload_digest,payload_custody_ref,presentation_phase,
      current_truth_key,state,revision,sequence,scope_kind,scope_id,idempotency_key,provider_id,
      provider_instance_id,provider_binding_digest,provider_config_generation,
      provider_config_generation_digest,runtime_owner_id,runtime_generation,schema_generation,
      authority_snapshot_digest,status_message_id,run_id,projection_revision,projection_purpose,
      deadline_at,created_at,updated_at)
      VALUES($1,'org_projection',$2,$3,$4,$5,'legacy-custody','running',$6,'pending',1,1,
      'local_repository','repo','legacy-event','slack','A1',$7,1,$8,'control-plane',1,1,$9,
      'external:status','run_projection',1,'external',$10,$11,$11)`,
    [legacyIntent.sideEffectIntentId,digest("legacy-journal"),legacyIntent,
      {providerRequest:{operation:{kind:"update_message",channelId:"C1",messageTs:"170.1"}}},
      digest("legacy-payload"),digest("legacy-truth"),digest("binding"),digest("generation"),
      digest("snapshot"),new Date(now.getTime()+300_000),now]);
    await fixture.pool.query(`UPDATE cp_provider_delivery_intent SET state='leased',revision=2,
      lease_owner='legacy-worker',lease_expires_at=$2,lease_fence='legacy-fence',lease_fence_digest=$3,
      updated_at=$4 WHERE intent_id=$1`,[legacyIntent.sideEffectIntentId,
      new Date(now.getTime()+60_000),digest("legacy-fence"),new Date(now.getTime()+1)]);
    await fixture.pool.query(`UPDATE cp_provider_delivery_intent SET state='provider_io_begun',revision=3,
      installation_begin_marker_id='legacy-install',installation_begin_marker_digest=$2,
      scope_begin_marker_id='legacy-scope',scope_begin_marker_digest=$2,begun_at=$3,updated_at=$3
      WHERE intent_id=$1`,[legacyIntent.sideEffectIntentId,digest("legacy-marker"),new Date(now.getTime()+2)]);
    await fixture.pool.query(`UPDATE cp_provider_delivery_intent SET state='rejected',revision=4,
      evidence_digest=$2,error_code='slack_rejected',outcome_recorded_at=$3,updated_at=$3
      WHERE intent_id=$1`,[legacyIntent.sideEffectIntentId,digest("legacy-evidence"),new Date(now.getTime()+3)]);
    const legacyJob = await fixture.pool.query<{job_id:string}>(`SELECT job_id FROM cp_job
      WHERE job_kind='team-relay.project' AND payload->>'deliveryIntentId'=$1
        AND (payload->>'deliveryRevision')::integer=4`,[legacyIntent.sideEffectIntentId]);
    expect(legacyJob.rows).toHaveLength(1);
    await runMigrations(fixture.pool,fixture.migrations);
    const cursor = await fixture.pool.query<{current_sequence:number}>(`SELECT current_sequence
      FROM cp_projection_event_cursor WHERE organization_id='org_projection' AND run_id='run_projection'`);
    const historicalMax = await fixture.pool.query<{maximum:number}>(`SELECT max(event_sequence)::int maximum
      FROM cp_projection_delivery_watermark WHERE organization_id='org_projection' AND run_id='run_projection'`);
    expect(cursor.rows[0]?.current_sequence).toBe(historicalMax.rows[0]?.maximum);
    const migrated = await fixture.pool.query<{payload:any}>("SELECT payload FROM cp_job WHERE job_id=$1",
      [legacyJob.rows[0]!.job_id]);
    expect(migrated.rows[0]?.payload).toMatchObject({ deliveryIntentId: legacyIntent.sideEffectIntentId,
      deliveryRevision: 4, eventSequence: expect.any(Number) });
    await fixture.pool.query(`UPDATE cp_job SET state='succeeded' WHERE job_kind='team-relay.project'
      AND job_id<>$1`,[legacyJob.rows[0]!.job_id]);
    const projected: any[]=[];
    const projectionRepository=createPostgresDeliveryRepository({pool:fixture.pool,owner,
      leaseOwner:"legacy-projection",leaseSeconds:30,now:()=>new Date(now.getTime()+10)});
    const service=createTeamRelayProjectionService({pool:fixture.pool,hosted:{inspect:async()=>({
      state:"queued",canonicalStatus:"queued",status:"waiting_for_runner",
      queueClaimDeadline:new Date(now.getTime()+300_000).toISOString(),outcome:null,
      terminalKind:null,terminalReason:null})} as any,clock:{now:()=>new Date(now.getTime()+10)},
      producer:{async enqueue(value){projected.push(value);await projectionRepository.recordIntent(value.intent,{
        envelopeVersion:1,providerRequest:value.providerRequest,phase:value.phase,
        frozenDeadline:new Date(now.getTime()+300_000).toISOString(),currentTruth:deliveryCurrentTruthDescriptor({
          intent:value.intent,owner:{organizationId:"org_projection",providerId:"slack",providerInstanceId:"A1",
            providerBindingDigest:digest("binding"),providerConfigGeneration:1,
            providerConfigGenerationDigest:digest("generation"),...owner}})});}}});
    const queueNow=new Date("2026-09-02T00:00:00.000Z");
    const queue=createDurableJobQueue({pool:fixture.pool,clock:{now:()=>queueNow},
      leaseDurationMs:30_000,tokenFactory:()=>"legacy-job-lease"});
    await expect(runOneJob({queue,workerId:"legacy-worker",handlers:{
      "team-relay.project":createTeamRelayProjectionJobHandler(service)},retryDelayMs:1000,
      clock:{now:()=>queueNow}})).resolves.toEqual({kind:"settled",jobId:legacyJob.rows[0]!.job_id});
    expect(projected).toHaveLength(1);
    expect(projected[0]?.intent.projectionEventSequence).toBe(migrated.rows[0]?.payload.eventSequence);
    const nextIntent=DeliveryIntentV2Schema.parse({...legacyIntent,sideEffectIntentId:"intent_after_upgrade",
      idempotencyKey:"after-upgrade",scope:{kind:"local_repository",id:"repo-after-upgrade"},
      presentationDigest:digest("after-upgrade"),createdAt:new Date(now.getTime()+5).toISOString()});
    const nextRepository=createPostgresDeliveryRepository({pool:fixture.pool,owner,
      leaseOwner:"after-upgrade-worker",leaseSeconds:30,now:()=>new Date(now.getTime()+20)});
    await nextRepository.recordIntent(nextIntent,{envelopeVersion:1,providerRequest:{},phase:"running",
      frozenDeadline:new Date(now.getTime()+300_000).toISOString(),currentTruth:deliveryCurrentTruthDescriptor({
        intent:nextIntent,owner:{organizationId:"org_projection",providerId:"slack",providerInstanceId:"A1",
          providerBindingDigest:digest("binding"),providerConfigGeneration:1,
          providerConfigGenerationDigest:digest("generation"),...owner}})});
    const nextClaim=(await nextRepository.claimNext())!;
    const nextRenewed=(await nextRepository.renewLease(nextClaim))!;
    const nextBegun=(await nextRepository.markBegin({...nextRenewed,
      installationBeginMarkerId:"after-upgrade-install",installationBeginMarkerDigest:digest("after-upgrade-marker"),
      scopeBeginMarkerId:"after-upgrade-scope",scopeBeginMarkerDigest:digest("after-upgrade-marker")}))!;
    await nextRepository.settleOrReadTerminal({...nextBegun,outcome:"accepted",
      evidenceDigest:digest("after-upgrade-evidence")});
    const newEvent=await fixture.pool.query<{event_sequence:number}>(`SELECT event_sequence
      FROM cp_projection_delivery_watermark WHERE intent_id=$1 AND delivery_state='accepted'`,
    [nextIntent.sideEffectIntentId]);
    expect(newEvent.rows).toEqual([{event_sequence:historicalMax.rows[0]!.maximum+1}]);
    const newJobs=await fixture.pool.query<{count:number}>(`SELECT count(*)::int count FROM cp_job
      WHERE job_kind='team-relay.project' AND payload->>'deliveryIntentId'=$1
        AND (payload->>'eventSequence')::integer=$2`,[nextIntent.sideEffectIntentId,newEvent.rows[0]!.event_sequence]);
    expect(newJobs.rows).toEqual([{count:1}]);
  });

  it("rejects a delayed older running projection after terminal revision commits", async () => {
    await insertRun();
    await fixture.pool.query("UPDATE cp_hosted_run SET state='running',updated_at=$1 WHERE run_id='run_projection'",
      [new Date(now.getTime()+1)]);
    await fixture.pool.query(`UPDATE cp_hosted_run SET state='failed',terminal_kind='failed',
      terminal_reason='terminal',terminal_receipt=$1,updated_at=$2 WHERE run_id='run_projection'`,
    [{kind:"terminal"},new Date(now.getTime()+2)]);
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

  it("never treats an external create delivery as the Slack status anchor", async () => {
    await insertRun();
    const external=DeliveryIntentV2Schema.parse({contractVersion:2,organizationId:"org_projection",
      sideEffectIntentId:"intent_external_not_anchor",causalId:"run_projection",intentKind:"delivery",
      operation:"create",deliveryKind:"message",presentationDigest:digest("external-not-anchor"),
      projectionPurpose:"external",provenance:{kind:"business",repositoryIdentityDigest:digest("repo"),
        runId:"run_projection",authorityLineageDigest:digest("authority")},providerBinding:{
        bindingKind:"established",providerId:"slack",providerInstanceId:"A1",
        providerPrincipalDigest:digest("principal"),principalAssurance:"provider_verified",
        providerConfigGeneration:1,providerConfigGenerationDigest:digest("generation"),lifecycle:"active",
        bindingDigest:digest("binding")},targetDigest:digest("target"),authorityKind:"run_authority",
      authoritySnapshotDigest:digest("snapshot"),evidencePolicy:"local_audit",idempotencyKey:"external-not-anchor",
      statusMessageId:"run_projection:status",scope:{kind:"local_repository",id:"repo"},
      createdAt:now.toISOString(),initialAttemptSequence:1});
    const repository=createPostgresDeliveryRepository({pool:fixture.pool,owner,
      leaseOwner:"external-not-anchor",leaseSeconds:30,now:()=>now});
    await repository.recordIntent(external,{envelopeVersion:1,providerRequest:{},phase:"running",
      frozenDeadline:new Date(now.getTime()+300_000).toISOString(),currentTruth:deliveryCurrentTruthDescriptor({
        intent:external,owner:{organizationId:"org_projection",providerId:"slack",providerInstanceId:"A1",
          providerBindingDigest:digest("binding"),providerConfigGeneration:1,
          providerConfigGenerationDigest:digest("generation"),...owner}})});
    const descriptor=deliveryExternalResourceLookupDescriptor({intent:external,
      statusMessageId:"run_projection:status",owner:{organizationId:"org_projection",providerId:"slack",
        providerInstanceId:"A1",providerBindingDigest:digest("binding"),providerConfigGeneration:1,
        providerConfigGenerationDigest:digest("generation"),...owner}});
    await expect(readExactDeliveryAnchor(fixture.pool,descriptor,{projectionPurpose:"anchor_create"}))
      .resolves.toEqual({outcome:"none"});
  });

  it("creates one Slack anchor and uses update_message for later projections", async () => {
    await insertRun();
    const requests: any[] = [];
    const baseline = DeliveryIntentV2Schema.parse({ contractVersion: 2, organizationId: "org_projection",
      sideEffectIntentId: "intent_baseline", causalId: "run_projection", intentKind: "delivery",
      operation: "create", deliveryKind: "message", presentationDigest: digest("baseline"),
      projectionPurpose:"anchor_create",
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
    const external=DeliveryIntentV2Schema.parse({...baseline,sideEffectIntentId:"external_rejected",
      idempotencyKey:"external_rejected",projectionPurpose:"external",
      presentationDigest:digest("external-rejected"),createdAt:new Date(now.getTime()+1).toISOString()});
    const externalPayload={...payload,currentTruth:deliveryCurrentTruthDescriptor({intent:external,owner:{
      organizationId:external.organizationId,providerId:"slack",providerInstanceId:"A1",
      providerBindingDigest:digest("binding"),providerConfigGeneration:1,
      providerConfigGenerationDigest:digest("generation"),...owner}})};
    await fixture.pool.query("UPDATE cp_job SET state='succeeded' WHERE job_kind='team-relay.project'");
    await repository.recordIntent(external,externalPayload);
    const externalClaim=(await repository.claimNext())!;
    const externalRenewed=(await repository.renewLease(externalClaim))!;
    const externalBegun=(await repository.markBegin({...externalRenewed,
      installationBeginMarkerId:"external-install",installationBeginMarkerDigest:digest("external-marker"),
      scopeBeginMarkerId:"external-scope",scopeBeginMarkerDigest:digest("external-marker")}))!;
    await repository.settleOrReadTerminal({...externalBegun,outcome:"rejected",
      evidenceDigest:digest("external-evidence"),errorCode:"slack_rejected"});
    const event=await fixture.pool.query<{delivery_revision:number;event_sequence:number}>(`SELECT delivery_revision,event_sequence
      FROM cp_projection_delivery_watermark WHERE intent_id='external_rejected' AND delivery_state='rejected'`);
    await fixture.pool.query("UPDATE cp_hosted_run SET updated_at=$1 WHERE run_id='run_projection'",
      [new Date(now.getTime()+3)]);
    const eventService=createTeamRelayProjectionService({pool:fixture.pool,hosted:{inspect:async()=>({
      state:"queued",canonicalStatus:"queued",status:"waiting_for_runner",
      queueClaimDeadline:new Date(now.getTime()+300_000).toISOString(),outcome:null,
      terminalKind:null,terminalReason:null})} as any,clock:{now:()=>new Date(now.getTime()+4)},
      producer:{async enqueue(value){requests.push(value);await repository.recordIntent(value.intent,{
        envelopeVersion:1,providerRequest:value.providerRequest,phase:value.phase,
        frozenDeadline:new Date(now.getTime()+300_000).toISOString(),currentTruth:deliveryCurrentTruthDescriptor({
          intent:value.intent,owner:{organizationId:"org_projection",providerId:"slack",providerInstanceId:"A1",
            providerBindingDigest:digest("binding"),providerConfigGeneration:1,
            providerConfigGenerationDigest:digest("generation"),...owner}})});}}});
    const eventClock=new Date("2026-09-02T00:00:00.000Z");
    const queue=createDurableJobQueue({pool:fixture.pool,clock:{now:()=>eventClock},
      leaseDurationMs:30_000,tokenFactory:()=>"event-job-lease"});
    await expect(runOneJob({queue,workerId:"event-worker",handlers:{
      "team-relay.project":createTeamRelayProjectionJobHandler(eventService)},retryDelayMs:1000,
      clock:{now:()=>eventClock}})).resolves.toMatchObject({kind:"settled"});
    expect(requests[1]?.intent.projectionRevision).toBe(2);
    expect(requests[1]?.intent.projectionEventSequence).toBe(event.rows[0]!.event_sequence);
    expect((await fixture.pool.query(`SELECT projection_revision,projection_event_sequence,state
      FROM cp_provider_delivery_intent WHERE intent_id=$1`,[requests[1]!.intent.sideEffectIntentId])).rows[0])
      .toEqual({projection_revision:2,projection_event_sequence:event.rows[0]!.event_sequence,state:"pending"});
    await fixture.pool.query(`INSERT INTO cp_provider_delivery_intent(
      intent_id,organization_id,journal_intent_digest,intent,payload,payload_digest,payload_custody_ref,
      presentation_phase,current_truth_key,state,revision,sequence,scope_kind,scope_id,idempotency_key,
      provider_id,provider_instance_id,provider_binding_digest,provider_config_generation,
      provider_config_generation_digest,runtime_owner_id,runtime_generation,schema_generation,
      authority_snapshot_digest,status_message_id,run_id,projection_revision,projection_purpose,lease_owner,lease_expires_at,
      lease_fence,lease_fence_digest,installation_begin_marker_id,installation_begin_marker_digest,
      scope_begin_marker_id,scope_begin_marker_digest,begun_at,evidence_digest,external_resource_digest,
      external_resource_id,outcome_recorded_at,deadline_at,created_at,updated_at)
      SELECT 'intent_duplicate_anchor',organization_id,$1,
        jsonb_set(jsonb_set(intent,'{sideEffectIntentId}','"intent_duplicate_anchor"'),
          '{idempotencyKey}','"duplicate_anchor"'),payload,$2,'duplicate-custody',presentation_phase,
        current_truth_key,state,revision,sequence,scope_kind,scope_id,'duplicate_anchor',provider_id,
        provider_instance_id,provider_binding_digest,provider_config_generation,
        provider_config_generation_digest,runtime_owner_id,runtime_generation,schema_generation,
        authority_snapshot_digest,status_message_id,run_id,projection_revision,projection_purpose,lease_owner,lease_expires_at,
        lease_fence,lease_fence_digest,installation_begin_marker_id,installation_begin_marker_digest,
        scope_begin_marker_id,scope_begin_marker_digest,begun_at,$3,$4,'171.009',outcome_recorded_at,
        deadline_at,created_at+interval '1 millisecond',updated_at
      FROM cp_provider_delivery_intent WHERE intent_id='intent_baseline'`,
    [digest("duplicate-journal"),digest("duplicate-payload"),digest("duplicate-evidence"),
      digest("duplicate-resource")]);
    await expect(service.projectRun({ organizationId:"org_projection",runId:"run_projection" }))
      .resolves.toMatchObject({kind:"anchor_ambiguous"});
    expect(requests).toHaveLength(2);
  });

  it("keeps the newest external outcome across ordinary Run revisions until a newer event supersedes it", async () => {
    await insertRun();
    const baseline = DeliveryIntentV2Schema.parse({ contractVersion: 2,
      organizationId: "org_projection", sideEffectIntentId: "intent_truth_anchor",
      causalId: "run_projection", intentKind: "delivery", operation: "create",
      deliveryKind: "message", presentationDigest: digest("truth-anchor"),
      projectionPurpose: "anchor_create", provenance: { kind: "business",
        repositoryIdentityDigest: digest("repo"), runId: "run_projection",
        authorityLineageDigest: digest("authority") }, providerBinding: { bindingKind: "established",
        providerId: "slack", providerInstanceId: "A1", providerPrincipalDigest: digest("principal"),
        principalAssurance: "provider_verified", providerConfigGeneration: 1,
        providerConfigGenerationDigest: digest("generation"), lifecycle: "active",
        bindingDigest: digest("binding") }, targetDigest: digest("target"),
      authorityKind: "run_authority", authoritySnapshotDigest: digest("snapshot"),
      evidencePolicy: "local_audit", idempotencyKey: "truth-anchor",
      statusMessageId: "run_projection:status", scope: { kind: "local_repository", id: "repo" },
      createdAt: now.toISOString(), initialAttemptSequence: 1 });
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "truth-worker", leaseSeconds: 30, now: () => now });
    const payloadFor = (value: typeof baseline) => ({ envelopeVersion: 1 as const,
      providerRequest: { operation: { kind: "create_message", channelId: "C1",
        threadTs: "1700000000.1" }, presentation: { kind: "message", text: "old" } },
      phase: "received" as const, frozenDeadline: new Date(now.getTime() + 300_000).toISOString(),
      currentTruth: deliveryCurrentTruthDescriptor({ intent: value, owner: {
        organizationId: value.organizationId, providerId: value.providerBinding.providerId,
        providerInstanceId: value.providerBinding.providerInstanceId,
        providerBindingDigest: value.providerBinding.bindingDigest,
        providerConfigGeneration: value.providerBinding.providerConfigGeneration,
        providerConfigGenerationDigest: value.providerBinding.providerConfigGenerationDigest, ...owner } }) });
    await repository.recordIntent(baseline, payloadFor(baseline));
    const anchorClaim = (await repository.claimNext())!;
    const anchorRenewed = (await repository.renewLease(anchorClaim))!;
    const anchorBegun = (await repository.markBegin({ ...anchorRenewed,
      installationBeginMarkerId: "truth-anchor-install", installationBeginMarkerDigest: digest("truth-anchor-marker"),
      scopeBeginMarkerId: "truth-anchor-scope", scopeBeginMarkerDigest: digest("truth-anchor-marker") }))!;
    await repository.settleOrReadTerminal({ ...anchorBegun, outcome: "accepted",
      evidenceDigest: digest("truth-anchor-evidence"), externalResourceId: "171.100",
      externalResourceDigest: digest("truth-anchor-resource") });
    const external = DeliveryIntentV2Schema.parse({ ...baseline, sideEffectIntentId: "intent_truth_external",
      idempotencyKey: "truth-external", projectionPurpose: "external",
      presentationDigest: digest("truth-external"), createdAt: new Date(now.getTime() + 1).toISOString() });
    await repository.recordIntent(external, payloadFor(external));
    const externalClaim = (await repository.claimNext())!;
    const externalRenewed = (await repository.renewLease(externalClaim))!;
    const externalBegun = (await repository.markBegin({ ...externalRenewed,
      installationBeginMarkerId: "truth-external-install", installationBeginMarkerDigest: digest("truth-external-marker"),
      scopeBeginMarkerId: "truth-external-scope", scopeBeginMarkerDigest: digest("truth-external-marker") }))!;
    await repository.settleOrReadTerminal({ ...externalBegun, outcome: "outcome_unknown",
      evidenceDigest: digest("truth-external-evidence"), errorCode: "ambiguous_response" });
    const projected: any[] = [];
    const service = createTeamRelayProjectionService({ pool: fixture.pool,
      hosted: { inspect: async () => ({ state: "queued", canonicalStatus: "queued",
        status: "waiting_for_runner", queueClaimDeadline: new Date(now.getTime() + 300_000).toISOString(),
        outcome: null, terminalKind: null, terminalReason: null }) } as any,
      producer: { async enqueue(value) { projected.push(value); } }, clock: { now: () => now } });
    const first = await service.projectRun({ organizationId: "org_projection", runId: "run_projection" });
    expect(first).toMatchObject({ kind: "queued", presentation: { providerDelivery: {
      state: "outcome_unknown", reasonCode: "ambiguous_response" } } });
    await fixture.pool.query("UPDATE cp_hosted_run SET updated_at=$1 WHERE run_id='run_projection'",
      [new Date(now.getTime() + 2)]);
    const ordinary = await service.projectRun({ organizationId: "org_projection", runId: "run_projection" });
    expect(ordinary).toMatchObject({ kind: "queued", presentation: { providerDelivery: {
      state: "outcome_unknown", reasonCode: "ambiguous_response" } } });
    const newer=DeliveryIntentV2Schema.parse({...external,sideEffectIntentId:"intent_truth_newer",
      idempotencyKey:"truth-newer",scope:{kind:"local_repository",id:"repo-newer"},
      presentationDigest:digest("truth-newer"),createdAt:new Date(now.getTime()+3).toISOString()});
    await repository.recordIntent(newer,payloadFor(newer));
    const newerClaim=(await repository.claimNext())!;
    const newerRenewed=(await repository.renewLease(newerClaim))!;
    const newerBegun=(await repository.markBegin({...newerRenewed,
      installationBeginMarkerId:"truth-newer-install",installationBeginMarkerDigest:digest("truth-newer-marker"),
      scopeBeginMarkerId:"truth-newer-scope",scopeBeginMarkerDigest:digest("truth-newer-marker")}))!;
    await repository.settleOrReadTerminal({...newerBegun,outcome:"accepted",
      evidenceDigest:digest("truth-newer-evidence")});
    const superseded=await service.projectRun({organizationId:"org_projection",runId:"run_projection"});
    expect(superseded).toMatchObject({kind:"queued",presentation:{providerDelivery:{state:"accepted"}}});
    expect(projected).toHaveLength(3);
  });

  it("defers N+1 while the one exact create anchor is still begun", async () => {
    await insertRun(); const requests: any[] = [];
    const baseline = DeliveryIntentV2Schema.parse({ contractVersion: 2, organizationId: "org_projection",
      sideEffectIntentId: "intent_anchor_begun", causalId: "run_projection", intentKind: "delivery",
      operation: "create", deliveryKind: "message", presentationDigest: digest("begun"), projectionRevision: 1,
      projectionPurpose:"anchor_create",
      provenance: { kind: "business", repositoryIdentityDigest: digest("repo"), runId: "run_projection",
        authorityLineageDigest: digest("authority") }, providerBinding: { bindingKind: "established",
        providerId: "slack", providerInstanceId: "A1", providerPrincipalDigest: digest("principal"),
        principalAssurance: "provider_verified", providerConfigGeneration: 1,
        providerConfigGenerationDigest: digest("generation"), lifecycle: "active", bindingDigest: digest("binding") },
      targetDigest: digest("target"), authorityKind: "run_authority", authoritySnapshotDigest: digest("snapshot"),
      evidencePolicy: "local_audit", idempotencyKey: "anchor_begun", statusMessageId: "run_projection:status",
      scope: { kind: "local_repository", id: "repo" }, createdAt: now.toISOString(), initialAttemptSequence: 1 });
    const repository = createPostgresDeliveryRepository({ pool: fixture.pool, owner,
      leaseOwner: "anchor-begun", leaseSeconds: 30, now: () => now });
    const payload = { envelopeVersion: 1 as const, providerRequest: { operation: {
      kind: "create_message", channelId: "C1", threadTs: "1700000000.1" },
      presentation: { kind: "message", text: "creating" } }, phase: "received" as const,
      frozenDeadline: new Date(now.getTime()+300_000).toISOString(),
      currentTruth: deliveryCurrentTruthDescriptor({ intent: baseline, owner: {
        organizationId: baseline.organizationId, providerId: "slack", providerInstanceId: "A1",
        providerBindingDigest: digest("binding"), providerConfigGeneration: 1,
        providerConfigGenerationDigest: digest("generation"), ...owner } }) };
    await repository.recordIntent(baseline,payload);
    const claim=(await repository.claimNext())!; const renewed=(await repository.renewLease(claim))!;
    const begun=(await repository.markBegin({ ...renewed, installationBeginMarkerId:"installation",
      installationBeginMarkerDigest:digest("marker"),scopeBeginMarkerId:"scope",
      scopeBeginMarkerDigest:digest("marker") }))!;
    const service=createTeamRelayProjectionService({ pool:fixture.pool,
      hosted:{ inspect:async()=>({ state:"running",canonicalStatus:"running",status:"running",
        queueClaimDeadline:new Date(now.getTime()+300_000).toISOString(),outcome:null,
        terminalKind:null,terminalReason:null }) } as any,
      producer:{ async enqueue(value){requests.push(value);} },clock:{now:()=>new Date(now.getTime()+1)} });
    await expect(service.projectRun({organizationId:"org_projection",runId:"run_projection"}))
      .resolves.toMatchObject({kind:"anchor_pending"});
    expect(requests).toHaveLength(0);
    await fixture.pool.query(`INSERT INTO cp_projection_deferred_revision(organization_id,run_id,
      projection_revision,anchor_intent_id,state,created_at)
      VALUES('org_projection','run_projection',2,'unrelated_anchor','pending',$1)`,[now]);
    await fixture.pool.query("UPDATE cp_job SET state='succeeded' WHERE job_kind='team-relay.project'");
    await repository.settleOrReadTerminal({ ...begun,outcome:"accepted",
      evidenceDigest:digest("accepted"),externalResourceId:"171.002",
      externalResourceDigest:digest("resource") });
    const deliveryJobs=await fixture.pool.query(`SELECT job_id FROM cp_job
      WHERE state='pending' AND job_kind='team-relay.project'`);
    expect(deliveryJobs.rows).toHaveLength(1);
    expect(deliveryJobs.rows[0]?.job_id).toMatch(/^team-relay-anchor-wake:/u);
    expect((await fixture.pool.query(`SELECT projection_revision,state FROM cp_projection_deferred_revision
      WHERE run_id='run_projection' ORDER BY projection_revision`)).rows).toEqual([
      {projection_revision:1,state:"woken"},{projection_revision:2,state:"pending"}]);
    const wakeClock=new Date("2026-09-02T00:00:00.000Z");
    const wakeQueue=createDurableJobQueue({pool:fixture.pool,clock:{now:()=>wakeClock},
      leaseDurationMs:30_000,tokenFactory:()=>"wake-job-lease"});
    await expect(runOneJob({queue:wakeQueue,workerId:"wake-worker",handlers:{
      "team-relay.project":createTeamRelayProjectionJobHandler(service)},retryDelayMs:1000,
      clock:{now:()=>wakeClock}})).resolves.toMatchObject({kind:"settled"});
    expect(requests).toHaveLength(1);
    expect(requests[0]?.intent.operation).toBe("update");
    await fixture.pool.query("UPDATE cp_job SET state='succeeded' WHERE job_kind='team-relay.project'");
    const selfIntent=DeliveryIntentV2Schema.parse({...baseline,
      sideEffectIntentId:"intent_projection_self",idempotencyKey:"projection_self",
      operation:"update",projectionPurpose:"anchor_update",presentationDigest:digest("self"),
      createdAt:new Date(now.getTime()+2).toISOString()});
    const selfPayload={...payload,phase:"received" as const,
      currentTruth:deliveryCurrentTruthDescriptor({intent:selfIntent,owner:{
        organizationId:selfIntent.organizationId,providerId:"slack",providerInstanceId:"A1",
        providerBindingDigest:digest("binding"),providerConfigGeneration:1,
        providerConfigGenerationDigest:digest("generation"),...owner}})};
    await repository.recordIntent(selfIntent,selfPayload);
    const selfClaim=(await repository.claimNext())!; const selfRenewed=(await repository.renewLease(selfClaim))!;
    const selfBegun=(await repository.markBegin({...selfRenewed,installationBeginMarkerId:"self-install",
      installationBeginMarkerDigest:digest("self-marker"),scopeBeginMarkerId:"self-scope",
      scopeBeginMarkerDigest:digest("self-marker")}))!;
    await repository.settleOrReadTerminal({...selfBegun,outcome:"accepted",evidenceDigest:digest("self-evidence"),
      externalResourceId:"171.002",externalResourceDigest:digest("self-resource")});
    expect((await fixture.pool.query(`SELECT count(*)::int count FROM cp_job
      WHERE state='pending' AND job_kind='team-relay.project'`)).rows[0]).toEqual({count:0});
    const {projectionRevision:_uncertainRevision,...uncertainBase}=baseline;
    const uncertain=DeliveryIntentV2Schema.parse({...uncertainBase,
      sideEffectIntentId:"uncertain_attention",idempotencyKey:"uncertain_attention",
      presentationDigest:digest("uncertain"),createdAt:new Date(now.getTime()+3).toISOString()});
    const uncertainPayload={...payload,currentTruth:deliveryCurrentTruthDescriptor({intent:uncertain,owner:{
      organizationId:uncertain.organizationId,providerId:"slack",providerInstanceId:"A1",
      providerBindingDigest:digest("binding"),providerConfigGeneration:1,
      providerConfigGenerationDigest:digest("generation"),...owner}})};
    await repository.recordIntent(uncertain,uncertainPayload);
    const uncertainClaim=(await repository.claimNext())!;
    const uncertainRenewed=(await repository.renewLease(uncertainClaim))!;
    const uncertainBegun=(await repository.markBegin({...uncertainRenewed,
      installationBeginMarkerId:"uncertain-install",installationBeginMarkerDigest:digest("uncertain-marker"),
      scopeBeginMarkerId:"uncertain-scope",scopeBeginMarkerDigest:digest("uncertain-marker")}))!;
    await repository.settleOrReadTerminal({...uncertainBegun,outcome:"attention",
      evidenceDigest:digest("uncertain-evidence"),errorCode:"provider_delivery_timeout"});
    await expect(service.projectRun({organizationId:"org_projection",runId:"run_projection"}))
      .resolves.toMatchObject({kind:"anchor_pending"});
    expect(requests).toHaveLength(1);
  });

  it("requires positive Run revisions, non-null delivery revisions, and durable delivery watermark", async () => {
    await insertRun();
    await expect(fixture.pool.query("UPDATE cp_hosted_run SET projection_revision=0 WHERE run_id='run_projection'"))
      .rejects.toThrow();
    await fixture.pool.query(`INSERT INTO cp_provider_delivery_intent(intent_id,organization_id,
      journal_intent_digest,intent,payload,payload_digest,payload_custody_ref,presentation_phase,
      current_truth_key,state,revision,sequence,scope_kind,scope_id,idempotency_key,provider_id,
      provider_instance_id,provider_binding_digest,provider_config_generation,
      provider_config_generation_digest,runtime_owner_id,runtime_generation,schema_generation,
      authority_snapshot_digest,projection_revision,projection_purpose,deadline_at,created_at,updated_at)
      VALUES('constraint_delivery','org_projection',$1,'{}','{}',$2,'constraint','received',$3,
      'pending',1,1,'local_repository','repo','constraint','slack','A1',$4,1,$5,'control-plane',1,1,$6,
      1,'external',$7,$8,$8)`,[digest("journal"),digest("payload"),digest("truth"),digest("binding"),
      digest("generation"),digest("snapshot"),new Date(now.getTime()+60_000),now]);
    for(const invalid of [null,0,-1])await expect(fixture.pool.query(
      "UPDATE cp_provider_delivery_intent SET projection_revision=$1 WHERE intent_id='constraint_delivery'",
      [invalid])).rejects.toThrow();
    await expect(fixture.pool.query(`UPDATE cp_provider_delivery_intent SET projection_purpose='blind_retry'
      WHERE intent_id='constraint_delivery'`)).rejects.toThrow();
    for(const invalid of [null,-1])await expect(fixture.pool.query(
      "UPDATE cp_provider_delivery_intent SET projection_event_sequence=$1 WHERE intent_id='constraint_delivery'",
      [invalid])).rejects.toThrow();
    await fixture.pool.query(`INSERT INTO cp_projection_delivery_watermark(organization_id,run_id,intent_id,
      delivery_state,delivery_revision,projection_revision,event_sequence,created_at)
      VALUES('org_projection','run_projection','constraint_event','rejected',1,1,1,$1)`,[now]);
    for(const invalid of [null,0,-1])await expect(fixture.pool.query(
      "UPDATE cp_projection_delivery_watermark SET event_sequence=$1 WHERE intent_id='constraint_event'",
      [invalid])).rejects.toThrow();
    const column = await fixture.pool.query(`SELECT is_nullable FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='cp_provider_delivery_intent'
        AND column_name='projection_revision'`);
    expect(column.rows).toEqual([{ is_nullable: "NO" }]);
    const watermark = await fixture.pool.query("SELECT to_regclass('cp_projection_delivery_watermark') relation");
    expect(watermark.rows[0]?.relation).toBe("cp_projection_delivery_watermark");
    await expect(checkProjectionSchemaReadiness(fixture.pool)).resolves.toEqual({ready:true});
    await fixture.pool.query("DROP TRIGGER cp_delivery_projection_trigger ON cp_provider_delivery_intent");
    await expect(checkProjectionSchemaReadiness(fixture.pool)).resolves.toEqual({
      ready:false,reason:"migrations_pending"});
  });

  it("rejects an old projection when terminal truth commits before the canonical Run lock", async () => {
    await insertRun();
    await fixture.pool.query("UPDATE cp_hosted_run SET state='running',updated_at=$1 WHERE run_id='run_projection'",
      [new Date(now.getTime()+1)]);
    let release!: () => void; const released=new Promise<void>((resolve)=>{release=resolve;});
    let entered!: () => void; const hookEntered=new Promise<void>((resolve)=>{entered=resolve;});
    const repository=createPostgresDeliveryRepository({ pool:fixture.pool,owner,
      leaseOwner:"toctou-worker",leaseSeconds:30,now:()=>now,
      testHooks:{ async beforeCanonicalLock(){entered();await released;} } } as any);
    const old=DeliveryIntentV2Schema.parse({ contractVersion:2,organizationId:"org_projection",
      sideEffectIntentId:"intent_toctou_old",causalId:"run_projection",intentKind:"delivery",
      operation:"create",deliveryKind:"message",presentationDigest:digest("old"),projectionRevision:2,
      provenance:{kind:"business",repositoryIdentityDigest:digest("repo"),runId:"run_projection",
        authorityLineageDigest:digest("authority")},providerBinding:{bindingKind:"established",providerId:"slack",
        providerInstanceId:"A1",providerPrincipalDigest:digest("principal"),principalAssurance:"provider_verified",
        providerConfigGeneration:1,providerConfigGenerationDigest:digest("generation"),lifecycle:"active",
        bindingDigest:digest("binding")},targetDigest:digest("target"),authorityKind:"run_authority",
      authoritySnapshotDigest:digest("snapshot"),evidencePolicy:"local_audit",idempotencyKey:"toctou_old",
      statusMessageId:"run_projection:status",scope:{kind:"local_repository",id:"repo"},createdAt:now.toISOString(),
      initialAttemptSequence:1});
    const payload={envelopeVersion:1 as const,providerRequest:{},phase:"running" as const,
      frozenDeadline:new Date(now.getTime()+300_000).toISOString(),currentTruth:deliveryCurrentTruthDescriptor({
        intent:old,owner:{organizationId:"org_projection",providerId:"slack",providerInstanceId:"A1",
          providerBindingDigest:digest("binding"),providerConfigGeneration:1,
          providerConfigGenerationDigest:digest("generation"),...owner}})};
    const pending=repository.recordIntent(old,payload);
    const observed=await Promise.race([hookEntered.then(()=>true),
      new Promise<boolean>((resolve)=>setTimeout(()=>resolve(false),50))]);
    expect(observed).toBe(true);
    await fixture.pool.query(`UPDATE cp_hosted_run SET state='failed',terminal_kind='failed',
      terminal_reason='terminal',terminal_receipt=$1,updated_at=$2 WHERE run_id='run_projection'`,
    [{kind:"terminal"},new Date(now.getTime()+2)]);
    release();
    await expect(pending).rejects.toThrow("delivery_projection_revision_stale");
  });

  it("orders and replays same-Run delivery events lexicographically",async()=>{
    await insertRun();
    const repository=createPostgresDeliveryRepository({pool:fixture.pool,owner,
      leaseOwner:"event-sequence",leaseSeconds:30,now:()=>now});
    const make=(eventSequence:number,id:string)=>DeliveryIntentV2Schema.parse({contractVersion:2,
      organizationId:"org_projection",sideEffectIntentId:id,causalId:"run_projection",intentKind:"delivery",
      operation:"update",deliveryKind:"message",presentationDigest:digest(id),projectionRevision:1,
      projectionEventSequence:eventSequence,projectionPurpose:"anchor_update",
      provenance:{kind:"business",repositoryIdentityDigest:digest("repo"),runId:"run_projection",
        authorityLineageDigest:digest("authority")},providerBinding:{bindingKind:"established",providerId:"slack",
        providerInstanceId:"A1",providerPrincipalDigest:digest("principal"),principalAssurance:"provider_verified",
        providerConfigGeneration:1,providerConfigGenerationDigest:digest("generation"),lifecycle:"active",
        bindingDigest:digest("binding")},targetDigest:digest("target"),authorityKind:"run_authority",
      authoritySnapshotDigest:digest("snapshot"),evidencePolicy:"local_audit",idempotencyKey:id,
      statusMessageId:"run_projection:status",scope:{kind:"local_repository",id:"repo"},createdAt:now.toISOString(),
      initialAttemptSequence:1});
    const record=(intent:ReturnType<typeof make>)=>repository.recordIntent(intent,{envelopeVersion:1,
      providerRequest:{},phase:"received",frozenDeadline:new Date(now.getTime()+60_000).toISOString(),
      currentTruth:deliveryCurrentTruthDescriptor({intent,owner:{organizationId:"org_projection",
        providerId:"slack",providerInstanceId:"A1",providerBindingDigest:digest("binding"),
        providerConfigGeneration:1,providerConfigGenerationDigest:digest("generation"),...owner}})});
    const ordinary=make(0,"event_zero");await record(ordinary);
    const first=make(1,"event_one");await record(first);await record(first);
    await expect(record(make(0,"event_zero_late"))).rejects.toThrow("delivery_projection_revision_stale");
    expect((await fixture.pool.query(`SELECT intent_id,state FROM cp_provider_delivery_intent
      WHERE run_id='run_projection' ORDER BY projection_event_sequence,intent_id`)).rows)
      .toEqual([{intent_id:"event_zero",state:"superseded"},{intent_id:"event_one",state:"pending"}]);
  });

  it.each([
    ["same-name trigger on wrong table", `DROP TRIGGER cp_delivery_projection_trigger ON cp_provider_delivery_intent;
      CREATE TRIGGER cp_delivery_projection_trigger AFTER UPDATE ON cp_job FOR EACH ROW
      EXECUTE FUNCTION cp_delivery_projection_after()`],
    ["permissive delivery function body", `CREATE OR REPLACE FUNCTION cp_delivery_projection_after()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`],
    ["missing positive Run constraint", `ALTER TABLE cp_hosted_run
      DROP CONSTRAINT cp_hosted_run_projection_revision_check`],
    ["nullable watermark timestamp", `ALTER TABLE cp_projection_delivery_watermark
      ALTER COLUMN created_at DROP NOT NULL`],
    ["weakened event cursor constraint", `ALTER TABLE cp_projection_event_cursor
      DROP CONSTRAINT cp_projection_event_cursor_current_sequence_check`],
    ["missing event cursor primary key", `ALTER TABLE cp_projection_event_cursor
      DROP CONSTRAINT cp_projection_event_cursor_pkey`],
    ["retargeted event cursor foreign key", `ALTER TABLE cp_projection_event_cursor
      DROP CONSTRAINT cp_projection_event_cursor_organization_id_run_id_fkey;
      ALTER TABLE cp_projection_event_cursor ADD CONSTRAINT cp_projection_event_cursor_organization_id_run_id_fkey
      FOREIGN KEY(organization_id) REFERENCES cp_organization(organization_id)`],
    ["missing watermark primary key", `ALTER TABLE cp_projection_delivery_watermark
      DROP CONSTRAINT cp_projection_delivery_watermark_pkey`],
    ["missing watermark event uniqueness", `ALTER TABLE cp_projection_delivery_watermark
      DROP CONSTRAINT cp_projection_delivery_watermark_run_event_key`],
    ["missing watermark foreign key", `ALTER TABLE cp_projection_delivery_watermark
      DROP CONSTRAINT cp_projection_delivery_watermark_organization_id_run_id_fkey`],
    ["missing deferred primary key", `ALTER TABLE cp_projection_deferred_revision
      DROP CONSTRAINT cp_projection_deferred_revision_pkey`],
    ["missing deferred foreign key", `ALTER TABLE cp_projection_deferred_revision
      DROP CONSTRAINT cp_projection_deferred_revision_organization_id_run_id_fkey`],
    ["weakened deferred shape", `ALTER TABLE cp_projection_deferred_revision
      DROP CONSTRAINT cp_projection_deferred_revision_check;
      ALTER TABLE cp_projection_deferred_revision ADD CONSTRAINT cp_projection_deferred_revision_check CHECK(true)`],
    ["missing truth lock key", `ALTER TABLE cp_provider_delivery_truth_lock
      DROP CONSTRAINT cp_provider_delivery_truth_lock_pkey`],
    ["weakened Slack claim shape", `ALTER TABLE cp_slack_action_authority
      DROP CONSTRAINT cp_slack_action_authority_claim_shape_check;
      ALTER TABLE cp_slack_action_authority ADD CONSTRAINT cp_slack_action_authority_claim_shape_check CHECK(true)`],
    ["weakened Slack decision vocabulary", `ALTER TABLE cp_slack_action_authority
      DROP CONSTRAINT cp_slack_action_authority_decisions_check;
      ALTER TABLE cp_slack_action_authority ADD CONSTRAINT cp_slack_action_authority_decisions_check CHECK(true)`],
    ["same-name wrong function arguments", `DROP FUNCTION cp_enqueue_team_relay_projection(text,text,integer);
      CREATE FUNCTION cp_enqueue_team_relay_projection(text,text) RETURNS void LANGUAGE plpgsql
      AS $$ BEGIN RETURN; END $$`],
  ])("fails readiness for %s",async(_label,sql)=>{
    await fixture.pool.query(sql);
    await expect(checkProjectionSchemaReadiness(fixture.pool)).resolves.toEqual({
      ready:false,reason:"migrations_pending"});
  });
});
