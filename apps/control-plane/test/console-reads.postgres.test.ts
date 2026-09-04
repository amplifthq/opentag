import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createConsoleReadModel } from "../src/modules/console-reads/index.js";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

const consolePrincipal = {
  operatorId: "operator_presence",
  organizationId: "org_presence",
  role: "viewer" as const,
  email: "viewer@example.test",
  displayName: "Viewer",
};

function presenceRow(overrides: Record<string, unknown> = {}) {
  return {
    installation_id: "install_1",
    binding_id: "binding_1",
    team_id: "T1",
    channel_id: "C1",
    app_id: "A1",
    bot_user_id: "U_BOT",
    configured_project_target_id: "target_1",
    project_target_id: "target_1",
    target_provider: "github",
    target_owner: "acme",
    target_repo: "demo",
    default_executor: "codex",
    configured_runner_id: "runner_1",
    runner_id: "runner_1",
    runner_display_name: "Build Mac",
    readiness_observed_at: new Date("2026-09-04T05:00:00.000Z"),
    readiness_expires_at: new Date("2026-09-04T06:00:00.000Z"),
    active_run_id: null,
    active_run_state: null,
    active_run_outcome_state: null,
    active_run_updated_at: null,
    active_run_count: 0,
    active_attempt_valid: true,
    ...overrides,
  };
}

describe("derived Agent Presence read model", () => {
  it("returns an explicit setup reason when no active Slack binding exists", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const reads = createConsoleReadModel({ pool: { query } as never });

    await expect(reads.presence(consolePrincipal)).resolves.toEqual({
      state: "setup_required",
      reason: "No active Slack installation and binding are configured.",
      agents: [],
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("hosted_admission->>'bindingId' = slack.binding_id"),
      ["org_presence"],
    );
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("binding.binding_digest = installation.binding_digest");
    expect(sql).toContain("hosted_admission->'projectTarget'->>'projectTargetId'");
    expect(sql).toContain("hosted_admission->'projectTarget'->>'digest'");
    expect(sql).toContain("runner_id = target.runner_id");
    expect(sql).toContain("producer'->>'credentialId'");
  });

  it("reports available only when the complete binding and fresh readiness exist", async () => {
    const reads = createConsoleReadModel({
      pool: { query: async () => ({ rows: [presenceRow()] }) } as never,
    });
    await expect(reads.presence(consolePrincipal)).resolves.toMatchObject({
      state: "available",
      agents: [{
        state: "available",
        reason: "Slack, Project Target, Runner, and fresh readiness are available.",
        projectTarget: { provider: "github", owner: "acme", repo: "demo" },
        runner: { runnerId: "runner_1" },
        activeRun: null,
      }],
    });
  });

  it.each([
    {
      name: "queued work",
      row: presenceRow({
        active_run_id: "run_queued",
        active_run_state: "queued",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"),
        active_run_count: 1,
      }),
      state: "queued",
    },
    {
      name: "fresh running work",
      row: presenceRow({
        active_run_id: "run_working",
        active_run_state: "running",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"),
        active_run_count: 1,
      }),
      state: "working",
    },
    {
      name: "expired readiness during a running Run",
      row: presenceRow({
        readiness_observed_at: null,
        readiness_expires_at: null,
        active_run_id: "run_stale",
        active_run_state: "running",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"),
        active_run_count: 1,
      }),
      state: "offline",
    },
    {
      name: "running work without a current valid Attempt",
      row: presenceRow({
        active_run_id: "run_invalid_attempt",
        active_run_state: "running",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"),
        active_run_count: 1,
        active_attempt_valid: false,
      }),
      state: "needs_attention",
    },
    {
      name: "human decision",
      row: presenceRow({
        active_run_id: "run_approval",
        active_run_state: "needs_approval",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"),
        active_run_count: 1,
      }),
      state: "needs_attention",
    },
    {
      name: "ambiguous outcome",
      row: presenceRow({
        active_run_id: "run_unknown",
        active_run_state: "running",
        active_run_outcome_state: "outcome_unknown",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"),
        active_run_count: 1,
      }),
      state: "needs_attention",
    },
  ])("derives $name without persisting a second state", async ({ row, state }) => {
    const reads = createConsoleReadModel({
      pool: { query: async () => ({ rows: [row] }) } as never,
    });
    await expect(reads.presence(consolePrincipal)).resolves.toMatchObject({
      state,
      agents: [{ state }],
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("tenant-scoped console read model", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const directory = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T10:00:00.000Z") },
      tokenFactory: () => "runtime_console",
      idFactory: () => "credential_console",
    });
    await directory.register({
      organizationId: "org_console_read",
      organizationName: "Console read",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_console_read",
        operationId: "operation_console_read",
        runnerId: "runner_visible",
        displayName: "Visible runner",
        capabilities: ["relay.readiness.v1"],
      },
    });
    const other = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => new Date("2026-08-15T10:00:00.000Z") },
      tokenFactory: () => "runtime_other",
      idFactory: () => "credential_other",
    });
    await other.register({
      organizationId: "org_other_read",
      organizationName: "Other",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_other_read",
        operationId: "operation_other_read",
        runnerId: "runner_concealed",
        capabilities: [],
      },
    });
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("never returns another tenant's runner or aggregate counts", async () => {
    const reads = createConsoleReadModel({ pool: fixture.pool });
    const principal = {
      operatorId: "operator_console",
      organizationId: "org_console_read",
      role: "viewer" as const,
      email: "viewer@example.test",
      displayName: "Viewer",
    };

    await expect(reads.overview(principal)).resolves.toEqual({
      runnerCount: 1,
      readyRunnerCount: 0,
      activeRunCount: 0,
      terminalRunCount: 0,
      pendingJobCount: 0,
    });
    const runners = await reads.listRunners(principal, { limit: 20 });
    expect(runners).toEqual([
      expect.objectContaining({
        runnerId: "runner_visible",
        displayName: "Visible runner",
      }),
    ]);
    expect(JSON.stringify(runners)).not.toContain("runner_concealed");
    await expect(reads.presence(principal)).resolves.toEqual({
      state: "setup_required",
      reason: "No active Slack installation and binding are configured.",
      agents: [],
    });
  });

  it("derives presence from the exact active Slack binding and fresh Runner facts", async () => {
    await fixture.pool.query(
      `INSERT INTO cp_project_target(
         organization_id, project_target_id, runner_id, binding_digest,
         provider, owner, repo, default_executor, default_branch,
         updated_at
       ) VALUES(
         'org_console_read', 'target_presence', 'runner_visible', $1,
         'github', 'acme', 'demo', 'codex', 'main', clock_timestamp()
       )`,
      [`sha256:${"a".repeat(64)}`],
    );
    await fixture.pool.query(
      `INSERT INTO cp_source_app_installation(
         organization_id, installation_id, source_app_id, app_instance_id,
         binding_digest, credential_generation, credential_generation_digest,
         state, created_at, updated_at
       ) VALUES(
         'org_console_read', 'install_presence', 'slack', 'slack_presence',
         $1, 1, $2, 'active', clock_timestamp(), clock_timestamp()
       )`,
      [`sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`],
    );
    await fixture.pool.query(
      `INSERT INTO cp_source_binding(
         organization_id, binding_id, installation_id, binding_digest, state,
         created_at, updated_at
       ) VALUES(
         'org_console_read', 'binding_presence', 'install_presence', $1,
         'active', clock_timestamp(), clock_timestamp()
       )`,
      [`sha256:${"b".repeat(64)}`],
    );
    await fixture.pool.query(
      `INSERT INTO cp_slack_installation(
         organization_id, installation_id, binding_id, project_target_id,
         publication_mode, team_id, app_id, channel_id, bot_user_id,
         signing_secret_ref, member_user_ids, operator_user_ids,
         approver_user_id, admin_user_ids, bot_token_ref, route_identity,
         created_at, updated_at
       ) VALUES(
         'org_console_read', 'install_presence', 'binding_presence',
         'target_presence', 'proposal_only', 'T_PRESENCE', 'A_PRESENCE',
         'C_PRESENCE', 'U_BOT', 'secret://slack/signing',
         ARRAY['U_MEMBER'], ARRAY['U_MEMBER'], 'U_MEMBER', ARRAY['U_MEMBER'],
         'secret://slack/bot', 'route_presence', clock_timestamp(),
         clock_timestamp()
       )`,
    );
    await fixture.pool.query(
      `INSERT INTO cp_runner_readiness(
         organization_id, runner_id, receipt_id, receipt_digest, observed_at,
         expires_at, receipt
       ) VALUES(
         'org_console_read', 'runner_visible', 'readiness_presence', $1,
         clock_timestamp(), clock_timestamp() + interval '1 hour',
         jsonb_build_object(
           'organizationId', 'org_console_read',
           'producer', jsonb_build_object(
             'id', 'runner_visible',
             'credentialId', 'credential_console',
             'registrationGeneration', 1
           ),
           'payload', jsonb_build_object(
             'runnerId', 'runner_visible',
             'registrationGeneration', 1,
             'targets', jsonb_build_array(jsonb_build_object(
               'projectTargetId', 'target_presence',
               'bindingDigest', $2::text,
               'state', 'ready'
             )),
             'executors', jsonb_build_array(jsonb_build_object(
               'executorId', 'codex',
               'state', 'ready'
             ))
           )
         )
       )`,
      [`sha256:${"d".repeat(64)}`, `sha256:${"a".repeat(64)}`],
    );
    const reads = createConsoleReadModel({ pool: fixture.pool });
    const principal = {
      operatorId: "operator_console",
      organizationId: "org_console_read",
      role: "viewer" as const,
      email: "viewer@example.test",
      displayName: "Viewer",
    };

    await expect(reads.presence(principal)).resolves.toMatchObject({
      state: "available",
      agents: [{
        presenceId: "install_presence",
        state: "available",
        slack: {
          bindingId: "binding_presence",
          teamId: "T_PRESENCE",
          channelId: "C_PRESENCE",
          botUserId: "U_BOT",
        },
        projectTarget: {
          projectTargetId: "target_presence",
          provider: "github",
          owner: "acme",
          repo: "demo",
          defaultExecutor: "codex",
        },
        runner: {
          runnerId: "runner_visible",
          readinessObservedAt: expect.any(String),
          readinessExpiresAt: expect.any(String),
        },
        activeRun: null,
      }],
    });

    await fixture.pool.query(
      `UPDATE cp_runner_readiness
       SET receipt = jsonb_set(
         receipt, '{producer,credentialId}', to_jsonb('credential_stale'::text)
       )
       WHERE organization_id = 'org_console_read'
         AND receipt_id = 'readiness_presence'`,
    );
    await expect(reads.presence(principal)).resolves.toMatchObject({
      state: "offline",
      agents: [{
        state: "offline",
        runner: { readinessObservedAt: null, readinessExpiresAt: null },
      }],
    });
    await fixture.pool.query(
      `UPDATE cp_runner_readiness
       SET receipt = jsonb_set(
         receipt, '{producer,credentialId}', to_jsonb('credential_console'::text)
       )
       WHERE organization_id = 'org_console_read'
         AND receipt_id = 'readiness_presence'`,
    );

    await fixture.pool.query(
      `UPDATE cp_source_binding
       SET binding_digest = $1
       WHERE organization_id = 'org_console_read'
         AND binding_id = 'binding_presence'`,
      [`sha256:${"f".repeat(64)}`],
    );
    await expect(reads.presence(principal)).resolves.toEqual({
      state: "setup_required",
      reason: "No active Slack installation and binding are configured.",
      agents: [],
    });
    await fixture.pool.query(
      `UPDATE cp_source_binding
       SET binding_digest = $1
       WHERE organization_id = 'org_console_read'
         AND binding_id = 'binding_presence'`,
      [`sha256:${"b".repeat(64)}`],
    );

    const insertRun = async (
      runId: string,
      bindingId: string,
      source: string,
    ) => fixture.pool.query(
      `INSERT INTO cp_hosted_run(
         organization_id, run_id, admission_id, admission_operation_id,
         admission_digest, source_identity_digest, runner_id, executor_id,
         source_version_ref, source_content_ids, source_context_digest,
         queue_claim_deadline, permission_ceiling_digest, publication_mode,
         publication_policy_digest, completion_mode,
         completion_contract_digest, state, current_attempt_number, hosted_admission,
         admission_policy_snapshot, created_at, updated_at
       ) VALUES(
         'org_console_read', $1, $2, $3, $4, $5, 'runner_visible', 'codex',
         $6, ARRAY[$7], $8, clock_timestamp() + interval '1 day', $9,
         'proposal_only', $10, 'proposal_ready', $11, 'running', 1,
         jsonb_build_object(
           'provider', 'slack',
           'bindingId', $12::text,
           'projectTarget', jsonb_build_object(
             'projectTargetId', 'target_presence',
             'digest', $13::text
           )
         ), '{}'::jsonb,
         clock_timestamp(), clock_timestamp()
       )`,
      [
        runId,
        `admission_${source}`,
        `operation_${source}`,
        `digest_${source}`,
        `source_identity_${source}`,
        `source_version_${source}`,
        `content_${source}`,
        `context_${source}`,
        `ceiling_${source}`,
        `publication_${source}`,
        `completion_${source}`,
        bindingId,
        `sha256:${"a".repeat(64)}`,
      ],
    );
    await insertRun("run_other_binding", "binding_other", "other");
    await expect(reads.presence(principal)).resolves.toMatchObject({
      state: "available",
      agents: [{ activeRun: null }],
    });

    await insertRun("run_presence", "binding_presence", "presence");
    await expect(reads.presence(principal)).resolves.toMatchObject({
      state: "needs_attention",
      agents: [{
        state: "needs_attention",
        activeRun: { runId: "run_presence", state: "running" },
      }],
    });
    await fixture.pool.query(
      `INSERT INTO cp_hosted_attempt(
         organization_id, run_id, attempt_number, attempt_id, runner_id,
         credential_id, fencing_token_digest, lease_expires_at, state,
         claimed_at, updated_at
       ) VALUES(
         'org_console_read', 'run_presence', 1, 'attempt_presence',
         'runner_visible', 'credential_console', $1,
         clock_timestamp() - interval '1 minute', 'running',
         clock_timestamp(), clock_timestamp()
       )`,
      [`sha256:${"7".repeat(64)}`],
    );
    await expect(reads.presence(principal)).resolves.toMatchObject({
      state: "needs_attention",
      agents: [{ state: "needs_attention" }],
    });
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt
       SET lease_expires_at = clock_timestamp() + interval '1 hour',
           credential_id = 'credential_stale'
       WHERE organization_id = 'org_console_read' AND run_id = 'run_presence'
         AND attempt_number = 1`,
    );
    await expect(reads.presence(principal)).resolves.toMatchObject({
      state: "needs_attention",
      agents: [{ state: "needs_attention" }],
    });
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt
       SET credential_id = 'credential_console', state = 'claimed'
       WHERE organization_id = 'org_console_read' AND run_id = 'run_presence'
         AND attempt_number = 1`,
    );
    await expect(reads.presence(principal)).resolves.toMatchObject({
      state: "needs_attention",
      agents: [{ state: "needs_attention" }],
    });
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt
       SET state = 'running'
       WHERE organization_id = 'org_console_read' AND run_id = 'run_presence'
         AND attempt_number = 1`,
    );
    await expect(reads.presence(principal)).resolves.toMatchObject({
      state: "working",
      agents: [{
        state: "working",
        activeRun: { runId: "run_presence", state: "running" },
      }],
    });

    await fixture.pool.query(
      `INSERT INTO cp_project_target(
         organization_id, project_target_id, runner_id, binding_digest,
         provider, owner, repo, default_executor, default_branch,
         updated_at
       ) VALUES(
         'org_console_read', 'target_rebound', 'runner_visible', $1,
         'github', 'acme', 'rebound', 'codex', 'main', clock_timestamp()
       )`,
      [`sha256:${"e".repeat(64)}`],
    );
    await fixture.pool.query(
      `INSERT INTO cp_runner_readiness(
         organization_id, runner_id, receipt_id, receipt_digest, observed_at,
         expires_at, receipt
       ) VALUES(
         'org_console_read', 'runner_visible', 'readiness_rebound', $1,
         clock_timestamp(), clock_timestamp() + interval '1 hour',
         jsonb_build_object(
           'organizationId', 'org_console_read',
           'producer', jsonb_build_object(
             'id', 'runner_visible',
             'credentialId', 'credential_console',
             'registrationGeneration', 1
           ),
           'payload', jsonb_build_object(
             'runnerId', 'runner_visible',
             'registrationGeneration', 1,
             'targets', jsonb_build_array(jsonb_build_object(
               'projectTargetId', 'target_rebound',
               'bindingDigest', $2::text,
               'state', 'ready'
             )),
             'executors', jsonb_build_array(jsonb_build_object(
               'executorId', 'codex',
               'state', 'ready'
             ))
           )
         )
       )`,
      [`sha256:${"9".repeat(64)}`, `sha256:${"e".repeat(64)}`],
    );
    await fixture.pool.query(
      `UPDATE cp_slack_installation
       SET project_target_id = 'target_rebound'
       WHERE organization_id = 'org_console_read'
         AND installation_id = 'install_presence'`,
    );
    await expect(reads.presence(principal)).resolves.toMatchObject({
      state: "available",
      agents: [{ activeRun: null }],
    });
    await fixture.pool.query(
      `UPDATE cp_slack_installation
       SET project_target_id = 'target_presence'
       WHERE organization_id = 'org_console_read'
         AND installation_id = 'install_presence'`,
    );

    await fixture.pool.query(
      `UPDATE cp_hosted_run
       SET state = 'failed', outcome_state = 'outcome_unknown',
           terminal_kind = 'failed', terminal_receipt = '{}'::jsonb
       WHERE organization_id = 'org_console_read' AND run_id = 'run_presence'`,
    );
    await expect(reads.presence(principal)).resolves.toMatchObject({
      state: "needs_attention",
      agents: [{
        state: "needs_attention",
        reason: "Run run_presence has an outcome that requires reconciliation.",
      }],
    });

    await expect(reads.presence({
      ...principal,
      organizationId: "org_other_read",
    })).resolves.toEqual({
      state: "setup_required",
      reason: "No active Slack installation and binding are configured.",
      agents: [],
    });
  });

  it("lists only tenant-owned Project Targets", async () => {
    await fixture.pool.query(
      `INSERT INTO cp_project_target(
         organization_id, project_target_id, runner_id, binding_digest,
         provider, owner, repo, default_executor, updated_at
       ) VALUES
         ('org_console_read', 'target_visible', 'runner_visible', 'digest-visible',
          'github', 'open', 'visible', 'codex', clock_timestamp()),
         ('org_other_read', 'target_concealed', 'runner_concealed', 'digest-hidden',
          'github', 'other', 'hidden', 'codex', clock_timestamp())`,
    );
    const reads = createConsoleReadModel({ pool: fixture.pool });
    const principal = {
      operatorId: "operator_console",
      organizationId: "org_console_read",
      role: "viewer" as const,
      email: "viewer@example.test",
      displayName: "Viewer",
    };

    const targets = await reads.listProjectTargets(principal);
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectTargetId: "target_visible" }),
    ]));
    expect(JSON.stringify(targets)).not.toContain("target_concealed");
  });
});
