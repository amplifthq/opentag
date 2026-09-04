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
      "0022_job_terminal_state.sql",
      "0023_effect_authority.sql",
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
    const tableNames = result.rows.map(({ table_name }) => table_name);
    expect(tableNames).toEqual([
      "control_plane_migrations",
      "cp_api_key",
      "cp_effect",
      "cp_effect_attempt",
      "cp_effect_evidence",
      "cp_hosted_attempt",
      "cp_hosted_audit_event",
      "cp_hosted_lifecycle_receipt",
      "cp_hosted_run",
      "cp_ingress_reservation",
      "cp_job",
      "cp_login_throttle",
      "cp_management_audit_event",
      "cp_material_action_begin_intent",
      "cp_material_action_current",
      "cp_material_action_receipt",
      "cp_membership",
      "cp_operator",
      "cp_organization",
      "cp_permission_operation",
      "cp_permission_request",
      "cp_project_target",
      "cp_projection_deferred_revision",
      "cp_projection_delivery_watermark",
      "cp_projection_event_cursor",
      "cp_projection_job_v2_authority",
      "cp_provider_delivery_intent",
      "cp_provider_delivery_truth_lock",
      "cp_publication_candidate",
      "cp_runner",
      "cp_runner_credential",
      "cp_runner_operation",
      "cp_runner_readiness",
      "cp_session",
      "cp_slack_action_authority",
      "cp_slack_installation",
      "cp_source_app_installation",
      "cp_source_binding",
      "cp_source_content",
      "cp_source_content_invalidation_receipt",
      "cp_source_content_read_grant",
      "cp_source_replay_tombstone",
    ]);
    expect(tableNames).not.toContain("cp_material_action_non_start_proof");

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
      // This test intentionally runs several failing migrations before it
      // exercises the migrated jobs. Keep the synthetic worker clock ahead of
      // that bounded work so a slow machine cannot make a valid migrated job
      // look not-yet-due.
      const queueNow=new Date(Date.now()+60_000);
      const claimedJobId="team-relay:org_upgrade:run_claimed:1";
      const claimedResult=await upgrade.pool.query<{job_id:string}>(`UPDATE cp_job
        SET state='claimed',attempt_count=attempt_count+1,lease_owner='old-worker',
          lease_token='old-worker-lease',lease_expires_at=$2,updated_at=$1
        WHERE job_id=$3 RETURNING job_id`,
      [queueNow,new Date(queueNow.getTime()+30_000),claimedJobId]);
      expect(claimedResult.rows).toEqual([{job_id:claimedJobId}]);
      await expect(runMigrations(upgrade.pool,upgrade.migrations)).rejects.toThrow(
        "projection_v2_legacy_job_claimed");
      expect((await upgrade.pool.query(`SELECT to_regclass('cp_projection_job_v2_authority') relation`)).rows)
        .toEqual([{relation:null}]);
      await upgrade.pool.query("UPDATE cp_job SET lease_expires_at=$2 WHERE job_id=$1",
        [claimedJobId,new Date(Date.now()-60_000)]);
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
      const newQueue=createDurableJobQueue({pool:upgrade.pool,clock:{now:()=>queueNow},
        leaseDurationMs:30_000,tokenFactory:()=>"new-worker-lease"});
      await expect(newQueue.claim("old-worker",["team-relay.project"])).resolves.toEqual({kind:"empty"});
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
      await upgrade.pool.query(
        "UPDATE cp_job SET state='failed',last_error_code='legacy_lineage_invalid' WHERE job_id=$1",
        [missingJobId],
      );
      await upgrade.pool.query(
        `INSERT INTO cp_job_settlement(job_id,lease_token,outcome,settled_at)
         VALUES($1,'legacy-lineage-terminal',$2,$3)`,
        [missingJobId, { errorCode: "legacy_lineage_invalid" }, at],
      );
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
        state,available_at,attempt_count,max_attempts,last_error_code,settlement_lease_token,
        settlement_outcome,settled_at,created_at,updated_at)
        VALUES('team-relay-state-conflict','org_collision','team-relay.project.v2',$1,
          md5('team-relay-state-conflict'||':'||$1::jsonb::text),'succeeded',$2,1,20,
          'unexpected','settled-token','{}'::jsonb,$2,$2,$2)`,[payload,at]);
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
      await corrupted.pool.query(`UPDATE cp_job SET state='succeeded',last_error_code='unexpected',
        settlement_lease_token='settled-token',settlement_outcome=$2,settled_at=$3 WHERE job_id=$1`,
      [succeeded.jobId,{errorCode:"unexpected"},at]);
      await expect(corrupted.pool.query("SELECT cp_insert_team_relay_v2_job($1,$2,$3)",
        [succeeded.jobId,"org_replay",succeeded.payload])).rejects.toThrow("projection_v2_job_state_conflict");
      const failed=await create("failed_mismatch");
      await corrupted.pool.query(`UPDATE cp_job SET state='failed',last_error_code='expected',
        settlement_lease_token='settled-token',settlement_outcome=$2,settled_at=$3 WHERE job_id=$1`,
      [failed.jobId,{errorCode:"different"},at]);
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

  it("converges publication authority to three fail-closed Effect tables", async () => {
    await fixture.migrate();
    const oldTables = ["cp_publication_branch_ownership", "cp_publication_intent",
      "cp_publication_capability", "cp_publication_begin", "cp_publication_receipt",
      "cp_publication_reconciliation", "cp_publication_completion"];
    const relations = await fixture.pool.query<{ name: string; relation: string | null }>(
      `SELECT name,to_regclass(name)::text AS relation
       FROM unnest($1::text[]) old_table(name)`, [oldTables]);
    expect(relations.rows.every(({ relation }) => relation === null)).toBe(true);
    for (const table of ["cp_effect", "cp_effect_attempt", "cp_effect_evidence"]) {
      const columns = await fixture.pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name,is_nullable FROM information_schema.columns
         WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
        [fixture.schema, table]);
      expect(columns.rows).toContainEqual({ column_name: "organization_id", is_nullable: "NO" });
      const primaryKey = await fixture.pool.query(
        `SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema=$1 AND table_name=$2 AND constraint_type='PRIMARY KEY'`,
        [fixture.schema, table]);
      expect(primaryKey.rowCount).toBe(1);
    }
    const targetGeneration = await fixture.pool.query(
      `SELECT is_nullable,column_default FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='cp_project_target'
         AND column_name='binding_generation'`, [fixture.schema]);
    expect(targetGeneration.rows).toEqual([{ is_nullable: "NO", column_default: null }]);
    const slackEffectApproval = await fixture.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema=$1
       AND table_name='cp_slack_action_authority'
       AND column_name IN ('publication_approval','effect_approval')`, [fixture.schema]);
    expect(slackEffectApproval.rows).toEqual([{ column_name: "effect_approval" }]);
  });

  it("backfills an existing Project Target to binding generation one", async () => {
    const upgrade = await createIsolatedPostgres();
    try {
      await runMigrations(upgrade.pool,
        migrationsBefore(upgrade.migrations, "0023_effect_authority.sql"));
      await upgrade.pool.query(
        "INSERT INTO cp_organization(organization_id,display_name) VALUES('org_effect_upgrade','Effect upgrade')",
      );
      await upgrade.pool.query(
        `INSERT INTO cp_runner(organization_id,runner_id,registration_generation,
           credential_generation,current_credential_id,capabilities,created_at,updated_at)
         VALUES('org_effect_upgrade','runner_effect_upgrade',1,1,'credential_effect_upgrade',
           '[]'::jsonb,$1,$1)`, [new Date("2026-08-15T07:00:00.000Z")],
      );
      await upgrade.pool.query(
        `INSERT INTO cp_project_target(organization_id,project_target_id,runner_id,binding_digest,
           provider,owner,repo,default_executor,default_branch,updated_at)
         VALUES('org_effect_upgrade','target_effect_upgrade','runner_effect_upgrade',$1,
           'github','acme','demo','executor_acp','main',$2)`,
        [`sha256:${"e".repeat(64)}`, new Date("2026-08-15T07:00:00.000Z")],
      );
      await runMigrations(upgrade.pool, upgrade.migrations);
      expect((await upgrade.pool.query(
        `SELECT binding_generation FROM cp_project_target
         WHERE organization_id='org_effect_upgrade'`,
      )).rows).toEqual([{ binding_generation: 1 }]);
      await expect(checkMigrationReadiness(upgrade.pool, upgrade.migrations))
        .resolves.toEqual({ ready: true });
    } finally { await upgrade.close(); }
  });

  it("rolls back the Effect cutover when a legacy publication capability exists", async () => {
    const cutover = await createIsolatedPostgres();
    const at = new Date("2026-08-15T07:00:00.000Z");
    const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
    try {
      await runMigrations(cutover.pool,
        migrationsBefore(cutover.migrations, "0023_effect_authority.sql"));
      const runners = createRunnerDirectory({ pool: cutover.pool, clock: { now: () => at },
        tokenFactory: () => "runtime_effect_cutover_secret",
        idFactory: () => "credential_effect_cutover" });
      await runners.register({ organizationId: "org_effect_cutover",
        organizationName: "Effect cutover", request: { schemaVersion: 1,
          protocolVersion: "1.0", requiredCapabilities: ["relay.registration.v1"],
          requestId: "request_effect_cutover", operationId: "operation_effect_cutover",
          runnerId: "runner_effect_cutover", capabilities: [...HOSTED_CAPABILITIES] } });
      const authenticated = await runners.authenticate("runtime_effect_cutover_secret");
      if (authenticated.kind !== "authenticated") throw new Error("cutover auth failed");
      await recordHostedReadiness({ pool: cutover.pool, organizationId: "org_effect_cutover",
        runnerId: "runner_effect_cutover" });
      const hosted = createHostedRunCoordinator({ pool: cutover.pool, clock: { now: () => at },
        leaseDurationMs: 60_000, idFactory: () => "attempt_effect_cutover",
        tokenFactory: () => "fence_effect_cutover",
        issueSourceContentGrantInTransaction: hostedGrantIssuerFixture });
      const admission = await hostedAdmissionFixture({ runId: "run_effect_cutover",
        suffix: "effect_cutover", organizationId: "org_effect_cutover",
        runnerId: "runner_effect_cutover", publicationMode: "pull_request",
        queueClaimDeadline: new Date(at.getTime() + 60 * 60_000).toISOString() });
      await hosted.admit({ runId: "run_effect_cutover", admission: admission.admission,
        policy: admission.policy });
      const claimed = await hosted.claim({ principal: authenticated.principal,
        request: hostedClaimRequest({ operationId: "operation_claim_effect_cutover",
          requestId: "request_claim_effect_cutover",
          credentialId: "credential_effect_cutover" }) });
      if (claimed.kind !== "claimed") throw new Error("cutover claim failed");
      const candidate = { candidateId: "candidate_effect_cutover",
        runId: "run_effect_cutover", attemptId: claimed.claim.attempt.id,
        projectTargetId: admission.admission.projectTarget.projectTargetId,
        frozenBaseRevision: "a".repeat(40), workspaceTreeDigest: "b".repeat(40),
        patchDigest: sha("cutover-patch"), changedFiles: ["cutover.ts"],
        verificationEvidenceIds: [sha("cutover-verification")],
        publicationPolicyDigest: admission.admission.publicationPolicy.digest,
        createdAt: at.toISOString() };
      const candidateDigest = sha(JSON.stringify(candidate));
      await cutover.pool.query(
        `INSERT INTO cp_publication_candidate(organization_id,candidate_id,run_id,attempt_id,
           attempt_number,project_target_id,frozen_base_revision,workspace_tree_digest,
           patch_digest,changed_files,verification_evidence_ids,publication_policy_digest,
           candidate,completion_assessment,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,
        ["org_effect_cutover", candidate.candidateId, candidate.runId, candidate.attemptId,
          claimed.claim.attempt.number, candidate.projectTargetId,
          candidate.frozenBaseRevision, candidate.workspaceTreeDigest, candidate.patchDigest,
          candidate.changedFiles, candidate.verificationEvidenceIds,
          candidate.publicationPolicyDigest, JSON.stringify(candidate),
          JSON.stringify({ state: "proposal_ready", accepted: false,
            candidateId: candidate.candidateId, reasonCodes: ["publication_pending"],
            assessedAt: at.toISOString() }), at],
      );
      await cutover.pool.query(
        `INSERT INTO cp_publication_branch_ownership(organization_id,ownership_id,run_id,
           attempt_id,attempt_number,fencing_token_digest,runner_id,runner_generation,
           candidate_id,candidate_digest,project_target_id,target_binding_digest,provider,
           owner,repo,remote,base_branch,frozen_base_revision,workspace_tree_digest,branch,
           expected_head_sha,attestation_digest,attested_at,created_at)
         VALUES($1,'ownership_effect_cutover',$2,$3,$4,$5,$6,1,$7,$8,$9,$10,
           'github','acme','demo','origin','main',$11,$12,$13,$14,$15,$16,$16)`,
        ["org_effect_cutover", candidate.runId, candidate.attemptId,
          claimed.claim.attempt.number, claimed.claim.attempt.fencingTokenDigest,
          "runner_effect_cutover", candidate.candidateId, candidateDigest,
          candidate.projectTargetId, admission.admission.projectTarget.digest,
          candidate.frozenBaseRevision, candidate.workspaceTreeDigest,
          `opentag/${candidate.runId}`, "c".repeat(40), sha("cutover-attestation"), at],
      );
      await cutover.pool.query(
        `INSERT INTO cp_publication_intent(organization_id,intent_id,run_id,attempt_id,
           attempt_number,candidate_id,candidate_digest,ownership_id,ownership_digest,
           approval_id,approver_id,approval_digest,repository,branch,expected_head_sha,
           runner_id,runner_generation,approved_at,expires_at,created_at)
         VALUES($1,'intent_effect_cutover',$2,$3,$4,$5,$6,'ownership_effect_cutover',$7,
           'approval_effect_cutover','human_effect_cutover',$8,$9::jsonb,$10,$11,$12,1,
           $13,$14,$13)`,
        ["org_effect_cutover", candidate.runId, candidate.attemptId,
          claimed.claim.attempt.number, candidate.candidateId, candidateDigest,
          sha("cutover-attestation"), sha("cutover-approval"), JSON.stringify({
            provider: "github", owner: "acme", repo: "demo", remote: "origin",
            baseBranch: "main" }), `opentag/${candidate.runId}`, "c".repeat(40),
          "runner_effect_cutover", at, new Date(at.getTime() + 15 * 60_000)],
      );
      await cutover.pool.query(
        `INSERT INTO cp_publication_capability(organization_id,capability_id,intent_id,
           operation_id,idempotency_key,step,attempt_number,capability_digest,capability,
           issued_at,expires_at)
         VALUES($1,'capability_effect_cutover','intent_effect_cutover',
           'operation_publication_effect_cutover','publication:effect-cutover',
           'create_draft_pull_request',1,$2,'{}'::jsonb,$3,$4)`,
        ["org_effect_cutover", sha("cutover-capability"), at,
          new Date(at.getTime() + 60_000)],
      );

      await expect(runMigrations(cutover.pool, cutover.migrations))
        .rejects.toThrow("effect_authority_cutover_reconciliation_required");
      expect((await cutover.pool.query(
        `SELECT count(*)::int AS count FROM cp_publication_capability
         WHERE organization_id='org_effect_cutover'`,
      )).rows[0]).toEqual({ count: 1 });
      expect((await cutover.pool.query(
        "SELECT to_regclass('cp_publication_capability')::text AS legacy, to_regclass('cp_effect')::text AS effect",
      )).rows).toEqual([{ legacy: "cp_publication_capability", effect: null }]);
      expect((await cutover.pool.query(
        `SELECT count(*)::int AS count FROM control_plane_migrations
         WHERE name='0023_effect_authority.sql'`,
      )).rows[0]).toEqual({ count: 0 });
      expect((await cutover.pool.query(
        `SELECT count(*)::int AS count FROM information_schema.columns
         WHERE table_schema=current_schema() AND table_name='cp_project_target'
           AND column_name='binding_generation'`,
      )).rows[0]).toEqual({ count: 0 });
      expect((await cutover.pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema()
         AND table_name='cp_slack_action_authority'
         AND column_name IN ('publication_approval','effect_approval')`,
      )).rows).toEqual([{ column_name: "publication_approval" }]);
    } finally { await cutover.close(); }
  });

  it.each([
    ["effect projection trigger", "ALTER TABLE cp_effect DISABLE TRIGGER cp_effect_projection"],
    ["effect transition trigger", "ALTER TABLE cp_effect DISABLE TRIGGER cp_effect_state_transition"],
    ["effect attempt trigger", "ALTER TABLE cp_effect_attempt DISABLE TRIGGER cp_effect_attempt_immutable"],
    ["effect evidence trigger", "ALTER TABLE cp_effect_evidence DISABLE TRIGGER cp_effect_evidence_immutable"],
    ["effect immutable function", `CREATE OR REPLACE FUNCTION cp_reject_effect_authority_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`],
    ["effect projection function", `CREATE OR REPLACE FUNCTION cp_project_effect_change()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`],
    ["binding generation constraint", `ALTER TABLE cp_project_target
      DROP CONSTRAINT cp_project_target_binding_generation_check`],
    ["same-name weakened projection check", `ALTER TABLE cp_effect
      DROP CONSTRAINT cp_effect_projection_shape_check;
      ALTER TABLE cp_effect ADD CONSTRAINT cp_effect_projection_shape_check CHECK (true)`],
    ["logical Effect uniqueness", "ALTER TABLE cp_effect DROP CONSTRAINT cp_effect_logical_key"],
    ["Effect candidate foreign key", `ALTER TABLE cp_effect
      DROP CONSTRAINT cp_effect_organization_id_candidate_id_fkey`],
    ["request digest nullability", "ALTER TABLE cp_effect ALTER COLUMN request_digest DROP NOT NULL"],
    ["dispatch index definition", `DROP INDEX cp_effect_dispatch_idx;
      CREATE INDEX cp_effect_dispatch_idx ON cp_effect(organization_id)`],
    ["projection trigger event", `DROP TRIGGER cp_effect_projection ON cp_effect;
      CREATE TRIGGER cp_effect_projection AFTER INSERT ON cp_effect
      FOR EACH ROW EXECUTE FUNCTION cp_project_effect_change()`],
  ] as const)("fails readiness closed for tampered EffectAuthority %s", async (_label, tamperSql) => {
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
});
