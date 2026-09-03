import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sortCanonicalUnicodeStrings } from "@opentag/core";
import { checkMigrationReadiness, runMigrations } from "../src/database/migrations.js";
import { createDurableJobQueue } from "../src/modules/jobs/index.js";
import { runOneJob } from "../src/modules/jobs/worker.js";
import { createPostgresDeliveryRepository } from "../src/modules/provider-delivery/repository.js";
import { DeliveryIntentV2Schema,deliveryCurrentTruthDescriptor } from "@opentag/delivery-contract";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
import { HOSTED_CAPABILITIES, hostedAdmissionFixture, hostedClaimRequest,
  hostedGrantIssuerFixture, recordHostedReadiness } from "./control-fixtures.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

type HistoricalCandidateMutation = {
  prepareCandidate?: (candidate: {
    candidateId: string;
    runId: string;
    attemptId: string;
    projectTargetId: string;
    frozenBaseRevision: string;
    workspaceTreeDigest: string;
    patchDigest: string;
    changedFiles: string[];
    verificationEvidenceIds: string[];
    publicationPolicyDigest: string;
    createdAt: string;
  }) => void;
  mutateCandidate?: (candidate: Record<string, unknown>) => void;
  mutateAssessment?: (assessment: Record<string, unknown>) => unknown;
};

const timestampParityCases = [
  ["year zero", "0000-01-01T00:00:00.000Z", false],
  ["minimum year", "0001-01-01T00:00:00.000Z", true],
  ["maximum year", "9999-12-31T23:59:59.999Z", true],
  ["extended year", "+010000-01-01T00:00:00.000Z", false],
  ["valid leap day", "2024-02-29T00:00:00.000Z", true],
  ["invalid leap day", "2025-02-29T00:00:00.000Z", false],
  ["leap second", "2024-12-31T23:59:60.000Z", false],
  ["24:00", "2024-01-01T24:00:00.000Z", false],
  ["offset", "2026-08-31T09:02:03.004+08:00", false],
  ["no fraction", "2026-08-31T01:02:03Z", false],
  ["one fraction digit", "2026-08-31T01:02:03.0Z", false],
  ["two fraction digits", "2026-08-31T01:02:03.00Z", false],
  ["three fraction digits", "2026-08-31T01:02:03.004Z", true],
  ["four fraction digits", "2026-08-31T01:02:03.0000Z", false],
  ["five fraction digits", "2026-08-31T01:02:03.00000Z", false],
] as const;

function migrationsBefore<T extends {name:string}>(migrations:readonly T[],name:string){
  const index=migrations.findIndex((migration)=>migration.name===name);
  if(index<0)throw new Error(`missing migration ${name}`);
  return migrations.slice(0,index);
}

async function insertProjectionRun(pool:any,organizationId:string,runId:string,suffix:string,at:Date){
  await pool.query(`INSERT INTO cp_runner(organization_id,runner_id,registration_generation,
    credential_generation,current_credential_id,capabilities,created_at,updated_at)
    VALUES($1,$2,1,1,$3,'[]',$4,$4) ON CONFLICT DO NOTHING`,
  [organizationId,`runner_${organizationId}`,`credential_${organizationId}`,at]);
  await pool.query(`INSERT INTO cp_hosted_run(organization_id,run_id,admission_id,
    admission_operation_id,admission_digest,source_identity_digest,runner_id,executor_id,
    source_version_ref,source_content_ids,source_context_digest,queue_claim_deadline,
    permission_ceiling_digest,publication_mode,publication_policy_digest,completion_mode,
    completion_contract_digest,state,current_attempt_number,hosted_admission,
    admission_policy_snapshot,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'executor_projection',$8,ARRAY[$9],$10,$11,$12,
      'proposal_only',$13,'proposal_ready',$14,'queued',1,'{}','{}',$15,$15)`,
  [organizationId,runId,`admission_${suffix}`,`operation_${suffix}`,
    `sha256:${"a".repeat(64)}`,`sha256:${createHash("sha256").update(suffix).digest("hex")}`,
    `runner_${organizationId}`,
    `source:${suffix}`,`content_${suffix}`,`sha256:${"c".repeat(64)}`,
    new Date(at.getTime()+300_000),`sha256:${"d".repeat(64)}`,`sha256:${"e".repeat(64)}`,
    `sha256:${"f".repeat(64)}`,at]);
}

async function createActualUnversionedFixture(
  mutation: HistoricalCandidateMutation = {},
) {
  const fixture = await createIsolatedPostgres();
  await runMigrations(fixture.pool,migrationsBefore(fixture.migrations,"0013_publication_candidates.sql"));
  const now = new Date("2026-08-15T07:00:00.000Z");
  const runners = createRunnerDirectory({ pool: fixture.pool,
    clock: { now: () => now }, tokenFactory: () => "runtime_malformed_secret",
    idFactory: () => "credential_malformed" });
  await runners.register({ organizationId: "org_malformed", organizationName: "Malformed",
    request: { schemaVersion: 1, protocolVersion: "1.0",
      requiredCapabilities: ["relay.registration.v1"], requestId: "request_malformed",
      operationId: "operation_malformed", runnerId: "runner_malformed",
      capabilities: [...HOSTED_CAPABILITIES] } });
  const authenticated = await runners.authenticate("runtime_malformed_secret");
  if (authenticated.kind !== "authenticated") throw new Error("malformed auth failed");
  await recordHostedReadiness({ pool: fixture.pool, organizationId: "org_malformed",
    runnerId: "runner_malformed" });
  const hosted = createHostedRunCoordinator({ pool: fixture.pool,
    clock: { now: () => now }, leaseDurationMs: 60_000,
    idFactory: () => "attempt_malformed", tokenFactory: () => "fence_attempt_malformed",
    issueSourceContentGrantInTransaction: hostedGrantIssuerFixture });
  const admission = await hostedAdmissionFixture({ runId: "run_malformed",
    suffix: "malformed", organizationId: "org_malformed", runnerId: "runner_malformed" });
  await hosted.admit({ runId: "run_malformed", admission: admission.admission,
    policy: admission.policy });
  const claimed = await hosted.claim({ principal: authenticated.principal,
    request: hostedClaimRequest({ operationId: "operation_claim_malformed",
      requestId: "request_claim_malformed", readinessDigest: admission.readinessDigest,
      credentialId: "credential_malformed" }) });
  if (claimed.kind !== "claimed") throw new Error("malformed claim failed");
  const candidateId = "candidate_malformed";
  const assessment: Record<string, unknown> = { state: "proposal_ready", accepted: true,
    candidateId, reasonCodes: ["proposal_ready"], assessedAt: now.toISOString() };
  await fixture.pool.query(`
    CREATE TABLE cp_publication_candidate (
      organization_id text NOT NULL REFERENCES cp_organization(organization_id),
      candidate_id text NOT NULL, run_id text NOT NULL, attempt_id text NOT NULL,
      project_target_id text NOT NULL, frozen_base_revision text NOT NULL,
      workspace_tree_digest text NOT NULL, patch_digest text NOT NULL,
      changed_files text[] NOT NULL, verification_evidence_ids text[] NOT NULL,
      publication_policy_digest text NOT NULL, candidate jsonb NOT NULL,
      created_at timestamptz NOT NULL, PRIMARY KEY (organization_id, candidate_id),
      UNIQUE (organization_id, run_id, attempt_id));
    CREATE INDEX cp_publication_candidate_run_idx
      ON cp_publication_candidate(organization_id, run_id);
    CREATE FUNCTION cp_reject_publication_candidate_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication_candidate_immutable'; END $$;
    CREATE TRIGGER cp_publication_candidate_immutable BEFORE UPDATE OR DELETE
      ON cp_publication_candidate FOR EACH ROW
      EXECUTE FUNCTION cp_reject_publication_candidate_mutation();`);
  const candidate = { candidateId, runId: "run_malformed",
    attemptId: claimed.claim.attempt.id,
    projectTargetId: admission.admission.projectTarget.projectTargetId,
    frozenBaseRevision: "a".repeat(40), workspaceTreeDigest: "b".repeat(40),
    patchDigest: `sha256:${"c".repeat(64)}`, changedFiles: ["a.ts"],
    verificationEvidenceIds: [`sha256:${"d".repeat(64)}`],
    publicationPolicyDigest: admission.admission.publicationPolicy.digest,
    createdAt: now.toISOString() };
  mutation.prepareCandidate?.(candidate);
  const durableCandidate = { ...candidate, changedFiles: [...candidate.changedFiles],
    verificationEvidenceIds: [...candidate.verificationEvidenceIds] };
  const candidateJson = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
  mutation.mutateCandidate?.(candidateJson);
  const assessmentJson = mutation.mutateAssessment
    ? mutation.mutateAssessment(assessment)
    : assessment;
  await fixture.pool.query(
    "UPDATE cp_hosted_attempt SET state = 'succeeded' WHERE organization_id = $1 AND run_id = $2",
    ["org_malformed", "run_malformed"]);
  await fixture.pool.query(
    `UPDATE cp_hosted_run SET state = 'succeeded', terminal_kind = 'succeeded',
       terminal_receipt = $3::jsonb WHERE organization_id = $1 AND run_id = $2`,
    ["org_malformed", "run_malformed", JSON.stringify({ kind: "proposal_ready",
      candidateId, assessment: assessmentJson })]);
  await fixture.pool.query(
    `INSERT INTO cp_publication_candidate(organization_id, candidate_id, run_id,
       attempt_id, project_target_id, frozen_base_revision, workspace_tree_digest,
       patch_digest, changed_files, verification_evidence_ids,
       publication_policy_digest, candidate, created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
    ["org_malformed", candidateId, "run_malformed", claimed.claim.attempt.id,
      durableCandidate.projectTargetId, durableCandidate.frozenBaseRevision,
      durableCandidate.workspaceTreeDigest, durableCandidate.patchDigest,
      durableCandidate.changedFiles, durableCandidate.verificationEvidenceIds,
      durableCandidate.publicationPolicyDigest, JSON.stringify(candidateJson), durableCandidate.createdAt]);
  return { fixture, candidateId };
}

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL migration corpus", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("migrates an empty schema and is idempotently ready", async () => {
    expect(fixture.migrations.map(({ name }) => name)).toEqual([
      "0000_control_plane.sql",
      "0001_permissions.sql",
      "0002_material_actions.sql",
      "0003_bind_session_tenant.sql",
      "0004_login_throttle.sql",
      "0005_source_content.sql",
      "0006_source_ingress.sql",
      "0007_hosted_run_offline_safe.sql",
      "0008_slack_source_app.sql",
      "0009_slack_action_authority_envelope.sql",
      "0010_provider_delivery.sql",
      "0011_slack_route_identity.sql",
      "0012_attempt_workspace_evidence.sql",
      "0013_publication_candidates.sql",
      "0014_publication_operations.sql",
      "0015_slack_projection_authority.sql",
      "0016_projection_outbox_control_family.sql",
      "0017_projection_authority_hardening.sql",
      "0018_projection_event_anchor_wakeup.sql",
      "0019_projection_event_sequence.sql",
      "0020_projection_lineage_serialization.sql",
      "0021_projection_job_v2_fence.sql",
    ]);

    await expect(fixture.migrate()).resolves.toBeUndefined();
    await expect(fixture.migrate()).resolves.toBeUndefined();
    await expect(
      checkMigrationReadiness(fixture.pool, fixture.migrations),
    ).resolves.toEqual({ ready: true });

    const result = await fixture.pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [fixture.schema],
    );
    expect(result.rows.map(({ table_name }) => table_name)).toEqual(
      expect.arrayContaining([
        "control_plane_migrations",
        "cp_runner",
        "cp_hosted_run",
        "cp_hosted_attempt",
        "cp_job",
        "cp_permission_request",
        "cp_permission_operation",
        "cp_material_action_receipt",
        "cp_material_action_current",
        "cp_management_audit_event",
        "cp_login_throttle",
        "cp_source_app_installation",
        "cp_source_binding",
        "cp_ingress_reservation",
        "cp_source_resolution",
        "cp_source_content_invalidation_receipt",
        "cp_slack_installation",
        "cp_slack_action_authority",
        "cp_provider_delivery_intent",
        "cp_publication_intent",
        "cp_publication_branch_ownership",
        "cp_publication_capability",
        "cp_publication_begin",
        "cp_publication_receipt",
      ]),
    );

    const sessionTenantColumn = await fixture.pool.query<{
      is_nullable: string;
    }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'cp_session'
         AND column_name = 'organization_id'`,
      [fixture.schema],
    );
    expect(sessionTenantColumn.rows).toEqual([{ is_nullable: "NO" }]);

    const sessionTenantForeignKey = await fixture.pool.query<{
      constraint_name: string;
    }>(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE table_schema = $1
         AND table_name = 'cp_session'
         AND constraint_type = 'FOREIGN KEY'
         AND constraint_name = 'cp_session_membership_fk'`,
      [fixture.schema],
    );
    expect(sessionTenantForeignKey.rows).toEqual([
      { constraint_name: "cp_session_membership_fk" },
    ]);
  });

  it("fences a live legacy projection claim and recovers an expired one into v2",async()=>{
    const upgrade=await createIsolatedPostgres();
    try{
      const v2Index=upgrade.migrations.findIndex((migration)=>migration.name==="0021_projection_job_v2_fence.sql");
      expect(v2Index).toBeGreaterThan(0);
      await runMigrations(upgrade.pool,upgrade.migrations.slice(0,v2Index));
      const createdAt=new Date("2026-09-01T00:00:00.000Z");
      await upgrade.pool.query(`INSERT INTO cp_organization(organization_id,display_name,created_at)
        VALUES('org_upgrade','Upgrade',$1)`,[createdAt]);
      await insertProjectionRun(upgrade.pool,"org_upgrade","run_claimed","claimed",createdAt);
      await insertProjectionRun(upgrade.pool,"org_upgrade","run_pending","pending",createdAt);
      const queueNow=new Date(Date.now()+1_000);
      const oldQueue=createDurableJobQueue({pool:upgrade.pool,clock:{now:()=>queueNow},
        leaseDurationMs:30_000,tokenFactory:()=>"old-worker-lease"});
      const claimed=await oldQueue.claim("old-worker",["team-relay.project"]);
      expect(claimed).toMatchObject({kind:"claimed",job:{jobId:"team-relay:org_upgrade:run_claimed:1"}});
      await expect(runMigrations(upgrade.pool,upgrade.migrations)).rejects.toThrow(
        "projection_v2_legacy_job_claimed");
      expect((await upgrade.pool.query(`SELECT to_regclass('cp_projection_job_v2_authority') relation`)).rows)
        .toEqual([{relation:null}]);
      if(claimed.kind!=="claimed")throw new Error("legacy claim missing");
      await upgrade.pool.query("UPDATE cp_job SET lease_expires_at=$2 WHERE job_id=$1",
        [claimed.job.jobId,new Date(Date.now()-60_000)]);
      const pendingJobId="team-relay:org_upgrade:run_pending:1";
      await upgrade.pool.query("UPDATE cp_job SET attempt_count=max_attempts WHERE job_id=$1",[pendingJobId]);
      await expect(runMigrations(upgrade.pool,upgrade.migrations)).rejects.toThrow(
        "projection_v2_legacy_job_contract_invalid");
      await upgrade.pool.query("UPDATE cp_job SET attempt_count=0 WHERE job_id=$1",[pendingJobId]);
      await upgrade.pool.query(`INSERT INTO cp_job_settlement(job_id,lease_token,outcome,settled_at)
        VALUES($1,'invalid-pending-settlement',$2,$3)`,[pendingJobId,{kind:"invalid"},queueNow]);
      await expect(runMigrations(upgrade.pool,upgrade.migrations)).rejects.toThrow(
        "projection_v2_legacy_job_contract_invalid");
      await upgrade.pool.query("DELETE FROM cp_job_settlement WHERE job_id=$1",[pendingJobId]);
      await upgrade.pool.query("UPDATE cp_job SET payload=payload||'{\"extra\":true}'::jsonb WHERE job_id=$1",
        [pendingJobId]);
      await expect(runMigrations(upgrade.pool,upgrade.migrations)).rejects.toThrow(
        "projection_v2_legacy_payload_invalid");
      await upgrade.pool.query("UPDATE cp_job SET payload=payload-'extra' WHERE job_id=$1",[pendingJobId]);
      await upgrade.pool.query("UPDATE cp_job SET request_digest='wrong-legacy-digest' WHERE job_id=$1",
        [pendingJobId]);
      await expect(runMigrations(upgrade.pool,upgrade.migrations)).rejects.toThrow(
        "projection_v2_legacy_job_identity_invalid");
      expect((await upgrade.pool.query(`SELECT to_regclass('cp_projection_job_v2_authority') relation`)).rows)
        .toEqual([{relation:null}]);
      await upgrade.pool.query("UPDATE cp_job SET request_digest=md5($2) WHERE job_id=$1",
        [pendingJobId,"org_upgrade:run_pending:1"]);
      await expect(runMigrations(upgrade.pool,upgrade.migrations)).resolves.toBeUndefined();
      await expect(oldQueue.claim("old-worker",["team-relay.project"])).resolves.toEqual({kind:"empty"});
      const newQueue=createDurableJobQueue({pool:upgrade.pool,clock:{now:()=>queueNow},
        leaseDurationMs:30_000,tokenFactory:()=>"new-worker-lease"});
      let executions=0;
      await expect(runOneJob({queue:newQueue,workerId:"new-worker",handlers:{
        "team-relay.project.v2":async()=>{executions+=1;return {kind:"projected_once"};}},
        retryDelayMs:1000,clock:{now:()=>queueNow}})).resolves.toMatchObject({kind:"settled"});
      await expect(runOneJob({queue:newQueue,workerId:"new-worker",handlers:{
        "team-relay.project.v2":async()=>{executions+=1;return {kind:"projected_once"};}},
        retryDelayMs:1000,clock:{now:()=>queueNow}})).resolves.toMatchObject({kind:"settled"});
      expect(executions).toBe(2);
      await expect(runOneJob({queue:newQueue,workerId:"new-worker",handlers:{
        "team-relay.project.v2":async()=>{executions+=1;return {kind:"duplicate"};}},
        retryDelayMs:1000,clock:{now:()=>queueNow}})).resolves.toEqual({kind:"empty"});
      expect(executions).toBe(2);
    }finally{await upgrade.close();}
  },15_000);

  it("rejects missing legacy event lineage and future v2 job identity conflicts",async()=>{
    const upgrade=await createIsolatedPostgres();
    try{
      const v2Index=upgrade.migrations.findIndex((migration)=>migration.name==="0021_projection_job_v2_fence.sql");
      await runMigrations(upgrade.pool,upgrade.migrations.slice(0,v2Index));
      const at=new Date("2026-09-01T01:00:00.000Z");
      await upgrade.pool.query(`INSERT INTO cp_organization(organization_id,display_name,created_at)
        VALUES('org_lineage','Lineage',$1)`,[at]);
      await insertProjectionRun(upgrade.pool,"org_lineage","run_missing","missing",at);
      const missingJobId="team-relay-delivery:org_lineage:run_missing:3";
      await upgrade.pool.query(`INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,
        state,available_at,attempt_count,max_attempts,created_at,updated_at)
        VALUES($1,'org_lineage','team-relay.project',$2,md5($1),'pending',$3,0,20,$3,$3)`,
      [missingJobId,{organizationId:"org_lineage",runId:"run_missing",projectionRevision:1,
        deliveryIntentId:"intent_missing",deliveryRevision:7,eventSequence:3},at]);
      await expect(runMigrations(upgrade.pool,upgrade.migrations)).rejects.toThrow(
        "projection_v2_legacy_event_ambiguous");
      await upgrade.pool.query(`ALTER TABLE cp_projection_delivery_watermark
        DROP CONSTRAINT cp_projection_delivery_watermark_organization_id_run_id_fkey;
        ALTER TABLE cp_projection_delivery_watermark
        DROP CONSTRAINT cp_projection_delivery_watermark_run_event_key`);
      await upgrade.pool.query(`INSERT INTO cp_projection_delivery_watermark(organization_id,run_id,intent_id,
        delivery_state,delivery_revision,projection_revision,event_sequence,created_at)
        VALUES('org_lineage','run_missing','intent_missing','accepted',7,2,3,$1)`,[at]);
      await expect(runMigrations(upgrade.pool,upgrade.migrations)).rejects.toThrow(
        "projection_v2_legacy_event_ambiguous");
      await upgrade.pool.query(`UPDATE cp_projection_delivery_watermark SET projection_revision=1
        WHERE intent_id='intent_missing'`);
      await upgrade.pool.query(`INSERT INTO cp_projection_delivery_watermark(organization_id,run_id,intent_id,delivery_state,
          delivery_revision,projection_revision,event_sequence,created_at)
        VALUES('org_lineage','run_missing','intent_missing','rejected',7,1,3,$1)`,[at]);
      await expect(runMigrations(upgrade.pool,upgrade.migrations)).rejects.toThrow(
        "projection_v2_legacy_event_ambiguous");
      await upgrade.pool.query(`DELETE FROM cp_projection_delivery_watermark
        WHERE intent_id='intent_missing' AND delivery_state='rejected'`);
      await upgrade.pool.query("UPDATE cp_job SET state='failed' WHERE job_id=$1",[missingJobId]);
      await runMigrations(upgrade.pool,upgrade.migrations);
      const payload={organizationId:"org_lineage",runId:"run_exact",projectionRevision:1};
      await expect(upgrade.pool.query(`SELECT cp_insert_team_relay_v2_job($1,$2,$3)`,
        ["team-relay-exact-replay","org_lineage",payload])).resolves.toBeDefined();
      await expect(upgrade.pool.query(`SELECT cp_insert_team_relay_v2_job($1,$2,$3)`,
        ["team-relay-exact-replay","org_lineage",payload])).resolves.toBeDefined();
      expect((await upgrade.pool.query("SELECT count(*)::int count FROM cp_job WHERE job_id='team-relay-exact-replay'")).rows)
        .toEqual([{count:1}]);
      await upgrade.pool.query(`INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,
        state,available_at,attempt_count,max_attempts,created_at,updated_at)
        VALUES('team-relay-occupied','org_lineage','other.kind',$1,'wrong','pending',$2,0,20,$2,$2)`,
      [payload,at]);
      await expect(upgrade.pool.query(`SELECT cp_insert_team_relay_v2_job($1,$2,$3)`,
        ["team-relay-occupied","org_lineage",payload])).rejects.toThrow("projection_v2_job_identity_conflict");
    }finally{await upgrade.close();}
  },15_000);

  it("rejects an occupied v2 job id with a mismatched identity",async()=>{
    const collision=await createIsolatedPostgres();
    try{
      await collision.migrate();const at=new Date("2026-09-01T02:00:00.000Z");
      await collision.pool.query(`INSERT INTO cp_organization(organization_id,display_name,created_at)
        VALUES('org_collision','Collision',$1)`,[at]);
      const payload={organizationId:"org_collision",runId:"run_collision",projectionRevision:1};
      await collision.pool.query(`INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,
        state,available_at,attempt_count,max_attempts,created_at,updated_at)
        VALUES('team-relay-occupied-v2','org_collision','other.kind',$1,'wrong','pending',$2,0,20,$2,$2)`,
      [payload,at]);
      await expect(collision.pool.query(`SELECT cp_insert_team_relay_v2_job($1,$2,$3)`,
        ["team-relay-occupied-v2","org_collision",payload]))
        .rejects.toThrow("projection_v2_job_identity_conflict");
      await collision.pool.query(`INSERT INTO cp_job(job_id,organization_id,job_kind,payload,request_digest,
        state,available_at,attempt_count,max_attempts,created_at,updated_at)
        VALUES('team-relay-state-conflict','org_collision','team-relay.project.v2',$1,
          md5('team-relay-state-conflict'||':'||$1::jsonb::text),'succeeded',$2,0,20,$2,$2)`,[payload,at]);
      await expect(collision.pool.query(`SELECT cp_insert_team_relay_v2_job($1,$2,$3)`,
        ["team-relay-state-conflict","org_collision",payload]))
        .rejects.toThrow("projection_v2_job_state_conflict");
    }finally{await collision.close();}
  });

  it("rejects exact-identity v2 replay with exhausted or contradictory durable state",async()=>{
    const corrupted=await createIsolatedPostgres();
    try{
      await corrupted.migrate();const at=new Date("2026-09-01T03:00:00.000Z");
      await corrupted.pool.query(`INSERT INTO cp_organization(organization_id,display_name,created_at)
        VALUES('org_replay','Replay',$1)`,[at]);
      const create=async(name:string)=>{const jobId=`team-relay-replay-${name}`;
        const payload={organizationId:"org_replay",runId:`run_${name}`,projectionRevision:1};
        await corrupted.pool.query("SELECT cp_insert_team_relay_v2_job($1,$2,$3)",[jobId,"org_replay",payload]);
        return {jobId,payload};};
      const exhausted=await create("exhausted_pending");
      await corrupted.pool.query("UPDATE cp_job SET attempt_count=max_attempts WHERE job_id=$1",[exhausted.jobId]);
      await expect(corrupted.pool.query("SELECT cp_insert_team_relay_v2_job($1,$2,$3)",
        [exhausted.jobId,"org_replay",exhausted.payload])).rejects.toThrow("projection_v2_job_state_conflict");
      const claimed=await create("exhausted_claimed");
      await corrupted.pool.query(`UPDATE cp_job SET state='claimed',attempt_count=max_attempts+1,
        lease_owner='worker',lease_token='token',lease_expires_at=$2 WHERE job_id=$1`,
      [claimed.jobId,new Date(at.getTime()+60_000)]);
      await expect(corrupted.pool.query("SELECT cp_insert_team_relay_v2_job($1,$2,$3)",
        [claimed.jobId,"org_replay",claimed.payload])).rejects.toThrow("projection_v2_job_state_conflict");
      const succeeded=await create("succeeded_with_error");
      await corrupted.pool.query("UPDATE cp_job SET state='succeeded',last_error_code='unexpected' WHERE job_id=$1",
        [succeeded.jobId]);
      await corrupted.pool.query(`INSERT INTO cp_job_settlement(job_id,lease_token,outcome,settled_at)
        VALUES($1,'settled-token',$2,$3)`,[succeeded.jobId,{errorCode:"unexpected"},at]);
      await expect(corrupted.pool.query("SELECT cp_insert_team_relay_v2_job($1,$2,$3)",
        [succeeded.jobId,"org_replay",succeeded.payload])).rejects.toThrow("projection_v2_job_state_conflict");
      const failed=await create("failed_mismatch");
      await corrupted.pool.query("UPDATE cp_job SET state='failed',last_error_code='expected' WHERE job_id=$1",
        [failed.jobId]);
      await corrupted.pool.query(`INSERT INTO cp_job_settlement(job_id,lease_token,outcome,settled_at)
        VALUES($1,'settled-token',$2,$3)`,[failed.jobId,{errorCode:"different"},at]);
      await expect(corrupted.pool.query("SELECT cp_insert_team_relay_v2_job($1,$2,$3)",
        [failed.jobId,"org_replay",failed.payload])).rejects.toThrow("projection_v2_job_state_conflict");
    }finally{await corrupted.close();}
  });

  it("recovers a crashed v2 job without authorizing duplicate provider I/O",async()=>{
    const recovered=await createIsolatedPostgres();
    try{
      await recovered.migrate();let clock=new Date(Date.now()+1_000);
      await recovered.pool.query(`INSERT INTO cp_organization(organization_id,display_name,created_at)
        VALUES('org_crash','Crash',$1)`,[clock]);
      const digest=(value:string)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
      const intent=DeliveryIntentV2Schema.parse({contractVersion:2,organizationId:"org_crash",
        sideEffectIntentId:"intent_crash_once",causalId:"run_crash",intentKind:"delivery",operation:"create",
        deliveryKind:"message",presentationDigest:digest("presentation"),provenance:{kind:"business",
          repositoryIdentityDigest:digest("repo"),runId:"run_crash",authorityLineageDigest:digest("authority")},
        providerBinding:{bindingKind:"established",providerId:"slack",providerInstanceId:"A_CRASH",
          providerPrincipalDigest:digest("principal"),principalAssurance:"provider_verified",
          providerConfigGeneration:1,providerConfigGenerationDigest:digest("generation"),lifecycle:"active",
          bindingDigest:digest("binding")},targetDigest:digest("target"),authorityKind:"run_authority",
        authoritySnapshotDigest:digest("snapshot"),evidencePolicy:"local_audit",idempotencyKey:"crash-once",
        statusMessageId:"run_crash:status",scope:{kind:"local_repository",id:"repo"},
        createdAt:clock.toISOString(),initialAttemptSequence:1});
      const owner={runtimeOwnerId:"control-plane",runtimeGeneration:1,schemaGeneration:1} as const;
      const repository=createPostgresDeliveryRepository({pool:recovered.pool,owner,
        leaseOwner:"provider-worker",leaseSeconds:30,now:()=>clock});
      const payload={envelopeVersion:1 as const,providerRequest:{},phase:"running" as const,
        frozenDeadline:new Date(clock.getTime()+300_000).toISOString(),currentTruth:deliveryCurrentTruthDescriptor({
          intent,owner:{organizationId:"org_crash",providerId:"slack",providerInstanceId:"A_CRASH",
            providerBindingDigest:digest("binding"),providerConfigGeneration:1,
            providerConfigGenerationDigest:digest("generation"),...owner}})};
      await repository.recordIntent(intent,payload);
      const jobPayload={organizationId:"org_crash",runId:"run_crash",projectionRevision:1};
      await recovered.pool.query("SELECT cp_insert_team_relay_v2_job($1,$2,$3)",
        ["team-relay-crash-recovery","org_crash",jobPayload]);
      const queue=createDurableJobQueue({pool:recovered.pool,clock:{now:()=>clock},leaseDurationMs:1_000,
        tokenFactory:()=>`lease-${clock.getTime()}`});
      const crashed=await queue.claim("crashed-worker",["team-relay.project.v2"]);
      expect(crashed).toMatchObject({kind:"claimed"});
      clock=new Date(clock.getTime()+2_000);
      await expect(runOneJob({queue,workerId:"recovery-worker",handlers:{
        "team-relay.project.v2":async()=>{await repository.recordIntent(intent,payload);return {kind:"recovered"};}},
        retryDelayMs:1_000,clock:{now:()=>clock}})).resolves.toMatchObject({kind:"settled"});
      expect((await recovered.pool.query(`SELECT count(*)::int count FROM cp_provider_delivery_intent
        WHERE intent_id=$1`,[intent.sideEffectIntentId])).rows).toEqual([{count:1}]);
      const first=await repository.claimNext();expect(first).not.toBeNull();
      await expect(repository.claimNext()).resolves.toBeNull();
    }finally{await recovered.close();}
  });

  it("revokes pre-0017 publication-reject authority without harming approve", async () => {
    const legacy = await createIsolatedPostgres();
    try {
      await runMigrations(legacy.pool,migrationsBefore(legacy.migrations,"0017_projection_authority_hardening.sql"));
      await legacy.pool.query("SET session_replication_role=replica");
      await legacy.pool.query(`INSERT INTO cp_slack_action_authority(
        organization_id,action_id,action_token_hash,installation_id,binding_id,team_id,app_id,
        channel_id,thread_root_message_id,run_id,pending_request_id,action_kind,action_descriptor,
        action_descriptor_digest,approval_epoch,frozen_ceiling,frozen_ceiling_digest,policy_digest,
        runner_id,attempt_id,attempt_number,attempt_epoch,projection_generation,authority_family_id,
        authority_epoch,claim_state,claimed_at,fencing_token_digest,permission_request_digest,
        pending_action_id,allowed_decisions,requester_user_id,member_user_ids,operator_user_ids,
        approver_user_id,admin_user_ids,publication_approval,expires_at,created_at)
        VALUES('org_legacy','reject_only','token_reject','install','binding','T','A','C','1','run',
        'request','publication','{}','descriptor','1','{}','ceiling','policy','runner','attempt',1,1,1,
        'family_reject',1,'available',NULL,'fence','permission','pending',ARRAY['publication_reject'],
        NULL,ARRAY['U'],ARRAY[]::text[],'APPROVER',ARRAY[]::text[],'{}',$1,$2),
        ('org_legacy','approve_and_reject','token_both','install','binding','T','A','C','1','run',
        'request','publication','{}','descriptor','1','{}','ceiling','policy','runner','attempt',1,1,1,
        'family_both',1,'available',NULL,'fence','permission','pending',
        ARRAY['publication_approve','publication_reject'],NULL,ARRAY['U'],ARRAY[]::text[],
        'APPROVER',ARRAY[]::text[],'{}',$1,$2)`,
      [new Date("2026-09-01T01:00:00.000Z"),new Date("2026-09-01T00:00:00.000Z")]);
      await legacy.pool.query("SET session_replication_role=origin");
      await runMigrations(legacy.pool, legacy.migrations);
      const rows=await legacy.pool.query(`SELECT action_id,allowed_decisions,claim_state,
        consumed_at IS NOT NULL consumed FROM cp_slack_action_authority ORDER BY action_id`);
      expect(rows.rows).toEqual([
        {action_id:"approve_and_reject",allowed_decisions:["publication_approve"],
          claim_state:"available",consumed:false},
        {action_id:"reject_only",allowed_decisions:["publication_approve"],
          claim_state:"consumed",consumed:true},
      ]);
    } finally { await legacy.close(); }
  });

  it("backfills pre-0018 status anchors by durable shape without emitting external events",async()=>{
    const legacy=await createIsolatedPostgres();
    try{
      await runMigrations(legacy.pool,migrationsBefore(legacy.migrations,"0019_projection_event_sequence.sql"));
      const insert=async(id:string,operation:"create"|"update")=>legacy.pool.query(`INSERT INTO
        cp_provider_delivery_intent(intent_id,organization_id,journal_intent_digest,intent,payload,
        payload_digest,payload_custody_ref,presentation_phase,current_truth_key,state,revision,sequence,
        scope_kind,scope_id,idempotency_key,provider_id,provider_instance_id,provider_binding_digest,
        provider_config_generation,provider_config_generation_digest,runtime_owner_id,runtime_generation,
        schema_generation,authority_snapshot_digest,status_message_id,run_id,projection_revision,
        projection_purpose,deadline_at,created_at,updated_at)
        VALUES($1,'org_legacy',$2,$3,'{}',$4,$5,'received',$6,'pending',1,1,'local_repository','repo',$7,
        'slack','A1',$8,1,$9,'control-plane',1,1,$10,'run_legacy:status','run_legacy',1,'external',$11,$12,$12)`,
      [id,`journal_${id}`,JSON.stringify({operation,deliveryKind:"message",provenance:{kind:"business"}}),
        `payload_${id}`,`custody_${id}`,`truth_${id}`,`key_${id}`,`binding_${id}`,`generation_${id}`,
        `snapshot_${id}`,new Date("2026-09-01T02:00:00.000Z"),new Date("2026-09-01T01:00:00.000Z")]);
      await insert("legacy_create","create");await insert("legacy_update","update");
      await runMigrations(legacy.pool,legacy.migrations);
      expect((await legacy.pool.query(`SELECT intent_id,projection_purpose FROM cp_provider_delivery_intent
        ORDER BY intent_id`)).rows).toEqual([
        {intent_id:"legacy_create",projection_purpose:"anchor_create"},
        {intent_id:"legacy_update",projection_purpose:"anchor_update"}]);
      expect((await legacy.pool.query("SELECT count(*)::int count FROM cp_projection_delivery_watermark")).rows[0])
        .toEqual({count:0});
      expect((await legacy.pool.query(`SELECT count(*)::int count FROM cp_job
        WHERE job_id LIKE 'team-relay-delivery:%'`)).rows[0]).toEqual({count:0});
    }finally{await legacy.close();}
  });

  it("keeps every 0014 publication authority family fail-closed in the schema catalog", async () => {
    await fixture.migrate();
    const tables = ["cp_publication_branch_ownership", "cp_publication_intent",
      "cp_publication_capability", "cp_publication_begin", "cp_publication_receipt",
      "cp_publication_reconciliation", "cp_publication_completion"];
    for (const table of tables) {
      const columns = await fixture.pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name,is_nullable,column_default FROM information_schema.columns
         WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [fixture.schema, table]);
      expect(columns.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ column_name: "organization_id", is_nullable: "NO" }),
      ]));
      const constraints = await fixture.pool.query<{ constraint_type: string }>(
        `SELECT constraint_type FROM information_schema.table_constraints WHERE table_schema=$1 AND table_name=$2`,
        [fixture.schema, table]);
      expect(constraints.rows.map((row) => row.constraint_type)).toContain("PRIMARY KEY");
      const trigger = await fixture.pool.query<{ trigger_name: string }>(
        `SELECT DISTINCT trigger_name FROM information_schema.triggers
         WHERE event_object_schema=$1 AND event_object_table=$2
           AND trigger_name=${"'"}cp_publication_${"'"} || regexp_replace($2, '^cp_publication_', '') || '_immutable'`,
        [fixture.schema, table]);
      expect(trigger.rows).toHaveLength(1);
    }
    const capability = await fixture.pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema=$1
       AND table_name='cp_publication_capability' AND column_name IN ('attempt_number','capability_digest','capability')`,
      [fixture.schema]);
    expect(capability.rows).toHaveLength(3);
    expect(capability.rows.every((column) => column.is_nullable === "NO")).toBe(true);
  });

  it.each([
    ["receipt nullability", "ALTER TABLE cp_publication_receipt ALTER COLUMN receipt_digest DROP NOT NULL"],
    ["capability attempt uniqueness", `DO $$ DECLARE constraint_name text; BEGIN
      SELECT conname INTO constraint_name FROM pg_constraint
       WHERE conrelid='cp_publication_capability'::regclass AND contype='u'
         AND conkey=ARRAY[1,3,6,7]::smallint[];
      EXECUTE format('ALTER TABLE cp_publication_capability DROP CONSTRAINT %I', constraint_name);
      END $$;
      ALTER TABLE cp_publication_capability
      ADD CONSTRAINT cp_publication_capability_organization_id_intent_id_step_attempt_number_key
      UNIQUE (organization_id,intent_id,step,capability_id)`],
    ["authority trigger disabled", "ALTER TABLE cp_publication_completion DISABLE TRIGGER cp_publication_completion_immutable"],
  ] as const)("fails readiness closed for tampered 0014 %s", async (_label, tamperSql) => {
    const tampered = await createIsolatedPostgres();
    try {
      await tampered.migrate();
      await tampered.pool.query(tamperSql);
      await expect(checkMigrationReadiness(tampered.pool, tampered.migrations))
        .resolves.toEqual({ ready: false, reason: "migrations_pending" });
    } finally { await tampered.close(); }
  });

  it.each([
    ["branch ownership head type", "ALTER TABLE cp_publication_branch_ownership ALTER COLUMN expected_head_sha TYPE varchar(64)"],
    ["intent repository type", "ALTER TABLE cp_publication_intent ALTER COLUMN repository TYPE text USING repository::text"],
    ["capability payload type", "ALTER TABLE cp_publication_capability ALTER COLUMN capability TYPE text USING capability::text"],
    ["begin timestamp type", "ALTER TABLE cp_publication_begin ALTER COLUMN begun_at TYPE text USING begun_at::text"],
    ["receipt payload type", "ALTER TABLE cp_publication_receipt ALTER COLUMN receipt TYPE text USING receipt::text"],
    ["reconciliation payload type", "ALTER TABLE cp_publication_reconciliation ALTER COLUMN observation TYPE text USING observation::text"],
    ["completion payload type", "ALTER TABLE cp_publication_completion ALTER COLUMN observation TYPE text USING observation::text"],
    ["permissive immutable function body", `CREATE OR REPLACE FUNCTION cp_reject_publication_authority_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`],
  ] as const)("fails readiness closed for every 0014 descriptor tamper: %s", async (_label, tamperSql) => {
    const tampered = await createIsolatedPostgres();
    try {
      await tampered.migrate();
      await tampered.pool.query(tamperSql);
      await expect(checkMigrationReadiness(tampered.pool, tampered.migrations))
        .resolves.toEqual({ ready: false, reason: "migrations_pending" });
    } finally { await tampered.close(); }
  });

  it.each([
    ["retargeted intent ownership FK", `ALTER TABLE cp_publication_intent
      DROP CONSTRAINT cp_publication_intent_organization_id_ownership_id_fkey;
      ALTER TABLE cp_publication_intent
      ADD CONSTRAINT cp_publication_intent_organization_id_ownership_id_fkey
      FOREIGN KEY (organization_id,ownership_id)
      REFERENCES cp_publication_branch_ownership(organization_id,candidate_id)`],
    ["dropped receipt FK", `ALTER TABLE cp_publication_receipt
      DROP CONSTRAINT cp_publication_receipt_organization_id_capability_id_fkey`],
    ["not-valid ownership attempt FK", `ALTER TABLE cp_publication_branch_ownership
      DROP CONSTRAINT cp_publication_branch_ownersh_organization_id_run_id_attem_fkey;
      ALTER TABLE cp_publication_branch_ownership
      ADD CONSTRAINT cp_publication_branch_ownersh_organization_id_run_id_attem_fkey
      FOREIGN KEY (organization_id,run_id,attempt_number,attempt_id)
      REFERENCES cp_hosted_attempt(organization_id,run_id,attempt_number,attempt_id) NOT VALID`],
    ["changed FK actions and deferrability", `ALTER TABLE cp_publication_begin
      DROP CONSTRAINT cp_publication_begin_organization_id_capability_id_fkey;
      ALTER TABLE cp_publication_begin
      ADD CONSTRAINT cp_publication_begin_organization_id_capability_id_fkey
      FOREIGN KEY (organization_id,capability_id)
      REFERENCES cp_publication_capability(organization_id,capability_id)
      MATCH FULL ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`],
    ["weakened ownership digest CHECK", `ALTER TABLE cp_publication_branch_ownership
      DROP CONSTRAINT cp_publication_branch_ownership_attestation_digest_check;
      ALTER TABLE cp_publication_branch_ownership
      ADD CONSTRAINT cp_publication_branch_ownership_attestation_digest_check
      CHECK (attestation_digest <> '')`],
    ["dropped capability expiry CHECK", `ALTER TABLE cp_publication_capability
      DROP CONSTRAINT cp_publication_capability_check`],
    ["no-inherit receipt outcome CHECK", `ALTER TABLE cp_publication_receipt
      DROP CONSTRAINT cp_publication_receipt_outcome_check;
      ALTER TABLE cp_publication_receipt
      ADD CONSTRAINT cp_publication_receipt_outcome_check
      CHECK (outcome IN ('succeeded','failed','outcome_unknown')) NO INHERIT`],
    ["changed capability primary key", `ALTER TABLE cp_publication_capability
      DROP CONSTRAINT cp_publication_capability_pkey CASCADE;
      ALTER TABLE cp_publication_capability
      ADD CONSTRAINT cp_publication_capability_pkey
      PRIMARY KEY (organization_id,capability_id,operation_id)`],
    ["changed ownership candidate uniqueness", `ALTER TABLE cp_publication_branch_ownership
      DROP CONSTRAINT cp_publication_branch_ownershi_organization_id_candidate_id_key CASCADE;
      ALTER TABLE cp_publication_branch_ownership
      ADD CONSTRAINT cp_publication_branch_ownershi_organization_id_candidate_id_key
      UNIQUE (organization_id,candidate_id,ownership_id)`],
    ["changed intent candidate uniqueness", `ALTER TABLE cp_publication_intent
      DROP CONSTRAINT cp_publication_intent_organization_id_candidate_id_key;
      ALTER TABLE cp_publication_intent
      ADD CONSTRAINT cp_publication_intent_organization_id_candidate_id_key
      UNIQUE (organization_id,candidate_id,intent_id)`],
    ["dropped intent approval uniqueness", `ALTER TABLE cp_publication_intent
      DROP CONSTRAINT cp_publication_intent_organization_id_approval_id_key`],
    ["changed capability attempt uniqueness", `ALTER TABLE cp_publication_capability
      DROP CONSTRAINT cp_publication_capability_organization_id_intent_id_step_at_key;
      ALTER TABLE cp_publication_capability
      ADD CONSTRAINT cp_publication_capability_organization_id_intent_id_step_at_key
      UNIQUE (organization_id,intent_id,step,attempt_number,capability_id)`],
    ["changed begin uniqueness", `ALTER TABLE cp_publication_begin
      DROP CONSTRAINT cp_publication_begin_pkey;
      ALTER TABLE cp_publication_begin
      ADD CONSTRAINT cp_publication_begin_pkey
      PRIMARY KEY (organization_id,capability_id,operation_id)`],
    ["dropped receipt capability uniqueness", `ALTER TABLE cp_publication_receipt
      DROP CONSTRAINT cp_publication_receipt_organization_id_capability_id_key`],
    ["unexpected reconciliation capability uniqueness", `ALTER TABLE cp_publication_reconciliation
      ADD CONSTRAINT cp_publication_reconciliation_organization_id_capability_id_key
      UNIQUE (organization_id,capability_id)`],
    ["changed completion run uniqueness", `ALTER TABLE cp_publication_completion
      DROP CONSTRAINT cp_publication_completion_organization_id_run_id_key;
      ALTER TABLE cp_publication_completion
      ADD CONSTRAINT cp_publication_completion_organization_id_run_id_key
      UNIQUE (organization_id,run_id,completion_id)`],
    ["changed ownership expression index expression", `DROP INDEX cp_publication_branch_owner_key;
      CREATE UNIQUE INDEX cp_publication_branch_owner_key ON cp_publication_branch_ownership(
        organization_id,lower(provider),lower(owner),lower(repo),branch)`],
    ["changed ownership expression index uniqueness", `DROP INDEX cp_publication_branch_owner_key;
      CREATE INDEX cp_publication_branch_owner_key ON cp_publication_branch_ownership(
        organization_id,lower(provider),lower(owner),lower(repo),lower(branch))`],
    ["changed ownership expression index predicate", `DROP INDEX cp_publication_branch_owner_key;
      CREATE UNIQUE INDEX cp_publication_branch_owner_key ON cp_publication_branch_ownership(
        organization_id,lower(provider),lower(owner),lower(repo),lower(branch))
      WHERE organization_id <> ''`],
  ] as const)("fails readiness closed for exact 0014 catalog tamper: %s", async (_label, tamperSql) => {
    const tampered = await createIsolatedPostgres();
    try {
      await tampered.migrate();
      await tampered.pool.query(tamperSql);
      await expect(checkMigrationReadiness(tampered.pool, tampered.migrations))
        .resolves.toEqual({ ready: false, reason: "migrations_pending" });
    } finally { await tampered.close(); }
  });

  it("matches the shared Unicode scalar sorter with real C-collated PostgreSQL text", async () => {
    const values = ["😀", "é", "e\u0301", "ab", "a", "Z", "A"];
    const expected = ["A", "Z", "a", "ab", "e\u0301", "é", "😀"];
    await fixture.pool.query("CREATE TEMP TABLE task8_unicode_order(value text NOT NULL)");
    for (const value of values) {
      await fixture.pool.query("INSERT INTO task8_unicode_order(value) VALUES($1)", [value]);
    }
    const rows = await fixture.pool.query<{ value: string }>(
      'SELECT value FROM task8_unicode_order ORDER BY value COLLATE "C"',
    );
    expect(rows.rows.map((row) => row.value)).toEqual(expected);
    expect(sortCanonicalUnicodeStrings(values)).toEqual(expected);
  });

  it.each(timestampParityCases)("reconciles historical Candidate timestamps exactly: %s", async (_label, createdAt, accepted) => {
    const historical = await createActualUnversionedFixture(accepted
      ? { prepareCandidate: (candidate) => { candidate.createdAt = createdAt; } }
      : { mutateCandidate: (candidate) => { candidate["createdAt"] = createdAt; } });
    try {
      const migration = runMigrations(historical.fixture.pool, historical.fixture.migrations);
      if (accepted) {
        await expect(migration).resolves.toBeUndefined();
      } else {
        await expect(migration).rejects.toThrow("publication_candidate_upgrade_reconciliation_required");
      }
    } finally {
      await historical.fixture.close();
    }
  }, 30_000);

  it.each(timestampParityCases)("reconciles historical proposal assessment timestamps exactly: %s", async (_label, assessedAt, accepted) => {
    const historical = await createActualUnversionedFixture({
      mutateAssessment: (assessment) => ({ ...assessment, assessedAt }),
    });
    try {
      const migration = runMigrations(historical.fixture.pool, historical.fixture.migrations);
      if (accepted) {
        await expect(migration).resolves.toBeUndefined();
      } else {
        await expect(migration).rejects.toThrow("publication_candidate_upgrade_reconciliation_required");
      }
    } finally {
      await historical.fixture.close();
    }
  }, 30_000);

  it("fails readiness closed for a partial PublicationCandidate schema", async () => {
    await fixture.migrate();
    await fixture.pool.query("DROP TRIGGER cp_publication_candidate_immutable ON cp_publication_candidate");
    await expect(checkMigrationReadiness(fixture.pool, fixture.migrations))
      .resolves.toEqual({ ready: false, reason: "migrations_pending" });
  });

  it("upgrades a fully applied 0012 schema through checked-in publication migrations", async () => {
    const upgrade = await createIsolatedPostgres();
    try {
      await runMigrations(upgrade.pool,migrationsBefore(upgrade.migrations,"0013_publication_candidates.sql"));
      expect((await upgrade.pool.query(
        "SELECT to_regclass('cp_publication_candidate') AS relation",
      )).rows).toEqual([{ relation: null }]);
      await runMigrations(upgrade.pool, upgrade.migrations);
      await expect(checkMigrationReadiness(upgrade.pool, upgrade.migrations))
        .resolves.toEqual({ ready: true });
    } finally {
      await upgrade.close();
    }
  });

  it("upgrades the exact b1f954dd unversioned immutable table with a durably accepted row", async () => {
    const upgrade = await createIsolatedPostgres();
    try {
      await runMigrations(upgrade.pool,migrationsBefore(upgrade.migrations,"0013_publication_candidates.sql"));
      const now = new Date("2026-08-15T07:00:00.000Z");
      const runners = createRunnerDirectory({ pool: upgrade.pool,
        clock: { now: () => now }, tokenFactory: () => "runtime_upgrade_secret",
        idFactory: () => "credential_upgrade" });
      await runners.register({ organizationId: "org_upgrade", organizationName: "Upgrade",
        request: { schemaVersion: 1, protocolVersion: "1.0",
          requiredCapabilities: ["relay.registration.v1"], requestId: "request_upgrade",
          operationId: "operation_upgrade", runnerId: "runner_upgrade",
          capabilities: [...HOSTED_CAPABILITIES] } });
      const authenticated = await runners.authenticate("runtime_upgrade_secret");
      if (authenticated.kind !== "authenticated") throw new Error("upgrade auth failed");
      await recordHostedReadiness({ pool: upgrade.pool, organizationId: "org_upgrade",
        runnerId: "runner_upgrade" });
      const hosted = createHostedRunCoordinator({ pool: upgrade.pool,
        clock: { now: () => now }, leaseDurationMs: 60_000,
        idFactory: () => "attempt_upgrade", tokenFactory: () => "fence_attempt_upgrade",
        issueSourceContentGrantInTransaction: hostedGrantIssuerFixture });
      const admission = await hostedAdmissionFixture({ runId: "run_upgrade",
        suffix: "upgrade", organizationId: "org_upgrade", runnerId: "runner_upgrade" });
      await hosted.admit({ runId: "run_upgrade", admission: admission.admission,
        policy: admission.policy });
      const claimed = await hosted.claim({ principal: authenticated.principal,
        request: hostedClaimRequest({ operationId: "operation_claim_upgrade",
          requestId: "request_claim_upgrade", readinessDigest: admission.readinessDigest,
          credentialId: "credential_upgrade" }) });
      if (claimed.kind !== "claimed") throw new Error("upgrade claim failed");
      const candidateId = "candidate_upgrade";
      const assessment = { state: "proposal_ready", accepted: true, candidateId,
        reasonCodes: ["proposal_ready"], assessedAt: now.toISOString() };
      await upgrade.pool.query(
        "UPDATE cp_hosted_attempt SET state = 'succeeded' WHERE organization_id = $1 AND run_id = $2",
        ["org_upgrade", "run_upgrade"]);
      await upgrade.pool.query(
        `UPDATE cp_hosted_run SET state = 'succeeded', terminal_kind = 'succeeded',
           terminal_receipt = $3::jsonb WHERE organization_id = $1 AND run_id = $2`,
        ["org_upgrade", "run_upgrade", JSON.stringify({ kind: "proposal_ready",
          candidateId, assessment })]);
      await upgrade.pool.query(`
        CREATE TABLE cp_publication_candidate (
          organization_id text NOT NULL REFERENCES cp_organization(organization_id),
          candidate_id text NOT NULL, run_id text NOT NULL, attempt_id text NOT NULL,
          project_target_id text NOT NULL, frozen_base_revision text NOT NULL
            CHECK (frozen_base_revision ~ '^[a-f0-9]{40,64}$'),
          workspace_tree_digest text NOT NULL CHECK (workspace_tree_digest ~ '^[a-f0-9]{40,64}$'),
          patch_digest text NOT NULL CHECK (patch_digest ~ '^sha256:[a-f0-9]{64}$'),
          changed_files text[] NOT NULL CHECK (cardinality(changed_files) > 0),
          verification_evidence_ids text[] NOT NULL CHECK (cardinality(verification_evidence_ids) > 0),
          publication_policy_digest text NOT NULL CHECK (publication_policy_digest ~ '^sha256:[a-f0-9]{64}$'),
          candidate jsonb NOT NULL CHECK (jsonb_typeof(candidate) = 'object'
            AND NOT candidate ?| ARRAY['baseToFinalBinaryDiff','limitations','workspacePath','logs','output','secret']),
          created_at timestamptz NOT NULL, PRIMARY KEY (organization_id, candidate_id),
          UNIQUE (organization_id, run_id, attempt_id));
        CREATE INDEX cp_publication_candidate_run_idx
          ON cp_publication_candidate(organization_id, run_id);
        CREATE FUNCTION cp_reject_publication_candidate_mutation() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication_candidate_immutable'; END $$;
        CREATE TRIGGER cp_publication_candidate_immutable BEFORE UPDATE OR DELETE
          ON cp_publication_candidate FOR EACH ROW
          EXECUTE FUNCTION cp_reject_publication_candidate_mutation();`);
      const candidate = { candidateId, runId: "run_upgrade",
        attemptId: claimed.claim.attempt.id,
        projectTargetId: admission.admission.projectTarget.projectTargetId,
        frozenBaseRevision: "a".repeat(40), workspaceTreeDigest: "b".repeat(40),
        patchDigest: `sha256:${"c".repeat(64)}`, changedFiles: ["a.ts"],
        verificationEvidenceIds: [`sha256:${"d".repeat(64)}`],
        publicationPolicyDigest: admission.admission.publicationPolicy.digest,
        createdAt: now.toISOString() };
      await upgrade.pool.query(
        `INSERT INTO cp_publication_candidate(organization_id, candidate_id, run_id,
           attempt_id, project_target_id, frozen_base_revision, workspace_tree_digest,
           patch_digest, changed_files, verification_evidence_ids,
           publication_policy_digest, candidate, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
        ["org_upgrade", candidateId, "run_upgrade", claimed.claim.attempt.id,
          candidate.projectTargetId, candidate.frozenBaseRevision,
          candidate.workspaceTreeDigest, candidate.patchDigest, candidate.changedFiles,
          candidate.verificationEvidenceIds, candidate.publicationPolicyDigest,
          JSON.stringify(candidate), now]);

      await runMigrations(upgrade.pool, upgrade.migrations);

      expect((await upgrade.pool.query(
        `SELECT attempt_number, completion_assessment, candidate
         FROM cp_publication_candidate WHERE candidate_id = $1`, [candidateId])).rows)
        .toEqual([{ attempt_number: claimed.claim.attempt.number,
          completion_assessment: assessment, candidate }]);
      await expect(checkMigrationReadiness(upgrade.pool, upgrade.migrations))
        .resolves.toEqual({ ready: true });
    } finally {
      await upgrade.close();
    }
  });

  it("aborts unversioned Candidate reconciliation with a stable operator-action reason", async () => {
    const unsupported = await createIsolatedPostgres();
    try {
      await runMigrations(unsupported.pool,migrationsBefore(unsupported.migrations,"0013_publication_candidates.sql"));
      await unsupported.pool.query(
        "INSERT INTO cp_organization(organization_id, display_name, created_at) VALUES('org_orphan','Orphan',clock_timestamp())");
      await unsupported.pool.query(`
        CREATE TABLE cp_publication_candidate (
          organization_id text NOT NULL REFERENCES cp_organization(organization_id),
          candidate_id text NOT NULL, run_id text NOT NULL, attempt_id text NOT NULL,
          project_target_id text NOT NULL, frozen_base_revision text NOT NULL,
          workspace_tree_digest text NOT NULL, patch_digest text NOT NULL,
          changed_files text[] NOT NULL, verification_evidence_ids text[] NOT NULL,
          publication_policy_digest text NOT NULL, candidate jsonb NOT NULL,
          created_at timestamptz NOT NULL, PRIMARY KEY (organization_id, candidate_id),
          UNIQUE (organization_id, run_id, attempt_id));
        CREATE INDEX cp_publication_candidate_run_idx
          ON cp_publication_candidate(organization_id, run_id);
        CREATE FUNCTION cp_reject_publication_candidate_mutation() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'publication_candidate_immutable'; END $$;
        CREATE TRIGGER cp_publication_candidate_immutable BEFORE UPDATE OR DELETE
          ON cp_publication_candidate FOR EACH ROW
          EXECUTE FUNCTION cp_reject_publication_candidate_mutation();
        INSERT INTO cp_publication_candidate VALUES(
          'org_orphan','candidate_orphan','run_missing','attempt_missing','target',
          repeat('a',40),repeat('b',40),'sha256:'||repeat('c',64),ARRAY['a.ts'],
          ARRAY['sha256:'||repeat('d',64)],'sha256:'||repeat('e',64),
          jsonb_build_object('candidateId','candidate_orphan','runId','run_missing',
            'attemptId','attempt_missing','projectTargetId','target',
            'frozenBaseRevision',repeat('a',40),'workspaceTreeDigest',repeat('b',40),
            'patchDigest','sha256:'||repeat('c',64),'changedFiles',ARRAY['a.ts'],
            'verificationEvidenceIds',ARRAY['sha256:'||repeat('d',64)],
            'publicationPolicyDigest','sha256:'||repeat('e',64),
            'createdAt','2026-08-15T07:00:00.000Z'),clock_timestamp());`);

      await expect(runMigrations(unsupported.pool, unsupported.migrations))
        .rejects.toThrow("publication_candidate_upgrade_reconciliation_required");
    } finally {
      await unsupported.close();
    }
  });

  it.each([
    ["missing assessedAt", { mutateAssessment: (assessment: Record<string, unknown>) => {
      delete assessment["assessedAt"];
    }}],
    ["invalid assessedAt", { mutateAssessment: (assessment: Record<string, unknown>) => {
      assessment["assessedAt"] = "not-a-timestamp";
    }}],
    ["noncanonical assessedAt", { mutateAssessment: (assessment: Record<string, unknown>) => {
      assessment["assessedAt"] = "2026-08-15T07:00:00Z";
    }}],
    ["year-zero assessedAt", { mutateAssessment: (assessment: Record<string, unknown>) => {
      assessment["assessedAt"] = "0000-01-01T00:00:00.000Z";
    }}],
    ["extra key", { mutateAssessment: (assessment: Record<string, unknown>) => {
      assessment["unexpected"] = true;
    }}],
    ["wrong accepted type", { mutateAssessment: (assessment: Record<string, unknown>) => {
      assessment["accepted"] = "true";
    }}],
    ["duplicate reason codes", { mutateAssessment: (assessment: Record<string, unknown>) => {
      assessment["reasonCodes"] = ["proposal_ready", "proposal_ready"];
    }}],
    ["noncanonical reason codes", { mutateAssessment: (assessment: Record<string, unknown>) => {
      assessment["reasonCodes"] = ["proposal_ready", "material_action_unknown"];
    }}],
    ["Candidate mismatch", { mutateAssessment: (assessment: Record<string, unknown>) => {
      assessment["candidateId"] = "candidate_other";
    }}],
    ["scalar", { mutateAssessment: () => "proposal_ready" }],
    ["array", { mutateAssessment: () => ["proposal_ready"] }],
    ["JSON null", { mutateAssessment: () => null }],
    ["wrong keys", { mutateAssessment: () => ({ unexpected: true }) }],
  ] as const)("refuses malformed historical assessment: %s", async (_label, mutation) => {
    const malformed = await createActualUnversionedFixture(mutation);
    try {
      await expect(runMigrations(malformed.fixture.pool, malformed.fixture.migrations))
        .rejects.toThrow("publication_candidate_upgrade_reconciliation_required");
    } finally {
      await malformed.fixture.close();
    }
  });

  it.each([
    ["numeric scalar identity", {
      prepareCandidate: (candidate) => { candidate.projectTargetId = "123"; },
      mutateCandidate: (candidate: Record<string, unknown>) => { candidate["projectTargetId"] = 123; },
    }],
    ["boolean scalar identity", {
      prepareCandidate: (candidate) => { candidate.projectTargetId = "true"; },
      mutateCandidate: (candidate: Record<string, unknown>) => { candidate["projectTargetId"] = true; },
    }],
    ["empty changed-file string", {
      prepareCandidate: (candidate) => { candidate.changedFiles = [""]; },
    }],
    ["invalid verification evidence digest", {
      prepareCandidate: (candidate) => { candidate.verificationEvidenceIds = ["not-a-digest"]; },
    }],
    ["unsorted changed files", {
      prepareCandidate: (candidate) => { candidate.changedFiles = ["z.ts", "a.ts"]; },
    }],
    ["duplicate changed files", {
      prepareCandidate: (candidate) => { candidate.changedFiles = ["a.ts", "a.ts"]; },
    }],
    ["unsorted verification evidence", {
      prepareCandidate: (candidate) => { candidate.verificationEvidenceIds = [
        `sha256:${"b".repeat(64)}`, `sha256:${"a".repeat(64)}`]; },
    }],
    ["duplicate verification evidence", {
      prepareCandidate: (candidate) => { candidate.verificationEvidenceIds = [
        `sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(64)}`]; },
    }],
    ["extra Candidate key", {
      mutateCandidate: (candidate: Record<string, unknown>) => { candidate["unexpected"] = true; },
    }],
    ["missing Candidate key", {
      mutateCandidate: (candidate: Record<string, unknown>) => { delete candidate["createdAt"]; },
    }],
    ["wrong Candidate value type", {
      mutateCandidate: (candidate: Record<string, unknown>) => { candidate["createdAt"] = null; },
    }],
    ["noncanonical Candidate timestamp", {
      prepareCandidate: (candidate) => { candidate.createdAt = "2026-08-15T07:00:00Z"; },
    }],
    ["year-zero Candidate timestamp", {
      mutateCandidate: (candidate: Record<string, unknown>) => {
        candidate["createdAt"] = "0000-01-01T00:00:00.000Z";
      },
    }],
  ] as const)("refuses malformed historical Candidate: %s", async (_label, mutation) => {
    const malformed = await createActualUnversionedFixture(mutation);
    try {
      await expect(runMigrations(malformed.fixture.pool, malformed.fixture.migrations))
        .rejects.toThrow("publication_candidate_upgrade_reconciliation_required");
    } finally {
      await malformed.fixture.close();
    }
  });

  it.each([
    ["attempt FK", `ALTER TABLE cp_publication_candidate DROP CONSTRAINT cp_publication_candidate_attempt_fk;
      ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_attempt_fk
      FOREIGN KEY (organization_id, run_id, attempt_number)
      REFERENCES cp_hosted_attempt(organization_id, run_id, attempt_number)`],
    ["organization FK alternate target", `ALTER TABLE cp_organization
      ADD COLUMN alternate_organization_id text;
      UPDATE cp_organization SET alternate_organization_id = organization_id || '_alternate';
      ALTER TABLE cp_organization ALTER COLUMN alternate_organization_id SET NOT NULL;
      ALTER TABLE cp_organization
      ADD CONSTRAINT cp_organization_alternate_organization_key UNIQUE (alternate_organization_id);
      ALTER TABLE cp_publication_candidate
      DROP CONSTRAINT cp_publication_candidate_organization_id_fkey;
      ALTER TABLE cp_publication_candidate
      ADD CONSTRAINT cp_publication_candidate_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES cp_organization(alternate_organization_id)`],
    ["check definition", `ALTER TABLE cp_publication_candidate DROP CONSTRAINT cp_publication_candidate_patch_digest_check;
      ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_patch_digest_check CHECK (patch_digest <> '')`],
    ["column nullability", "ALTER TABLE cp_publication_candidate ALTER COLUMN completion_assessment DROP NOT NULL"],
    ["column type", "ALTER TABLE cp_publication_candidate ALTER COLUMN project_target_id TYPE varchar(255)"],
    ["index definition", `DROP INDEX cp_publication_candidate_run_idx;
      CREATE INDEX cp_publication_candidate_run_idx ON cp_publication_candidate(candidate_id)`],
    ["trigger event", `DROP TRIGGER cp_publication_candidate_immutable ON cp_publication_candidate;
      CREATE TRIGGER cp_publication_candidate_immutable BEFORE UPDATE ON cp_publication_candidate
      FOR EACH ROW EXECUTE FUNCTION cp_reject_publication_candidate_mutation()`],
    ["function body", `CREATE OR REPLACE FUNCTION cp_reject_publication_candidate_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`],
    ["token-preserving content check", `ALTER TABLE cp_publication_candidate
      DROP CONSTRAINT cp_publication_candidate_content_free_check;
      ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_content_free_check
      CHECK ((jsonb_typeof(candidate) = 'object' AND NOT candidate ?| ARRAY[
        'baseToFinalBinaryDiff','limitations','workspacePath','logs','output','secret']) OR true)`],
    ["not-valid attempt FK", `ALTER TABLE cp_publication_candidate
      DROP CONSTRAINT cp_publication_candidate_attempt_fk;
      ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_attempt_fk
      FOREIGN KEY (organization_id,run_id,attempt_number,attempt_id)
      REFERENCES cp_hosted_attempt(organization_id,run_id,attempt_number,attempt_id) NOT VALID`],
    ["not-valid check", `ALTER TABLE cp_publication_candidate
      DROP CONSTRAINT cp_publication_candidate_patch_digest_check;
      ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_patch_digest_check
      CHECK (patch_digest ~ '^sha256:[a-f0-9]{64}$') NOT VALID`],
    ["FK actions and deferrability", `ALTER TABLE cp_publication_candidate
      DROP CONSTRAINT cp_publication_candidate_attempt_fk;
      ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_attempt_fk
      FOREIGN KEY (organization_id,run_id,attempt_number,attempt_id)
      REFERENCES cp_hosted_attempt(organization_id,run_id,attempt_number,attempt_id)
      MATCH FULL ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`],
    ["no-inherit check", `ALTER TABLE cp_publication_candidate
      DROP CONSTRAINT cp_publication_candidate_patch_digest_check;
      ALTER TABLE cp_publication_candidate ADD CONSTRAINT cp_publication_candidate_patch_digest_check
      CHECK (patch_digest ~ '^sha256:[a-f0-9]{64}$') NO INHERIT`],
    ["conditional trigger", `DROP TRIGGER cp_publication_candidate_immutable ON cp_publication_candidate;
      CREATE TRIGGER cp_publication_candidate_immutable BEFORE UPDATE OR DELETE
      ON cp_publication_candidate FOR EACH ROW WHEN (false)
      EXECUTE FUNCTION cp_reject_publication_candidate_mutation()`],
    ["trigger arguments", `DROP TRIGGER cp_publication_candidate_immutable ON cp_publication_candidate;
      CREATE TRIGGER cp_publication_candidate_immutable BEFORE UPDATE OR DELETE
      ON cp_publication_candidate FOR EACH ROW
      EXECUTE FUNCTION cp_reject_publication_candidate_mutation('unexpected')`],
  ] as const)("fails readiness closed for tampered %s", async (_label, tamperSql) => {
    const tampered = await createIsolatedPostgres();
    try {
      await tampered.migrate();
      await tampered.pool.query(tamperSql);
      await expect(checkMigrationReadiness(tampered.pool, tampered.migrations))
        .resolves.toEqual({ ready: false, reason: "migrations_pending" });
    } finally {
      await tampered.close();
    }
  });

  it("does not let a spare correct Organization FK mask a retargeted canonical FK", async () => {
    const tampered = await createIsolatedPostgres();
    try {
      await tampered.migrate();
      await tampered.pool.query(`ALTER TABLE cp_organization
        ADD COLUMN alternate_organization_id text;
        UPDATE cp_organization SET alternate_organization_id = organization_id || '_alternate';
        ALTER TABLE cp_organization ALTER COLUMN alternate_organization_id SET NOT NULL;
        ALTER TABLE cp_organization
          ADD CONSTRAINT cp_organization_alternate_organization_key UNIQUE (alternate_organization_id);
        ALTER TABLE cp_publication_candidate
          DROP CONSTRAINT cp_publication_candidate_organization_id_fkey;
        ALTER TABLE cp_publication_candidate
          ADD CONSTRAINT cp_publication_candidate_organization_id_fkey
          FOREIGN KEY (organization_id) REFERENCES cp_organization(alternate_organization_id);
        ALTER TABLE cp_publication_candidate
          ADD CONSTRAINT cp_publication_candidate_spare_organization_fk
          FOREIGN KEY (organization_id) REFERENCES cp_organization(organization_id)`);
      await expect(checkMigrationReadiness(tampered.pool, tampered.migrations))
        .resolves.toEqual({ ready: false, reason: "migrations_pending" });
    } finally {
      await tampered.close();
    }
  });

  it("carries legacy hosted rows into the canonical immutable lifecycle", async () => {
    const legacy = await createIsolatedPostgres();
    try {
      await runMigrations(legacy.pool, legacy.migrations.slice(0, 7));
      const createdAt = "2026-08-28T00:00:00.000Z";
      await legacy.pool.query(
        "INSERT INTO cp_organization(organization_id, display_name, created_at) VALUES($1,$2,$3)",
        ["org_legacy", "Legacy", createdAt],
      );
      await legacy.pool.query(
        `INSERT INTO cp_runner(organization_id, runner_id, registration_generation,
           credential_generation, current_credential_id, capabilities, created_at, updated_at)
         VALUES($1,$2,1,1,$3,'[]'::jsonb,$4,$4)`,
        ["org_legacy", "runner_legacy", "credential_legacy", createdAt],
      );
      await legacy.pool.query(
        `INSERT INTO cp_hosted_run(organization_id, run_id, admission_id,
           admission_operation_id, admission_digest, source_identity_digest,
           runner_id, executor_id, state, hosted_admission,
           admission_policy_snapshot, created_at, updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending','{}'::jsonb,'{}'::jsonb,$9,$9)`,
        ["org_legacy", "run_legacy", "admission_legacy", "operation_legacy",
          `sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`,
          "runner_legacy", "executor_legacy", createdAt],
      );
      await legacy.pool.query(
        `INSERT INTO cp_hosted_claim(organization_id, operation_id, request_digest,
           run_id, claim, created_at) VALUES($1,$2,$3,$4,'{}'::jsonb,$5)`,
        ["org_legacy", "operation_claim_legacy", `sha256:${"3".repeat(64)}`,
          "run_legacy", createdAt],
      );

      await runMigrations(legacy.pool, legacy.migrations);

      const row = await legacy.pool.query(
        `SELECT state, source_version_ref, source_content_ids, queue_claim_deadline,
           publication_mode, completion_mode FROM cp_hosted_run WHERE run_id = $1`,
        ["run_legacy"],
      );
      expect(row.rows[0]).toMatchObject({ state: "interrupted",
        source_version_ref: `legacy:sha256:${"2".repeat(64)}`,
        source_content_ids: ["legacy:run_legacy"], publication_mode: "proposal_only",
        completion_mode: "proposal_ready" });
      expect((await legacy.pool.query(
        "SELECT claim_version FROM cp_hosted_claim WHERE operation_id = $1",
        ["operation_claim_legacy"])).rows).toEqual([{ claim_version: 1 }]);
      await expect(legacy.pool.query(
        "UPDATE cp_hosted_run SET queue_claim_deadline = queue_claim_deadline + interval '1 hour' WHERE run_id = $1",
        ["run_legacy"],
      )).rejects.toThrow("hosted_run_admission_frozen");
    } finally {
      await legacy.close();
    }
  });

  it("backfills migration material precedence and fully closes exact proof authority", async () => {
    const legacy = await createIsolatedPostgres();
    try {
      await runMigrations(legacy.pool, legacy.migrations.slice(0, 7));
      const createdAt = "2026-08-28T01:00:00.000Z";
      await legacy.pool.query(
        "INSERT INTO cp_organization(organization_id, display_name, created_at) VALUES($1,$2,$3)",
        ["org_truth", "Truth", createdAt]);
      await legacy.pool.query(
        `INSERT INTO cp_runner(organization_id, runner_id, registration_generation,
           credential_generation, current_credential_id, capabilities, created_at, updated_at)
         VALUES($1,$2,1,1,$3,'[]'::jsonb,$4,$4)`,
        ["org_truth", "runner_truth", "credential_truth", createdAt]);
      const kinds = ["begin", "begin_proof", "receipt_begin_proof", "proof",
        "proof_future", "malformed_proof", "mismatched_proof", "missing"] as const;
      for (const [kindIndex, kind] of kinds.entries()) {
        const runId = `run_truth_${kind}`;
        await legacy.pool.query(
          `INSERT INTO cp_hosted_run(organization_id, run_id, admission_id,
             admission_operation_id, admission_digest, source_identity_digest,
             runner_id, executor_id, state, current_attempt_number, hosted_admission,
             admission_policy_snapshot, created_at, updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,'executor','claimed',1,'{}','{}',$8,$8)`,
          ["org_truth", runId, `admission_${kind}`, `operation_${kind}`,
            `sha256:${(kindIndex + 1).toString(16).repeat(64)}`,
            `sha256:${(kindIndex + 9).toString(16).repeat(64)}`,
            "runner_truth", createdAt]);
        await legacy.pool.query(
          `INSERT INTO cp_hosted_attempt(organization_id, run_id, attempt_number,
             attempt_id, runner_id, credential_id, fencing_token_digest,
             lease_expires_at, state, claimed_at, updated_at)
           VALUES($1,$2,1,$3,$4,$5,$6,$7,'claimed',$8,$8)`,
          ["org_truth", runId, `attempt_${kind}`, "runner_truth", "credential_truth",
            `sha256:${"a".repeat(64)}`, "2026-08-29T00:00:00.000Z", createdAt]);
        await legacy.pool.query(
          `INSERT INTO cp_source_content_read_grant(grant_id, organization_id,
             token_hash, run_id, attempt_id, fence_digest, content_ids, purpose,
             expires_at, created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,'source_context',$8,$9)`,
          [`grant_${kind}`, "org_truth", `token_${kind}`, runId, `attempt_${kind}`,
            `sha256:${"a".repeat(64)}`, [`content_${kind}`],
            "2026-08-29T00:00:00.000Z", createdAt]);
        await legacy.pool.query(
          `INSERT INTO cp_permission_request(organization_id, permission_request_id,
             run_id, runner_id, attempt_id, attempt_number, action_id, resolution_id,
             permission_request_digest, policy_snapshot_digest, state, request,
             current_receipt, created_at, updated_at)
           VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,'waiting','{}','{}',$10,$10)`,
          ["org_truth", `permission_${kind}`, runId, "runner_truth", `attempt_${kind}`,
            `action_${kind}`, `resolution_${kind}`, `sha256:${"e".repeat(64)}`,
            `sha256:${"f".repeat(64)}`, createdAt]);
        if (kind === "receipt_begin_proof") await legacy.pool.query(
          `INSERT INTO cp_material_action_receipt(organization_id, receipt_id,
             operation_id, run_id, runner_id, attempt_id, attempt_number,
             action_id, receipt_digest, outcome, receipt, created_at)
           VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,'outcome_unknown','{}',$9)`,
          ["org_truth", `receipt_${kind}`, `material_${kind}`, runId,
            "runner_truth", `attempt_${kind}`, `action_${kind}`,
            `sha256:${"c".repeat(64)}`, createdAt]);
      }
      await legacy.pool.query(
        `CREATE TABLE cp_material_action_non_start_proof(
           organization_id text NOT NULL, run_id text NOT NULL, attempt_id text NOT NULL,
           attempt_number integer NOT NULL, fencing_token_digest text NOT NULL,
           proof_id text NOT NULL, proof_digest text NOT NULL, recorded_at timestamptz NOT NULL,
           PRIMARY KEY(organization_id,run_id,attempt_id), UNIQUE(organization_id,proof_id),
           FOREIGN KEY(organization_id,run_id,attempt_number)
             REFERENCES cp_hosted_attempt(organization_id,run_id,attempt_number))`);
      await legacy.pool.query(
        `CREATE TABLE cp_material_action_begin_intent(
           organization_id text NOT NULL, run_id text NOT NULL, attempt_id text NOT NULL,
           attempt_number integer NOT NULL, fencing_token_digest text NOT NULL,
           action_id text NOT NULL, action_descriptor text NOT NULL,
           action_descriptor_digest text NOT NULL, target_fingerprint text NOT NULL,
           policy_snapshot_digest text NOT NULL, authority_kind text NOT NULL,
           authority_reference_id text NOT NULL, authority_reference_digest text NOT NULL,
           idempotency_key text NOT NULL, begun_at timestamptz NOT NULL,
           PRIMARY KEY(organization_id,run_id,attempt_id,action_id),
           UNIQUE(organization_id,idempotency_key))`);
      for (const kind of ["begin", "begin_proof", "receipt_begin_proof"] as const) {
        await legacy.pool.query(
          `INSERT INTO cp_material_action_begin_intent VALUES(
             $1,$2,$3,1,$4,$5,'workspace.write',$6,$7,$8,'permission_resolution',
             $9,$10,$11,$12)`,
          ["org_truth", `run_truth_${kind}`, `attempt_${kind}`,
            `sha256:${"a".repeat(64)}`, `action_${kind}`, `sha256:${"b".repeat(64)}`,
            `sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`,
            `permission_receipt_${kind}`, `sha256:${"e".repeat(64)}`,
            `begin_${kind}`, createdAt]);
      }
      for (const kind of ["proof", "proof_future", "begin_proof",
        "receipt_begin_proof"] as const) await legacy.pool.query(
        `INSERT INTO cp_material_action_non_start_proof VALUES($1,$2,$3,1,$4,$5,$6,$7)`,
        ["org_truth", `run_truth_${kind}`, `attempt_${kind}`,
          `sha256:${"a".repeat(64)}`, `proof_${kind}`,
          `sha256:${"d".repeat(64)}`, createdAt]);
      await legacy.pool.query(
        `INSERT INTO cp_material_action_non_start_proof VALUES($1,$2,$3,1,$4,$5,$6,$7)`,
        ["org_truth", "run_truth_malformed_proof", "malformed", "not-a-digest",
          "proof_malformed", "malformed", createdAt]);
      await legacy.pool.query(
        `INSERT INTO cp_material_action_non_start_proof VALUES($1,$2,$3,1,$4,$5,$6,$7)`,
        ["org_truth", "run_truth_mismatched_proof", "attempt_other",
          `sha256:${"9".repeat(64)}`, "proof_mismatched",
          `sha256:${"d".repeat(64)}`, createdAt]);

      await runMigrations(legacy.pool, legacy.migrations);

      const states = await legacy.pool.query(
        `SELECT run_id, state, material_start_state, lease_expires_at <= $2 AS fenced
         FROM cp_hosted_attempt
         WHERE organization_id = $1 ORDER BY run_id`, ["org_truth", createdAt]);
      expect(states.rows).toEqual([
        { run_id: "run_truth_begin", state: "claimed",
          material_start_state: "started_or_ambiguous", fenced: false },
        { run_id: "run_truth_begin_proof", state: "claimed",
          material_start_state: "started_or_ambiguous", fenced: false },
        { run_id: "run_truth_malformed_proof", state: "claimed",
          material_start_state: "open", fenced: false },
        { run_id: "run_truth_mismatched_proof", state: "claimed",
          material_start_state: "open", fenced: false },
        { run_id: "run_truth_missing", state: "claimed",
          material_start_state: "open", fenced: false },
        { run_id: "run_truth_proof", state: "expired",
          material_start_state: "proven_not_started", fenced: true },
        { run_id: "run_truth_proof_future", state: "expired",
          material_start_state: "proven_not_started", fenced: true },
        { run_id: "run_truth_receipt_begin_proof", state: "claimed",
          material_start_state: "started_or_ambiguous", fenced: false },
      ]);
      expect((await legacy.pool.query(
        `SELECT permission.state AS permission_state, grant_record.revoked_at IS NOT NULL AS revoked,
                run.state AS run_state
         FROM cp_hosted_run run
         JOIN cp_permission_request permission USING (organization_id, run_id)
         JOIN cp_source_content_read_grant grant_record USING (organization_id, run_id)
         WHERE run.organization_id = $1 AND run.run_id IN ($2,$3)
         ORDER BY run.run_id`, ["org_truth", "run_truth_proof", "run_truth_proof_future"]
      )).rows).toEqual([
        { permission_state: "revoked", revoked: true, run_state: "assigned" },
        { permission_state: "revoked", revoked: true, run_state: "assigned" },
      ]);

      await legacy.pool.query(
        `INSERT INTO cp_material_action_begin_intent VALUES(
           $1,$2,$3,1,$4,$5,'workspace.write',$6,$7,$8,'permission_resolution',
           $9,$10,$11,$12)`,
        ["org_truth", "run_truth_missing", "attempt_missing",
          `sha256:${"a".repeat(64)}`, "action_guard", `sha256:${"b".repeat(64)}`,
          `sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`,
          "permission_receipt_guard", `sha256:${"e".repeat(64)}`,
          "begin_guard", createdAt]);
      await legacy.pool.query(
        `UPDATE cp_hosted_attempt SET material_start_state = 'started_or_ambiguous'
         WHERE organization_id = $1 AND run_id = $2`, ["org_truth", "run_truth_missing"]);
      await expect(legacy.pool.query(
        `INSERT INTO cp_material_action_non_start_proof VALUES($1,$2,$3,1,$4,$5,$6,$7)`,
        ["org_truth", "run_truth_missing", "attempt_missing",
          `sha256:${"a".repeat(64)}`, "proof_guard",
          `sha256:${"f".repeat(64)}`, createdAt])).rejects.toThrow(
        "material_non_start_proof_conflict",
      );
    } finally { await legacy.close(); }
  });
});
