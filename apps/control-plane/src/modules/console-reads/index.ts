import type { Pool } from "pg";
import type { ConsolePrincipal } from "../identity/index.js";

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("invalid_read_limit");
  }
  return value;
}

function redactFencingToken(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFencingToken);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => key === "fencingToken"
      ? []
      : [[key, redactFencingToken(child)]]),
  );
}

export type AgentPresenceState =
  | "setup_required"
  | "offline"
  | "available"
  | "queued"
  | "working"
  | "needs_attention";

export type AgentPresenceView = {
  presenceId: string;
  state: AgentPresenceState;
  reason: string;
  slack: {
    installationId: string;
    bindingId: string;
    teamId: string;
    channelId: string;
    appId: string;
    botUserId: string;
  };
  projectTarget: {
    projectTargetId: string;
    provider: string;
    owner: string;
    repo: string;
    defaultExecutor: string;
  } | null;
  runner: {
    runnerId: string;
    displayName: string | null;
    readinessObservedAt: string | null;
    readinessExpiresAt: string | null;
  } | null;
  activeRun: {
    runId: string;
    state: string;
    outcomeState: string | null;
    updatedAt: string;
  } | null;
};

export type AgentPresenceSummary = {
  state: AgentPresenceState;
  reason: string;
  agents: AgentPresenceView[];
};

type AgentPresenceRow = {
  installation_id: string;
  binding_id: string;
  team_id: string;
  channel_id: string;
  app_id: string;
  bot_user_id: string;
  configured_project_target_id: string | null;
  project_target_id: string | null;
  target_provider: string | null;
  target_owner: string | null;
  target_repo: string | null;
  default_executor: string | null;
  configured_runner_id: string | null;
  runner_id: string | null;
  runner_display_name: string | null;
  readiness_observed_at: Date | null;
  readiness_expires_at: Date | null;
  active_run_id: string | null;
  active_run_state: string | null;
  active_run_outcome_state: string | null;
  active_run_updated_at: Date | null;
  active_run_count: number;
  active_attempt_valid: boolean;
};

function presenceFromRow(row: AgentPresenceRow): AgentPresenceView {
  const activeRun = row.active_run_id && row.active_run_state && row.active_run_updated_at
    ? {
        runId: row.active_run_id,
        state: row.active_run_state,
        outcomeState: row.active_run_outcome_state,
        updatedAt: row.active_run_updated_at.toISOString(),
      }
    : null;
  const projectTarget = row.project_target_id
    && row.target_provider && row.target_owner && row.target_repo
    && row.default_executor
    ? {
        projectTargetId: row.project_target_id,
        provider: row.target_provider,
        owner: row.target_owner,
        repo: row.target_repo,
        defaultExecutor: row.default_executor,
      }
    : null;
  const runner = row.runner_id
    ? {
        runnerId: row.runner_id,
        displayName: row.runner_display_name,
        readinessObservedAt: row.readiness_observed_at?.toISOString() ?? null,
        readinessExpiresAt: row.readiness_expires_at?.toISOString() ?? null,
      }
    : null;

  let state: AgentPresenceState;
  let reason: string;
  if (!row.configured_project_target_id) {
    state = "setup_required";
    reason = "This Slack binding has no Project Target.";
  } else if (!projectTarget) {
    state = "setup_required";
    reason = "The configured Project Target was not found.";
  } else if (!row.configured_runner_id || !runner) {
    state = "setup_required";
    reason = "The Project Target has no registered Runner.";
  } else if (row.active_run_count > 1) {
    state = "needs_attention";
    reason = "More than one active Run is bound to this Slack presence.";
  } else if (
    activeRun?.outcomeState === "outcome_unknown"
    || activeRun?.state === "needs_approval"
  ) {
    state = "needs_attention";
    reason = activeRun.outcomeState === "outcome_unknown"
      ? `Run ${activeRun.runId} has an outcome that requires reconciliation.`
      : `Run ${activeRun.runId} is waiting for a human decision.`;
  } else if (activeRun?.state === "queued") {
    state = "queued";
    reason = row.readiness_expires_at
      ? `Run ${activeRun.runId} is queued for the paired Runner.`
      : `Run ${activeRun.runId} is queued while the paired Runner is offline.`;
  } else if (
    (activeRun?.state === "assigned" || activeRun?.state === "running")
    && !row.active_attempt_valid
  ) {
    state = "needs_attention";
    reason = `Run ${activeRun.runId} has no current valid Attempt lease for the paired Runner.`;
  } else if (!row.readiness_expires_at) {
    state = "offline";
    reason = activeRun
      ? `Runner readiness expired while Run ${activeRun.runId} remains ${activeRun.state}; OpenTag does not claim it is working.`
      : "The paired Runner has no fresh readiness receipt.";
  } else if (activeRun?.state === "assigned" || activeRun?.state === "running") {
    state = "working";
    reason = `Run ${activeRun.runId} is ${activeRun.state} on the ready paired Runner.`;
  } else if (activeRun) {
    state = "needs_attention";
    reason = `Run ${activeRun.runId} has an unexpected active state: ${activeRun.state}.`;
  } else {
    state = "available";
    reason = "Slack, Project Target, Runner, and fresh readiness are available.";
  }

  return {
    presenceId: row.installation_id,
    state,
    reason,
    slack: {
      installationId: row.installation_id,
      bindingId: row.binding_id,
      teamId: row.team_id,
      channelId: row.channel_id,
      appId: row.app_id,
      botUserId: row.bot_user_id,
    },
    projectTarget,
    runner,
    activeRun,
  };
}

const presencePriority: Record<AgentPresenceState, number> = {
  setup_required: 6,
  needs_attention: 5,
  offline: 4,
  working: 3,
  queued: 2,
  available: 1,
};

function summarizePresence(agents: AgentPresenceView[]): AgentPresenceSummary {
  if (agents.length === 0) {
    return {
      state: "setup_required",
      reason: "No active Slack installation and binding are configured.",
      agents: [],
    };
  }
  const primary = [...agents].sort((left, right) =>
    presencePriority[right.state] - presencePriority[left.state]
    || left.presenceId.localeCompare(right.presenceId))[0]!;
  return {
    state: primary.state,
    reason: agents.length === 1
      ? primary.reason
      : `${agents.length} Slack teammate presences; highest-priority state is ${primary.state}.`,
    agents,
  };
}

export function createConsoleReadModel(input: { pool: Pool }) {
  return {
    async presence(principal: ConsolePrincipal): Promise<AgentPresenceSummary> {
      const result = await input.pool.query<AgentPresenceRow>(
        `WITH active_slack AS (
           SELECT slack.organization_id, slack.installation_id,
                  slack.binding_id, slack.project_target_id,
                  slack.team_id, slack.channel_id, slack.app_id,
                  slack.bot_user_id
           FROM cp_slack_installation slack
           JOIN cp_source_app_installation installation
             ON installation.organization_id = slack.organization_id
            AND installation.installation_id = slack.installation_id
            AND installation.source_app_id = 'slack'
            AND installation.state = 'active'
           JOIN cp_source_binding binding
             ON binding.organization_id = slack.organization_id
            AND binding.binding_id = slack.binding_id
            AND binding.installation_id = slack.installation_id
            AND binding.binding_digest = installation.binding_digest
            AND binding.state = 'active'
           WHERE slack.organization_id = $1
         )
         SELECT slack.installation_id, slack.binding_id, slack.team_id,
                slack.channel_id, slack.app_id, slack.bot_user_id,
                slack.project_target_id AS configured_project_target_id,
                target.project_target_id, target.provider AS target_provider,
                target.owner AS target_owner, target.repo AS target_repo,
                target.default_executor, target.runner_id AS configured_runner_id,
                runner.runner_id, runner.display_name AS runner_display_name,
                readiness.observed_at AS readiness_observed_at,
                readiness.expires_at AS readiness_expires_at,
                active_run.run_id AS active_run_id,
                active_run.state AS active_run_state,
                active_run.outcome_state AS active_run_outcome_state,
                active_run.updated_at AS active_run_updated_at,
                COALESCE(active_run.active_run_count, 0)::int AS active_run_count,
                COALESCE(active_run.active_attempt_valid, false) AS active_attempt_valid
         FROM active_slack slack
         LEFT JOIN cp_project_target target
           ON target.organization_id = slack.organization_id
          AND target.project_target_id = slack.project_target_id
         LEFT JOIN cp_runner runner
           ON runner.organization_id = target.organization_id
          AND runner.runner_id = target.runner_id
         LEFT JOIN LATERAL (
           SELECT readiness_candidate.observed_at, readiness_candidate.expires_at
           FROM cp_runner_readiness readiness_candidate
           WHERE readiness_candidate.organization_id = runner.organization_id
             AND readiness_candidate.runner_id = runner.runner_id
             AND readiness_candidate.expires_at > clock_timestamp()
             AND readiness_candidate.receipt->>'organizationId' = runner.organization_id
             AND readiness_candidate.receipt->'producer'->>'id' = runner.runner_id
             AND readiness_candidate.receipt->'producer'->>'credentialId'
               = runner.current_credential_id
             AND readiness_candidate.receipt->'producer'->>'registrationGeneration'
               = runner.registration_generation::text
             AND readiness_candidate.receipt->'payload'->>'runnerId' = runner.runner_id
             AND readiness_candidate.receipt->'payload'->>'registrationGeneration'
               = runner.registration_generation::text
             AND EXISTS (
               SELECT 1
               FROM cp_runner_credential credential
               WHERE credential.organization_id = runner.organization_id
                 AND credential.runner_id = runner.runner_id
                 AND credential.credential_id = runner.current_credential_id
                 AND credential.credential_generation = runner.credential_generation
                 AND credential.revoked_at IS NULL
             )
             AND EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 COALESCE(readiness_candidate.receipt->'payload'->'targets', '[]'::jsonb)
               ) target_readiness
               WHERE target_readiness->>'projectTargetId' = target.project_target_id
                 AND target_readiness->>'bindingDigest' = target.binding_digest
                 AND target_readiness->>'state' = 'ready'
             )
             AND EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 COALESCE(readiness_candidate.receipt->'payload'->'executors', '[]'::jsonb)
               ) executor_readiness
               WHERE executor_readiness->>'executorId' = target.default_executor
                 AND executor_readiness->>'state' = 'ready'
             )
           ORDER BY readiness_candidate.observed_at DESC,
                    readiness_candidate.receipt_id DESC
           LIMIT 1
         ) readiness ON true
         LEFT JOIN LATERAL (
           SELECT run.run_id, run.state, run.outcome_state, run.updated_at,
                  count(*) OVER()::int AS active_run_count,
                  EXISTS (
                    SELECT 1
                    FROM cp_hosted_attempt attempt
                    WHERE attempt.organization_id = run.organization_id
                      AND attempt.run_id = run.run_id
                      AND attempt.attempt_number = run.current_attempt_number
                      AND attempt.runner_id = run.runner_id
                      AND attempt.credential_id = runner.current_credential_id
                      AND attempt.lease_expires_at > clock_timestamp()
                      AND (
                        (run.state = 'assigned' AND attempt.state = 'claimed')
                        OR (run.state = 'running' AND attempt.state = 'running')
                      )
                  ) AS active_attempt_valid
           FROM cp_hosted_run run
           WHERE run.organization_id = slack.organization_id
             AND (run.terminal_kind IS NULL OR run.outcome_state = 'outcome_unknown')
             AND run.hosted_admission->>'provider' = 'slack'
             AND run.hosted_admission->>'bindingId' = slack.binding_id
             AND run.hosted_admission->'projectTarget'->>'projectTargetId'
               = target.project_target_id
             AND run.hosted_admission->'projectTarget'->>'digest'
               = target.binding_digest
             AND run.runner_id = target.runner_id
           ORDER BY run.created_at DESC, run.run_id DESC
           LIMIT 1
         ) active_run ON true
         ORDER BY slack.team_id, slack.channel_id, slack.installation_id`,
        [principal.organizationId],
      );
      return summarizePresence(result.rows.map(presenceFromRow));
    },

    async overview(principal: ConsolePrincipal) {
      const result = await input.pool.query<{
        runner_count: number;
        ready_runner_count: number;
        active_run_count: number;
        terminal_run_count: number;
        pending_job_count: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM cp_runner
           WHERE organization_id = $1) AS runner_count,
          (SELECT count(*)::int FROM cp_runner runner
           WHERE runner.organization_id = $1
             AND EXISTS (
               SELECT 1 FROM cp_runner_readiness readiness
               WHERE readiness.organization_id = runner.organization_id
                 AND readiness.runner_id = runner.runner_id
                 AND readiness.expires_at > clock_timestamp()
                 AND readiness.receipt->>'organizationId' = runner.organization_id
                 AND readiness.receipt->'producer'->>'id' = runner.runner_id
                 AND readiness.receipt->'producer'->>'credentialId'
                   = runner.current_credential_id
                 AND readiness.receipt->'producer'->>'registrationGeneration'
                   = runner.registration_generation::text
                 AND readiness.receipt->'payload'->>'runnerId' = runner.runner_id
                 AND readiness.receipt->'payload'->>'registrationGeneration'
                   = runner.registration_generation::text
                 AND EXISTS (
                   SELECT 1
                   FROM cp_runner_credential credential
                   WHERE credential.organization_id = runner.organization_id
                     AND credential.runner_id = runner.runner_id
                     AND credential.credential_id = runner.current_credential_id
                     AND credential.credential_generation = runner.credential_generation
                     AND credential.revoked_at IS NULL
                 )
                 AND EXISTS (
                   SELECT 1 FROM jsonb_array_elements(
                     COALESCE(readiness.receipt->'payload'->'targets', '[]'::jsonb)
                   ) target_readiness
                   WHERE target_readiness->>'state' = 'ready'
                 )
                 AND EXISTS (
                   SELECT 1 FROM jsonb_array_elements(
                     COALESCE(readiness.receipt->'payload'->'executors', '[]'::jsonb)
                   ) executor_readiness
                   WHERE executor_readiness->>'state' = 'ready'
                 )
             )) AS ready_runner_count,
          (SELECT count(*)::int FROM cp_hosted_run
           WHERE organization_id = $1
             AND terminal_kind IS NULL) AS active_run_count,
          (SELECT count(*)::int FROM cp_hosted_run
           WHERE organization_id = $1
             AND terminal_kind IS NOT NULL) AS terminal_run_count,
          (SELECT count(*)::int FROM cp_job
           WHERE organization_id = $1
             AND state IN ('pending', 'claimed')) AS pending_job_count`,
        [principal.organizationId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("console_overview_unavailable");
      return {
        runnerCount: row.runner_count,
        readyRunnerCount: row.ready_runner_count,
        activeRunCount: row.active_run_count,
        terminalRunCount: row.terminal_run_count,
        pendingJobCount: row.pending_job_count,
      };
    },

    async listRunners(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        runner_id: string;
        display_name: string | null;
        registration_generation: number;
        credential_generation: number;
        capabilities: string[];
        readiness: unknown | null;
        updated_at: Date;
      }>(
        `SELECT runner.runner_id, runner.display_name,
                runner.registration_generation,
                runner.credential_generation, runner.capabilities,
                readiness.receipt AS readiness, runner.updated_at
         FROM cp_runner runner
         LEFT JOIN LATERAL (
           SELECT readiness_candidate.receipt
           FROM cp_runner_readiness readiness_candidate
           WHERE readiness_candidate.organization_id = runner.organization_id
             AND readiness_candidate.runner_id = runner.runner_id
             AND readiness_candidate.expires_at > clock_timestamp()
             AND readiness_candidate.receipt->>'organizationId' = runner.organization_id
             AND readiness_candidate.receipt->'producer'->>'id' = runner.runner_id
             AND readiness_candidate.receipt->'producer'->>'credentialId'
               = runner.current_credential_id
             AND readiness_candidate.receipt->'producer'->>'registrationGeneration'
               = runner.registration_generation::text
             AND readiness_candidate.receipt->'payload'->>'runnerId' = runner.runner_id
             AND readiness_candidate.receipt->'payload'->>'registrationGeneration'
               = runner.registration_generation::text
             AND EXISTS (
               SELECT 1
               FROM cp_runner_credential credential
               WHERE credential.organization_id = runner.organization_id
                 AND credential.runner_id = runner.runner_id
                 AND credential.credential_id = runner.current_credential_id
                 AND credential.credential_generation = runner.credential_generation
                 AND credential.revoked_at IS NULL
             )
           ORDER BY readiness_candidate.observed_at DESC,
                    readiness_candidate.receipt_id DESC
           LIMIT 1
         ) readiness ON true
         WHERE runner.organization_id = $1
         ORDER BY runner.runner_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        runnerId: row.runner_id,
        displayName: row.display_name,
        registrationGeneration: row.registration_generation,
        credentialGeneration: row.credential_generation,
        capabilities: row.capabilities,
        readiness: row.readiness,
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async listRuns(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        run_id: string;
        runner_id: string;
        executor_id: string;
        state: string;
        current_attempt_number: number;
        terminal_kind: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT run_id, runner_id, executor_id, state,
                current_attempt_number, terminal_kind, created_at, updated_at
         FROM cp_hosted_run
         WHERE organization_id = $1
         ORDER BY created_at DESC, run_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        runId: row.run_id,
        runnerId: row.runner_id,
        executorId: row.executor_id,
        state: row.state,
        currentAttemptNumber: row.current_attempt_number,
        terminalKind: row.terminal_kind,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async listAudit(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        sequence_id: string;
        run_id: string | null;
        event_kind: string;
        event: unknown;
        created_at: Date;
      }>(
        `SELECT sequence_id, run_id, event_kind, event, created_at
         FROM (
           SELECT 'run:' || sequence_id::text AS sequence_id,
                  run_id, event_kind, event, created_at
           FROM cp_hosted_audit_event
           WHERE organization_id = $1
           UNION ALL
           SELECT 'management:' || sequence_id::text AS sequence_id,
                  NULL::text AS run_id, operation_kind AS event_kind,
                  jsonb_build_object(
                    'actor', jsonb_build_object('kind', actor_kind, 'id', actor_id),
                    'resource', jsonb_build_object('kind', resource_kind, 'id', resource_id),
                    'outcome', outcome,
                    'detail', event
                  ) AS event,
                  created_at
           FROM cp_management_audit_event
           WHERE organization_id = $1
         ) audit
         ORDER BY created_at DESC, sequence_id DESC
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        sequenceId: row.sequence_id,
        runId: row.run_id,
        eventKind: row.event_kind,
        event: row.event,
        createdAt: row.created_at.toISOString(),
      }));
    },

    async listPermissions(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        permission_request_id: string;
        run_id: string;
        runner_id: string;
        attempt_id: string;
        action_id: string;
        state: string;
        request: unknown;
        current_receipt: unknown;
        updated_at: Date;
      }>(
        `SELECT permission_request_id, run_id, runner_id, attempt_id,
                action_id, state, request, current_receipt, updated_at
         FROM cp_permission_request
         WHERE organization_id = $1
         ORDER BY updated_at DESC, permission_request_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        permissionRequestId: row.permission_request_id,
        runId: row.run_id,
        runnerId: row.runner_id,
        attemptId: row.attempt_id,
        actionId: row.action_id,
        state: row.state,
        request: redactFencingToken(row.request),
        currentReceipt: redactFencingToken(row.current_receipt),
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async listMaterialActions(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        run_id: string;
        attempt_id: string;
        action_id: string;
        receipt_id: string;
        receipt_digest: string;
        outcome: string;
        receipt: unknown;
        updated_at: Date;
      }>(
        `SELECT run_id, attempt_id, action_id, receipt_id, receipt_digest,
                outcome, receipt, updated_at
         FROM cp_material_action_current
         WHERE organization_id = $1
         ORDER BY updated_at DESC, run_id, action_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        runId: row.run_id,
        attemptId: row.attempt_id,
        actionId: row.action_id,
        receiptId: row.receipt_id,
        receiptDigest: row.receipt_digest,
        outcome: row.outcome,
        receipt: row.receipt,
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async listProjectTargets(
      principal: ConsolePrincipal,
      options: { limit?: number } = {},
    ) {
      const result = await input.pool.query<{
        project_target_id: string;
        runner_id: string;
        provider: string;
        owner: string;
        repo: string;
        default_executor: string;
        default_branch: string | null;
        updated_at: Date;
      }>(
        `SELECT project_target_id, runner_id, provider, owner, repo,
                default_executor, default_branch, updated_at
         FROM cp_project_target
         WHERE organization_id = $1
         ORDER BY project_target_id
         LIMIT $2`,
        [principal.organizationId, boundedLimit(options.limit)],
      );
      return result.rows.map((row) => ({
        projectTargetId: row.project_target_id,
        runnerId: row.runner_id,
        provider: row.provider,
        owner: row.owner,
        repo: row.repo,
        defaultExecutor: row.default_executor,
        defaultBranch: row.default_branch,
        updatedAt: row.updated_at.toISOString(),
      }));
    },

  };
}

export type ConsoleReadModel = ReturnType<typeof createConsoleReadModel>;
