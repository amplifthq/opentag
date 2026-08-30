import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkMigrationReadiness, runMigrations } from "../src/database/migrations.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

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
