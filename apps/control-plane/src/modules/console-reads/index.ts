import type { Pool } from "pg";
import { composeTeamRelayThreadProjection, type TeammateView, type TeammateWorkState } from "@opentag/core";
import type { ConsolePrincipal } from "../identity/index.js";
import { projectRunPhase, type CanonicalRunStatus } from "../hosted-runs/index.js";
import { readRunThreadFeedback } from "../hosted-runs/thread-feedback.js";

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

type TeammateRow = {
  binding_id: string;
  display_name: string;
  team_id: string;
  channel_id: string;
  bot_user_id: string;
  configured_project_target_id: string | null;
  project_target_id: string | null;
  target_provider: string | null;
  target_owner: string | null;
  target_repo: string | null;
  default_executor: string | null;
  configured_runner_id: string | null;
  runner_id: string | null;
  readiness_expires_at: Date | null;
  active_run_id: string | null;
  active_run_state: string | null;
  active_run_outcome_state: string | null;
  active_run_updated_at: Date | null;
  active_run_count: number;
  active_attempt_valid: boolean;
  active_run_attempt_number: number | null;
  active_publication_mode: string | null;
  active_has_candidate: boolean;
};

function teammateFromRow(row: TeammateRow,
  feedback?: Awaited<ReturnType<typeof readRunThreadFeedback>>): TeammateView {
  const activeWork = row.active_run_id && row.active_run_state && row.active_run_updated_at
    ? {
        runId: row.active_run_id,
        state: row.active_run_state,
        outcomeState: row.active_run_outcome_state,
        updatedAt: row.active_run_updated_at.toISOString(),
      }
    : null;
  const projectTarget = row.project_target_id
    && row.target_provider === "github" && row.target_owner && row.target_repo
    && row.default_executor
    ? {
        projectTargetId: row.project_target_id,
        provider: "github" as const,
        owner: row.target_owner,
        repo: row.target_repo,
        executorId: row.default_executor,
      }
    : null;

  let workState: TeammateWorkState;
  let reason: string;
  const phase = activeWork ? projectRunPhase({state:activeWork.state as CanonicalRunStatus,
    ...(row.active_publication_mode?{publication_mode:row.active_publication_mode}:{}),has_candidate:row.active_has_candidate}) : undefined;
  const publicationPending = phase === "publication_pending";
  const waitingForApproval = feedback?.approval?.state === "waiting" || activeWork?.state === "needs_approval";
  const presentation = activeWork && (publicationPending || waitingForApproval || feedback?.approval)
    ? composeTeamRelayThreadProjection({runId:activeWork.runId,generation:row.active_run_attempt_number??1,
        state:publicationPending?"publication_pending":waitingForApproval?"waiting_for_approval":"running",controls:[],
        ...(feedback?.approval?{approval:feedback.approval}:{}),
        ...(feedback?.publication?{publication:feedback.publication}:{})}) : undefined;
  if (!row.configured_project_target_id) {
    workState = "setup_required";
    reason = "This teammate has no GitHub Project Target.";
  } else if (!projectTarget) {
    workState = "setup_required";
    reason = "The teammate's configured Project Target was not found.";
  } else if (!row.configured_runner_id || !row.runner_id) {
    workState = "setup_required";
    reason = "The teammate's Project Target has no registered Runner.";
  } else if (row.active_run_count > 1) {
    workState = "needs_attention";
    reason = "More than one active Run is bound to this teammate.";
  } else if (activeWork?.outcomeState === "outcome_unknown") {
    workState = "needs_attention";
    reason = `Run ${activeWork.runId} has an outcome that requires reconciliation.`;
  } else if (publicationPending) {
    const publicationState=feedback?.publication?.state;
    workState = !publicationState || ["requested","attention","outcome_unknown","cancelled_before_permit"].includes(publicationState)
      ? "needs_attention" : !row.readiness_expires_at ? "runner_offline" : "working";
    reason = presentation!.summary;
  } else if (waitingForApproval) {
    workState = "needs_attention";
    reason = presentation!.summary;
  } else if (!row.readiness_expires_at && !(activeWork && row.active_attempt_valid)) {
    workState = "runner_offline";
    reason = activeWork
      ? `Runner readiness expired while Run ${activeWork.runId} remains ${activeWork.state}.`
      : "The teammate's Runner has no fresh readiness receipt.";
  } else if (activeWork?.state === "queued") {
    workState = "queued";
    reason = `Run ${activeWork.runId} is queued for this teammate.`;
  } else if ((activeWork?.state === "assigned" || activeWork?.state === "running")
    && !row.active_attempt_valid) {
    workState = "needs_attention";
    reason = `Run ${activeWork.runId} has no current valid Attempt lease.`;
  } else if (activeWork?.state === "assigned" || activeWork?.state === "running") {
    workState = "working";
    reason = presentation?.summary ?? `Run ${activeWork.runId} is ${activeWork.state} on the paired Runner.`;
  } else if (activeWork) {
    workState = "needs_attention";
    reason = `Run ${activeWork.runId} has an unexpected active state: ${activeWork.state}.`;
  } else {
    workState = "ready";
    reason = "This teammate is ready for work.";
  }

  return {
    teammateId: row.binding_id,
    displayName: row.display_name,
    workState,
    reason,
    home: {
      kind: "slack_channel",
      teamId: row.team_id,
      channelId: row.channel_id,
      botUserId: row.bot_user_id,
    },
    execution: {
      runnerId: row.runner_id,
      projectTarget,
    },
    activeWork,
  };
}

export function createConsoleReadModel(input: { pool: Pool }) {
  return {
    async listTeammates(principal: ConsolePrincipal): Promise<TeammateView[]> {
      const result = await input.pool.query<TeammateRow>(
        `WITH active_slack AS (
           SELECT slack.organization_id, slack.binding_id, slack.display_name,
                  slack.project_target_id, slack.team_id, slack.channel_id,
                  slack.bot_user_id
           FROM cp_slack_binding slack
           WHERE slack.organization_id = $1
             AND slack.state='active'
         )
         SELECT slack.binding_id, slack.display_name, slack.team_id,
                slack.channel_id, slack.bot_user_id,
                slack.project_target_id AS configured_project_target_id,
                target.project_target_id, target.provider AS target_provider,
                target.owner AS target_owner, target.repo AS target_repo,
                target.default_executor, target.runner_id AS configured_runner_id,
                runner.runner_id,
                readiness.expires_at AS readiness_expires_at,
                active_run.run_id AS active_run_id,
                active_run.state AS active_run_state,
                active_run.outcome_state AS active_run_outcome_state,
                active_run.updated_at AS active_run_updated_at,
                active_run.current_attempt_number AS active_run_attempt_number,
                active_run.publication_mode AS active_publication_mode,
                COALESCE(active_run.has_candidate,false) AS active_has_candidate,
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
                 AND target_readiness->>'bindingGeneration'
                   = target.binding_generation::text
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
                  run.current_attempt_number,run.publication_mode,
                  EXISTS (SELECT 1 FROM cp_publication_candidate candidate
                    WHERE candidate.organization_id=run.organization_id AND candidate.run_id=run.run_id
                      AND candidate.attempt_number=run.current_attempt_number) AS has_candidate,
                  count(*) OVER()::int AS active_run_count,
                  EXISTS (
                    SELECT 1
                    FROM cp_hosted_attempt attempt
                    WHERE attempt.organization_id = run.organization_id
                      AND attempt.run_id = run.run_id
                      AND attempt.attempt_number = run.current_attempt_number
                      AND attempt.runner_id = run.runner_id
                      AND attempt.credential_id = runner.current_credential_id
                      AND EXISTS (SELECT 1 FROM cp_runner_credential current_credential
                        WHERE current_credential.organization_id=runner.organization_id
                          AND current_credential.runner_id=runner.runner_id
                          AND current_credential.credential_id=runner.current_credential_id
                          AND current_credential.credential_generation=runner.credential_generation
                          AND current_credential.revoked_at IS NULL)
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
         ORDER BY slack.team_id, slack.channel_id, slack.binding_id`,
        [principal.organizationId],
      );
      return Promise.all(result.rows.map(async row => {
        const feedback=row.active_run_id && row.active_run_attempt_number
          ? await readRunThreadFeedback(input.pool,{organizationId:principal.organizationId,
              runId:row.active_run_id,attemptNumber:row.active_run_attempt_number}) : undefined;
        return teammateFromRow(row,feedback);
      }));
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
        registration_generation: number;
        credential_generation: number;
        capabilities: string[];
        readiness: unknown | null;
        updated_at: Date;
      }>(
        `SELECT runner.runner_id, runner.registration_generation,
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
