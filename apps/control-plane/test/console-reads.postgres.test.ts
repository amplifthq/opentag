import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createConsoleReadModel } from "../src/modules/console-reads/index.js";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

const consolePrincipal = {
  operatorId: "operator_teammates",
  organizationId: "org_teammates",
  role: "viewer" as const,
  email: "viewer@example.test",
  displayName: "Viewer",
};

function teammateRow(overrides: Record<string, unknown> = {}) {
  return {
    binding_id: "binding_1",
    display_name: "Release teammate",
    team_id: "T1",
    channel_id: "C1",
    bot_user_id: "U_BOT",
    configured_project_target_id: "target_1",
    project_target_id: "target_1",
    target_provider: "github",
    target_owner: "acme",
    target_repo: "demo",
    default_executor: "codex",
    configured_runner_id: "runner_1",
    runner_id: "runner_1",
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

describe("derived Teammate read model", () => {
  it("returns an empty list when no active Slack binding exists", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const reads = createConsoleReadModel({ pool: { query } as never });

    await expect(reads.listTeammates(consolePrincipal)).resolves.toEqual([]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("hosted_admission->>'bindingId' = slack.binding_id"),
      ["org_teammates"],
    );
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM cp_slack_binding slack");
    expect(sql).toContain("slack.display_name");
    expect(sql).toContain("slack.state='active'");
    expect(sql).toContain("hosted_admission->'projectTarget'->>'digest'");
    expect(sql).toContain("producer'->>'credentialId'");
    expect(sql).toContain("bindingGeneration");
  });

  it("uses stable binding identity and display name for a ready teammate", async () => {
    const reads = createConsoleReadModel({
      pool: { query: async () => ({ rows: [teammateRow()] }) } as never,
    });
    await expect(reads.listTeammates(consolePrincipal)).resolves.toEqual([{
      teammateId: "binding_1",
      displayName: "Release teammate",
      workState: "ready",
      reason: "This teammate is ready for work.",
      home: {
        kind: "slack_channel",
        teamId: "T1",
        channelId: "C1",
        botUserId: "U_BOT",
      },
      execution: {
        runnerId: "runner_1",
        projectTarget: {
          projectTargetId: "target_1",
          provider: "github",
          owner: "acme",
          repo: "demo",
          executorId: "codex",
        },
      },
      activeWork: null,
    }]);
  });

  it.each([
    {
      name: "queued work",
      row: teammateRow({ active_run_id: "run_queued", active_run_state: "queued",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"), active_run_count: 1 }),
      workState: "queued",
    },
    {
      name: "fresh running work",
      row: teammateRow({ active_run_id: "run_working", active_run_state: "running",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"), active_run_count: 1 }),
      workState: "working",
    },
    {
      name: "expired readiness",
      row: teammateRow({ readiness_expires_at: null, active_run_id: "run_stale",
        active_run_state: "running",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"), active_run_count: 1 }),
      workState: "runner_offline",
    },
    {
      name: "invalid current Attempt",
      row: teammateRow({ active_run_id: "run_invalid_attempt", active_run_state: "running",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"),
        active_run_count: 1, active_attempt_valid: false }),
      workState: "needs_attention",
    },
    {
      name: "human decision",
      row: teammateRow({ active_run_id: "run_approval", active_run_state: "needs_approval",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"), active_run_count: 1 }),
      workState: "needs_attention",
    },
    {
      name: "ambiguous outcome",
      row: teammateRow({ active_run_id: "run_unknown", active_run_state: "running",
        active_run_outcome_state: "outcome_unknown",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"), active_run_count: 1 }),
      workState: "needs_attention",
    },
    {
      name: "multiple active Runs",
      row: teammateRow({ active_run_id: "run_latest", active_run_state: "queued",
        active_run_updated_at: new Date("2026-09-04T05:10:00.000Z"), active_run_count: 2 }),
      workState: "needs_attention",
    },
  ])("derives $name without persisting teammate status", async ({ row, workState }) => {
    const reads = createConsoleReadModel({
      pool: { query: async () => ({ rows: [row] }) } as never,
    });
    await expect(reads.listTeammates(consolePrincipal)).resolves.toMatchObject([
      { workState },
    ]);
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
      }),
    ]);
    expect(JSON.stringify(runners)).not.toContain("runner_concealed");
    await expect(reads.listTeammates(principal)).resolves.toEqual([]);
  });

  it("derives teammate work state from the exact binding and fresh Runner facts", async () => {
    await fixture.pool.query(
      `INSERT INTO cp_project_target(
         organization_id, project_target_id, runner_id, binding_digest,
         provider, owner, repo, default_executor, default_branch,
         binding_generation, updated_at
       ) VALUES(
         'org_console_read', 'target_presence', 'runner_visible', $1,
         'github', 'acme', 'demo', 'codex', 'main', 1, clock_timestamp()
       )`,
      [`sha256:${"a".repeat(64)}`],
    );
    await fixture.pool.query(
      `INSERT INTO cp_slack_binding(organization_id,binding_id,installation_id,
         binding_digest,state,credential_generation,credential_generation_digest,
         route_identity,team_id,app_id,channel_id,bot_user_id,member_user_ids,
         operator_user_ids,approver_user_id,admin_user_ids,signing_secret_ref,
         bot_token_ref,project_target_id,publication_mode,display_name,created_at,updated_at)
       VALUES('org_console_read','binding_presence','install_presence',$1,'active',1,$2,
         'route_presence','T_PRESENCE','A_PRESENCE','C_PRESENCE','U_BOT',
         ARRAY['U_MEMBER'],ARRAY['U_MEMBER'],'U_MEMBER',ARRAY['U_MEMBER'],
         'secret://slack/signing','secret://slack/bot','target_presence',
         'proposal_only','Release teammate',clock_timestamp(),clock_timestamp())`,
      [`sha256:${"b".repeat(64)}`,`sha256:${"c".repeat(64)}`],
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
               'bindingGeneration', 1,
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

    const readyTeammates = await reads.listTeammates(principal);
    expect(readyTeammates).toMatchObject([{
        teammateId: "binding_presence",
        displayName: "Release teammate",
        workState: "ready",
        home: {
          teamId: "T_PRESENCE",
          channelId: "C_PRESENCE",
          botUserId: "U_BOT",
        },
        execution: { runnerId: "runner_visible", projectTarget: {
          projectTargetId: "target_presence",
          provider: "github",
          owner: "acme",
          repo: "demo",
          executorId: "codex",
        } },
        activeWork: null,
    }]);

    await fixture.pool.query(
      `UPDATE cp_runner_readiness
       SET receipt = jsonb_set(
         receipt, '{producer,credentialId}', to_jsonb('credential_stale'::text)
       )
       WHERE organization_id = 'org_console_read'
         AND receipt_id = 'readiness_presence'`,
    );
    const offlineTeammates = await reads.listTeammates(principal);
    expect(offlineTeammates).toMatchObject([{
      teammateId: "binding_presence",
      displayName: "Release teammate",
      workState: "runner_offline",
    }]);
    expect(offlineTeammates[0]?.home).toEqual(readyTeammates[0]?.home);
    await fixture.pool.query(
      `UPDATE cp_slack_binding
       SET credential_generation = 2,
           credential_generation_digest = $1,
           updated_at = clock_timestamp()
       WHERE organization_id = 'org_console_read'
         AND binding_id = 'binding_presence'`,
      [`sha256:${"8".repeat(64)}`],
    );
    await expect(reads.listTeammates(principal)).resolves.toMatchObject([{
      teammateId: "binding_presence",
      displayName: "Release teammate",
      workState: "runner_offline",
    }]);
    await fixture.pool.query(
      `UPDATE cp_runner_readiness
       SET receipt = jsonb_set(
         receipt, '{producer,credentialId}', to_jsonb('credential_console'::text)
       )
       WHERE organization_id = 'org_console_read'
         AND receipt_id = 'readiness_presence'`,
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
    await expect(reads.listTeammates(principal)).resolves.toMatchObject([
      { workState: "ready", activeWork: null },
    ]);

    await insertRun("run_presence", "binding_presence", "presence");
    await expect(reads.listTeammates(principal)).resolves.toMatchObject([{
      workState: "needs_attention",
      activeWork: { runId: "run_presence", state: "running" },
    }]);
    await fixture.pool.query(
      `INSERT INTO cp_hosted_attempt(
         organization_id, run_id, attempt_number, attempt_id, runner_id,
         credential_id, fencing_token_digest, claim_operation_id,
         claim_request_digest, claim, lease_expires_at, state,
         claimed_at, updated_at
       ) VALUES(
         'org_console_read', 'run_presence', 1, 'attempt_presence',
         'runner_visible', 'credential_console', $1, 'operation_presence_claim',
         'request_digest_presence_claim', '{}'::jsonb,
         clock_timestamp() - interval '1 minute', 'running',
         clock_timestamp(), clock_timestamp()
       )`,
      [`sha256:${"7".repeat(64)}`],
    );
    await expect(reads.listTeammates(principal)).resolves.toMatchObject([
      { workState: "needs_attention" },
    ]);
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt
       SET lease_expires_at = clock_timestamp() + interval '1 hour',
           credential_id = 'credential_stale'
       WHERE organization_id = 'org_console_read' AND run_id = 'run_presence'
         AND attempt_number = 1`,
    );
    await expect(reads.listTeammates(principal)).resolves.toMatchObject([
      { workState: "needs_attention" },
    ]);
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt
       SET credential_id = 'credential_console', state = 'claimed'
       WHERE organization_id = 'org_console_read' AND run_id = 'run_presence'
         AND attempt_number = 1`,
    );
    await expect(reads.listTeammates(principal)).resolves.toMatchObject([
      { workState: "needs_attention" },
    ]);
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt
       SET state = 'running'
       WHERE organization_id = 'org_console_read' AND run_id = 'run_presence'
         AND attempt_number = 1`,
    );
    await expect(reads.listTeammates(principal)).resolves.toMatchObject([{
      workState: "working",
      activeWork: { runId: "run_presence", state: "running" },
    }]);

    await fixture.pool.query(
      `INSERT INTO cp_project_target(
         organization_id, project_target_id, runner_id, binding_digest,
         provider, owner, repo, default_executor, default_branch,
         binding_generation, updated_at
       ) VALUES(
         'org_console_read', 'target_rebound', 'runner_visible', $1,
         'github', 'acme', 'rebound', 'codex', 'main', 1, clock_timestamp()
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
               'bindingGeneration', 1,
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
      `UPDATE cp_slack_binding
       SET project_target_id = 'target_rebound'
       WHERE organization_id = 'org_console_read'
         AND installation_id = 'install_presence'`,
    );
    await expect(reads.listTeammates(principal)).resolves.toMatchObject([
      { teammateId: "binding_presence", workState: "ready", activeWork: null },
    ]);
    await fixture.pool.query(
      `UPDATE cp_slack_binding
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
    await expect(reads.listTeammates(principal)).resolves.toMatchObject([{
      teammateId: "binding_presence",
      workState: "needs_attention",
      reason: "Run run_presence has an outcome that requires reconciliation.",
    }]);

    await expect(reads.listTeammates({
      ...principal,
      organizationId: "org_other_read",
    })).resolves.toEqual([]);
  });

  it("lists only tenant-owned Project Targets", async () => {
    await fixture.pool.query(
      `INSERT INTO cp_project_target(
         organization_id, project_target_id, runner_id, binding_digest,
         provider, owner, repo, default_executor, binding_generation, updated_at
       ) VALUES
         ('org_console_read', 'target_visible', 'runner_visible', 'digest-visible',
          'github', 'open', 'visible', 'codex', 1, clock_timestamp()),
         ('org_other_read', 'target_concealed', 'runner_concealed', 'digest-hidden',
          'github', 'other', 'hidden', 'codex', 1, clock_timestamp())`,
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
