import { createHash, randomBytes } from "node:crypto";
import type { OpenTagSourceDeletionEvent, OpenTagSourceIngressEvent } from "@opentag/core";
import { computeControlPayloadDigestV1 } from "@opentag/control-protocol";
import { SourceAppRegistry, executeSourceThreadCommand, type SourceAppDefinition,
  type SourceThreadCommand, type SourceThreadCommandAuthorityPorts } from "@opentag/source-app-runtime";
import { createSlackSourceApp, SlackVerificationError } from "@opentag/slack";
import type { Pool } from "pg";
import { withPostgresTransaction } from "../../database/postgres.js";
import type { DurableJobQueue } from "../jobs/index.js";
import type { RelayContentCustody } from "../source-content/index.js";
import { createSourceIngressService, type SourceIngressService } from "../source-ingress/index.js";

type HttpResult = { status: number; body: unknown };
type RawRequest = { rawBody: Uint8Array; headers: Headers; receivedAt: string };
export type SlackSecretResolver = { resolve(reference: string): Promise<string> };
const hashBytes = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

type SlackInstallation = {
  organizationId: string; installationId: string; bindingId: string;
  teamId: string; appId: string; channelId: string; botUserId: string;
  memberUserIds: string[];
  signingSecretRef: string; botTokenRef: string; appInstanceId: string;
  bindingDigest: string; credentialGeneration: number; credentialGenerationDigest: string;
};
type InstallationResolution = { kind: "found"; installation: SlackInstallation }
  | { kind: "not_found" } | { kind: "ambiguous" };
type SlackUrlVerificationResult = { kind: "not_url_verification" }
  | { kind: "malformed" }
  | { kind: "accepted"; challenge: string };
const MAX_SLACK_CHALLENGE_LENGTH = 4096;

type ActionRow = { organization_id: string; action_id: string; installation_id: string;
  action_token_hash: string;
  binding_id: string; team_id: string; app_id: string; channel_id: string;
  thread_root_message_id: string; run_id: string; pending_request_id: string;
  action_kind: "status" | "cancel" | "approval" | "bind" | "unbind";
  action_descriptor: unknown;
  action_descriptor_digest: string;
  approval_epoch: string; frozen_ceiling: unknown; allowed_decisions: string[];
  frozen_ceiling_digest: string; policy_digest: string; runner_id: string;
  attempt_id: string; attempt_number: number; attempt_epoch: number;
  fencing_token_digest: string; permission_request_digest: string; pending_action_id: string;
  requester_user_id: string | null; operator_user_ids: string[];
  member_user_ids: string[];
  approver_user_id: string | null; admin_user_ids: string[]; expires_at: Date;
  consumed_at: Date | null };

async function resolveInstallation(pool: Pool, installationId: string): Promise<InstallationResolution> {
  const result = await pool.query<{
    organization_id: string; installation_id: string; binding_id: string;
    team_id: string; app_id: string; channel_id: string; bot_user_id: string;
    member_user_ids: string[];
    signing_secret_ref: string; bot_token_ref: string; app_instance_id: string;
    binding_digest: string; credential_generation: number; credential_generation_digest: string;
  }>(`SELECT slack.*, installation.app_instance_id, installation.binding_digest,
      installation.credential_generation, installation.credential_generation_digest
    FROM cp_slack_installation slack
    JOIN cp_source_app_installation installation
      ON installation.organization_id = slack.organization_id
     AND installation.installation_id = slack.installation_id
    JOIN cp_source_binding binding
      ON binding.organization_id = slack.organization_id
     AND binding.binding_id = slack.binding_id
     AND binding.installation_id = slack.installation_id
    WHERE slack.installation_id = $1 AND installation.source_app_id = 'slack'
      AND installation.state = 'active' AND binding.state = 'active'
      AND binding.binding_digest = installation.binding_digest LIMIT 2`, [installationId]);
  if (result.rows.length === 0) return { kind: "not_found" };
  if (result.rows.length > 1) return { kind: "ambiguous" };
  const row = result.rows[0]!;
  return { kind: "found", installation: {
    organizationId: row.organization_id, installationId: row.installation_id,
    bindingId: row.binding_id, teamId: row.team_id, appId: row.app_id,
    channelId: row.channel_id, botUserId: row.bot_user_id,
    memberUserIds: row.member_user_ids,
    signingSecretRef: row.signing_secret_ref, botTokenRef: row.bot_token_ref,
    appInstanceId: row.app_instance_id, bindingDigest: row.binding_digest,
    credentialGeneration: row.credential_generation,
    credentialGenerationDigest: row.credential_generation_digest,
  } };
}

function payloadRecord(trusted: unknown): Record<string, any> | null {
  if (!trusted || typeof trusted !== "object" || !("payload" in trusted)) return null;
  const payload = (trusted as { payload: unknown }).payload;
  return payload && typeof payload === "object" ? payload as Record<string, any> : null;
}

function payloadIdentity(payload: Record<string, any>): { teamId: string; appId: string;
  channelId?: string; threadRootMessageId?: string } | null {
  if (payload.type === "event_callback" || payload.type === "url_verification") {
    if (typeof payload.team_id !== "string" || typeof payload.api_app_id !== "string") return null;
    const event = payload.event;
    return { teamId: payload.team_id, appId: payload.api_app_id,
      ...(event && typeof event.channel === "string" ? { channelId: event.channel } : {}),
      ...(event && typeof (event.thread_ts ?? event.deleted_ts ?? event.ts) === "string"
        ? { threadRootMessageId: event.thread_ts ?? event.deleted_ts ?? event.ts } : {}) };
  }
  if (payload.type === "block_actions") {
    const teamId = payload.team?.id; const appId = payload.api_app_id;
    const channelId = payload.channel?.id ?? payload.container?.channel_id;
    const threadRootMessageId = payload.container?.thread_ts ?? payload.message?.thread_ts
      ?? payload.container?.message_ts ?? payload.message?.ts;
    return typeof teamId === "string" && typeof appId === "string" && typeof channelId === "string"
      && typeof threadRootMessageId === "string"
      ? { teamId, appId, channelId, threadRootMessageId } : null;
  }
  return null;
}

function verificationFailure(error: unknown): HttpResult {
  if (error instanceof SlackVerificationError) {
    return error.kind === "malformed_payload"
      ? { status: 400, body: { error: "invalid_slack_payload" } }
      : { status: 401, body: { error: error.kind } };
  }
  return { status: 503, body: { error: "slack_ingress_unavailable" } };
}

function identityMatches(installation: SlackInstallation, identity: ReturnType<typeof payloadIdentity>) {
  return identity && identity.teamId === installation.teamId && identity.appId === installation.appId
    && (identity.channelId === undefined || identity.channelId === installation.channelId);
}

function urlVerificationResult(payload: Record<string, any>): SlackUrlVerificationResult {
  if (payload.type !== "url_verification") return { kind: "not_url_verification" };
  return typeof payload.challenge === "string" && payload.challenge.length > 0
    && payload.challenge.length <= MAX_SLACK_CHALLENGE_LENGTH
    ? { kind: "accepted", challenge: payload.challenge }
    : { kind: "malformed" };
}

function createInstallationApp(input: { installation: SlackInstallation; signingSecret: string;
  secrets: SlackSecretResolver; fetchImpl?: typeof fetch; clock: { now(): Date } }) {
  const sourceApp = createSlackSourceApp({ installation: {
    appInstanceId: input.installation.appInstanceId,
    bindingDigest: input.installation.bindingDigest,
    credentialGeneration: input.installation.credentialGeneration,
    credentialGenerationDigest: input.installation.credentialGenerationDigest,
  }, signingSecret: input.signingSecret, botUserId: input.installation.botUserId,
  resolveCredential: () => input.secrets.resolve(input.installation.botTokenRef),
  ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  clock: () => input.clock.now().getTime() });
  const registry = new SourceAppRegistry().register(sourceApp);
  return registry.resolveDelivery({ appId: "slack", ...sourceApp.installation })!;
}

function createBoundIngress(input: { sourceApp: SourceAppDefinition<unknown, unknown, unknown>;
  installation: SlackInstallation; sourceIngress: Pick<SourceIngressService, "reserve" | "findSourceIdentity">;
  sourceContent: Pick<RelayContentCustody, "withdraw">; clock: { now(): Date } }) {
  async function withdraw(event: OpenTagSourceDeletionEvent): Promise<HttpResult> {
    const original = await input.sourceIngress.findSourceIdentity({
      organizationId: input.installation.organizationId,
      installationId: input.installation.installationId, sourceAppId: input.sourceApp.appId,
      sourceVersionRef: event.source.sourceVersionRef });
    if (original.kind === "not_found") return { status: 404, body: { error: "source_content_not_found" } };
    if (original.kind === "ambiguous") return { status: 409, body: { error: "source_content_ambiguous" } };
    try {
      await input.sourceContent.withdraw({ schemaVersion: 1, kind: "verified_source_withdrawal",
        commandId: `slack_delete:${event.eventId}`,
        organizationId: input.installation.organizationId, sourceVersionRef: event.source.sourceVersionRef,
        verification: { installationId: input.installation.installationId,
          sourceAppId: input.sourceApp.appId, sourceDeliveryId: original.sourceDeliveryId,
          verifiedAt: event.verification.verifiedAt, evidenceDigest: event.verification.evidenceDigest } });
      return { status: 200, body: { ok: true, withdrawn: true } };
    } catch { return { status: 503, body: { error: "source_withdrawal_unavailable" } }; }
  }
  async function receiveNormalized(normalized: OpenTagSourceIngressEvent,
    rawBody: Uint8Array): Promise<HttpResult> {
    if (normalized.trigger === "source_content_deleted") return withdraw(normalized);
    const event = normalized as Exclude<OpenTagSourceIngressEvent, OpenTagSourceDeletionEvent>;
    const sourceMessageId = event.source.messageId;
    if (!sourceMessageId) return { status: 400, body: { error: "source_message_identity_missing" } };
    const workspace = event.source.channel.workspace;
    const sourceVersionRef = `slack:${workspace ?? "unknown"}:${event.source.channel.id}:${sourceMessageId}`;
    const reservation = await input.sourceIngress.reserve({
      organizationId: input.installation.organizationId,
      installationId: input.installation.installationId, bindingId: input.installation.bindingId,
      sourceApp: input.sourceApp, sourceDeliveryId: event.eventId, sourceMessageId,
      sourceVersionRef, rawDigest: hashBytes(rawBody), normalizedContent: event,
      expiresAt: new Date(input.clock.now().getTime() + 7 * 86_400_000) });
    return reservation.mayAcknowledge ? { status: 200, body: { ok: true } }
      : { status: 503, body: { error: "source_ingress_unavailable" } };
  }
  return {
    receiveNormalized,
    async receiveTrusted(trusted: unknown, rawBody: Uint8Array): Promise<HttpResult> {
      const payload = payloadRecord(trusted);
      if (payload?.type === "url_verification") {
        return typeof payload.challenge === "string" ? { status: 200, body: payload.challenge }
          : { status: 400, body: { error: "invalid_challenge" } };
      }
      let normalized: OpenTagSourceIngressEvent | null;
      try {
        const result = input.sourceApp.ingress.normalizeResult?.(trusted);
        if (result?.kind === "malformed") return { status: 400, body: { error: result.code } };
        if (result?.kind === "unsupported") return { status: 200, body: { ok: true, ignored: true } };
        normalized = result?.kind === "accepted" ? result.event
          : input.sourceApp.ingress.normalize(trusted);
      } catch { return { status: 400, body: { error: "slack_normalization_failed" } }; }
      if (!normalized) return { status: 200, body: { ok: true, ignored: true } };
      return receiveNormalized(normalized, rawBody);
    }
  };
}

export function createPostgresSlackIngress(input: { pool: Pool; clock: { now(): Date };
  custody: RelayContentCustody; jobs: Pick<DurableJobQueue, "enqueueInTransaction">;
  secrets: SlackSecretResolver; commandAuthority?: SourceThreadCommandAuthorityPorts;
  fetchImpl?: typeof fetch; tokenFactory?: () => string }) {
  const sourceIngress = createSourceIngressService({ pool: input.pool, clock: input.clock,
    custody: input.custody, jobs: input.jobs });
  const resolve = async (installationId: string) => {
    const resolution = await resolveInstallation(input.pool, installationId);
    if (resolution.kind !== "found") return resolution;
    const signingSecret = await input.secrets.resolve(resolution.installation.signingSecretRef);
    const sourceApp = createInstallationApp({ installation: resolution.installation,
      signingSecret, secrets: input.secrets, clock: input.clock,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
    return { kind: "found" as const, installation: resolution.installation, sourceApp };
  };

  return {
    async checkReadiness() {
      try {
        const rows = await input.pool.query<{ installation_id: string }>(
          "SELECT installation_id FROM cp_slack_installation ORDER BY organization_id, installation_id");
        for (const row of rows.rows) {
          const resolved = await resolve(row.installation_id);
          if (resolved.kind !== "found") return { ready: false, reason: "configuration_invalid" } as const;
          await input.secrets.resolve(resolved.installation.botTokenRef);
        }
        return { ready: true } as const;
      } catch { return { ready: false, reason: "configuration_invalid" } as const; }
    },
    async issueAction(command: { organizationId: string; actionId: string; installationId: string;
      bindingId: string; teamId: string; appId: string; channelId: string;
      threadRootMessageId: string; runId: string; pendingRequestId: string;
      actionKind: ActionRow["action_kind"]; actionDescriptor: unknown;
      approvalEpoch: string; frozenCeiling: unknown; policyDigest: string;
      runnerId: string; attemptId: string; attemptNumber: number; attemptEpoch: number;
      fencingTokenDigest: string; permissionRequestDigest: string; pendingActionId: string;
      allowedDecisions: string[]; requesterUserId?: string; operatorUserIds: string[];
      memberUserIds: string[];
      approverUserId?: string; adminUserIds: string[]; expiresAt: Date }) {
      const token = input.tokenFactory?.() ?? randomBytes(32).toString("base64url");
      const actionDescriptorDigest = await computeControlPayloadDigestV1(command.actionDescriptor);
      const frozenCeilingDigest = await computeControlPayloadDigestV1(command.frozenCeiling);
      await input.pool.query(`INSERT INTO cp_slack_action_authority(
        organization_id,action_id,action_token_hash,installation_id,binding_id,team_id,app_id,
        channel_id,thread_root_message_id,run_id,pending_request_id,action_kind,action_descriptor,
        action_descriptor_digest,approval_epoch,frozen_ceiling,frozen_ceiling_digest,policy_digest,
        runner_id,attempt_id,attempt_number,attempt_epoch,fencing_token_digest,permission_request_digest,
        pending_action_id,allowed_decisions,requester_user_id,member_user_ids,operator_user_ids,
        approver_user_id,admin_user_ids,expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
          $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)`, [command.organizationId, command.actionId,
        hashBytes(token), command.installationId, command.bindingId, command.teamId, command.appId,
        command.channelId, command.threadRootMessageId, command.runId, command.pendingRequestId,
        command.actionKind, JSON.stringify(command.actionDescriptor), actionDescriptorDigest, command.approvalEpoch,
        JSON.stringify(command.frozenCeiling), frozenCeilingDigest, command.policyDigest, command.runnerId,
        command.attemptId, command.attemptNumber, command.attemptEpoch, command.fencingTokenDigest,
        command.permissionRequestDigest, command.pendingActionId, command.allowedDecisions,
        command.requesterUserId ?? null, command.memberUserIds, command.operatorUserIds, command.approverUserId ?? null,
        command.adminUserIds, command.expiresAt, input.clock.now()]);
      return token;
    },

    async receiveEvents(installationId: string, request: RawRequest): Promise<HttpResult> {
      try {
        const resolved = await resolve(installationId);
        if (resolved.kind === "not_found") return { status: 404, body: { error: "slack_installation_not_found" } };
        if (resolved.kind === "ambiguous") return { status: 409, body: { error: "slack_installation_ambiguous" } };
        const trusted = await resolved.sourceApp.ingress.verify(request);
        const payload = payloadRecord(trusted);
        const identity = payloadIdentity(payload ?? {});
        if (!identity) return { status: 400, body: { error: "invalid_slack_envelope" } };
        if (!identityMatches(resolved.installation, identity)) {
          return { status: 404, body: { error: "slack_installation_not_found" } };
        }
        const urlVerification = urlVerificationResult(payload!);
        if (urlVerification.kind === "malformed") {
          return { status: 400, body: { error: "invalid_slack_challenge" } };
        }
        if (urlVerification.kind === "accepted") {
          return { status: 200, body: urlVerification.challenge };
        }
        const bound = createBoundIngress({ sourceApp: resolved.sourceApp,
          installation: resolved.installation, sourceIngress,
          sourceContent: input.custody, clock: input.clock });
        let normalization;
        try { normalization = resolved.sourceApp.ingress.normalizeResult?.(trusted); }
        catch { return { status: 400, body: { error: "slack_normalization_failed" } }; }
        if (normalization?.kind === "malformed") {
          return { status: 400, body: { error: normalization.code } };
        }
        if (normalization?.kind === "unsupported") {
          return { status: 200, body: { ok: true, ignored: true } };
        }
        const normalized = normalization?.kind === "accepted" ? normalization.event
          : resolved.sourceApp.ingress.normalize(trusted);
        if (!normalized) return { status: 200, body: { ok: true, ignored: true } };
        if (normalized.trigger === "mention"
          && !resolved.installation.memberUserIds.includes(normalized.source.actor.id)) {
          return { status: 403, body: { error: "slack_actor_not_authorized" } };
        }
        return bound.receiveNormalized(normalized, request.rawBody);
      } catch (error) { return verificationFailure(error); }
    },

    async receiveInteractivity(installationId: string, request: RawRequest): Promise<HttpResult> {
      const commandAuthority = input.commandAuthority;
      if (!commandAuthority) return { status: 503, body: { error: "slack_command_authority_unavailable" } };
      try {
        const resolved = await resolve(installationId);
        if (resolved.kind === "not_found") return { status: 404, body: { error: "slack_installation_not_found" } };
        if (resolved.kind === "ambiguous") return { status: 409, body: { error: "slack_installation_ambiguous" } };
        const trusted = await resolved.sourceApp.ingress.verify(request);
        const payload = payloadRecord(trusted); const identity = payloadIdentity(payload ?? {});
        if (!payload || !identity) return { status: 400, body: { error: "invalid_slack_envelope" } };
        if (!identityMatches(resolved.installation, identity)) {
          return { status: 404, body: { error: "slack_installation_not_found" } };
        }
        const action = Array.isArray(payload.actions) ? payload.actions[0] : null;
        const token = action?.value; const actorId = payload.user?.id;
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,512}$/u.test(token)
          || typeof actorId !== "string" || typeof action.action_id !== "string"
          || !/^opentag:decision:(status|cancel|allow_once|allow_run|deny|bind|unbind)$/u.test(action.action_id)) {
          return { status: 400, body: { error: "invalid_slack_action" } };
        }
        return withPostgresTransaction(input.pool, async (client) => {
          const rows = await client.query<ActionRow>(`SELECT * FROM cp_slack_action_authority
            WHERE action_token_hash = $1 FOR UPDATE`, [hashBytes(token)]);
          const row = rows.rows[0];
          if (!row || row.consumed_at || row.expires_at <= input.clock.now()) {
            return { status: 403, body: { error: "slack_action_not_authorized" } };
          }
          if (row.installation_id !== resolved.installation.installationId
            || row.binding_id !== resolved.installation.bindingId
            || row.team_id !== identity.teamId || row.app_id !== identity.appId
            || row.channel_id !== identity.channelId
            || row.thread_root_message_id !== identity.threadRootMessageId) {
            return { status: 403, body: { error: "slack_action_not_authorized" } };
          }
          const decision = action.action_id.replace("opentag:decision:", "");
          if (!row.allowed_decisions.includes(decision)) {
            return { status: 403, body: { error: "slack_action_not_authorized" } };
          }
          if (row.action_kind === "approval") {
            const current = await client.query<{
              run_state: string; permission_ceiling_digest: string; attempt_state: string;
              blocked_permission_request_id: string | null;
              blocked_action_descriptor_digest: string | null;
              blocked_policy_snapshot_digest: string | null;
              runner_id: string; attempt_id: string; attempt_number: number;
              fencing_token_digest: string; permission_state: string;
              permission_request_digest: string; permission_action_id: string;
              permission_policy_digest: string; permission_attempt_epoch: string | null;
            }>(`SELECT run.state AS run_state, run.permission_ceiling_digest,
                attempt.state AS attempt_state, attempt.blocked_permission_request_id,
                attempt.blocked_action_descriptor_digest, attempt.blocked_policy_snapshot_digest,
                attempt.runner_id, attempt.attempt_id, attempt.attempt_number,
                attempt.fencing_token_digest, permission.state AS permission_state,
                permission.permission_request_digest,
                permission.action_id AS permission_action_id,
                permission.policy_snapshot_digest AS permission_policy_digest,
                permission.request->'attempt'->>'epoch' AS permission_attempt_epoch
              FROM cp_hosted_run run
              JOIN cp_hosted_attempt attempt ON attempt.organization_id = run.organization_id
                AND attempt.run_id = run.run_id AND attempt.attempt_number = run.current_attempt_number
              JOIN cp_permission_request permission ON permission.organization_id = run.organization_id
                AND permission.run_id = run.run_id AND permission.permission_request_id = $3
              WHERE run.organization_id = $1 AND run.run_id = $2`,
            [row.organization_id, row.run_id, row.pending_request_id]);
            const state = current.rows[0];
            if (!state || state.run_state !== "needs_approval" || state.attempt_state !== "needs_approval"
              || state.permission_state !== "waiting"
              || state.blocked_permission_request_id !== row.pending_request_id
              || state.blocked_action_descriptor_digest !== row.action_descriptor_digest
              || state.blocked_policy_snapshot_digest !== row.policy_digest
              || state.permission_ceiling_digest !== row.frozen_ceiling_digest
              || state.permission_request_digest !== row.permission_request_digest
              || state.permission_action_id !== row.pending_action_id
              || state.permission_policy_digest !== row.policy_digest
              || state.permission_attempt_epoch !== row.approval_epoch
              || state.permission_attempt_epoch !== String(row.attempt_epoch)
              || state.runner_id !== row.runner_id || state.attempt_id !== row.attempt_id
              || state.attempt_number !== row.attempt_number
              || state.fencing_token_digest !== row.fencing_token_digest) {
              return { status: 403, body: { error: "slack_action_authority_stale" } };
            }
          }
          const actor = { provider: "slack", id: actorId } as const;
          const authority = { organizationId: row.organization_id,
            installationId: row.installation_id, bindingId: row.binding_id,
            sourceThreadId: `${row.channel_id}:${row.thread_root_message_id}`,
            runId: row.run_id, pendingRequestId: row.pending_request_id,
            approvalEpoch: row.approval_epoch, runnerId: row.runner_id,
            attemptId: row.attempt_id, attemptNumber: row.attempt_number,
            attemptEpoch: row.attempt_epoch, fencingTokenDigest: row.fencing_token_digest,
            permissionRequestDigest: row.permission_request_digest, actionId: row.pending_action_id,
            actionDescriptorDigest: row.action_descriptor_digest,
            frozenCeilingDigest: row.frozen_ceiling_digest, policyDigest: row.policy_digest,
            actionTokenIdentity: row.action_token_hash,
            selectedDecision: decision as "status" | "cancel" | "allow_once" | "allow_run" | "deny" | "bind" | "unbind",
            allowedDecisions: row.allowed_decisions as Array<"status" | "cancel" | "allow_once" | "allow_run" | "deny" | "bind" | "unbind"> };
          let command: SourceThreadCommand | null = null;
          if (decision === "status" && row.action_kind === "status" && row.member_user_ids.includes(actorId)) command = {
            type: "status", commandId: row.action_id, actor, authority };
          if (decision === "cancel" && row.action_kind === "cancel"
            && (actorId === row.requester_user_id || row.operator_user_ids.includes(actorId))) command = {
            type: "cancel", commandId: row.action_id, actor, reason: "source_thread_request", authority };
          if ((decision === "allow_once" || decision === "allow_run") && row.action_kind === "approval"
            && actorId === row.approver_user_id) command = { type: "approve", commandId: row.action_id,
              actor, requestId: row.pending_request_id, decision, authority };
          if (decision === "deny" && row.action_kind === "approval" && actorId === row.approver_user_id) {
            command = { type: "reject", commandId: row.action_id, actor,
              requestId: row.pending_request_id, authority };
          }
          if (decision === "bind" && row.action_kind === "bind" && row.admin_user_ids.includes(actorId)) {
            command = { type: "bind", commandId: row.action_id, actor,
              bindingDigest: resolved.installation.bindingDigest, authority };
          }
          if (decision === "unbind" && row.action_kind === "unbind" && row.admin_user_ids.includes(actorId)) {
            command = { type: "unbind", commandId: row.action_id, actor,
              bindingDigest: resolved.installation.bindingDigest, authority };
          }
          if (!command) return { status: 403, body: { error: "slack_action_not_authorized" } };
          const result = await executeSourceThreadCommand({ adapter: resolved.sourceApp,
            authority: commandAuthority, command });
          if (result.outcome !== "completed") return { status: 403, body: { error: result.outcome } };
          await client.query(`UPDATE cp_slack_action_authority SET consumed_at = $2
            WHERE organization_id = $1 AND action_id = $3`,
          [row.organization_id, input.clock.now(), row.action_id]);
          return { status: 200, body: { ok: true } };
        });
      } catch (error) { return verificationFailure(error); }
    }
  };
}

/** Explicit test seam for unit tests that do not exercise canonical PostgreSQL resolution. */
export function createSlackIngressForTest(input: {
  sourceApp: SourceAppDefinition<unknown, unknown, unknown>;
  organizationId: string; installationId: string; bindingId: string;
  sourceIngress: Pick<SourceIngressService, "reserve" | "findSourceIdentity">;
  sourceContent: Pick<RelayContentCustody, "withdraw">; clock: { now(): Date };
}) {
  const installation: SlackInstallation = { organizationId: input.organizationId,
    installationId: input.installationId, bindingId: input.bindingId,
    teamId: "test", appId: "test", channelId: "test", botUserId: "test",
    memberUserIds: ["test"],
    signingSecretRef: "test", botTokenRef: "test", appInstanceId: input.sourceApp.installation.appInstanceId,
    bindingDigest: input.sourceApp.installation.bindingDigest,
    credentialGeneration: input.sourceApp.installation.credentialGeneration,
    credentialGenerationDigest: input.sourceApp.installation.credentialGenerationDigest };
  return { async receiveEvents(request: RawRequest) {
    try { const trusted = await input.sourceApp.ingress.verify(request);
      return createBoundIngress({ sourceApp: input.sourceApp, installation,
        sourceIngress: input.sourceIngress, sourceContent: input.sourceContent,
        clock: input.clock }).receiveTrusted(trusted, request.rawBody);
    } catch (error) { return verificationFailure(error); }
  } };
}
