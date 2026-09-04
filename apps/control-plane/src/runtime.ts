import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Pool } from "pg";
import { createControlPlaneApplication } from "./application.js";
import type { ControlPlaneConfig } from "./config.js";
import {
  checkMigrationReadiness,
  checkSourceContentSchemaReadiness,
  checkSourceIngressSchemaReadiness,
  checkSlackIngressSchemaReadiness,
  checkProjectionSchemaReadiness,
  type SqlMigration,
} from "./database/migrations.js";
import {
  checkPostgresReadiness,
  createPostgresRuntime,
} from "./database/postgres.js";
import { createHostedRunCoordinator } from "./modules/hosted-runs/index.js";
import { createPermissionCoordinator } from "./modules/hosted-runs/permissions.js";
import { createMaterialActionCoordinator } from "./modules/hosted-runs/material-actions.js";
import { createPublicationPublisher } from "./modules/publication-candidates/publisher.js";
import { createConsoleReadModel } from "./modules/console-reads/index.js";
import {
  createIdentityModule,
  createLoginThrottleKeyFactory,
} from "./modules/identity/index.js";
import {
  createDurableJobQueue,
  scheduleControlPlaneMaintenance,
} from "./modules/jobs/index.js";
import { createGithubIngress } from "./modules/github-ingress/index.js";
import { createRunnerDirectory } from "./modules/runners/index.js";
import {
  createRelayContentCustody,
  type SourceContentInvalidationAuthority,
} from "./modules/source-content/index.js";
import { loadRelayContentKey } from "./modules/source-content/crypto.js";
import { createSourceContentJobHandlers } from "./modules/source-content/worker.js";
import { createSourceIngressService } from "./modules/source-ingress/index.js";
import { createPostgresSlackIngress, type SlackSecretResolver } from "./modules/slack-ingress/index.js";
import { createPostgresDeliveryRepository } from "./modules/provider-delivery/repository.js";
import { createProviderDeliveryWorker } from "./modules/provider-delivery/worker.js";
import { createTeamRelayProjectionJobHandler,
  createTeamRelayProjectionService } from "./modules/provider-delivery/team-relay-projection.js";
import { createControlPlaneSourceThreadAuthority } from "./modules/slack-ingress/authority.js";
import { SourceAppRegistry, type SourceThreadCommandAuthorityPorts } from "@opentag/source-app-runtime";
import { ProviderAdapterRegistry, ProviderSideEffectKernel,
  UnifiedDeliveryProducer } from "@opentag/delivery-runtime";
import { DeliveryIntentV2Schema, deliveryCurrentTruthDescriptor,
  type DeliveryIntentV2, type DeliveryPayloadEnvelope } from "@opentag/delivery-contract";
import {
  createSourceIngressWorker,
  type SourceResolutionPort,
} from "./modules/source-ingress/worker.js";
import { z } from "zod";
import {
  AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  computeHostedAdmissionEnvelopeDigestV1,
  computeSlackAppMentionSourceIdentityDigestV1,
  HostedAdmissionEnvelopeV1Schema,
  RunnerReadinessReceiptEnvelopeV1Schema,
} from "@opentag/control-protocol";
import { composeTeamRelayThreadProjection, OpenTagEventSchema } from "@opentag/core";
import { createSlackTeamRelayProjectionBlocks,
  renderSlackTeamRelayProjection } from "@opentag/slack";

const BASE_CAPABILITIES = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.material-receipt.v1",
  "relay.publication.v1",
  "relay.permission.v1",
  "relay.readiness.v1",
  "relay.registration.v1",
  "relay.source-content-redeem.v1",
] as const;

const HOSTED_ADMISSION_CAPABILITIES = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1",
  "relay.source-content-redeem.v1",
] as const;

type PostgresCapability = {
  pool: Pool;
  close(): Promise<void>;
};

function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretsEqual(left: string, right: string): boolean {
  return timingSafeEqual(secretDigest(left), secretDigest(right));
}

function randomIdentifier(
  kind:
    | "api_key"
    | "attempt"
    | "credential"
    | "operator"
    | "permission_receipt"
    | "permission_resolution"
    | "session",
): string {
  return `${kind}_${randomBytes(16).toString("hex")}`;
}

function runtimeSecret(
  prefix: "api_key" | "job_lease" | "runtime" | "session",
): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function createControlPlaneRuntime(input: {
  config: ControlPlaneConfig;
  migrations: readonly SqlMigration[];
  postgres?: PostgresCapability;
  sourceContentInvalidationAuthority?: SourceContentInvalidationAuthority;
  sourceResolutionPort?: SourceResolutionPort;
  slackSecrets?: SlackSecretResolver;
  slackCommandAuthority?: SourceThreadCommandAuthorityPorts;
  slackFetchImpl?: typeof fetch;
}) {
  const postgres = input.postgres ?? createPostgresRuntime({
    databaseUrl: input.config.databaseUrl,
    poolMax: input.config.poolMax,
  });
  const clock = { now: () => new Date() };
  const runners = createRunnerDirectory({
    pool: postgres.pool,
    clock,
    idFactory: () => randomIdentifier("credential"),
    tokenFactory: () => runtimeSecret("runtime"),
  });
  let sourceContent: ReturnType<typeof createRelayContentCustody> | null = null;
  const hosted = createHostedRunCoordinator({
    pool: postgres.pool,
    clock,
    leaseDurationMs: 60_000,
    idFactory: () => randomIdentifier("attempt"),
    tokenFactory: (context) => `fence_${createHmac(
      "sha256",
      input.config.fencingTokenSecret,
    ).update(JSON.stringify([
      "opentag.control.fencing-token/v1",
      context.organizationId,
      context.operationId,
      context.runId,
      context.attemptId,
      context.attemptNumber,
    ])).digest("base64url")}`,
    issueSourceContentGrantInTransaction: (client, command) => {
      if (!sourceContent) throw new Error("source_content_unavailable");
      return sourceContent.issueReadGrantInTransaction(client, command);
    },
  });
  const identity = createIdentityModule({
    pool: postgres.pool,
    clock,
    idFactory: (kind) => randomIdentifier(kind),
    opaqueBearerFactory: (kind) => runtimeSecret(kind),
    sessionDurationMs: 8 * 60 * 60 * 1_000,
    throttleKeyFactory: createLoginThrottleKeyFactory(
      input.config.loginRateLimit.secret,
    ),
    loginRateLimit: input.config.loginRateLimit,
  });
  let slack: ReturnType<typeof createPostgresSlackIngress> | null = null;
  const permissions = createPermissionCoordinator({
    pool: postgres.pool,
    clock,
    idFactory: (kind) => randomIdentifier(kind),
    issueWaitingAuthorityInTransaction: async (client, command) => {
      await slack?.issuePermissionActionInTransaction(client, command);
    },
  });
  const materials = createMaterialActionCoordinator({
    pool: postgres.pool,
    clock,
  });
  const publisher = createPublicationPublisher({
    pool: postgres.pool,
    clock,
    idFactory: (kind) => `publication_${kind}_${randomBytes(16).toString("hex")}`,
    issuePublicationAuthorityInTransaction: async (client, command) => {
      await slack?.issuePublicationActionInTransaction(client, command);
    },
  });
  const reads = createConsoleReadModel({ pool: postgres.pool });
  const slackCommandAuthority = input.slackCommandAuthority
    ?? createControlPlaneSourceThreadAuthority({ hosted, permissions, clock });
  const jobs = createDurableJobQueue({
    pool: postgres.pool,
    clock,
    leaseDurationMs: input.config.jobLeaseDurationMs,
    tokenFactory: () => runtimeSecret("job_lease"),
  });
  const sourceApps = new SourceAppRegistry();
  const deliveryRuntimeOwner = { runtimeOwnerId: "control-plane", runtimeGeneration: 1,
    schemaGeneration: 1 } as const;
  const providerDeliveryRepository = createPostgresDeliveryRepository({
    pool: postgres.pool,
    owner: deliveryRuntimeOwner,
    leaseOwner: `control-plane-${process.pid}`,
    leaseSeconds: Math.min(86_400,
      Math.max(1, Math.ceil(input.config.jobLeaseDurationMs / 1_000))),
  });
  let sourceContentKey: ReturnType<typeof loadRelayContentKey> | null = null;
  if (input.config.relayContentKey) {
    try {
      sourceContentKey = loadRelayContentKey(input.config.relayContentKey);
    } catch {
      sourceContentKey = null;
    }
  }
  sourceContent = sourceContentKey
    ? createRelayContentCustody({
        pool: postgres.pool,
        clock,
        key: sourceContentKey,
        invalidationAuthority: input.sourceContentInvalidationAuthority ?? hosted,
      })
    : null;
  const sourceIngress = sourceContent
    ? createSourceIngressService({
        pool: postgres.pool,
        clock,
        custody: sourceContent,
        jobs,
      })
    : null;
  const sourceResolutionPort = input.sourceResolutionPort ?? {
    async resolve(command) {
      const contextResult = z.object({
        executionBearingCommentBody: z.string().min(1),
        event: OpenTagEventSchema,
      }).strict().safeParse(command.sourceContext);
      if (!contextResult.success) {
        return { kind: "invalid_request", code: "source_context_invalid" } as const;
      }
      const context = contextResult.data;
      const event = context.event;
      const metadata = event.metadata;
      const installationResult = await postgres.pool.query<{
        installation_id: string; binding_id: string; project_target_id: string | null;
        publication_mode: "proposal_only" | "pull_request"; team_id: string; app_id: string;
        channel_id: string; bot_user_id: string; member_user_ids: string[];
        app_instance_id: string; source_binding_digest: string;
        credential_generation: number; credential_generation_digest: string;
        runner_id: string | null; target_binding_digest: string | null;
        repository_provider: string | null; owner: string | null; repo: string | null;
        default_executor: string | null; default_branch: string | null; target_version: number | null;
      }>(`SELECT slack.installation_id,slack.binding_id,slack.project_target_id,
          slack.publication_mode,slack.team_id,slack.app_id,slack.channel_id,
          slack.bot_user_id,slack.member_user_ids,installation.app_instance_id,
          installation.binding_digest AS source_binding_digest,
          installation.credential_generation,installation.credential_generation_digest,
          target.runner_id,target.binding_digest AS target_binding_digest,
          target.provider AS repository_provider,target.owner,target.repo,
          target.default_executor,target.default_branch,target.version AS target_version
        FROM cp_slack_installation slack
        JOIN cp_source_app_installation installation
          ON installation.organization_id=slack.organization_id
         AND installation.installation_id=slack.installation_id
        JOIN cp_source_binding binding
          ON binding.organization_id=slack.organization_id
         AND binding.binding_id=slack.binding_id
         AND binding.installation_id=slack.installation_id
        LEFT JOIN cp_project_target target
          ON target.organization_id=slack.organization_id
         AND target.project_target_id=slack.project_target_id
        WHERE slack.organization_id=$1 AND slack.installation_id=$2
          AND slack.binding_id=$3 AND installation.source_app_id='slack'
          AND installation.state='active' AND binding.state='active'
          AND binding.binding_digest=installation.binding_digest`,
      [command.reservation.organizationId, command.reservation.installationId,
        command.reservation.bindingId]);
      const installation = installationResult.rows[0];
      if (!installation || !installation.project_target_id || !installation.runner_id
        || !installation.target_binding_digest || !installation.repository_provider
        || !installation.owner || !installation.repo || !installation.default_executor
        || !installation.target_version) {
        return { kind: "setup_required", code: "slack_project_target_missing" } as const;
      }
      const teamId = typeof metadata["teamId"] === "string" ? metadata["teamId"] : null;
      const channelId = typeof metadata["channelId"] === "string" ? metadata["channelId"] : null;
      const messageId = typeof metadata["messageTs"] === "string" ? metadata["messageTs"] : null;
      const sourceDeliveryId = typeof metadata["sourceDeliveryId"] === "string"
        ? metadata["sourceDeliveryId"] : null;
      const threadKey = event.callback?.provider === "slack" ? event.callback.threadKey : null;
      const threadParts = threadKey?.split("|") ?? [];
      const threadTs = threadParts.length === 3 ? threadParts[2] : null;
      if (event.source !== "slack" || event.actor.provider !== "slack"
        || !installation.member_user_ids.includes(event.actor.providerUserId)
        || teamId !== installation.team_id || channelId !== installation.channel_id
        || sourceDeliveryId !== command.reservation.sourceDeliveryId
        || messageId !== command.reservation.sourceMessageId
        || threadParts[0] !== installation.team_id || threadParts[1] !== installation.channel_id
        || !threadTs || event.command.rawText !== context.executionBearingCommentBody
        || metadata["repoProvider"] !== installation.repository_provider
        || metadata["owner"] !== installation.owner || metadata["repo"] !== installation.repo) {
        return { kind: "invalid_request", code: "source_context_identity_mismatch" } as const;
      }
      const readinessResult = await postgres.pool.query<{ receipt: unknown; receipt_digest: string }>(
        `SELECT receipt,receipt_digest FROM cp_runner_readiness
         WHERE organization_id=$1 AND runner_id=$2 AND expires_at>$3
         ORDER BY observed_at DESC LIMIT 1`,
        [command.reservation.organizationId, installation.runner_id, clock.now()]);
      const readinessRow = readinessResult.rows[0];
      const readiness = readinessRow
        ? RunnerReadinessReceiptEnvelopeV1Schema.safeParse(readinessRow.receipt) : null;
      const readyTarget = readiness?.success ? readiness.data.payload.targets.find((candidate) =>
        candidate.projectTargetId === installation.project_target_id
          && candidate.bindingDigest === installation.target_binding_digest
          && candidate.state === "ready") : null;
      const readyExecutor = readiness?.success ? readiness.data.payload.executors.find((candidate) =>
        candidate.executorId === installation.default_executor && candidate.state === "ready") : null;
      if (!readiness?.success || readiness.data.receiptDigest !== readinessRow?.receipt_digest
        || !readyTarget || !readyExecutor) {
        return { kind: "temporarily_unavailable", code: "runner_not_ready" } as const;
      }
      const repository = { provider: installation.repository_provider,
        providerRepositoryId: installation.project_target_id,
        owner: installation.owner, repo: installation.repo };
      const sourceThread = { kind: "channel_thread" as const, providerThreadId: threadKey!,
        channelId: installation.channel_id, threadTs };
      const sourceEvent = { providerEventId: event.sourceEventId,
        kind: "app_mention" as const, messageId };
      const actor = { providerUserId: event.actor.providerUserId,
        login: event.actor.handle ?? event.actor.providerUserId };
      const sourceIdentityDigest = await computeSlackAppMentionSourceIdentityDigestV1({
        provider: "slack", repository, sourceThread, sourceEvent, actor,
        executionBearingMessageBody: context.executionBearingCommentBody,
      });
      const identitySuffix = sourceIdentityDigest.slice("sha256:".length, 38);
      const runId = `run_${identitySuffix}`;
      const operationId = `operation_admit_${identitySuffix}`;
      const snapshotId = `policy_${identitySuffix}`;
      const receivedAt = event.receivedAt;
      const queueClaimDeadline = new Date(Date.parse(receivedAt) + 8 * 60 * 60 * 1_000).toISOString();
      const authorizationRef = `slack_${installation.binding_id}_${actor.providerUserId}`;
      const policyPayload = {
        snapshotId, capturedAt: receivedAt,
        tenant: { organizationId: command.reservation.organizationId },
        actor: { provider: "slack", ...actor, authorizationRef },
        target: { projectTargetId: installation.project_target_id,
          bindingId: installation.binding_id,
          repositoryProvider: installation.repository_provider,
          providerRepositoryId: installation.project_target_id,
          defaultBranch: installation.default_branch ?? "main",
          authorizedPublicationModes: installation.publication_mode === "pull_request"
            ? ["proposal_only", "pull_request"] as const : ["proposal_only"] as const },
        runner: { runnerId: installation.runner_id,
          readinessReceiptDigest: readiness.data.receiptDigest },
        executor: { executorId: installation.default_executor,
          capabilityDigest: readyExecutor.capabilityDigest },
        requiredRelayCapabilities: HOSTED_ADMISSION_CAPABILITIES,
        admissionRules: { profile: "slack-app-mention/v1",
          requiredCheckNames: [] as string[], mergeRequired: false,
          humanApprovalRequiredFor: installation.publication_mode === "pull_request"
            ? ["publication"] : [] },
      };
      const policySeed = {
        schemaVersion: 1 as const, protocolVersion: "1.0" as const,
        receiptId: `policy_receipt_${identitySuffix}`,
        organizationId: command.reservation.organizationId, operationId,
        requiredCapabilities: [...HOSTED_ADMISSION_CAPABILITIES],
        producer: { kind: "cloud" as const, id: "control_plane" },
        identity: { namespace: "opentag.control.receipt/admission-policy-snapshot/v1" as const,
          parts: [command.reservation.organizationId, runId, snapshotId] },
        observedAt: receivedAt,
        payloadDigest: await computeControlPayloadDigestV1(policyPayload),
        receiptDigest: `sha256:${"0".repeat(64)}`,
        receiptKind: "admission_policy_snapshot" as const, runId, payload: policyPayload,
      };
      const { receiptDigest: _policyDigest, ...policyDigestInput } = policySeed;
      const policy = AdmissionPolicySnapshotReceiptEnvelopeV1Schema.parse({ ...policySeed,
        receiptDigest: await computeControlReceiptDigestV1(policyDigestInput) });
      const contentEnvelopeRef = command.reservation.contentRef;
      const sourceContextEnvelope = { ...contentEnvelopeRef,
        envelopeDigest: await computeControlPayloadDigestV1(contentEnvelopeRef) };
      const permissionDescriptors: Array<"workspace.write"> = ["workspace.write"];
      const publicationMode = installation.publication_mode;
      const admissionSeed = {
        kind: "hosted_admission" as const, schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        requiredCapabilities: ["relay.hosted-admission.v1"] as ["relay.hosted-admission.v1"],
        admissionId: `admission_${identitySuffix}`, operationId,
        organizationId: command.reservation.organizationId,
        bindingId: installation.binding_id,
        bindingSecretVersion: String(installation.credential_generation),
        provider: "slack" as const, deliveryId: command.reservation.sourceDeliveryId,
        deliveryPayloadDigest: command.reservation.rawDigest, sourceIdentityDigest,
        eventName: "app_mention" as const, action: "created" as const,
        repository, sourceThread, sourceEvent,
        verifiedActor: { ...actor, authorization: { decision: "allowed" as const,
          grantRef: authorizationRef, grantVersion: 1,
          grantDigest: await computeControlPayloadDigestV1({ authorizationRef,
            actorId: actor.providerUserId, bindingId: installation.binding_id }) } },
        projectTarget: { projectTargetId: installation.project_target_id,
          version: installation.target_version, digest: installation.target_binding_digest },
        runnerId: installation.runner_id, sourceContextEnvelope, queueClaimDeadline,
        permissionCeiling: { allowedActionDescriptors: permissionDescriptors,
          digest: await computeControlPayloadDigestV1(permissionDescriptors) },
        publicationPolicy: { mode: publicationMode,
          digest: await computeControlPayloadDigestV1({ bindingId: installation.binding_id,
            mode: publicationMode }) },
        completionContract: { mode: publicationMode === "proposal_only"
          ? "proposal_ready" as const : "pull_request_ready" as const,
          digest: await computeControlPayloadDigestV1({ bindingId: installation.binding_id,
            mode: publicationMode === "proposal_only" ? "proposal_ready" : "pull_request_ready" }) },
        admissionPolicySnapshot: { snapshotId, digest: policy.receiptDigest },
        receivedAt, envelopeDigest: `sha256:${"0".repeat(64)}`,
      };
      const admission = HostedAdmissionEnvelopeV1Schema.parse({ ...admissionSeed,
        envelopeDigest: await computeHostedAdmissionEnvelopeDigestV1(admissionSeed) });
      const requestDigest = await computeControlPayloadDigestV1({
        idempotencyKey: command.idempotencyKey, runId,
        admissionDigest: admission.envelopeDigest, policyDigest: policy.receiptDigest,
      });
      await postgres.pool.query(
        `INSERT INTO cp_source_resolution_admission(idempotency_key, organization_id,
           request_digest, run_id, state, resolution, created_at)
         VALUES($1,$2,$3,$4,'pending',NULL,$5) ON CONFLICT (idempotency_key) DO NOTHING`,
        [command.idempotencyKey, admission.organizationId,
          requestDigest, runId, clock.now()],
      );
      const durable = await postgres.pool.query<{ request_digest: string;
        run_id: string; state: "pending" | "decided"; resolution: {
          kind: "accepted" | "waiting_for_runner"; runId: string } | null }>(
        `SELECT request_digest, run_id, state, resolution FROM cp_source_resolution_admission
         WHERE idempotency_key = $1`, [command.idempotencyKey],
      );
      const stored = durable.rows[0];
      if (!stored || stored.request_digest !== requestDigest || stored.run_id !== runId) {
        return { kind: "invalid_request", code: "source_resolution_idempotency_conflict" } as const;
      }
      const admitted = await hosted.admit({ runId, admission, policy });
      if (admitted.kind === "conflict") {
        return { kind: "invalid_request", code: admitted.reason } as const;
      }
      const projectionRevision = (await postgres.pool.query<{ projection_revision: number }>(
        "SELECT projection_revision FROM cp_hosted_run WHERE organization_id=$1 AND run_id=$2",
        [admission.organizationId, runId])).rows[0]?.projection_revision;
      if (!projectionRevision) {
        return { kind: "temporarily_unavailable", code: "projection_authority_missing" } as const;
      }
      const projectableStates = ["waiting_for_runner", "assigned", "running",
        "waiting_for_approval", "publication_pending", "proposal_ready", "ready_for_review",
        "failed", "cancelled", "interrupted", "timed_out"] as const;
      const projectionState = projectableStates.find((state) => state === admitted.view.status)
        ?? "waiting_for_runner";
      const presentation = composeTeamRelayThreadProjection({ runId, generation: 1,
        state: projectionState, controls: [], providerDelivery: { state: "pending" } });
      const text = renderSlackTeamRelayProjection(presentation);
      const blocks = createSlackTeamRelayProjectionBlocks(presentation);
      const providerBinding = { bindingKind: "established" as const,
        providerId: "slack", providerInstanceId: installation.app_instance_id,
        providerPrincipalDigest: `sha256:${createHash("sha256")
          .update(installation.bot_user_id).digest("hex")}`,
        principalAssurance: "provider_verified" as const,
        providerConfigGeneration: installation.credential_generation,
        providerConfigGenerationDigest: installation.credential_generation_digest,
        lifecycle: "active" as const, bindingDigest: installation.source_binding_digest };
      const intent = DeliveryIntentV2Schema.parse({ contractVersion: 2,
        organizationId: admission.organizationId,
        sideEffectIntentId: `intent_anchor_${identitySuffix}`, causalId: runId,
        intentKind: "delivery", operation: "create", deliveryKind: "message",
        presentationDigest: await computeControlPayloadDigestV1({ text, blocks }),
        provenance: { kind: "business", runId,
          repositoryIdentityDigest: await computeControlPayloadDigestV1(repository),
          authorityLineageDigest: admission.envelopeDigest },
        providerBinding,
        targetDigest: await computeControlPayloadDigestV1({ teamId: installation.team_id,
          channelId: installation.channel_id, threadTs }),
        authorityKind: "hosted_send_authority", authoritySnapshotDigest: policy.receiptDigest,
        evidencePolicy: "hosted_control", idempotencyKey: `anchor_${identitySuffix}`,
        scope: { kind: "hosted_control", id: runId }, statusMessageId: `slack:${runId}`,
        projectionRevision, projectionEventSequence: 0, projectionPurpose: "anchor_create",
        createdAt: receivedAt, initialAttemptSequence: 1,
      });
      const currentTruth = deliveryCurrentTruthDescriptor({ intent, owner: {
        organizationId: intent.organizationId, providerId: "slack",
        providerInstanceId: providerBinding.providerInstanceId,
        providerBindingDigest: providerBinding.bindingDigest,
        providerConfigGeneration: providerBinding.providerConfigGeneration,
        providerConfigGenerationDigest: providerBinding.providerConfigGenerationDigest,
        ...deliveryRuntimeOwner } });
      await providerDeliveryRepository.recordIntent(intent, { envelopeVersion: 1,
        providerRequest: { operation: { kind: "create_message",
          channelId: installation.channel_id, threadTs },
          presentation: { kind: "message", text, textFormat: "mrkdwn", blocks } },
        phase: "received", frozenDeadline: queueClaimDeadline, currentTruth });
      const deliveryJob = await jobs.enqueue({ jobId: `provider-delivery:${intent.sideEffectIntentId}`,
        organizationId: null, kind: "provider-delivery", payload: {}, maxAttempts: 1 });
      if (deliveryJob.kind === "conflict") {
        return { kind: "temporarily_unavailable", code: "provider_delivery_job_conflict" } as const;
      }
      const resolution = admitted.view.status === "waiting_for_runner"
        ? { kind: "waiting_for_runner", runId: admitted.runId } as const
        : { kind: "accepted", runId: admitted.runId } as const;
      await postgres.pool.query(
        `UPDATE cp_source_resolution_admission SET state = 'decided', resolution = $2::jsonb
         WHERE idempotency_key = $1 AND request_digest = $3 AND run_id = $4`,
        [command.idempotencyKey, JSON.stringify(resolution), requestDigest, runId],
      );
      return resolution;
    },
  } satisfies SourceResolutionPort;
  const sourceIngressWorker = sourceIngress
    ? createSourceIngressWorker({
        ingress: sourceIngress,
        queue: jobs,
        resolver: sourceResolutionPort,
        workerId: `source_ingress_${process.pid}`,
        retryDelayMs: input.config.jobRetryDelayMs,
        clock,
      })
    : null;
  const scheduleJobs = () => scheduleControlPlaneMaintenance({
    queue: jobs,
    clock,
    includeSourceContentPurge: Boolean(sourceContent),
  });
  const github = input.config.githubIngressMasterSecret && sourceContent
    ? createGithubIngress({
        pool: postgres.pool,
        hosted,
        clock,
        masterSecret: input.config.githubIngressMasterSecret,
        sourceContent,
      })
    : null;
  slack = sourceContent && input.slackSecrets
    ? createPostgresSlackIngress({ pool: postgres.pool, clock, custody: sourceContent,
        jobs, secrets: input.slackSecrets, sourceApps, commandAuthority: slackCommandAuthority,
        publicationAuthority: { approve: (command) => publisher.approve(command) },
        ...(input.slackFetchImpl ? { fetchImpl: input.slackFetchImpl } : {}) })
    : null;
  const providerDeliveryKernel = new ProviderSideEffectKernel<object>({
    repository: providerDeliveryRepository,
    registry: new ProviderAdapterRegistry<object>(sourceApps),
    prepareRequest(intent, stored) {
      const payload = stored as DeliveryPayloadEnvelope<object>;
      return { request: payload.providerRequest, operation: intent.operation,
        presentationDigest: intent.presentationDigest, targetDigest: intent.targetDigest };
    },
  });
  const providerDeliveryProducer = new UnifiedDeliveryProducer<{
    intent: DeliveryIntentV2; providerRequest: object;
    phase: DeliveryPayloadEnvelope["phase"]; frozenDeadline: string;
  }>({ submitter: providerDeliveryKernel, async resolveIntent(presentation) {
    const intent = presentation.intent; const binding = intent.providerBinding;
    const persistedPayload: DeliveryPayloadEnvelope<object> = { envelopeVersion: 1,
      providerRequest: presentation.providerRequest, phase: presentation.phase,
      frozenDeadline: presentation.frozenDeadline,
      currentTruth: deliveryCurrentTruthDescriptor({ intent, owner: {
        organizationId: intent.organizationId, providerId: binding.providerId,
        providerInstanceId: binding.providerInstanceId,
        providerBindingDigest: binding.bindingDigest,
        providerConfigGeneration: binding.providerConfigGeneration,
        providerConfigGenerationDigest: binding.providerConfigGenerationDigest,
        ...deliveryRuntimeOwner } }) };
    return { intent, persistedPayload };
  } });
  const teamRelayProjection = createTeamRelayProjectionService({ pool: postgres.pool,
    hosted, producer: providerDeliveryProducer, clock,deliveryOwner:deliveryRuntimeOwner,
    ...(slack ? { controls: slack } : {}) });
  const providerDeliveryWorker = createProviderDeliveryWorker({ kernel: providerDeliveryKernel,
    preloadSourceApps: async () => {
      const preload = await slack?.preloadSourceApps();
      return { registered: sourceApps.deliveryAuthorities().length,
        healthy: sourceApps.deliveryAuthorities(), failures: preload?.failures ?? [] };
    }, clock });
  const jobHandlers = {
    "hosted-attempt-reconciliation": async (job: { organizationId: string | null }) => {
      const queued = await hosted.expireQueued(job.organizationId);
      const attempts = await hosted.reconcileExpiredAttempts(job.organizationId);
      return { expiredQueued: queued.expired, expiredAttempts: attempts.expired };
    },
    "runner-readiness-retention": async (job: { organizationId: string | null }) =>
      runners.pruneExpiredReadiness(job.organizationId),
    "provider-delivery": async () => {
      let delivered = 0;
      for (; delivered < 100; delivered += 1) {
        const result = await providerDeliveryWorker.processNext();
        if (result.kind !== "delivered") return { kind: "drained", delivered, terminal: result };
      }
      return { kind: "bounded", delivered };
    },
    "team-relay.project.v2": createTeamRelayProjectionJobHandler(teamRelayProjection),
    ...(sourceContent ? createSourceContentJobHandlers(sourceContent) : {}),
  };
  const application = createControlPlaneApplication({
    capabilities: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      registryVersion: "opentag.control.capabilities/v1",
      capabilities: [
        ...BASE_CAPABILITIES,
        ...(input.config.recoveryPairingToken
          ? ["relay.credential-reprovision.v1" as const]
          : []),
      ].sort(),
      minimumClient: { schemaVersion: 1, protocolVersion: "1.0" },
      deployment: {
        environment: input.config.environment,
        releaseSha: input.config.releaseSha,
      },
      artifact: {
        packageName: "@opentag/control-plane",
        packageVersion: "0.0.0",
      },
    },
    readiness: {
      async check() {
        const database = await checkPostgresReadiness(postgres.pool);
        if (!database.ready) return database;
        const migrations = await checkMigrationReadiness(postgres.pool, input.migrations);
        if (!migrations.ready) return migrations;
        const projectionSchema = await checkProjectionSchemaReadiness(postgres.pool);
        if (!projectionSchema.ready) return projectionSchema;
        // Hand-constructed legacy test configs omit the property. Parsed runtime
        // configs always carry null or an explicit reference and therefore fail
        // closed when relay content custody has no usable operator key.
        if (input.config.relayContentKey !== undefined) {
          if (!sourceContent) return { ready: false, reason: "configuration_invalid" };
          const sourceSchema = await checkSourceContentSchemaReadiness(postgres.pool);
          if (!sourceSchema.ready) return sourceSchema;
          const ingressSchema = await checkSourceIngressSchemaReadiness(postgres.pool);
          if (!ingressSchema.ready) return ingressSchema;
          if (input.slackSecrets) {
            const slackSchema = await checkSlackIngressSchemaReadiness(postgres.pool);
            if (!slackSchema.ready) return slackSchema;
            const configured = await postgres.pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM cp_slack_installation");
            if ((configured.rows[0]?.count ?? 0) > 0 && !slack) {
              return { ready: false, reason: "configuration_invalid" };
            }
            if (slack) {
              const slackReady = await slack.checkReadiness();
              if (!slackReady.ready) return slackReady;
            }
          }
          return sourceContent.checkReadiness();
        }
        return { ready: true };
      },
    },
    control: {
      bootstrap: {
        authenticate(token) {
          if (!secretsEqual(token, input.config.bootstrapPairingToken)) {
            return null;
          }
          return {
            organizationId: input.config.bootstrapOrganizationId,
            organizationName: input.config.bootstrapOrganizationName,
          };
        },
      },
      ...(input.config.recoveryPairingToken
        ? {
            recovery: {
              authenticate(token: string) {
                if (!secretsEqual(token, input.config.recoveryPairingToken!)) {
                  return null;
                }
                return {
                  organizationId: input.config.bootstrapOrganizationId,
                };
              },
            },
          }
        : {}),
      runners,
      hosted,
      materials,
      publisher,
      permissions,
      approver: {
        async authenticate(token) {
          const outcome = await identity.authenticateApiKey(token);
          if (outcome.kind !== "authenticated") return outcome;
          if (!outcome.principal.scopes.includes("permission:resolve")
            && !outcome.principal.scopes.includes("publication:approve")) {
            return { kind: "insufficient_scope" as const };
          }
          return {
            kind: "authenticated" as const,
            principal: {
              organizationId: outcome.principal.organizationId,
              actorId: outcome.principal.apiKeyId,
              scopes: outcome.principal.scopes,
            },
          };
        },
      },
      ...(sourceContent ? { sourceContent } : {}),
      ...(sourceIngress ? { sourceIngress } : {}),
    },
    console: {
      identity,
      reads,
      publicOrigin: input.config.publicOrigin,
      loginNetworkMode: input.config.loginRateLimit.networkMode,
      targets: runners,
    },
    ...(github ? { github } : {}),
    ...(slack ? { slack } : {}),
  });

  return {
    application,
    hosted,
    github,
    identity,
    jobHandlers,
    jobs,
    scheduleJobs,
    materials,
    permissions,
    publisher,
    providerDeliveryKernel,
    providerDeliveryProducer,
    providerDeliveryRepository,
    providerDeliveryWorker,
    teamRelayProjection,
    reads,
    runners,
    sourceContent,
    sourceIngress,
    sourceResolutionPort,
    sourceIngressWorker,
    sourceApps,
    slack,
    close: () => postgres.close(),
  };
}
