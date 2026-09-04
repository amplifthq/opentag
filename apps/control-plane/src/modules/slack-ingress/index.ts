import { createHash, randomBytes } from "node:crypto";
import type { OpenTagSourceDeletionEvent, OpenTagSourceIngressEvent } from "@opentag/core";
import { AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1, computeMaterialActionFencingTokenDigestV1,
  HostedAdmissionEnvelopeV1Schema, HumanPublicationApprovalV1Schema } from "@opentag/control-protocol";
import type { PermissionResolutionReceiptEnvelopeV1,
  RunnerBranchOwnershipAttestationV1, RunnerPermissionRequestV1 } from "@opentag/control-protocol";
import { SourceAppRegistry, executeSourceThreadCommand, type SourceAppDefinition,
  type SourceThreadCommand, type SourceThreadCommandAuthorityPorts } from "@opentag/source-app-runtime";
import { createSlackSourceApp, normalizeSlackAppMention, SlackVerificationError } from "@opentag/slack";
import type { Pool } from "pg";
import { withPostgresTransaction, type PostgresTransactionClient } from "../../database/postgres.js";
import type { DurableJobQueue } from "../jobs/index.js";
import type { RelayContentCustody } from "../source-content/index.js";
import { createSourceIngressService, type SourceIngressService } from "../source-ingress/index.js";

type HttpResult = { status: number; body: unknown };
type RawRequest = { rawBody: Uint8Array; headers: Headers; receivedAt: string };
export type SlackSecretResolver = { resolve(reference: string): Promise<string> };
const hashBytes = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

type SlackInstallation = {
  organizationId: string; installationId: string; routeIdentity: string; bindingId: string;
  projectTargetId: string | null; publicationMode: "proposal_only" | "pull_request";
  teamId: string; appId: string; channelId: string; botUserId: string;
  memberUserIds: string[];
  operatorUserIds: string[]; approverUserId: string | null; adminUserIds: string[];
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
  action_kind: "status" | "cancel" | "approval" | "publication" | "bind" | "unbind";
  action_descriptor: unknown;
  action_descriptor_digest: string;
  approval_epoch: string; frozen_ceiling: unknown; allowed_decisions: string[];
  frozen_ceiling_digest: string; policy_digest: string; runner_id: string;
  attempt_id: string; attempt_number: number; attempt_epoch: number;
  projection_generation: number;
  authority_family_id: string; authority_epoch: number;
  claim_state: "available" | "claimed" | "consumed"; claimed_at: Date | null;
  fencing_token_digest: string; permission_request_digest: string; pending_action_id: string;
  requester_user_id: string | null; operator_user_ids: string[];
  member_user_ids: string[];
  approver_user_id: string | null; admin_user_ids: string[]; expires_at: Date;
  consumed_at: Date | null; publication_approval: unknown | null };

type SlackActionIssue = {
  organizationId: string; actionId: string; installationId: string;
  bindingId: string; teamId: string; appId: string; channelId: string;
  threadRootMessageId: string; runId: string; pendingRequestId: string;
  actionKind: ActionRow["action_kind"]; actionDescriptor: unknown;
  approvalEpoch: string; frozenCeiling: unknown; policyDigest: string;
  runnerId: string; attemptId: string; attemptNumber: number; attemptEpoch: number;
  projectionGeneration?: number; authorityFamilyId?: string; authorityEpoch?: number;
  fencingTokenDigest: string; permissionRequestDigest: string; pendingActionId: string;
  allowedDecisions: string[]; requesterUserId?: string; operatorUserIds: string[];
  memberUserIds: string[]; approverUserId?: string; adminUserIds: string[];
  expiresAt: Date;
  publicationApproval?: ReturnType<typeof HumanPublicationApprovalV1Schema.parse>;
};

async function resolveInstallation(pool: Pool, identity: { organizationId: string; installationId: string }
  | { routeIdentity: string }): Promise<InstallationResolution> {
  const route = "routeIdentity" in identity;
  const result = await pool.query<{
    organization_id: string; installation_id: string; route_identity: string; binding_id: string;
    project_target_id: string | null; publication_mode: "proposal_only" | "pull_request";
    team_id: string; app_id: string; channel_id: string; bot_user_id: string;
    member_user_ids: string[];
    operator_user_ids: string[]; approver_user_id: string | null; admin_user_ids: string[];
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
    WHERE ${route ? "slack.route_identity = $1" : "slack.organization_id = $1 AND slack.installation_id = $2"}
      AND installation.source_app_id = 'slack'
      AND installation.state = 'active' AND binding.state = 'active'
      AND binding.binding_digest = installation.binding_digest LIMIT 2`, route
      ? [identity.routeIdentity] : [identity.organizationId, identity.installationId]);
  if (result.rows.length === 0) return { kind: "not_found" };
  if (result.rows.length > 1) return { kind: "ambiguous" };
  const row = result.rows[0]!;
  return { kind: "found", installation: {
    organizationId: row.organization_id, installationId: row.installation_id,
    routeIdentity: row.route_identity, projectTargetId: row.project_target_id,
    publicationMode: row.publication_mode,
    bindingId: row.binding_id, teamId: row.team_id, appId: row.app_id,
    channelId: row.channel_id, botUserId: row.bot_user_id,
    memberUserIds: row.member_user_ids, operatorUserIds: row.operator_user_ids,
    approverUserId: row.approver_user_id, adminUserIds: row.admin_user_ids,
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

function buildInstallationApp(input: { installation: SlackInstallation; signingSecret: string;
  secrets: SlackSecretResolver;
  fetchImpl?: typeof fetch; clock: { now(): Date } }) {
  return createSlackSourceApp({ installation: {
    organizationId: input.installation.organizationId,
    appInstanceId: input.installation.appInstanceId,
    bindingDigest: input.installation.bindingDigest,
    credentialGeneration: input.installation.credentialGeneration,
    credentialGenerationDigest: input.installation.credentialGenerationDigest,
  }, signingSecret: input.signingSecret, botUserId: input.installation.botUserId,
  resolveCredential: () => input.secrets.resolve(input.installation.botTokenRef),
  ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  clock: () => input.clock.now().getTime() });
}

function createBoundIngress(input: { sourceApp: SourceAppDefinition<unknown, unknown, unknown>;
  installation: SlackInstallation; sourceIngress: Pick<SourceIngressService, "reserve" | "findSourceIdentity">;
  sourceContent: Pick<RelayContentCustody, "withdraw">; clock: { now(): Date };
  prepareSourceContext?: (event: Exclude<OpenTagSourceIngressEvent,
    OpenTagSourceDeletionEvent>) => Promise<unknown> }) {
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
    const normalizedContent = input.prepareSourceContext
      ? await input.prepareSourceContext(event) : event;
    const reservation = await input.sourceIngress.reserve({
      organizationId: input.installation.organizationId,
      installationId: input.installation.installationId, bindingId: input.installation.bindingId,
      sourceApp: input.sourceApp, sourceDeliveryId: event.eventId, sourceMessageId,
      sourceVersionRef, rawDigest: hashBytes(rawBody), normalizedContent,
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
  secrets: SlackSecretResolver; sourceApps: SourceAppRegistry;
  commandAuthority?: SourceThreadCommandAuthorityPorts;
  publicationAuthority?: { approve(command: ReturnType<typeof HumanPublicationApprovalV1Schema.parse>
    & { approverId: string }): Promise<{ kind: "approved" | "replayed" | "rejected"; reason?: string }> };
  testHooks?: { afterServiceBeforeFinalize?(): Promise<void> };
  fetchImpl?: typeof fetch; tokenFactory?: () => string }) {
  const sourceIngress = createSourceIngressService({ pool: input.pool, clock: input.clock,
    custody: input.custody, jobs: input.jobs });
  const issueActionWith = async (client: PostgresTransactionClient,
    command: SlackActionIssue) => {
    const token = input.tokenFactory?.() ?? randomBytes(32).toString("base64url");
    const actionDescriptorDigest = await computeControlPayloadDigestV1(command.actionDescriptor);
    const frozenCeilingDigest = await computeControlPayloadDigestV1(command.frozenCeiling);
    await client.query(`INSERT INTO cp_slack_action_authority(
      organization_id,action_id,action_token_hash,installation_id,binding_id,team_id,app_id,
      channel_id,thread_root_message_id,run_id,pending_request_id,action_kind,action_descriptor,
      action_descriptor_digest,approval_epoch,frozen_ceiling,frozen_ceiling_digest,policy_digest,
      runner_id,attempt_id,attempt_number,attempt_epoch,projection_generation,authority_family_id,
      authority_epoch,claim_state,claimed_at,fencing_token_digest,permission_request_digest,
      pending_action_id,allowed_decisions,requester_user_id,member_user_ids,operator_user_ids,
      approver_user_id,admin_user_ids,publication_approval,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,'available',NULL,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)`,
    [command.organizationId, command.actionId, hashBytes(token), command.installationId,
      command.bindingId, command.teamId, command.appId, command.channelId,
      command.threadRootMessageId, command.runId, command.pendingRequestId,
      command.actionKind, JSON.stringify(command.actionDescriptor), actionDescriptorDigest,
      command.approvalEpoch, JSON.stringify(command.frozenCeiling), frozenCeilingDigest,
      command.policyDigest, command.runnerId, command.attemptId, command.attemptNumber,
      command.attemptEpoch, command.projectionGeneration ?? command.attemptNumber,
      command.authorityFamilyId ?? command.actionId,
      command.authorityEpoch ?? command.projectionGeneration ?? command.attemptNumber,
      command.fencingTokenDigest, command.permissionRequestDigest, command.pendingActionId,
      command.allowedDecisions, command.requesterUserId ?? null, command.memberUserIds,
      command.operatorUserIds, command.approverUserId ?? null, command.adminUserIds,
      command.publicationApproval ? JSON.stringify(command.publicationApproval) : null,
      command.expiresAt, input.clock.now()]);
    return token;
  };
  const prepareSourceContext = async (event: Exclude<OpenTagSourceIngressEvent,
    OpenTagSourceDeletionEvent>, installation: SlackInstallation) => {
    const target = installation.projectTargetId ? await input.pool.query<{
      provider: string; owner: string; repo: string }>(
      `SELECT provider,owner,repo FROM cp_project_target
       WHERE organization_id=$1 AND project_target_id=$2`,
      [installation.organizationId, installation.projectTargetId]) : { rows: [] };
    const repository = target.rows[0];
    const channelId = event.source.channel.id;
    const teamId = event.source.channel.workspace;
    const messageId = event.source.messageId;
    if (!teamId || !channelId || !messageId || !event.text) {
      throw new Error("slack_source_context_invalid");
    }
    const normalizedEvent = normalizeSlackAppMention({
      teamId, channelId, userId: event.source.actor.id,
      text: `<@${installation.botUserId}> ${event.text}`,
      ts: messageId,
      ...(event.source.thread?.parentMessageId
        ? { threadTs: event.source.thread.parentMessageId } : {}),
      eventId: event.eventId,
      eventTime: Math.floor(Date.parse(event.occurredAt) / 1_000),
      appId: installation.appId,
      botUserId: installation.botUserId,
      signatureVerified: true,
      binding: repository
        ? { teamId, channelId, repoProvider: repository.provider,
            owner: repository.owner, repo: repository.repo }
        : { teamId, channelId },
    });
    if (!normalizedEvent) throw new Error("slack_source_context_invalid");
    return { executionBearingMessageBody: event.text, event: normalizedEvent };
  };
  const resolveRoute = async (routeIdentity: string) => {
    const resolution = await resolveInstallation(input.pool, { routeIdentity });
    if (resolution.kind !== "found") return resolution;
    const signingSecret = await input.secrets.resolve(resolution.installation.signingSecretRef);
    const definition = buildInstallationApp({ installation: resolution.installation,
      signingSecret, secrets: input.secrets, clock: input.clock,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) });
    input.sourceApps.register(definition);
    const sourceApp = input.sourceApps.resolveDelivery({ appId: "slack", ...definition.installation })!;
    return { kind: "found" as const, installation: resolution.installation, sourceApp };
  };

  return {
    async preloadSourceApps() {
      const rows = await input.pool.query<{ organization_id: string; installation_id: string }>(
        `SELECT slack.organization_id,slack.installation_id FROM cp_slack_installation slack
         JOIN cp_source_app_installation installation
           ON installation.organization_id=slack.organization_id
          AND installation.installation_id=slack.installation_id
         JOIN cp_source_binding binding
           ON binding.organization_id=slack.organization_id
          AND binding.binding_id=slack.binding_id
          AND binding.installation_id=slack.installation_id
         WHERE installation.source_app_id='slack' AND installation.state='active'
           AND binding.state='active' AND binding.binding_digest=installation.binding_digest
         ORDER BY slack.organization_id, slack.installation_id`);
      const healthy: SourceAppDefinition<unknown, unknown, unknown>[] = [];
      const failures: Array<{ organizationId: string; installationId: string;
        errorCode: string; evidenceDigest: string }> = [];
      for (const row of rows.rows) {
        try {
          const resolution = await resolveInstallation(input.pool, {
            organizationId: row.organization_id, installationId: row.installation_id });
          if (resolution.kind !== "found") throw new Error("installation_unavailable");
          const signingSecret = await input.secrets.resolve(resolution.installation.signingSecretRef);
          healthy.push(buildInstallationApp({ installation: resolution.installation,
            signingSecret, secrets: input.secrets, clock: input.clock,
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}) }));
        } catch {
          failures.push({ organizationId: row.organization_id, installationId: row.installation_id,
            errorCode: "slack_installation_preload_failed",
            evidenceDigest: hashBytes(`${row.organization_id}\0${row.installation_id}\0preload_failed`) });
        }
      }
      input.sourceApps.replaceAppSnapshot("slack", healthy);
      return { registered: healthy.length, healthy: healthy.map((definition) => ({
        organizationId: definition.installation.organizationId, appId: definition.appId,
        appInstanceId: definition.installation.appInstanceId,
        bindingDigest: definition.installation.bindingDigest,
        credentialGeneration: definition.installation.credentialGeneration,
        credentialGenerationDigest: definition.installation.credentialGenerationDigest,
      })), failures };
    },
    async checkReadiness() {
      try {
        const rows = await input.pool.query<{ organization_id: string; installation_id: string }>(
          "SELECT organization_id,installation_id FROM cp_slack_installation ORDER BY organization_id, installation_id");
        for (const row of rows.rows) {
          const resolved = await resolveInstallation(input.pool, {
            organizationId: row.organization_id, installationId: row.installation_id });
          if (resolved.kind !== "found") return { ready: false, reason: "configuration_invalid" } as const;
          await input.secrets.resolve(resolved.installation.botTokenRef);
        }
        return { ready: true } as const;
      } catch { return { ready: false, reason: "configuration_invalid" } as const; }
    },
    async issueProjectionControls(command: { organizationId: string; runId: string;
      generation: number }) {
      return withPostgresTransaction(input.pool, async (client) => {
      const source = await client.query<ActionRow>(`SELECT DISTINCT ON (action_kind) *
        FROM cp_slack_action_authority WHERE organization_id=$1 AND run_id=$2
          AND attempt_number=$3 AND projection_generation=$3 AND consumed_at IS NULL
          AND expires_at>$4 ORDER BY action_kind,created_at DESC`,
      [command.organizationId, command.runId, command.generation, input.clock.now()]);
      const controls: Array<{ kind: "status" | "cancel" | "approve" | "reject"
        | "publication_approve"; actionId: string; generation: number }> = [];
      const kindFor = (decision: string) => decision === "allow_once" ? "approve" as const
        : decision === "deny" ? "reject" as const
        : decision === "publication_approve" ? "publication_approve" as const
        : decision === "status" ? "status" as const
        : decision === "cancel" ? "cancel" as const : null;
      const familyId = `projection:${command.runId}:${command.generation}:${randomBytes(12).toString("hex")}`;
      for (const row of source.rows) for (const decision of row.allowed_decisions) {
        const kind = kindFor(decision); if (!kind) continue;
        const token = input.tokenFactory?.() ?? randomBytes(32).toString("base64url");
        const actionId = `${row.action_id}:projection:${command.generation}:${hashBytes(token).slice(7, 19)}`;
        await client.query(`INSERT INTO cp_slack_action_authority(
          organization_id,action_id,action_token_hash,installation_id,binding_id,team_id,app_id,
          channel_id,thread_root_message_id,run_id,pending_request_id,action_kind,action_descriptor,
          action_descriptor_digest,approval_epoch,frozen_ceiling,frozen_ceiling_digest,policy_digest,
          runner_id,attempt_id,attempt_number,attempt_epoch,projection_generation,authority_family_id,
          authority_epoch,claim_state,claimed_at,fencing_token_digest,
          permission_request_digest,pending_action_id,allowed_decisions,requester_user_id,member_user_ids,
          operator_user_ids,approver_user_id,admin_user_ids,publication_approval,expires_at,created_at)
          SELECT organization_id,$2,$3,installation_id,binding_id,team_id,app_id,channel_id,
            thread_root_message_id,run_id,pending_request_id,action_kind,action_descriptor,
            action_descriptor_digest,approval_epoch,frozen_ceiling,frozen_ceiling_digest,policy_digest,
            runner_id,attempt_id,attempt_number,attempt_epoch,$4::integer,$8,$4::integer,'available',NULL,fencing_token_digest,
            permission_request_digest,pending_action_id,ARRAY[$5]::text[],requester_user_id,member_user_ids,
            operator_user_ids,approver_user_id,admin_user_ids,publication_approval,expires_at,$6
          FROM cp_slack_action_authority WHERE organization_id=$1 AND action_id=$7`,
        [command.organizationId, actionId, hashBytes(token), command.generation, decision,
          input.clock.now(), row.action_id, familyId]);
        controls.push({ kind, actionId: token, generation: command.generation });
      }
      return controls;
      });
    },
    async issuePermissionActionInTransaction(client: PostgresTransactionClient, command: {
      principal: { organizationId: string; runnerId: string };
      request: RunnerPermissionRequestV1;
      receipt: PermissionResolutionReceiptEnvelopeV1;
    }) {
      const result = await client.query<{
        hosted_admission: unknown; installation_id: string; binding_id: string;
        project_target_id: string | null; team_id: string; app_id: string; channel_id: string;
        member_user_ids: string[]; operator_user_ids: string[]; approver_user_id: string | null;
        admin_user_ids: string[];
      }>(`SELECT run.hosted_admission,slack.installation_id,slack.binding_id,
          slack.project_target_id,slack.team_id,slack.app_id,slack.channel_id,
          slack.member_user_ids,slack.operator_user_ids,slack.approver_user_id,
          slack.admin_user_ids
        FROM cp_hosted_run run
        JOIN cp_slack_installation slack ON slack.organization_id=run.organization_id
          AND slack.binding_id=run.hosted_admission->>'bindingId'
        WHERE run.organization_id=$1 AND run.run_id=$2 AND run.runner_id=$3
        FOR UPDATE OF run,slack`,
      [command.principal.organizationId, command.request.runId, command.principal.runnerId]);
      const row = result.rows[0];
      const admission = row ? HostedAdmissionEnvelopeV1Schema.safeParse(row.hosted_admission) : null;
      if (!row || !admission?.success || admission.data.provider !== "slack") return;
      if (!row.approver_user_id || row.project_target_id !== admission.data.projectTarget.projectTargetId
        || admission.data.sourceThread.kind !== "channel_thread"
        || admission.data.sourceThread.channelId !== row.channel_id
        || !admission.data.sourceThread.threadTs
        || command.request.permissionRequestDigest !== command.receipt.payload.permissionRequestDigest) {
        throw new Error("slack_permission_action_authority_unavailable");
      }
      const expiresAt = new Date(admission.data.queueClaimDeadline);
      if (expiresAt <= input.clock.now()) throw new Error("slack_permission_action_authority_expired");
      const actionIdentity = hashBytes(`${command.request.runId}\0${command.request.permissionRequestId}`)
        .slice("sha256:".length, 31);
      await issueActionWith(client, {
        organizationId: command.principal.organizationId,
        actionId: `slack_permission_${actionIdentity}`,
        installationId: row.installation_id, bindingId: row.binding_id,
        teamId: row.team_id, appId: row.app_id, channelId: row.channel_id,
        threadRootMessageId: admission.data.sourceThread.threadTs,
        runId: command.request.runId, pendingRequestId: command.request.permissionRequestId,
        actionKind: "approval", actionDescriptor: command.request.actionDescriptor,
        approvalEpoch: String(command.request.attempt.epoch),
        frozenCeiling: admission.data.permissionCeiling.allowedActionDescriptors,
        policyDigest: command.request.policySnapshotDigest,
        runnerId: command.request.runnerId, attemptId: command.request.attempt.attemptId,
        attemptNumber: command.request.attempt.attemptNumber,
        attemptEpoch: command.request.attempt.epoch,
        projectionGeneration: command.request.attempt.attemptNumber,
        authorityEpoch: command.request.attempt.epoch,
        fencingTokenDigest: command.request.attempt.fencingTokenDigest,
        permissionRequestDigest: command.request.permissionRequestDigest,
        pendingActionId: command.request.actionId,
        allowedDecisions: ["allow_once", "deny"],
        requesterUserId: admission.data.verifiedActor.providerUserId,
        memberUserIds: row.member_user_ids, operatorUserIds: row.operator_user_ids,
        approverUserId: row.approver_user_id, adminUserIds: row.admin_user_ids,
        expiresAt,
      });
    },
    async issuePublicationActionInTransaction(client: PostgresTransactionClient, command: {
      principal: { organizationId: string; runnerId: string };
      attestation: RunnerBranchOwnershipAttestationV1;
      ownershipId: string;
      ownershipDigest: string;
      createdAt: Date;
    }) {
      const result = await client.query<{
        hosted_admission: unknown; admission_policy_snapshot: unknown;
        installation_id: string; binding_id: string; project_target_id: string | null;
        team_id: string; app_id: string; channel_id: string; member_user_ids: string[];
        operator_user_ids: string[]; approver_user_id: string | null; admin_user_ids: string[];
      }>(`SELECT run.hosted_admission,run.admission_policy_snapshot,
          slack.installation_id,slack.binding_id,slack.project_target_id,
          slack.team_id,slack.app_id,slack.channel_id,slack.member_user_ids,
          slack.operator_user_ids,slack.approver_user_id,slack.admin_user_ids
        FROM cp_hosted_run run
        JOIN cp_slack_installation slack ON slack.organization_id=run.organization_id
          AND slack.binding_id=run.hosted_admission->>'bindingId'
        WHERE run.organization_id=$1 AND run.run_id=$2 AND run.runner_id=$3
          AND run.state='running' AND run.publication_mode='pull_request'
          AND run.terminal_kind IS NULL
        FOR UPDATE OF run,slack`,
      [command.principal.organizationId, command.attestation.runId,
        command.principal.runnerId]);
      const row = result.rows[0];
      const admission = row ? HostedAdmissionEnvelopeV1Schema.safeParse(row.hosted_admission) : null;
      if (!row || !admission?.success || admission.data.provider !== "slack") return;
      if (!row.approver_user_id || row.project_target_id !== command.attestation.projectTargetId
        || admission.data.sourceThread.kind !== "channel_thread"
        || admission.data.sourceThread.channelId !== row.channel_id
        || !admission.data.sourceThread.threadTs) {
        throw new Error("slack_publication_action_authority_unavailable");
      }
      const expiresAt = new Date(command.createdAt.getTime() + 15 * 60_000);
      const actionIdentity = hashBytes(`${command.attestation.runId}\0${command.ownershipId}`)
        .slice("sha256:".length, 31);
      const publicationApproval = HumanPublicationApprovalV1Schema.parse({
        schemaVersion: 1, protocolVersion: "1.0",
        requiredCapabilities: ["relay.publication.v1"],
        requestId: `request_publication_${actionIdentity}`,
        organizationId: command.principal.organizationId,
        runnerId: command.principal.runnerId, runId: command.attestation.runId,
        ownershipId: command.ownershipId, ownershipDigest: command.ownershipDigest,
        candidateId: command.attestation.candidateId,
        candidateDigest: command.attestation.candidateDigest,
        approvalId: `approval_${actionIdentity}`,
        approvedAt: command.createdAt.toISOString(), expiresAt: expiresAt.toISOString(),
      });
      const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse(
        row.admission_policy_snapshot);
      await issueActionWith(client, {
        organizationId: command.principal.organizationId,
        actionId: `slack_publication_${actionIdentity}`,
        installationId: row.installation_id, bindingId: row.binding_id,
        teamId: row.team_id, appId: row.app_id, channelId: row.channel_id,
        threadRootMessageId: admission.data.sourceThread.threadTs,
        runId: command.attestation.runId, pendingRequestId: command.ownershipId,
        actionKind: "publication",
        actionDescriptor: { kind: "publication_approve",
          candidateId: command.attestation.candidateId, ownershipId: command.ownershipId },
        approvalEpoch: String(command.attestation.attemptNumber),
        frozenCeiling: admission.data.publicationPolicy,
        policyDigest: policy.receiptDigest,
        runnerId: command.principal.runnerId, attemptId: command.attestation.attemptId,
        attemptNumber: command.attestation.attemptNumber,
        attemptEpoch: command.attestation.attemptNumber,
        projectionGeneration: command.attestation.attemptNumber,
        authorityEpoch: command.attestation.attemptNumber,
        fencingTokenDigest: await computeMaterialActionFencingTokenDigestV1(
          command.attestation.fencingToken),
        permissionRequestDigest: command.ownershipDigest,
        pendingActionId: command.attestation.candidateId,
        allowedDecisions: ["publication_approve"],
        requesterUserId: admission.data.verifiedActor.providerUserId,
        memberUserIds: row.member_user_ids, operatorUserIds: row.operator_user_ids,
        approverUserId: row.approver_user_id, adminUserIds: row.admin_user_ids,
        publicationApproval, expiresAt,
      });
    },
    async issueAction(command: SlackActionIssue) {
      return issueActionWith(input.pool, command);
    },

    async receiveEvents(routeIdentity: string, request: RawRequest): Promise<HttpResult> {
      try {
        const resolved = await resolveRoute(routeIdentity);
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
          sourceContent: input.custody, clock: input.clock,
          prepareSourceContext: (event) => prepareSourceContext(event, resolved.installation) });
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
          return { status: 200, body: { ok: true, ignored: true } };
        }
        return bound.receiveNormalized(normalized, request.rawBody);
      } catch (error) { return verificationFailure(error); }
    },

    async receiveInteractivity(routeIdentity: string, request: RawRequest): Promise<HttpResult> {
      const commandAuthority = input.commandAuthority;
      if (!commandAuthority) return { status: 503, body: { error: "slack_command_authority_unavailable" } };
      try {
        const resolved = await resolveRoute(routeIdentity);
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
          || !/^opentag:decision:(status|cancel|allow_once|allow_run|deny|publication_approve|bind|unbind)$/u.test(action.action_id)) {
          return { status: 400, body: { error: "invalid_slack_action" } };
        }
        const claimed = await withPostgresTransaction(input.pool, async (client) => {
          const rows = await client.query<ActionRow>(`SELECT * FROM cp_slack_action_authority
            WHERE action_token_hash = $1`, [hashBytes(token)]);
          let row = rows.rows[0];
          if (!row || row.consumed_at || row.expires_at <= input.clock.now()) {
            return { status: 403, body: { error: "slack_action_not_authorized" } };
          }
          const lockedFamily = await client.query<ActionRow>(`SELECT * FROM cp_slack_action_authority
            WHERE organization_id=$1 AND authority_family_id=$2 ORDER BY action_id FOR UPDATE`,
          [row.organization_id,row.authority_family_id]);
          row = lockedFamily.rows.find((member) => member.action_token_hash === hashBytes(token))!;
          if (!row || row.consumed_at || lockedFamily.rows.some((member) =>
            (member.claim_state === "consumed" && member.action_kind !== "status")
            || (member.claim_state === "claimed" && member.action_id !== row.action_id))) {
            return { status: 403, body: { error: "slack_action_not_authorized" } };
          }
          const currentAuthority = await client.query<{ current_attempt_number: number;
            attempt_id: string; attempt_number: number; fencing_token_digest: string }>(
            `SELECT run.current_attempt_number,attempt.attempt_id,attempt.attempt_number,
               attempt.fencing_token_digest FROM cp_hosted_run run
             JOIN cp_hosted_attempt attempt ON attempt.organization_id=run.organization_id
               AND attempt.run_id=run.run_id AND attempt.attempt_number=run.current_attempt_number
             WHERE run.organization_id=$1 AND run.run_id=$2`,
            [row.organization_id, row.run_id]);
          const currentTuple = currentAuthority.rows[0];
          if (!currentTuple || row.projection_generation !== currentTuple.current_attempt_number
            || row.attempt_number !== currentTuple.attempt_number
            || row.attempt_id !== currentTuple.attempt_id
            || row.fencing_token_digest !== currentTuple.fencing_token_digest) {
            return { status: 403, body: { error: "slack_action_authority_stale" } };
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
          if (decision === "publication_approve"
            && row.action_kind === "publication" && actorId === row.approver_user_id) {
            if (!row.publication_approval) return { status: 403,
              body: { error: "slack_action_authority_stale" } };
            if (row.claim_state === "available") await client.query(`UPDATE cp_slack_action_authority
              SET claim_state='claimed',claimed_at=$3 WHERE organization_id=$1 AND action_id=$2`,
            [row.organization_id,row.action_id,input.clock.now()]);
            return { kind: "claimed" as const, row, decision, actorId,
              publicationApproval: HumanPublicationApprovalV1Schema.parse(row.publication_approval) };
          }
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
            allowedDecisions: row.allowed_decisions.filter((value) => value !== "publication_approve") as
              Array<"status" | "cancel" | "allow_once" | "allow_run" | "deny" | "bind" | "unbind"> };
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
          if (row.claim_state === "available") await client.query(`UPDATE cp_slack_action_authority
            SET claim_state='claimed',claimed_at=$3 WHERE organization_id=$1 AND action_id=$2`,
          [row.organization_id,row.action_id,input.clock.now()]);
          return { kind: "claimed" as const, row, command, sourceApp: resolved.sourceApp };
        });
        if (!("kind" in claimed) || claimed.kind !== "claimed") return claimed;
        let completed = false;
        if ("publicationApproval" in claimed) {
          if (input.publicationAuthority) {
            const result = await input.publicationAuthority.approve({ ...claimed.publicationApproval,
              approverId: claimed.actorId!, approvedAt: input.clock.now().toISOString() });
            completed = result.kind === "approved" || result.kind === "replayed";
          }
        } else {
          const result = await executeSourceThreadCommand({ adapter: claimed.sourceApp,
            authority: commandAuthority, command: claimed.command });
          completed = result.outcome === "completed";
        }
        if (!completed) return { status: 403, body: { error: "source_thread_control_rejected" } };
        await input.testHooks?.afterServiceBeforeFinalize?.();
        const terminalDecision = "publicationApproval" in claimed
          || (!("publicationApproval" in claimed) && claimed.command.type !== "status");
        await input.pool.query(`UPDATE cp_slack_action_authority SET claim_state='consumed',
          consumed_at=COALESCE(consumed_at,$3) WHERE organization_id=$1
          AND ${terminalDecision ? "authority_family_id=$2" : "action_id=$2"}`,
        [claimed.row.organization_id,
          terminalDecision ? claimed.row.authority_family_id : claimed.row.action_id,input.clock.now()]);
        return { status: 200, body: { ok: true } };
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
    projectTargetId: null, publicationMode: "proposal_only",
    routeIdentity: "test-route",
    teamId: "test", appId: "test", channelId: "test", botUserId: "test",
    memberUserIds: ["test"], operatorUserIds: ["test"], approverUserId: "test",
    adminUserIds: ["test"],
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
