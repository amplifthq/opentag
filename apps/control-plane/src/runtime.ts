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
import { createTeamRelayProjectionService } from "./modules/provider-delivery/team-relay-projection.js";
import { createControlPlaneSourceThreadAuthority } from "./modules/slack-ingress/authority.js";
import { SourceAppRegistry, type SourceThreadCommandAuthorityPorts } from "@opentag/source-app-runtime";
import { ProviderAdapterRegistry, ProviderSideEffectKernel,
  UnifiedDeliveryProducer } from "@opentag/delivery-runtime";
import { deliveryCurrentTruthDescriptor,
  type DeliveryIntentV2, type DeliveryPayloadEnvelope } from "@opentag/delivery-contract";
import {
  createSourceIngressWorker,
  type SourceResolutionPort,
} from "./modules/source-ingress/worker.js";
import { z } from "zod";
import {
  AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
  computeControlPayloadDigestV1,
  HostedAdmissionEnvelopeV1Schema,
} from "@opentag/control-protocol";

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
  const permissions = createPermissionCoordinator({
    pool: postgres.pool,
    clock,
    idFactory: (kind) => randomIdentifier(kind),
  });
  const materials = createMaterialActionCoordinator({
    pool: postgres.pool,
    clock,
  });
  const publisher = createPublicationPublisher({
    pool: postgres.pool,
    clock,
    idFactory: (kind) => `publication_${kind}_${randomBytes(16).toString("hex")}`,
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
      const context = z.object({
        runId: z.string().min(1).max(512),
        hostedAdmission: HostedAdmissionEnvelopeV1Schema,
        admissionPolicySnapshot: AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
      }).strict().parse(command.sourceContext);
      if (context.hostedAdmission.organizationId !== command.reservation.organizationId
        || context.hostedAdmission.sourceContextEnvelope.contentId
          !== command.reservation.contentRef.contentId
        || context.hostedAdmission.sourceContextEnvelope.sourceVersionRef
          !== command.reservation.contentRef.sourceVersionRef
        || context.hostedAdmission.sourceContextEnvelope.aadDigest
          !== command.reservation.contentRef.aadDigest
        || context.hostedAdmission.sourceContextEnvelope.keyVersion
          !== command.reservation.contentRef.keyVersion) {
        return { kind: "invalid_request", code: "source_context_identity_mismatch" } as const;
      }
      const requestDigest = await computeControlPayloadDigestV1({
        idempotencyKey: command.idempotencyKey, runId: context.runId,
        admissionDigest: context.hostedAdmission.envelopeDigest,
        policyDigest: context.admissionPolicySnapshot.receiptDigest,
      });
      await postgres.pool.query(
        `INSERT INTO cp_source_resolution_admission(idempotency_key, organization_id,
           request_digest, run_id, state, resolution, created_at)
         VALUES($1,$2,$3,$4,'pending',NULL,$5) ON CONFLICT (idempotency_key) DO NOTHING`,
        [command.idempotencyKey, context.hostedAdmission.organizationId,
          requestDigest, context.runId, clock.now()],
      );
      const durable = await postgres.pool.query<{ request_digest: string;
        run_id: string; state: "pending" | "decided"; resolution: {
          kind: "accepted" | "waiting_for_runner"; runId: string } | null }>(
        `SELECT request_digest, run_id, state, resolution FROM cp_source_resolution_admission
         WHERE idempotency_key = $1`, [command.idempotencyKey],
      );
      const stored = durable.rows[0];
      if (!stored || stored.request_digest !== requestDigest || stored.run_id !== context.runId) {
        return { kind: "invalid_request", code: "source_resolution_idempotency_conflict" } as const;
      }
      if (stored.state === "decided" && stored.resolution) return stored.resolution;
      const admitted = await hosted.admit({ runId: context.runId,
        admission: context.hostedAdmission, policy: context.admissionPolicySnapshot });
      if (admitted.kind === "conflict") {
        return { kind: "invalid_request", code: admitted.reason } as const;
      }
      const resolution = admitted.view.status === "waiting_for_runner"
        ? { kind: "waiting_for_runner", runId: admitted.runId } as const
        : { kind: "accepted", runId: admitted.runId } as const;
      await postgres.pool.query(
        `UPDATE cp_source_resolution_admission SET state = 'decided', resolution = $2::jsonb
         WHERE idempotency_key = $1 AND request_digest = $3 AND run_id = $4`,
        [command.idempotencyKey, JSON.stringify(resolution), requestDigest, context.runId],
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
  const slack = sourceContent && input.slackSecrets
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
    hosted, producer: providerDeliveryProducer, clock,
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
    "provider-delivery": async () => providerDeliveryWorker.processNext(),
    "team-relay.project": async (job: { payload: unknown }) => {
      const payload = z.object({ organizationId: z.string().min(1), runId: z.string().min(1),
        projectionRevision: z.number().int().positive() }).strict().parse(job.payload);
      return teamRelayProjection.projectRun(payload);
    },
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
      sourceThreadReads: { async authorize(command) {
        const result = await postgres.pool.query(`SELECT 1 FROM cp_hosted_run run
          JOIN cp_slack_installation slack ON slack.organization_id=run.organization_id
            AND slack.installation_id=$3
            AND run.source_version_ref LIKE 'slack:' || slack.team_id || ':' || slack.channel_id || ':%'
          WHERE run.organization_id=$1 AND run.run_id=$2 AND $4=ANY(slack.member_user_ids) LIMIT 1`,
        [command.organizationId, command.runId, command.installationId, command.actorId]);
        return result.rowCount === 1;
      } },
      reader: {
        async authenticate(token) {
          const outcome = await identity.authenticateApiKey(token);
          if (outcome.kind !== "authenticated") return outcome;
          return { kind: "authenticated" as const, principal: {
            organizationId: outcome.principal.organizationId,
            actorId: outcome.principal.apiKeyId,
            scopes: outcome.principal.scopes,
          } };
        },
      },
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
    close: () => postgres.close(),
  };
}
