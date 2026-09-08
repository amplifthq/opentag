import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createOpenTagClient, type OpenTagClient } from "@opentag/client";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type {
  ActionPermissionRequest,
  ActionPermissionResolution,
  HostedClaimRequestV1,
  HostedClaimV1,
  HostedExecutorResultReasonCodeV1,
  HostedLifecycleActionV1,
  HostedLifecycleReceiptEnvelopeV1,
  HostedLifecycleRequestV1,
  MaterialActionReceipt,
  RunnerReadinessReceiptEnvelopeV1,
  RunnerControlContextResponseV1,
} from "@opentag/core";
import {
  computeControlPayloadDigestV1,
  computeControlReceiptDigestV1,
  compareCanonicalUnicodeStrings,
  buildHostedLifecycleRequestV1,
  HostedCompleteRequestV1Schema,
  HostedHeartbeatRequestV1Schema,
  HostedProgressRequestV1Schema,
  LocalWorkspaceWriteObservationV1Schema,
  HostedRejectStartRequestV1Schema,
  HostedRunningRequestV1Schema,
  computeMaterialActionPayloadDigestV1,
  computeMaterialActionReceiptDigestV1,
  computePermissionRequestDigestV1,
  computeSlackAppMentionSourceIdentityDigestV1,
  verifyHostedAdmissionEnvelopeDigestV1,
  HostedSourceContentRedeemRequestV1Schema,
  verifyHostedSourceContentRedeemPayloadV1,
  OpenTagEventSchema,
  RunnerReadinessReceiptEnvelopeV1Schema,
  sortCanonicalUnicodeStrings,
} from "@opentag/core";
import {
  createPairedRunnerRepository,
  migratePairedRunnerSchema,
  type PairedRunnerRepository,
} from "@opentag/store";
import type { EffectPermitV1 } from "@opentag/control-protocol";
import {
  type ExecutorAdapter,
  type RunnerSecurityPolicy,
} from "@opentag/runner";
import {
  canonicalRepositoryIdentity,
  type OpenTagDaemonConfig,
  type RepositoryBindingConfig,
} from "./config.js";
import {
  executeClaimedRun,
  type ClaimedRun,
  type ClaimedRunExecutionClient,
} from "./daemon.js";
import {
  LocalEffectExecutor,
  buildPublicationEffectRequest,
  createGitHubDraftPullRequestEffectAdapter,
} from "./effects/index.js";

const require = createRequire(import.meta.url);
const LOCAL_RUNTIME_VERSION = (require("../package.json") as { version: string }).version;
const READINESS_TTL_MS = 60_000;
const READINESS_PROBE_CACHE_RATIO = 0.5;
const CONTROL_TRANSFER_TIMEOUT_MS = 30_000;
const CONTROL_LEASE_SAFETY_MS = 5_000;
const DEFAULT_CONTROL_LEASE_SECONDS = 90;
const DEFAULT_CLOSE_DRAIN_TIMEOUT_MS = 5_000;

function openLocalGovernanceStore(databasePath: string) {
  const sqlite = new Database(databasePath);
  migratePairedRunnerSchema(sqlite);
  return {
    repo: createPairedRunnerRepository(drizzle(sqlite)),
    close() {
      sqlite.close();
    },
  };
}
const HOSTED_CLAIM_CAPABILITIES = [
  "relay.claim-fence.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.lifecycle.v1",
  "relay.readiness.v1",
  "relay.source-content-redeem.v1",
] as const;

export type ControlPlaneProjectionEnvelope = RunnerReadinessReceiptEnvelopeV1;

export type ControlPlaneProjectionOutboxEntry = {
  receiptId: string;
  destinationId: string;
  organizationId: string;
  runnerId?: string;
  runId?: string;
  workThreadId?: string;
  receiptKind: ControlPlaneProjectionEnvelope["receiptKind"];
  identity: { namespace: string; parts: string[]; key: string };
  operationId: string;
  payloadDigest: string;
  receiptDigest: string;
  envelope: ControlPlaneProjectionEnvelope;
  state: "pending" | "leased" | "acknowledged" | "attention";
  attemptCount: number;
  nextAttemptAt?: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ControlProjectionRepository = {
  recoverExpiredControlPlaneProjectionLeases(input: { destinationId: string; organizationId: string; limit?: number; now?: Date }): Promise<unknown>;
  claimDueControlPlaneProjections(input: { destinationId: string; organizationId: string; leaseOwner: string; leaseSeconds: number; limit?: number; now?: Date }): Promise<{ entries: ControlPlaneProjectionOutboxEntry[] }>;
  acknowledgeControlPlaneProjection(input: { destinationId: string; organizationId: string; receiptId: string; leaseToken: string; httpStatus?: number; now?: Date }): Promise<{ outcome: "acknowledged" | "stale_lease" | "not_found" }>;
  retryControlPlaneProjection(input: { destinationId: string; organizationId: string; receiptId: string; leaseToken: string; nextAttemptAt: string; reasonCode: string; httpStatus?: number; now?: Date }): Promise<{ outcome: "retried" | "stale_lease" | "not_found" }>;
  markControlPlaneProjectionAttention(input: { destinationId: string; organizationId: string; receiptId: string; leaseToken: string; reasonCode: string; httpStatus?: number; now?: Date }): Promise<{ outcome: "attention" | "stale_lease" | "not_found" }>;
};

export type ControlProjectionClient = Pick<
  OpenTagClient,
  "reportRunnerReadinessControlV1"
>;

export type HostedLifecycleOperationEntry = {
  destinationId: string;
  organizationId: string;
  runnerId: string;
  credentialId: string;
  operationId: string;
  requestId: string;
  action: HostedLifecycleActionV1;
  runId: string;
  request: HostedLifecycleRequestV1;
  state: "pending" | "leased" | "acknowledged" | "attention";
  attemptCount: number;
  leaseToken?: string;
  leaseExpiresAt?: string;
};

export type HostedLifecycleRepository = {
  recoverExpiredHostedLifecycleOperations(input: {
    destinationId: string;
    organizationId: string;
    now?: Date;
  }): Promise<unknown>;
  claimDueHostedLifecycleOperations(input: {
    destinationId: string;
    organizationId: string;
    leaseOwner: string;
    leaseSeconds: number;
    limit?: number;
    now?: Date;
  }): Promise<HostedLifecycleOperationEntry[]>;
  acknowledgeHostedLifecycleOperation(input: {
    destinationId: string;
    organizationId: string;
    operationId: string;
    leaseToken: string;
    receipt: HostedLifecycleReceiptEnvelopeV1;
    now?: Date;
  }): Promise<"acknowledged" | "stale_lease" | "not_found">;
  retryHostedLifecycleOperation(input: {
    destinationId: string;
    organizationId: string;
    operationId: string;
    leaseToken: string;
    nextAttemptAt: string;
    reasonCode: string;
    now?: Date;
  }): Promise<"retried" | "stale_lease" | "not_found">;
  markHostedLifecycleOperationAttention(input: {
    destinationId: string;
    organizationId: string;
    operationId: string;
    leaseToken: string;
    reasonCode: string;
    now?: Date;
  }): Promise<"attention" | "stale_lease" | "not_found">;
};

export type HostedLifecycleClient = Pick<OpenTagClient,
  "heartbeatHostedRunControlV1" | "markHostedRunRunningControlV1" |
  "progressHostedRunControlV1" | "completeHostedRunControlV1" |
  "rejectHostedAttemptStartControlV1">;

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function retryable(status: number | undefined): boolean {
  return status === 0
    || status === 408
    || status === 429
    || (status !== undefined && status >= 500 && status < 600);
}

function transportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || httpStatus(error) !== undefined) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return error instanceof TypeError
    || name === "AbortError"
    || name === "FetchError"
    || name === "NetworkError";
}

function retryAfterMs(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const seconds = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000
    : 0;
}

async function deliverProjection(client: ControlProjectionClient, envelope: ControlPlaneProjectionEnvelope): Promise<number> {
  const result = await client.reportRunnerReadinessControlV1(envelope);
  return result.status;
}

export async function pumpControlPlaneProjections(input: {
  repo: ControlProjectionRepository;
  client: ControlProjectionClient;
  destinationId: string;
  organizationId: string;
  leaseOwner: string;
  leaseSeconds?: number;
  limit?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  transferTimeoutMs?: number;
  now?: Date | (() => Date);
  cancelled?: () => boolean;
}): Promise<{ delivered: number; retried: number; attention: number }> {
  const clock = typeof input.now === "function"
    ? input.now
    : input.now
      ? () => input.now as Date
      : () => new Date();
  const claimNow = clock();
  await input.repo.recoverExpiredControlPlaneProjectionLeases({ destinationId: input.destinationId, organizationId: input.organizationId, ...(input.limit ? { limit: input.limit } : {}), now: claimNow });
  const summary = { delivered: 0, retried: 0, attention: 0 };
  const transferTimeoutMs = input.transferTimeoutMs ?? CONTROL_TRANSFER_TIMEOUT_MS;
  const minimumLeaseRemainingMs = transferTimeoutMs + CONTROL_LEASE_SAFETY_MS;
  const leaseSeconds = Math.max(
    input.leaseSeconds ?? DEFAULT_CONTROL_LEASE_SECONDS,
    Math.ceil(minimumLeaseRemainingMs / 1_000),
  );
  const limit = input.limit ?? 25;
  for (let index = 0; index < limit; index += 1) {
    const nextClaimAt = index === 0 ? claimNow : clock();
    const claimed = await input.repo.claimDueControlPlaneProjections({
      destinationId: input.destinationId,
      organizationId: input.organizationId,
      leaseOwner: input.leaseOwner,
      leaseSeconds,
      limit: 1,
      now: nextClaimAt,
    });
    const entry = claimed.entries[0];
    if (!entry) break;
    if (!entry.leaseToken) continue;
    const sendAt = clock();
    const leaseExpiresAt = Date.parse(entry.leaseExpiresAt ?? "");
    if (
      !Number.isFinite(leaseExpiresAt)
      || leaseExpiresAt - sendAt.getTime() < minimumLeaseRemainingMs
    ) {
      const outcome = await input.repo.retryControlPlaneProjection({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        receiptId: entry.receiptId,
        leaseToken: entry.leaseToken,
        nextAttemptAt: sendAt.toISOString(),
        reasonCode: "lease_window_insufficient",
        now: sendAt,
      });
      if (outcome.outcome === "retried") summary.retried += 1;
      continue;
    }
    try {
      const status = await deliverProjection(input.client, entry.envelope);
      if (input.cancelled?.()) return summary;
      const outcome = await input.repo.acknowledgeControlPlaneProjection({ destinationId: input.destinationId, organizationId: input.organizationId, receiptId: entry.receiptId, leaseToken: entry.leaseToken, httpStatus: status, now: clock() });
      if (outcome.outcome === "acknowledged") summary.delivered += 1;
    } catch (error) {
      if (input.cancelled?.()) return summary;
      const status = httpStatus(error);
      const failureNow = clock();
      if (retryable(status) || transportFailure(error)) {
        const backoff = Math.min(input.retryMaxMs ?? 60_000, (input.retryBaseMs ?? 1_000) * 2 ** Math.max(0, entry.attemptCount - 1));
        const delay = Math.max(backoff, retryAfterMs(error));
        const outcome = await input.repo.retryControlPlaneProjection({ destinationId: input.destinationId, organizationId: input.organizationId, receiptId: entry.receiptId, leaseToken: entry.leaseToken, nextAttemptAt: new Date(failureNow.getTime() + delay).toISOString(), reasonCode: status ? `http_${status}` : "transport_failed", ...(status ? { httpStatus: status } : {}), now: failureNow });
        if (outcome.outcome === "retried") summary.retried += 1;
      } else {
        const outcome = await input.repo.markControlPlaneProjectionAttention({ destinationId: input.destinationId, organizationId: input.organizationId, receiptId: entry.receiptId, leaseToken: entry.leaseToken, reasonCode: status === undefined ? "unexpected_error" : `http_${status}`, ...(status ? { httpStatus: status } : {}), now: failureNow });
        if (outcome.outcome === "attention") summary.attention += 1;
      }
    }
  }
  return summary;
}

async function deliverHostedLifecycle(
  client: HostedLifecycleClient,
  entry: HostedLifecycleOperationEntry,
): Promise<HostedLifecycleReceiptEnvelopeV1> {
  const common = {
    organizationId: entry.organizationId,
    credentialId: entry.credentialId,
    runnerId: entry.runnerId,
    runId: entry.runId,
  };
  const result = entry.action === "heartbeat"
    ? await client.heartbeatHostedRunControlV1({
      ...common,
      request: HostedHeartbeatRequestV1Schema.parse(entry.request),
    })
    : entry.action === "running"
      ? await client.markHostedRunRunningControlV1({
        ...common,
        request: HostedRunningRequestV1Schema.parse(entry.request),
      })
      : entry.action === "progress"
        ? await client.progressHostedRunControlV1({
          ...common,
          request: HostedProgressRequestV1Schema.parse(entry.request),
        })
        : entry.action === "complete"
          ? await client.completeHostedRunControlV1({
            ...common,
            request: HostedCompleteRequestV1Schema.parse(entry.request),
          })
          : await client.rejectHostedAttemptStartControlV1({
            ...common,
            request: HostedRejectStartRequestV1Schema.parse(entry.request),
          });
  return result.receipt;
}

export async function pumpHostedLifecycleOperations(input: {
  repo: HostedLifecycleRepository;
  client: HostedLifecycleClient;
  destinationId: string;
  organizationId: string;
  leaseOwner: string;
  leaseSeconds?: number;
  limit?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: Date | (() => Date);
  cancelled?: () => boolean;
}): Promise<{ delivered: number; retried: number; attention: number }> {
  const clock = typeof input.now === "function"
    ? input.now
    : input.now
      ? () => input.now as Date
      : () => new Date();
  const summary = { delivered: 0, retried: 0, attention: 0 };
  if (input.cancelled?.()) return summary;
  const claimNow = clock();
  await input.repo.recoverExpiredHostedLifecycleOperations({
    destinationId: input.destinationId,
    organizationId: input.organizationId,
    now: claimNow,
  });
  if (input.cancelled?.()) return summary;
  const limit = input.limit ?? 25;
  for (let index = 0; index < limit; index += 1) {
    if (input.cancelled?.()) return summary;
    const claimed = await input.repo.claimDueHostedLifecycleOperations({
      destinationId: input.destinationId,
      organizationId: input.organizationId,
      leaseOwner: input.leaseOwner,
      leaseSeconds: input.leaseSeconds ?? DEFAULT_CONTROL_LEASE_SECONDS,
      limit: 1,
      now: index === 0 ? claimNow : clock(),
    });
    if (input.cancelled?.()) return summary;
    const entry = claimed[0];
    if (!entry) break;
    if (!entry.leaseToken) continue;
    try {
      if (input.cancelled?.()) return summary;
      const receipt = await deliverHostedLifecycle(input.client, entry);
      if (input.cancelled?.()) return summary;
      const outcome = await input.repo.acknowledgeHostedLifecycleOperation({
        destinationId: input.destinationId,
        organizationId: input.organizationId,
        operationId: entry.operationId,
        leaseToken: entry.leaseToken,
        receipt,
        now: clock(),
      });
      if (outcome === "acknowledged") summary.delivered += 1;
      else if (outcome === "stale_lease") {
        const attention = await input.repo.markHostedLifecycleOperationAttention({
          destinationId: input.destinationId,
          organizationId: input.organizationId,
          operationId: entry.operationId,
          leaseToken: entry.leaseToken,
          reasonCode: "receipt_rejected",
          now: clock(),
        });
        if (attention === "attention") summary.attention += 1;
      }
    } catch (error) {
      if (input.cancelled?.()) return summary;
      const status = httpStatus(error);
      const failureNow = clock();
      if (retryable(status) || transportFailure(error)) {
        const backoff = Math.min(
          input.retryMaxMs ?? 60_000,
          (input.retryBaseMs ?? 1_000)
            * 2 ** Math.max(0, entry.attemptCount - 1),
        );
        const delay = Math.max(backoff, retryAfterMs(error));
        const outcome = await input.repo.retryHostedLifecycleOperation({
          destinationId: input.destinationId,
          organizationId: input.organizationId,
          operationId: entry.operationId,
          leaseToken: entry.leaseToken,
          nextAttemptAt: new Date(failureNow.getTime() + delay).toISOString(),
          reasonCode: status ? `http_${status}` : "transport_failed",
          now: failureNow,
        });
        if (outcome === "retried") summary.retried += 1;
      } else {
        const outcome = await input.repo.markHostedLifecycleOperationAttention({
          destinationId: input.destinationId,
          organizationId: input.organizationId,
          operationId: entry.operationId,
          leaseToken: entry.leaseToken,
          reasonCode: status === undefined
            ? "invalid_receipt_or_unexpected_error"
            : `http_${status}`,
          now: failureNow,
        });
        if (outcome === "attention") summary.attention += 1;
      }
    }
  }
  return summary;
}

function stableDigestId(prefix: string, digest: string): string {
  return `${prefix}_${digest.slice("sha256:".length, "sha256:".length + 24)}`;
}

export function isRunnerControlContextFreshV1(
  observedAt: string,
  now: Date,
  maxAgeMs = READINESS_TTL_MS,
): boolean {
  const ageMs = now.getTime() - Date.parse(observedAt);
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function canonicalReadinessAuthority(
  readiness: RunnerReadinessReceiptEnvelopeV1,
): unknown {
  return {
    organizationId: readiness.organizationId,
    runnerId: readiness.payload.runnerId,
    producer: {
      kind: readiness.producer.kind,
      id: readiness.producer.id,
      credentialId: readiness.producer.credentialId,
      registrationGeneration: readiness.producer.registrationGeneration,
    },
    registrationGeneration: readiness.payload.registrationGeneration,
    capabilities: sortCanonicalUnicodeStrings(readiness.payload.capabilities),
    executors: [...readiness.payload.executors]
      .sort((left, right) => compareCanonicalUnicodeStrings(left.executorId, right.executorId)),
    targets: [...readiness.payload.targets]
      .sort((left, right) => compareCanonicalUnicodeStrings(left.projectTargetId, right.projectTargetId)),
  };
}

export function hasSameRunnerReadinessAuthorityV1(
  left: RunnerReadinessReceiptEnvelopeV1,
  right: RunnerReadinessReceiptEnvelopeV1,
): boolean {
  return JSON.stringify(canonicalReadinessAuthority(left))
    === JSON.stringify(canonicalReadinessAuthority(right));
}

export function runnerReadinessReuseWindowV1(
  readiness: RunnerReadinessReceiptEnvelopeV1,
  now: Date,
): "reusable" | "final_window" | "expired" {
  const remainingMs = Date.parse(readiness.payload.expiresAt) - now.getTime();
  if (remainingMs > CONTROL_LEASE_SAFETY_MS) return "reusable";
  return remainingMs >= 0 ? "final_window" : "expired";
}

export function assertRunnerControlContextRegistrationV1(input: {
  context: RunnerControlContextResponseV1;
  registration: OpenTagDaemonConfig["controlRegistration"];
}): void {
  const registration = input.registration;
  if (!registration || !("registration" in registration)) {
    throw new Error("runner_control_context_registration_unavailable");
  }
  if (input.context.organizationId !== registration.registration.organizationId) {
    throw new Error("runner_control_context_organization_mismatch");
  }
  if (
    input.context.credentialId !== registration.registration.credentialId
    || input.context.registrationGeneration
      !== registration.registration.registrationGeneration
    || input.context.credentialGeneration
      !== registration.registration.credentialGeneration
  ) {
    throw new Error("runner_control_context_credential_mismatch");
  }
}

export function buildHostedClaimRequestV1(input: {
  context: RunnerControlContextResponseV1;
  readiness: RunnerReadinessReceiptEnvelopeV1;
  requestId: string;
  operationId: string;
}): HostedClaimRequestV1 {
  if (
    input.readiness.organizationId !== input.context.organizationId
    || input.readiness.payload.runnerId !== input.context.runnerId
    || input.readiness.producer.credentialId !== input.context.credentialId
    || input.readiness.producer.registrationGeneration
      !== input.context.registrationGeneration
  ) {
    throw new Error("hosted_claim_readiness_context_mismatch");
  }
  return {
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: [...HOSTED_CLAIM_CAPABILITIES],
    requestId: input.requestId,
    operationId: input.operationId,
    expectedAuthority: {
      credentialId: input.context.credentialId,
      registrationGeneration: input.context.registrationGeneration,
      credentialGeneration: input.context.credentialGeneration,
      runnerReadinessReceiptId: input.readiness.receiptId,
      runnerReadinessReceiptDigest: input.readiness.receiptDigest,
    },
  };
}

export async function assertHostedClaimCurrentAuthorityV1(input: {
  claim: HostedClaimV1;
  context: RunnerControlContextResponseV1;
  readiness: RunnerReadinessReceiptEnvelopeV1;
  request: HostedClaimRequestV1;
  now: Date;
}): Promise<void> {
  const { claim, context, readiness, request } = input;
  await assertHostedClaimRequestBindingV1({ claim, request });
  if (
    claim.organizationId !== context.organizationId
    || claim.runnerId !== context.runnerId
    || claim.authority.credentialId !== context.credentialId
    || claim.authority.registrationGeneration !== context.registrationGeneration
    || claim.authority.credentialGeneration !== context.credentialGeneration
  ) {
    throw new Error("hosted_claim_current_context_mismatch");
  }
  const contextCapabilities = sortCanonicalUnicodeStrings([...new Set(context.capabilities)]);
  const readinessCapabilities = sortCanonicalUnicodeStrings([
    ...new Set(readiness.payload.capabilities),
  ]);
  if (
    request.requiredCapabilities.some(
      (capability) => !contextCapabilities.includes(capability),
    )
    || JSON.stringify(readinessCapabilities)
      !== JSON.stringify(contextCapabilities)
  ) {
    throw new Error("hosted_claim_current_capability_mismatch");
  }
  const target = context.targets.find(
    (candidate) => candidate.projectTargetId === claim.authority.projectTargetId,
  );
  const targetIdentity = target
    ? canonicalRepositoryIdentity(target)
    : null;
  const admissionIdentity = canonicalRepositoryIdentity({
    provider: claim.hostedAdmission.repository.provider,
    owner: claim.hostedAdmission.repository.owner,
    repo: claim.hostedAdmission.repository.repo,
  });
  if (
    !target
    || !targetIdentity
    || target.bindingDigest !== claim.authority.targetBindingDigest
    || targetIdentity.provider !== admissionIdentity.provider
    || targetIdentity.owner !== admissionIdentity.owner
    || targetIdentity.repo !== admissionIdentity.repo
    || target.defaultExecutor !== claim.executorId
  ) {
    throw new Error("hosted_claim_target_mismatch");
  }
  const readyTarget = readiness.payload.targets.find(
    (candidate) => candidate.projectTargetId === target.projectTargetId,
  );
  const readyExecutor = readiness.payload.executors.find(
    (candidate) => candidate.executorId === claim.executorId,
  );
  if (
    readyTarget?.state !== "ready"
    || readyTarget.bindingDigest !== target.bindingDigest
    || readyExecutor?.state !== "ready"
    || readyExecutor.capabilityDigest !== claim.authority.executorCapabilityDigest
  ) {
    throw new Error("hosted_claim_readiness_not_ready");
  }
  const leaseExpiresAt = Date.parse(claim.attempt.leaseExpiresAt);
  if (
    !Number.isFinite(leaseExpiresAt)
    || leaseExpiresAt <= input.now.getTime()
  ) {
    throw new Error("hosted_claim_lease_expired");
  }
}

async function assertHostedClaimRequestBindingV1(input: {
  claim: HostedClaimV1;
  request: HostedClaimRequestV1;
}): Promise<void> {
  const { claim, request } = input;
  if (!(await verifyHostedAdmissionEnvelopeDigestV1(claim.hostedAdmission))) {
    throw new Error("hosted_claim_admission_envelope_digest_mismatch");
  }
  if (
    claim.requestId !== request.requestId
    || claim.operationId !== request.operationId
    || claim.hostedAdmission.organizationId !== claim.organizationId
    || claim.hostedAdmission.runnerId !== claim.runnerId
    || claim.authority.credentialId !== request.expectedAuthority.credentialId
    || claim.authority.registrationGeneration
      !== request.expectedAuthority.registrationGeneration
    || claim.authority.credentialGeneration
      !== request.expectedAuthority.credentialGeneration
  ) {
    throw new Error("hosted_claim_request_authority_mismatch");
  }
  if (
    claim.authority.runnerReadinessReceiptId
      !== request.expectedAuthority.runnerReadinessReceiptId
    || claim.authority.runnerReadinessReceiptDigest
      !== request.expectedAuthority.runnerReadinessReceiptDigest
  ) {
    throw new Error("hosted_claim_readiness_mismatch");
  }
}

export async function buildRunnerReadinessReceipt(input: {
  context: RunnerControlContextResponseV1;
  executors: Record<string, ExecutorAdapter>;
  repositories: RepositoryBindingConfig[];
  observedAt?: string;
  now?: () => Date;
  ttlMs?: number;
  readinessProbeCache?: Map<string, {
    expiresAt: number;
    readiness: Awaited<ReturnType<ExecutorAdapter["canRun"]>>;
  }>;
}): Promise<RunnerReadinessReceiptEnvelopeV1> {
  if (!input.context.capabilities.includes("relay.readiness.v1")) {
    throw new Error("runner_control_context_missing_readiness_capability");
  }
  const clock = input.now ?? (() => new Date());
  const probeNow = clock();
  const readinessTtlMs = input.ttlMs ?? READINESS_TTL_MS;
  const contextDigest = await computeControlPayloadDigestV1({
    organizationId: input.context.organizationId,
    runnerId: input.context.runnerId,
    credentialId: input.context.credentialId,
    registrationGeneration: input.context.registrationGeneration,
    credentialGeneration: input.context.credentialGeneration,
    capabilities: input.context.capabilities,
    targets: input.context.targets,
  });
  const matchedRepositories = new Map<string, RepositoryBindingConfig>();
  const targets = input.context.targets.map((target) => {
    const targetIdentity = canonicalRepositoryIdentity(target);
    const matches = input.repositories.filter((binding) => {
      const bindingIdentity = canonicalRepositoryIdentity(binding);
      return binding.projectTargetId === target.projectTargetId
        && bindingIdentity.provider === targetIdentity.provider
        && bindingIdentity.owner === targetIdentity.owner
        && bindingIdentity.repo === targetIdentity.repo
        && binding.defaultExecutor === target.defaultExecutor
        && (binding.baseBranch ?? null) === target.defaultBranch;
    });
    if (matches.length !== 1) {
      return {
        projectTargetId: target.projectTargetId,
        bindingDigest: target.bindingDigest,
        bindingGeneration: target.bindingGeneration,
        state: "unknown" as const,
        reasonCode: "target_binding_stale" as const,
      };
    }
    const binding = matches[0]!;
    let checkoutVerified = false;
    if (existsSync(binding.checkoutPath)) {
      try {
        checkoutVerified = execFileSync(
          "git",
          ["-C", binding.checkoutPath, "rev-parse", "--is-inside-work-tree"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim() === "true";
      } catch {
        checkoutVerified = false;
      }
    }
    if (checkoutVerified && !matchedRepositories.has(binding.defaultExecutor)) {
      matchedRepositories.set(binding.defaultExecutor, binding);
    }
    return checkoutVerified
      ? {
          projectTargetId: target.projectTargetId,
          bindingDigest: target.bindingDigest,
          bindingGeneration: target.bindingGeneration,
          state: "ready" as const,
        }
      : {
          projectTargetId: target.projectTargetId,
          bindingDigest: target.bindingDigest,
          bindingGeneration: target.bindingGeneration,
          state: "blocked" as const,
          reasonCode: "target_unavailable" as const,
        };
  });
  const executors = await Promise.all(Object.values(input.executors)
    .sort((left, right) => compareCanonicalUnicodeStrings(left.id, right.id))
    .map(async (executor) => {
      const base = {
        executorId: executor.id,
        adapterVersion: LOCAL_RUNTIME_VERSION,
        capabilityDigest: await computeControlPayloadDigestV1(
          executor.capability ?? { id: executor.id },
        ),
      };
      const binding = matchedRepositories.get(executor.id);
      if (!binding) {
        return {
          ...base,
          state: "unknown" as const,
          reasonCode: "executor_unavailable" as const,
        };
      }
      try {
        const cacheKey = await computeControlPayloadDigestV1({
          contextDigest,
          capabilityDigest: base.capabilityDigest,
          binding: {
            provider: binding.provider,
            owner: binding.owner,
            repo: binding.repo,
            checkoutPath: binding.checkoutPath,
            defaultExecutor: binding.defaultExecutor,
            baseBranch: binding.baseBranch ?? null,
            worktreeRoot: binding.worktreeRoot ?? null,
            keepWorktree: binding.keepWorktree ?? null,
          },
        });
        const cached = input.readinessProbeCache?.get(cacheKey);
        const readiness = cached && cached.expiresAt > probeNow.getTime()
          ? cached.readiness
          : await executor.canRun({
              runId: "control-v1-readiness",
              workspace: { kind: "repository", path: binding.checkoutPath },
              command: { rawText: "control-v1-readiness", intent: "unknown", args: {} },
              context: [],
              ...(binding.baseBranch ? { baseBranch: binding.baseBranch } : {}),
              ...(binding.worktreeRoot ? { worktreeRoot: binding.worktreeRoot } : {}),
              ...(binding.keepWorktree ? { keepWorktree: binding.keepWorktree } : {}),
            });
        if (!cached || cached.expiresAt <= probeNow.getTime()) {
          input.readinessProbeCache?.set(cacheKey, {
            expiresAt: probeNow.getTime() + Math.floor(readinessTtlMs * READINESS_PROBE_CACHE_RATIO),
            readiness,
          });
        }
        return readiness.ready
          ? { ...base, state: "ready" as const }
          : {
              ...base,
              state: "blocked" as const,
              reasonCode: "executor_unavailable" as const,
            };
      } catch {
        return {
          ...base,
          state: "blocked" as const,
          reasonCode: "executor_unavailable" as const,
        };
      }
    }));
  // This timestamp describes the completed local probe. The server context's
  // observedAt is an acceptance timestamp and must not be reused as evidence.
  const observedAt = input.observedAt ?? clock().toISOString();
  const payloadBase = {
    readinessId: "pending",
    runnerId: input.context.runnerId,
    registrationGeneration: input.context.registrationGeneration,
    capabilities: input.context.capabilities,
    executors,
    targets,
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + (input.ttlMs ?? READINESS_TTL_MS)).toISOString(),
  };
  const readinessSeedDigest = await computeControlPayloadDigestV1(payloadBase);
  const readinessId = stableDigestId("readiness", readinessSeedDigest);
  const payload = { ...payloadBase, readinessId };
  const receiptId = stableDigestId("readiness_receipt", await computeControlPayloadDigestV1(payload));
  const base = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    receiptKind: "runner_readiness" as const,
    receiptId,
    organizationId: input.context.organizationId,
    operationId: stableDigestId("readiness_operation", readinessSeedDigest),
    requiredCapabilities: ["relay.readiness.v1"] as const,
    producer: {
      kind: "runner" as const,
      id: input.context.runnerId,
      credentialId: input.context.credentialId,
      registrationGeneration: input.context.registrationGeneration,
    },
    identity: {
      namespace: "opentag.control.receipt/runner-readiness/v1",
      parts: [input.context.organizationId, input.context.runnerId, String(input.context.registrationGeneration), readinessId],
    },
    observedAt,
    payload,
    payloadDigest: await computeControlPayloadDigestV1(payload),
  };
  return RunnerReadinessReceiptEnvelopeV1Schema.parse({
    ...base,
    receiptDigest: await computeControlReceiptDigestV1(base),
  });
}

export type HostedControlLoop = {
  beforeIteration(): Promise<boolean>;
  afterIteration(): Promise<void>;
  abort(): void;
  close(): Promise<void>;
};

type HostedExecutionRepository = PairedRunnerRepository;

function permissionResolutionFromReceipt(input: {
  receipt: Awaited<ReturnType<OpenTagClient["getActionPermissionCurrentControlV1"]>>["receipt"];
  request: ActionPermissionRequest;
}): ActionPermissionResolution {
  const { receipt, request } = input;
  const state = receipt.payload.state;
  return {
    state,
    action: {
      id: receipt.payload.actionId,
      runId: receipt.runId,
      attemptId: receipt.attempt.attemptId,
      actionFamily: receipt.payload.actionDescriptor,
      capability: receipt.payload.actionDescriptor,
      scope: { permissionScopes: request.permissionScopes },
      target: { fingerprint: receipt.payload.targetFingerprint },
      riskTier: receipt.payload.riskTier,
      status: state === "waiting"
        ? "waiting_approval"
        : state === "authorized"
          ? "authorized"
          : "cancelled",
      idempotencyKey: receipt.payload.permissionRequestId,
      attemptFenceDigest: receipt.attempt.fencingTokenDigest,
      createdAt: receipt.payload.requestedAt,
      updatedAt: receipt.observedAt,
    },
    ...(state === "authorized" ? { decision: "allow_once" as const } : {}),
    ...(receipt.payload.reasonCode ? { reason: receipt.payload.reasonCode } : {}),
  };
}

export async function buildHostedProgressMetadataForControlV1(input: {
  at: string;
}): Promise<{ progressId: string; progressDigest: string }> {
  const progressDigest = await computeControlPayloadDigestV1({
    type: "status",
    occurredAt: input.at,
  });
  return {
    progressId: `progress_${progressDigest.slice("sha256:".length)}`,
    progressDigest,
  };
}

export async function buildHostedCompletionMetadataForControlV1(
  result: import("@opentag/core").OpenTagRunResult,
): Promise<{
  conclusion: import("@opentag/core").OpenTagRunResult["conclusion"];
  reasonCode: HostedExecutorResultReasonCodeV1;
  resultDigest: string;
  artifactDigests: string[];
  evidenceDigests: string[];
}> {
  const reasonCodes = {
    success: "executor_success",
    failure: "executor_failure",
    cancelled: "executor_cancelled",
    interrupted: "executor_interrupted",
    timed_out: "executor_timed_out",
    needs_human: "executor_needs_human",
  } as const satisfies Record<
    import("@opentag/core").OpenTagRunResult["conclusion"],
    HostedExecutorResultReasonCodeV1
  >;
  return {
    conclusion: result.conclusion,
    reasonCode: reasonCodes[result.conclusion],
    resultDigest: await computeControlPayloadDigestV1(result),
    artifactDigests: sortCanonicalUnicodeStrings([...new Set(await Promise.all(
      (result.artifacts ?? []).map((artifact) =>
        computeControlPayloadDigestV1(artifact)
      ),
    ))]),
    evidenceDigests: sortCanonicalUnicodeStrings([...new Set(await Promise.all(
      (result.verification ?? []).map((evidence) =>
        computeControlPayloadDigestV1(evidence)
      ),
    ))]),
  };
}

export async function redeemHostedClaimSourceContentV1(input: {
  claim: HostedClaimV1;
  client: Pick<OpenTagClient, "redeemHostedSourceContentControlV1">;
  requestId: string;
  operationId: string;
  now?: () => Date;
}): Promise<{
  event: import("@opentag/core").OpenTagEvent;
  receipt: {
    provider: "slack";
    providerRepositoryId: string;
    owner: string;
    repo: string;
    sourceThread: HostedClaimV1["hostedAdmission"]["sourceThread"];
    sourceEvent: HostedClaimV1["hostedAdmission"]["sourceEvent"];
    actor: { providerUserId: string; login: string };
    sourceIdentityDigest: string;
    eventDigest: string;
    redeemedAt: string;
  };
}> {
  const { claim } = input;
  if (!(await verifyHostedAdmissionEnvelopeDigestV1(claim.hostedAdmission))) {
    throw new Error("hosted_source_admission_digest_invalid");
  }
  const request = HostedSourceContentRedeemRequestV1Schema.parse({
    schemaVersion: 1,
    protocolVersion: "1.0",
    requiredCapabilities: ["relay.source-content-redeem.v1"],
    requestId: input.requestId,
    operationId: input.operationId,
    organizationId: claim.organizationId,
    runnerId: claim.runnerId,
    runId: claim.runId,
    expectedAuthority: {
      credentialId: claim.authority.credentialId,
      registrationGeneration: claim.authority.registrationGeneration,
      credentialGeneration: claim.authority.credentialGeneration,
    },
    attempt: {
      attemptId: claim.attempt.id,
      attemptNumber: claim.attempt.number,
      epoch: claim.attempt.epoch,
      fencingTokenDigest: claim.attempt.fencingTokenDigest,
      leaseExpiresAt: claim.attempt.leaseExpiresAt,
    },
    grant: claim.sourceContentGrant,
    admissionEnvelopeDigest: claim.hostedAdmission.envelopeDigest,
    contentEnvelope: claim.hostedAdmission.sourceContextEnvelope,
  });
  const response = await input.client.redeemHostedSourceContentControlV1({
    runnerId: claim.runnerId,
    request,
  });
  if (!(await verifyHostedSourceContentRedeemPayloadV1(response))) {
    throw new Error("hosted_source_payload_digest_mismatch");
  }
  const payload = response.content.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("hosted_source_content_invalid");
  }
  const executionBearingMessageBody = (payload as Record<string, unknown>)
    .executionBearingMessageBody;
  const event = OpenTagEventSchema.parse((payload as Record<string, unknown>).event);
  if (typeof executionBearingMessageBody !== "string"
    || executionBearingMessageBody.length === 0) {
    throw new Error("hosted_source_content_invalid");
  }
  const admission = claim.hostedAdmission;
  const sourceIdentityDigest = await computeSlackAppMentionSourceIdentityDigestV1({
    provider: "slack", repository: admission.repository,
    sourceThread: admission.sourceThread, sourceEvent: admission.sourceEvent,
    actor: { providerUserId: admission.verifiedActor.providerUserId,
      login: admission.verifiedActor.login },
    executionBearingMessageBody,
  });
  if (sourceIdentityDigest !== admission.sourceIdentityDigest) {
    throw new Error("hosted_source_identity_mismatch");
  }
  return {
    event,
    receipt: {
      provider: admission.provider,
      providerRepositoryId: admission.repository.providerRepositoryId,
      owner: admission.repository.owner,
      repo: admission.repository.repo,
      sourceThread: admission.sourceThread,
      sourceEvent: admission.sourceEvent,
      actor: {
        providerUserId: admission.verifiedActor.providerUserId,
        login: admission.verifiedActor.login,
      },
      sourceIdentityDigest,
      eventDigest: await computeControlPayloadDigestV1(event),
      redeemedAt: (input.now?.() ?? new Date()).toISOString(),
    },
  };
}

async function createHostedExecutionClient(input: {
  client: OpenTagClient;
  repo: HostedExecutionRepository;
  authority: {
    organizationId: string;
    runnerId: string;
    attemptId: string;
    attemptNumber: number;
    epoch: number;
    fencingToken: string;
    fencingTokenDigest: string;
    credentialId: string;
    executorId: string;
    executorCapabilityDigest: string;
    leaseExpiresAt: string;
    policySnapshotRef: string;
    policySnapshotDigest: string;
    runningOccurredAt: string;
  };
  now?: () => Date;
  cancelled?: () => boolean;
  buildHostedLifecycleRequestImpl?: typeof buildHostedLifecycleRequestV1;
}): Promise<ClaimedRunExecutionClient> {
  const { client, repo, authority } = input;
  const clock = input.now ?? (() => new Date());
  const buildLifecycleRequest = input.buildHostedLifecycleRequestImpl
    ?? buildHostedLifecycleRequestV1;
  const executionOccurredAt = clock().toISOString();
  // Sequence time follows serialized dispatch. The progress digest uses that
  // same protocol timestamp; journal retries keep sealed bytes.
  let lastSignalAt = Date.parse(authority.runningOccurredAt);
  const nextSignalTime = (observedAt: string) => {
    lastSignalAt = Math.max(lastSignalAt + 1, Date.parse(observedAt), clock().getTime());
    return new Date(lastSignalAt).toISOString();
  };
  // Seal new evidence only after earlier renewals/signals have finished pumping.
  // Retried journal entries retain their original request bytes.
  let lifecycleTail: Promise<unknown> = Promise.resolve();
  const serializeLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleTail.then(operation);
    lifecycleTail = result.catch(() => undefined);
    return result;
  };
  const currentWorkspaceAttestation = async (runId: string,
    value: import("@opentag/core").AttemptWorkspaceAttestationV1 | undefined) => {
    if (!value) return undefined;
    const current = await repo.getHostedExecutionLease({ destinationId: "cloud",
      organizationId: authority.organizationId, runnerId: authority.runnerId,
      credentialId: authority.credentialId, runId, attemptId: authority.attemptId,
      fencingToken: authority.fencingToken });
    if (!current || value.attemptId !== authority.attemptId
      || value.attemptNumber !== authority.attemptNumber
      || value.credentialId !== authority.credentialId
      || value.fencingTokenDigest !== authority.fencingTokenDigest
      || Date.parse(value.leaseExpiresAt) > Date.parse(current.leaseExpiresAt)) {
      throw new Error("hosted_workspace_attestation_authority_mismatch");
    }
    // Only freshness comes from the accepted lease; workspace and fence facts
    // are never replaced. The Control Plane still verifies the full attestation.
    return { ...value, leaseExpiresAt: current.leaseExpiresAt };
  };
  let executionStarted = false;
  const permissionRequests = new Map<string, {
    request: ActionPermissionRequest;
    permissionRequestId: string;
    permissionRequestDigest: string;
    actionDescriptor: "workspace.read" | "workspace.write" | "command.execute"
      | "git.read" | "git.push" | "git.force_push" | "git.target_write"
      | "github.pull_request.create" | "github.pull_request.update"
      | "github.pull_request.merge" | "github.release.create" | "github.branch.delete";
    actionDescriptorDigest: string;
    targetFingerprint: string;
    materialIdempotencyKey: string;
    workspaceAttestationDigest?: string;
  }>();
  const attempt = {
    attemptId: authority.attemptId,
    attemptNumber: authority.attemptNumber,
    epoch: authority.epoch,
    fencingToken: authority.fencingToken,
    fencingTokenDigest: authority.fencingTokenDigest,
  };
  const pumpLifecycle = () => pumpHostedLifecycleOperations({
    repo,
    client,
    destinationId: "cloud",
    organizationId: authority.organizationId,
    leaseOwner: `runner_${authority.runnerId}`,
    now: clock,
    ...(input.cancelled ? { cancelled: input.cancelled } : {}),
  });
  const assertNotCancelled = () => {
    if (input.cancelled?.()) {
      throw new Error("hosted_control_operation_cancelled");
    }
  };
  return {
    async markRunning(runId, executor, lease, options) {
      assertNotCancelled();
      const request = HostedRunningRequestV1Schema.parse(
        await buildLifecycleRequest({
        action: "running",
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        attempt,
        occurredAt: authority.runningOccurredAt,
        executorId: executor,
        executorCapabilityDigest: authority.executorCapabilityDigest,
        ...(options?.runTimeoutMs ? { runTimeoutMs: options.runTimeoutMs } : {}),
        }),
      );
      assertNotCancelled();
      const localInput = {
        destinationId: "cloud",
        organizationId: authority.organizationId,
        credentialId: authority.credentialId,
        runnerId: authority.runnerId,
        runId,
        executor,
        ...lease,
        ...(options?.runTimeoutMs ? { runTimeoutMs: options.runTimeoutMs } : {}),
        request,
      };
      const local = await repo.markHostedRunRunningLocally(localInput);
      assertNotCancelled();
      if (local.outcome !== "running" && local.outcome !== "duplicate") {
        throw new Error("hosted_local_mark_running_split_outcome");
      }
      if (local.operation.state !== "acknowledged") await pumpLifecycle();
      assertNotCancelled();
      const replayed = await repo.markHostedRunRunningLocally(localInput);
      assertNotCancelled();
      if (replayed.operation.state !== "acknowledged") {
        throw new Error("hosted_running_not_acknowledged");
      }
      const acquired = await repo.acquireHostedExecutionStart({
        runId,
        attemptId: lease.attemptId,
        fencingToken: lease.fencingToken,
      });
      assertNotCancelled();
      if (!acquired) throw new Error("hosted_execution_start_not_acquired");
      executionStarted = true;
    },
    async rejectAttemptStart(runId, executorId, _reason, lease) {
      assertNotCancelled();
      const request = HostedRejectStartRequestV1Schema.parse(
        await buildLifecycleRequest({
        action: "reject-start",
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        attempt,
        occurredAt: executionOccurredAt,
        executorId,
        reasonCode: "unknown_safe_failure",
        }),
      );
      assertNotCancelled();
      const local = await repo.rejectHostedAttemptStartLocally({
        destinationId: "cloud",
        organizationId: authority.organizationId,
        credentialId: authority.credentialId,
        runnerId: authority.runnerId,
        runId,
        executorId,
        ...lease,
        request,
      });
      assertNotCancelled();
      if (local.outcome !== "requeued" && local.outcome !== "duplicate") {
        throw new Error("hosted_local_reject_start_split_outcome");
      }
      if (local.operation.state !== "acknowledged") await pumpLifecycle();
      assertNotCancelled();
    },
    async heartbeat(runId, _lease) {
      return serializeLifecycle(async () => {
        assertNotCancelled();
        const journalAuthority = {
          destinationId: "cloud",
          organizationId: authority.organizationId,
          runnerId: authority.runnerId,
          credentialId: authority.credentialId,
          runId,
          attemptId: authority.attemptId,
          fencingToken: authority.fencingToken,
        };
        let operation = await repo.getHostedHeartbeatOperationForRetry(
          journalAuthority,
        );
        assertNotCancelled();
        if (!operation) {
          const currentLease = await repo.getHostedExecutionLease(
            journalAuthority,
          );
          assertNotCancelled();
          if (!currentLease) {
            throw new Error("hosted_execution_authority_expired");
          }
          const request = HostedHeartbeatRequestV1Schema.parse(
            await buildLifecycleRequest({
              action: "heartbeat",
              organizationId: authority.organizationId,
              runnerId: authority.runnerId,
              runId,
              attempt,
              occurredAt: nextSignalTime(clock().toISOString()),
              expectedLeaseExpiresAt: currentLease.leaseExpiresAt,
            }),
          );
          assertNotCancelled();
          operation = (await repo.beginHostedHeartbeatOperation({
            ...journalAuthority,
            request,
          })).operation;
          assertNotCancelled();
        }
        if (operation.state !== "acknowledged") await pumpLifecycle();
        assertNotCancelled();
        const acceptedLease = await repo.getHostedExecutionLease(journalAuthority);
        assertNotCancelled();
        if (
          !acceptedLease
          || Date.parse(acceptedLease.leaseExpiresAt)
            <= Date.parse(operation.request.expectedLeaseExpiresAt)
        ) {
          throw new Error("hosted_heartbeat_receipt_rejected");
        }
      });
    },
    async progress(runId, lease, progress) {
      return serializeLifecycle(async () => {
        assertNotCancelled();
        const workspaceAttestation = await currentWorkspaceAttestation(runId, progress.workspaceAttestation);
        const occurredAt = nextSignalTime(progress.at);
        const progressMetadata = await buildHostedProgressMetadataForControlV1(
          { at: occurredAt },
        );
        assertNotCancelled();
        const request = HostedProgressRequestV1Schema.parse(
          await buildLifecycleRequest({
          action: "progress",
          organizationId: authority.organizationId,
          runnerId: authority.runnerId,
          runId,
          attempt,
          occurredAt,
          ...progressMetadata,
          ...(workspaceAttestation ? { workspaceAttestation } : {}),
          ...(progress.interruptionEvidence
            ? { interruptionEvidence: progress.interruptionEvidence } : {}),
          }),
        );
        assertNotCancelled();
        const local = await repo.recordHostedProgressLocally({
          destinationId: "cloud",
          organizationId: authority.organizationId,
          credentialId: authority.credentialId,
          runnerId: authority.runnerId,
          runId,
          ...lease,
          request,
        });
        assertNotCancelled();
        if (local.operation.state !== "acknowledged") await pumpLifecycle();
        assertNotCancelled();
      });
    },
    async complete(runId, lease, result, evidence) {
      return serializeLifecycle(async () => {
        assertNotCancelled();
        if (!executionStarted) {
          const request = HostedRejectStartRequestV1Schema.parse(
            await buildLifecycleRequest({
              action: "reject-start",
              organizationId: authority.organizationId,
              runnerId: authority.runnerId,
              runId,
              attempt,
              occurredAt: executionOccurredAt,
              executorId: authority.executorId,
              reasonCode: "unknown_safe_failure",
            }),
          );
          assertNotCancelled();
          const rejected = await repo.rejectHostedAttemptStartLocally({
            destinationId: "cloud",
            organizationId: authority.organizationId,
            credentialId: authority.credentialId,
            runnerId: authority.runnerId,
            runId,
            executorId: authority.executorId,
            ...lease,
            request,
          });
          assertNotCancelled();
          if (rejected.outcome !== "requeued" && rejected.outcome !== "duplicate") {
            throw new Error("hosted_local_reject_start_split_outcome");
          }
          if (rejected.operation.state !== "acknowledged") await pumpLifecycle();
          assertNotCancelled();
          return;
        }
        const completionMetadata =
          await buildHostedCompletionMetadataForControlV1(result);
        let blockedPermission: { permissionRequestId: string;
          actionDescriptorDigest: string; policySnapshotDigest: string } | undefined;
        if (completionMetadata.conclusion === "needs_human") {
          const waiting: Array<(typeof permissionRequests extends Map<string, infer T> ? T : never)> = [];
          for (const [actionId, pending] of permissionRequests) {
            const current = await client.getActionPermissionCurrentControlV1({
              organizationId: authority.organizationId, runnerId: authority.runnerId,
              runId, actionId, attempt: { attemptId: attempt.attemptId,
                attemptNumber: attempt.attemptNumber, epoch: attempt.epoch,
                fencingTokenDigest: attempt.fencingTokenDigest },
              permissionRequestId: pending.permissionRequestId,
              permissionRequestDigest: pending.permissionRequestDigest,
            });
            if (current.receipt.payload.state === "waiting") waiting.push(pending);
          }
          if (waiting.length !== 1) throw new Error("hosted_needs_human_permission_link_missing");
          blockedPermission = { permissionRequestId: waiting[0]!.permissionRequestId,
            actionDescriptorDigest: waiting[0]!.actionDescriptorDigest,
            policySnapshotDigest: authority.policySnapshotDigest };
        }
        assertNotCancelled();
        const workspaceAttestation = await currentWorkspaceAttestation(runId, evidence?.workspaceAttestation);
        const request = HostedCompleteRequestV1Schema.parse(
          await buildLifecycleRequest({
            action: "complete",
            organizationId: authority.organizationId,
            runnerId: authority.runnerId,
            runId,
            attempt,
            occurredAt: executionOccurredAt,
            ...completionMetadata,
            ...(blockedPermission ? { blockedPermission } : {}),
            ...(workspaceAttestation ? { workspaceAttestation } : {}),
            ...(evidence?.interruptionEvidence
              ? { interruptionEvidence: evidence.interruptionEvidence } : {}),
          }),
        );
        assertNotCancelled();
        const outcome = await repo.completeHostedRunLocally({
          destinationId: "cloud",
          organizationId: authority.organizationId,
          credentialId: authority.credentialId,
          runnerId: authority.runnerId,
          runId,
          ...lease,
          result,
          request,
        });
        assertNotCancelled();
        if (outcome !== "completed" && outcome !== "duplicate") {
          throw new Error("hosted_local_complete_split_outcome");
        }
      });
    },
    async requestActionPermission(runId, lease, request) {
      assertNotCancelled();
      const actionId = `action_${(await computeControlPayloadDigestV1({
        runId,
        attemptId: lease.attemptId,
        toolCallId: request.toolCallId,
      })).slice("sha256:".length, "sha256:".length + 24)}`;
      assertNotCancelled();
      const permissionRequestId = `permission_${(await computeControlPayloadDigestV1({
        actionId,
        request,
      })).slice("sha256:".length, "sha256:".length + 24)}`;
      assertNotCancelled();
      const requestedAt = new Date().toISOString();
      const actionFamily = request.operation.toLowerCase().replace(/[^a-z0-9._-]/gu, "_").slice(0, 64) || "tool";
      const actionDescriptor = (() => {
        const normalized = actionFamily.replaceAll("_", ".");
        const exact = new Map<string, "workspace.read" | "workspace.write" | "command.execute"
          | "git.read" | "git.push" | "git.force_push" | "git.target_write"
          | "github.pull_request.create" | "github.pull_request.update"
          | "github.pull_request.merge" | "github.release.create" | "github.branch.delete">([
          ["read", "workspace.read"], ["list", "workspace.read"], ["search", "workspace.read"],
          ["write", "workspace.write"], ["edit", "workspace.write"], ["patch", "workspace.write"],
          ["execute", "command.execute"], ["command", "command.execute"], ["shell", "command.execute"],
          ["git.read", "git.read"], ["git.push", "git.push"],
          ["git.force.push", "git.force_push"], ["git.target.write", "git.target_write"],
          ["publish", "github.pull_request.create"],
          ["github.pull.request.create", "github.pull_request.create"],
          ["github.pull.request.update", "github.pull_request.update"],
          ["merge", "github.pull_request.merge"],
          ["github.pull.request.merge", "github.pull_request.merge"],
          ["release", "github.release.create"],
          ["github.release.create", "github.release.create"],
          ["branch.delete", "github.branch.delete"],
          ["github.branch.delete", "github.branch.delete"],
        ]);
        const capability = exact.get(normalized);
        if (!capability) throw new Error("permission_action_capability_unknown");
        return capability;
      })();
      const actionDescriptorDigest = await computeControlPayloadDigestV1(actionDescriptor);
      const materialIdempotencyKey = `material_begin_${(await computeControlPayloadDigestV1({
        runId, actionId, permissionRequestId,
      })).slice("sha256:".length, "sha256:".length + 32)}`;
      const targetFingerprint = request.targetFingerprint
        ?? await computeControlPayloadDigestV1({
          connectionId: request.connectionId,
          operation: request.operation,
          resource: request.resource ?? null,
          targetConstraints: request.targetConstraints ?? null,
        });
      assertNotCancelled();
      const digestInput = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        requiredCapabilities: ["relay.permission.v1"] as ["relay.permission.v1"],
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        attempt: {
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          epoch: attempt.epoch,
          fencingTokenDigest: attempt.fencingTokenDigest,
        },
        permissionRequestId,
        actionId,
        actionDescriptor,
        actionDescriptorDigest,
        riskTier: "high" as const,
        targetFingerprint,
        policySnapshotRef: authority.policySnapshotRef,
        policySnapshotDigest: authority.policySnapshotDigest,
        ...(request.workspaceAttestationDigest
          ? { workspaceAttestationDigest: request.workspaceAttestationDigest } : {}),
        requestedAt,
      };
      const permissionRequestDigest = await computePermissionRequestDigestV1(digestInput);
      assertNotCancelled();
      const result = await client.requestActionPermissionControlV1({
        ...digestInput,
        requestId: permissionRequestId,
        operationId: permissionRequestId,
        attempt,
        permissionRequestDigest,
      });
      assertNotCancelled();
      const pending = { request, permissionRequestId, permissionRequestDigest,
        actionDescriptor, actionDescriptorDigest, targetFingerprint,
        materialIdempotencyKey,
        ...(request.workspaceAttestationDigest
          ? { workspaceAttestationDigest: request.workspaceAttestationDigest } : {}) };
      permissionRequests.set(actionId, pending);
      return permissionResolutionFromReceipt({ receipt: result.receipt, request });
    },
    async resolveActionPermission(runId, _lease, actionId) {
      assertNotCancelled();
      const pending = permissionRequests.get(actionId);
      if (!pending) throw new Error("hosted_permission_request_unknown");
      const result = await client.getActionPermissionCurrentControlV1({
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        actionId,
        attempt: {
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          epoch: attempt.epoch,
          fencingTokenDigest: attempt.fencingTokenDigest,
        },
        permissionRequestId: pending.permissionRequestId,
        permissionRequestDigest: pending.permissionRequestDigest,
      });
      assertNotCancelled();
      return permissionResolutionFromReceipt({ receipt: result.receipt, request: pending.request });
    },
    async confirmActionPermission(runId, _lease, actionId) {
      assertNotCancelled();
      const pending = permissionRequests.get(actionId);
      if (!pending) throw new Error("hosted_permission_request_unknown");
      const result = await client.getActionPermissionCurrentControlV1({
        organizationId: authority.organizationId, runnerId: authority.runnerId,
        runId, actionId, attempt: { attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber, epoch: attempt.epoch,
          fencingTokenDigest: attempt.fencingTokenDigest },
        permissionRequestId: pending.permissionRequestId,
        permissionRequestDigest: pending.permissionRequestDigest,
      });
      assertNotCancelled();
      if (result.receipt.payload.state === "authorized") {
        await client.beginMaterialActionControlV1({ schemaVersion: 1,
          protocolVersion: "1.0", requiredCapabilities: ["relay.material-receipt.v1"],
          requestId: pending.materialIdempotencyKey,
          operationId: pending.materialIdempotencyKey,
          organizationId: authority.organizationId, runnerId: authority.runnerId,
          runId, attempt, actionId, actionDescriptor: pending.actionDescriptor,
          actionDescriptorDigest: pending.actionDescriptorDigest,
          targetFingerprint: pending.targetFingerprint,
          policySnapshotRef: authority.policySnapshotRef,
          policySnapshotDigest: authority.policySnapshotDigest,
          ...(pending.workspaceAttestationDigest
            ? { workspaceAttestationDigest: pending.workspaceAttestationDigest } : {}),
          authority: { kind: "permission_resolution",
            permissionRequestId: pending.permissionRequestId,
            permissionRequestDigest: pending.permissionRequestDigest,
            resolutionReceiptId: result.receipt.receiptId,
            resolutionReceiptDigest: result.receipt.receiptDigest,
            ...(pending.workspaceAttestationDigest
              ? { workspaceAttestationDigest: pending.workspaceAttestationDigest } : {}) },
          idempotencyKey: pending.materialIdempotencyKey, begunAt: clock().toISOString() });
      }
      return permissionResolutionFromReceipt({ receipt: result.receipt,
        request: pending.request });
    },
    async recordMaterialActionReceipt(runId, _lease, actionId, receipt: MaterialActionReceipt) {
      assertNotCancelled();
      const pending = permissionRequests.get(actionId);
      if (!pending) throw new Error("hosted_material_action_permission_unknown");
      if (receipt.targetFingerprint !== undefined
        && receipt.targetFingerprint !== pending.targetFingerprint) {
        throw new Error("hosted_material_action_target_mismatch");
      }
      const observedAt = receipt.observedAt;
      const operationId = `material_${receipt.id}`;
      const localWriteObservation = receipt.metadata?.localWriteObservation === undefined ? undefined
        : LocalWorkspaceWriteObservationV1Schema.parse(receipt.metadata.localWriteObservation);
      if (localWriteObservation && (pending.actionDescriptor !== "workspace.write"
        || receipt.provider !== "local_workspace" || receipt.outcome !== "succeeded"
        || localWriteObservation.targetFingerprint !== pending.targetFingerprint)) {
        throw new Error("hosted_local_write_observation_scope_mismatch");
      }
      const payload = {
        actionId,
        actionDescriptor: pending.actionDescriptor,
        actionDescriptorDigest: pending.actionDescriptorDigest,
        idempotencyKey: pending.materialIdempotencyKey,
        provider: receipt.provider,
        connectionRef: receipt.connectionId ?? pending.request.connectionId,
        targetFingerprint: pending.targetFingerprint,
        operationId,
        requestDigest: pending.permissionRequestDigest,
        actionPayloadDigest: await computeControlPayloadDigestV1(localWriteObservation ?? receipt.metadata ?? {}),
        ...(localWriteObservation ? { localWriteObservation } : {}),
        outcome: receipt.outcome === "unknown" ? "outcome_unknown" as const : receipt.outcome,
        ...(receipt.externalId ? { externalId: receipt.externalId } : {}),
        ...(receipt.externalUri ? { externalUri: receipt.externalUri } : {}),
        observedAt,
        reasonCode: localWriteObservation ? "local_write_observed" as const : receipt.outcome === "succeeded"
          ? "provider_accepted" as const
          : receipt.outcome === "failed"
            ? "provider_error" as const
            : "provider_receipt_missing" as const,
        ...(receipt.outcome === "unknown"
          ? { nextAction: "reconcile_provider_receipt", owner: "local_operator" }
          : {}),
      };
      assertNotCancelled();
      const receiptId = receipt.id;
      const envelopeBase = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        receiptKind: "material_action" as const,
        receiptId,
        organizationId: authority.organizationId,
        operationId,
        requiredCapabilities: ["relay.material-receipt.v1"] as ["relay.material-receipt.v1"],
        producer: { kind: "local_opentag" as const, id: authority.runnerId },
        identity: {
          namespace: "opentag.control.receipt/material-action/v1" as const,
          parts: [authority.organizationId, runId, attempt.attemptId, actionId, receiptId],
        },
        observedAt,
        runId,
        attempt: {
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          epoch: attempt.epoch,
          fencingTokenDigest: attempt.fencingTokenDigest,
        },
        payload,
        payloadDigest: await computeMaterialActionPayloadDigestV1(payload),
      };
      assertNotCancelled();
      const envelope = {
        ...envelopeBase,
        receiptDigest: await computeMaterialActionReceiptDigestV1(envelopeBase),
      };
      assertNotCancelled();
      await client.recordMaterialActionReceiptControlV1({
        runnerId: authority.runnerId,
        fencingToken: attempt.fencingToken,
        receipt: envelope,
      });
      assertNotCancelled();
      const resolved = await client.getActionPermissionCurrentControlV1({
        organizationId: authority.organizationId,
        runnerId: authority.runnerId,
        runId,
        actionId,
        attempt: {
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
          epoch: attempt.epoch,
          fencingTokenDigest: attempt.fencingTokenDigest,
        },
        permissionRequestId: pending.permissionRequestId,
        permissionRequestDigest: pending.permissionRequestDigest,
      });
      assertNotCancelled();
      return permissionResolutionFromReceipt({ receipt: resolved.receipt, request: pending.request });
    },
  };
}

export function createHostedControlLoop(input: {
  config: OpenTagDaemonConfig;
  databasePath: string;
  executors: Record<string, ExecutorAdapter>;
  security?: RunnerSecurityPolicy;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  controlClient?: OpenTagClient;
  governanceStore?: {
    repo: HostedExecutionRepository;
    close(): void;
  };
  executeClaimedRunImpl?: typeof executeClaimedRun;
  buildHostedLifecycleRequestImpl?: typeof buildHostedLifecycleRequestV1;
  closeDrainTimeoutMs?: number;
}): HostedControlLoop {
  const registration = input.config.controlRegistration;
  if (!registration || registration.state !== "paired" || !input.config.runnerToken) {
    throw new Error("paired_control_registration_required");
  }
  const store = input.governanceStore
    ?? openLocalGovernanceStore(input.databasePath);
  const repo = store.repo as HostedExecutionRepository;
  const abortController = new AbortController();
  const client = input.controlClient ?? createOpenTagClient({
    controlPlaneUrl: input.config.relayUrl,
    controlCredential: { kind: "runtime", token: input.config.runnerToken },
    controlSignal: abortController.signal,
  });
  const clock = input.now ?? (() => new Date());
  let context: RunnerControlContextResponseV1 | undefined;
  const readinessProbeCache = new Map<string, {
    expiresAt: number;
    readiness: Awaited<ReturnType<ExecutorAdapter["canRun"]>>;
  }>();
  let inFlight: Promise<unknown> | undefined;
  let closed = false;
  const effectAdapter = createGitHubDraftPullRequestEffectAdapter({
    repositories: input.config.repositories,
    ...(input.config.githubToken ? { githubToken: input.config.githubToken } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    now: clock,
  });
  let effectExecutor: LocalEffectExecutor | undefined;
  let effectExecutorGeneration: number | undefined;
  const currentEffectExecutor = () => {
    if (!context) throw new Error("runner_control_context_missing");
    if (!effectExecutor || effectExecutorGeneration !== context.credentialGeneration) {
      effectExecutorGeneration = context.credentialGeneration;
      effectExecutor = new LocalEffectExecutor({
        organizationId: context.organizationId,
        runnerId: context.runnerId,
        runnerGeneration: context.credentialGeneration,
        repository: repo,
        client,
        adapter: effectAdapter,
        leaseOwner: `runner_effect_${context.runnerId}_${context.credentialGeneration}`,
        now: clock,
        signal: abortController.signal,
        isWorkAuthorityCurrent: async (permit: EffectPermitV1) => {
          if (!context
            || context.organizationId !== permit.organizationId
            || context.runnerId !== permit.runnerId
            || context.credentialGeneration !== permit.runnerGeneration) {
            return false;
          }
          const target = context.targets.find((candidate) =>
            candidate.projectTargetId === permit.target.projectTargetId
            && candidate.bindingDigest === permit.target.targetBindingDigest
            && candidate.bindingGeneration === permit.target.targetBindingGeneration
            && candidate.provider === permit.target.provider
            && candidate.owner.toLowerCase() === permit.target.owner.toLowerCase()
            && candidate.repo.toLowerCase() === permit.target.repo.toLowerCase()
            && candidate.defaultBranch === permit.target.baseBranch);
          if (!target) return false;
          const authority = await repo.getHostedSucceededPublicationAuthority({
            destinationId: "cloud",
            organizationId: permit.organizationId,
            runnerId: permit.runnerId,
            runId: permit.runId,
            attemptId: permit.runAttemptId,
            fencingTokenDigest: permit.fencingTokenDigest,
          });
          return authority?.attemptNumber === permit.runAttemptNumber;
        },
      });
    }
    return effectExecutor;
  };
  const pump = async () => {
    if (!context) return;
    await pumpHostedLifecycleOperations({
      repo,
      client,
      destinationId: "cloud",
      organizationId: context.organizationId,
      leaseOwner: `runner_${input.config.runnerId}`,
      now: clock,
      cancelled: () => closed,
    });
    if (closed) return;
    await pumpControlPlaneProjections({
      repo,
      client,
      destinationId: "cloud",
      organizationId: context.organizationId,
      leaseOwner: `runner_${input.config.runnerId}`,
      now: clock,
      cancelled: () => closed,
    });
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    inFlight = operation;
    return operation.finally(() => {
      if (inFlight === operation) inFlight = undefined;
    });
  };
  return {
    beforeIteration() {
      return track((async () => {
        const nextContext = await client.getRunnerControlContextV1({
          runnerId: input.config.runnerId,
        });
        if (closed) return false;
        assertRunnerControlContextRegistrationV1({
          context: nextContext,
          registration,
        });
        // Read the clock after the response so network delay cannot make stale
        // authority appear current.
        if (!isRunnerControlContextFreshV1(nextContext.observedAt, clock())) {
          throw new Error("runner_control_context_stale");
        }
        context = nextContext;
        if (context.capabilities.includes("relay.effect-authority.v1")) {
          const recoveredEffect = await currentEffectExecutor().recoverOnce();
          if (closed || recoveredEffect.outcome !== "idle") {
            return recoveredEffect.outcome !== "idle";
          }
        }
        const proposalSettlement = await repo.getHostedProposalSettlementForRetry({
          destinationId: "cloud", organizationId: context.organizationId,
          runnerId: context.runnerId,
        });
        if (closed) return false;
        if (proposalSettlement) {
          const settled = await client.settleProposalCandidateControlV1({
            schemaVersion: 1, protocolVersion: "1.0",
            requiredCapabilities: ["relay.lifecycle.v1"],
            requestId: `request_settle_${proposalSettlement.candidateId}`,
            organizationId: context.organizationId, runnerId: context.runnerId,
            runId: proposalSettlement.runId,
            attempt: { attemptId: proposalSettlement.attemptId,
              attemptNumber: proposalSettlement.attemptNumber,
              epoch: proposalSettlement.attemptNumber,
              fencingToken: proposalSettlement.fencingToken,
              fencingTokenDigest: proposalSettlement.fencingTokenDigest },
            candidateId: proposalSettlement.candidateId,
            proposalArtifact: proposalSettlement.proposalArtifact,
          });
          if (settled.candidateId !== proposalSettlement.candidateId) {
            throw new Error("proposal_settlement_identity_mismatch");
          }
          if (settled.status === "publication_pending") {
            if (!context.capabilities.includes("relay.effect-authority.v1")) {
              throw new Error("effect_authority_capability_missing");
            }
            const target = context.targets.find((candidate) =>
              candidate.projectTargetId === proposalSettlement.projectTargetId
                && candidate.bindingDigest === proposalSettlement.targetBindingDigest);
            const binding = target ? input.config.repositories.find((candidate) => {
              const actual = canonicalRepositoryIdentity(candidate);
              return candidate.projectTargetId === target.projectTargetId
                && actual.provider === target.provider && actual.owner === target.owner
                && actual.repo === target.repo;
            }) : null;
            if (!target || !binding) {
              throw new Error("publication_effect_local_authority_missing");
            }
            const proposalCreatedAt = proposalSettlement.proposalArtifact.createdAt;
            if (typeof proposalCreatedAt !== "string") {
              throw new Error("publication_effect_requested_at_missing");
            }
            const effectRequest = await buildPublicationEffectRequest({
              organizationId: context.organizationId,
              runnerId: context.runnerId,
              runnerGeneration: context.credentialGeneration,
              settlement: {
                ...proposalSettlement,
                candidateDigest: settled.candidateDigest,
                proposalCreatedAt,
              },
              target,
              binding,
              now: clock(),
            });
            const effect = await client.requestEffectControlV1(effectRequest);
            if (effect.effectId !== effectRequest.effectId) {
              throw new Error("publication_effect_identity_mismatch");
            }
          }
          await repo.markHostedProposalSettlementHandled({
            destinationId: "cloud",
            organizationId: context.organizationId,
            runnerId: context.runnerId,
            runId: proposalSettlement.runId,
            candidateId: proposalSettlement.candidateId,
            now: clock(),
          });
          return true;
        }
        if (context.capabilities.includes("relay.effect-authority.v1")) {
          const effect = await currentEffectExecutor().runOnce();
          if (closed || effect.outcome !== "idle") return effect.outcome !== "idle";
        }
        const preImportRecovery =
          await repo.getHostedPreImportAuthorityRecovery({
            destinationId: "cloud",
            organizationId: context.organizationId,
            runnerId: context.runnerId,
          });
        if (closed) return false;
        if (preImportRecovery?.state === "reject_attention") return false;
        if (preImportRecovery?.state === "reject_pending") {
          await pumpHostedLifecycleOperations({
            repo,
            client,
            destinationId: "cloud",
            organizationId: context.organizationId,
            leaseOwner: `runner_${input.config.runnerId}`,
            now: clock,
            cancelled: () => closed,
          });
          return false;
        }
        const existing = preImportRecovery?.state === "claim_retry"
          ? preImportRecovery.operation
          : await repo.getHostedClaimOperationForRetry({
            destinationId: "cloud",
            organizationId: context.organizationId,
            runnerId: context.runnerId,
          });
        if (closed) return false;
        await pumpHostedLifecycleOperations({
          repo,
          client,
          destinationId: "cloud",
          organizationId: context.organizationId,
          leaseOwner: `runner_${input.config.runnerId}`,
          now: clock,
          cancelled: () => closed,
        });
        if (closed) return false;
        const localReadiness = await buildRunnerReadinessReceipt({
          context,
          executors: input.executors,
          repositories: input.config.repositories,
          now: clock,
          readinessProbeCache,
        });
        if (closed) return false;
        const recovery = await repo.getHostedAssignedRunForRecovery({
          destinationId: "cloud",
          organizationId: context.organizationId,
          runnerId: context.runnerId,
        });
        if (closed) return false;
        if (recovery) {
          const authority = recovery.hostedAuthority;
          const target = context.targets.find(
            (candidate) => candidate.projectTargetId === authority.projectTargetId,
          );
          const readyTarget = localReadiness.payload.targets.find(
            (candidate) => candidate.projectTargetId === authority.projectTargetId,
          );
          const readyExecutor = localReadiness.payload.executors.find(
            (candidate) => candidate.executorId === authority.executorId,
          );
          if (
            authority.organizationId !== context.organizationId
            || authority.runnerId !== context.runnerId
            || authority.credentialId !== context.credentialId
            || authority.registrationGeneration !== context.registrationGeneration
            || authority.credentialGeneration !== context.credentialGeneration
            || !target
            || target.bindingDigest !== authority.targetBindingDigest
            || target.defaultExecutor !== authority.executorId
            || readyTarget?.state !== "ready"
            || readyExecutor?.state !== "ready"
            || readyExecutor.capabilityDigest !== authority.executorCapabilityDigest
          ) {
            throw new Error("hosted_recovery_current_authority_mismatch");
          }
          const executionClient = await createHostedExecutionClient({
            client,
            repo,
            now: clock,
            cancelled: () => closed,
            ...(input.buildHostedLifecycleRequestImpl
              ? { buildHostedLifecycleRequestImpl: input.buildHostedLifecycleRequestImpl }
              : {}),
            authority: {
              organizationId: authority.organizationId,
              runnerId: authority.runnerId,
              credentialId: authority.credentialId,
              executorId: authority.executorId,
              attemptId: authority.attemptId,
              attemptNumber: authority.attemptNumber,
              epoch: authority.epoch,
              fencingToken: recovery.claimed.fencingToken,
              fencingTokenDigest: authority.fencingTokenDigest,
              executorCapabilityDigest: authority.executorCapabilityDigest,
              leaseExpiresAt: recovery.leaseExpiresAt,
              policySnapshotRef: authority.admissionPolicySnapshotId,
              policySnapshotDigest: authority.policyReceiptDigest,
              runningOccurredAt: authority.importedAt,
            },
          });
          if (closed) return false;
          await (input.executeClaimedRunImpl ?? executeClaimedRun)({
            runnerId: context.runnerId,
            repositories: input.config.repositories,
            executors: input.executors,
            scratchRoot: input.config.scratchRoot,
            keepScratch: input.config.keepScratch,
            approvalMode: input.config.approvalMode,
            ...(input.security ? { security: input.security } : {}),
            ...(input.config.heartbeatIntervalMs ? { heartbeatIntervalMs: input.config.heartbeatIntervalMs } : {}),
            ...(input.config.runTimeoutMs ? { runTimeoutMs: input.config.runTimeoutMs } : {}),
            ...(input.config.agentSessionProfile ? { agentSessionProfile: input.config.agentSessionProfile } : {}),
            client: executionClient,
            claimed: recovery.claimed,
            hostedExecutionAuthority: {
              leaseExpiresAt: recovery.leaseExpiresAt,
              now: clock,
              assertCurrent: async () => {
                if (closed) return false;
                const current = await repo.isHostedExecutionCurrent({
                  runId: recovery.claimed.run.id,
                  attemptId: recovery.claimed.attemptId,
                  fencingToken: recovery.claimed.fencingToken,
                });
                return !closed && current;
              },
              readAcceptedLeaseExpiresAt: async () => {
                if (closed) return null;
                const lease = await repo.getHostedExecutionLease({
                  destinationId: "cloud",
                  organizationId: authority.organizationId,
                  runnerId: authority.runnerId,
                  credentialId: authority.credentialId,
                  runId: recovery.claimed.run.id,
                  attemptId: recovery.claimed.attemptId,
                  fencingToken: recovery.claimed.fencingToken,
                });
                return closed ? null : lease?.leaseExpiresAt ?? null;
              },
            },
          });
          return !closed;
        }
        let operation = existing;
        let readinessValidation: RunnerReadinessReceiptEnvelopeV1;
        if (operation) {
          // Once an operation exists, Cloud owns reconciliation. This includes
          // persisted operations whose accepted readiness predates the local
          // projection outbox and requests whose first response was lost. The
          // exact persisted request must be replayed regardless of local TTL.
          // Its expectedAuthority remains the sole accepted-readiness
          // reference; this fresh local receipt is used only to validate that
          // the returned claim's target and executor are currently runnable.
          readinessValidation = localReadiness;
        } else {
          const latest = await repo.getLatestRunnerReadinessProjection({
            destinationId: "cloud",
            organizationId: context.organizationId,
            runnerId: context.runnerId,
          });
          let readinessEntry = latest;
          if (
            latest
            && latest.receiptKind === "runner_readiness"
            && hasSameRunnerReadinessAuthorityV1(
              RunnerReadinessReceiptEnvelopeV1Schema.parse(latest.envelope),
              localReadiness,
            )
          ) {
            const window = runnerReadinessReuseWindowV1(
              RunnerReadinessReceiptEnvelopeV1Schema.parse(latest.envelope),
              clock(),
            );
            if (window === "final_window") return false;
            if (window === "expired") readinessEntry = null;
          } else {
            readinessEntry = null;
          }
          if (!readinessEntry) {
            const enqueued = await repo.enqueueControlPlaneProjection({
              destinationId: "cloud",
              envelope: localReadiness,
              now: clock(),
            });
            if (enqueued.outcome === "conflict") {
              throw new Error("runner_readiness_projection_conflict");
            }
            readinessEntry = enqueued.entry;
          }
          if (readinessEntry.state !== "acknowledged") {
            await pumpControlPlaneProjections({
              repo,
              client,
              destinationId: "cloud",
              organizationId: context.organizationId,
              leaseOwner: `runner_${input.config.runnerId}`,
              now: clock,
              cancelled: () => closed,
            });
          }
          if (closed) return false;
          const exact = await repo.getControlPlaneProjection({
            destinationId: "cloud",
            organizationId: context.organizationId,
            receiptId: readinessEntry.receiptId,
          });
          if (
            !exact
            || exact.receiptKind !== "runner_readiness"
            || exact.state !== "acknowledged"
            || exact.receiptDigest !== readinessEntry.receiptDigest
          ) return false;
          readinessValidation = RunnerReadinessReceiptEnvelopeV1Schema.parse(
            exact.envelope,
          );
          if (
            !hasSameRunnerReadinessAuthorityV1(
              readinessValidation,
              localReadiness,
            )
            || runnerReadinessReuseWindowV1(readinessValidation, clock())
              !== "reusable"
          ) return false;
          operation = (await repo.beginHostedClaimOperation({
            destinationId: "cloud",
            organizationId: context.organizationId,
            runnerId: context.runnerId,
            request: buildHostedClaimRequestV1({
              context,
              readiness: readinessValidation,
              requestId: `request_${randomUUID()}`,
              operationId: `operation_${randomUUID()}`,
            }),
          })).operation;
        }
        if (closed) return false;
        let claim: HostedClaimV1 | null;
        try {
          claim = await client.claimHostedRunControlV1({
            runnerId: context.runnerId,
            request: operation.request,
          });
        } catch (error) {
          if (closed) return false;
          const controlError = error as { status?: unknown; code?: unknown };
          if (
            controlError.status === 409
            && (controlError.code === "stale_control_authority"
              || controlError.code === "operation_digest_conflict")
            && operation.state !== "claimed"
          ) {
            await repo.abandonHostedClaimOperation({
              operationId: operation.operationId,
              requestId: operation.requestId,
              reasonCode: controlError.code,
            });
          }
          throw error;
        }
        if (closed) return false;
        if (!claim) {
          await repo.acknowledgeHostedClaimEmpty({
            operationId: operation.operationId,
            requestId: operation.requestId,
          });
          return false;
        }
        await assertHostedClaimRequestBindingV1({
          claim,
          request: operation.request,
        });
        if (closed) return false;
        await repo.persistHostedClaimAuthorityShell({
          destinationId: "cloud",
          credentialId: claim.authority.credentialId,
          request: operation.request,
          claim,
        });
        if (closed) return false;
        let imported: Awaited<ReturnType<HostedExecutionRepository["importHostedAssignedRun"]>>;
        try {
          // Persist first: any subsequent current-authority mismatch must be
          // reconciled as a durable reject-start from the claimed shell, never
          // through the pending-operation abandon transition.
          await assertHostedClaimCurrentAuthorityV1({
            claim,
            context,
            readiness: readinessValidation,
            request: operation.request,
            now: clock(),
          });
          if (closed) return false;
          const redeemed = await redeemHostedClaimSourceContentV1({
            claim,
            client,
            requestId: `request_redeem_${randomUUID()}`,
            operationId: `operation_redeem_${randomUUID()}`,
            now: clock,
          });
          if (closed) return false;
          if (Date.parse(claim.attempt.leaseExpiresAt) <= clock().getTime()) {
            throw new Error("hosted_claim_lease_expired");
          }
          imported = await repo.importHostedAssignedRun({
            event: redeemed.event,
            claim,
            sourceReceipt: redeemed.receipt,
          });
        } catch (error) {
          if (closed) return false;
          // A rejection is itself fenced lifecycle mutation. Never emit it
          // after expiry or when the current Cloud authority was not verified.
          if (Date.parse(claim.attempt.leaseExpiresAt) > clock().getTime()) {
            const request = HostedRejectStartRequestV1Schema.parse(
              await (input.buildHostedLifecycleRequestImpl
                ?? buildHostedLifecycleRequestV1)({
              organizationId: claim.organizationId,
              runnerId: claim.runnerId,
              runId: claim.runId,
              action: "reject-start",
              attempt: {
                attemptId: claim.attempt.id,
                attemptNumber: claim.attempt.number,
                epoch: claim.attempt.epoch,
                fencingToken: claim.attempt.fencingToken,
                fencingTokenDigest: claim.attempt.fencingTokenDigest,
              },
              occurredAt: clock().toISOString(),
              executorId: claim.executorId,
              reasonCode: "unknown_safe_failure",
              }),
            );
            if (closed) return false;
            const rejected = await repo.rejectHostedAttemptStartLocally({
              destinationId: "cloud",
              organizationId: claim.organizationId,
              credentialId: claim.authority.credentialId,
              runnerId: claim.runnerId,
              runId: claim.runId,
              attemptId: claim.attempt.id,
              fencingToken: claim.attempt.fencingToken,
              executorId: claim.executorId,
              request,
            });
            if (closed) return false;
            if (rejected.operation.state !== "acknowledged") {
              await pumpHostedLifecycleOperations({
                repo,
                client,
                destinationId: "cloud",
                organizationId: claim.organizationId,
                leaseOwner: `runner_${claim.runnerId}`,
                now: clock,
                cancelled: () => closed,
              });
              if (closed) return false;
            }
          }
          throw error;
        }
        if (closed) return false;
        if (Date.parse(claim.attempt.leaseExpiresAt) <= clock().getTime()) {
          throw new Error("hosted_claim_lease_expired_after_import");
        }
        if (imported.executionState !== "ready_to_start") return false;
        if (!imported.claimed) {
          throw new Error("hosted_import_ready_without_claimed_run");
        }
        const executionClient = await createHostedExecutionClient({
          client,
          repo,
          now: clock,
          cancelled: () => closed,
          ...(input.buildHostedLifecycleRequestImpl
            ? { buildHostedLifecycleRequestImpl: input.buildHostedLifecycleRequestImpl }
            : {}),
          authority: {
            organizationId: claim.organizationId,
            runnerId: claim.runnerId,
            credentialId: claim.authority.credentialId,
            executorId: claim.executorId,
            attemptId: claim.attempt.id,
            attemptNumber: claim.attempt.number,
            epoch: claim.attempt.epoch,
            fencingToken: claim.attempt.fencingToken,
            fencingTokenDigest: claim.attempt.fencingTokenDigest,
            executorCapabilityDigest: claim.authority.executorCapabilityDigest,
            leaseExpiresAt: claim.attempt.leaseExpiresAt,
            policySnapshotRef: claim.admissionPolicySnapshot.payload.snapshotId,
            policySnapshotDigest: claim.admissionPolicySnapshot.receiptDigest,
            runningOccurredAt: imported.hostedAuthority.importedAt,
          },
        });
        if (closed) return false;
        await (input.executeClaimedRunImpl ?? executeClaimedRun)({
          runnerId: claim.runnerId,
          repositories: input.config.repositories,
          executors: input.executors,
          scratchRoot: input.config.scratchRoot,
          keepScratch: input.config.keepScratch,
          approvalMode: input.config.approvalMode,
          ...(input.security ? { security: input.security } : {}),
          ...(input.config.heartbeatIntervalMs ? { heartbeatIntervalMs: input.config.heartbeatIntervalMs } : {}),
          ...(input.config.runTimeoutMs ? { runTimeoutMs: input.config.runTimeoutMs } : {}),
          ...(input.config.agentSessionProfile ? { agentSessionProfile: input.config.agentSessionProfile } : {}),
          client: executionClient,
          claimed: imported.claimed,
          hostedExecutionAuthority: {
            leaseExpiresAt: claim.attempt.leaseExpiresAt,
            credentialId: claim.authority.credentialId,
            attemptNumber: claim.attempt.number,
            fencingTokenDigest: claim.attempt.fencingTokenDigest,
            now: clock,
            assertCurrent: async () => {
              if (closed) return false;
              const current = await repo.isHostedExecutionCurrent({
                runId: claim.runId,
                attemptId: claim.attempt.id,
                fencingToken: claim.attempt.fencingToken,
              });
              return !closed && current;
            },
            readAcceptedLeaseExpiresAt: async () => {
              if (closed) return null;
              const lease = await repo.getHostedExecutionLease({
                destinationId: "cloud",
                organizationId: claim.organizationId,
                runnerId: claim.runnerId,
                credentialId: claim.authority.credentialId,
                runId: claim.runId,
                attemptId: claim.attempt.id,
                fencingToken: claim.attempt.fencingToken,
              });
              return closed ? null : lease?.leaseExpiresAt ?? null;
            },
          },
        });
        return !closed;
      })());
    },
    afterIteration() {
      return track(pump());
    },
    abort() {
      abortController.abort();
    },
    async close() {
      if (closed) return;
      closed = true;
      const drainTimeoutMs = Math.max(
        0,
        input.closeDrainTimeoutMs ?? DEFAULT_CLOSE_DRAIN_TIMEOUT_MS,
      );
      const settleWithin = async (operation: Promise<unknown>) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        try {
          settled = await Promise.race([
            operation.then(
              () => true,
              () => true,
            ),
            new Promise<false>((resolve) => {
              timeout = setTimeout(() => resolve(false), drainTimeoutMs);
            }),
          ]);
        } catch {
          // Durable journals retain unacknowledged work for restart replay.
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        return settled;
      };
      let storeClosed = false;
      const closeStoreOnce = () => {
        if (storeClosed) return;
        storeClosed = true;
        store.close();
      };
      const active = inFlight;
      if (active) {
        // Abort a possibly stuck transport before bounded draining. The
        // durable lifecycle journal is the shutdown/restart handoff.
        abortController.abort();
        if (await settleWithin(active)) closeStoreOnce();
        else void active.finally(closeStoreOnce).catch(() => undefined);
      } else if (context) {
        // The client remains usable for one bounded best-effort transfer. The
        // repository only acknowledges after a verified Cloud receipt.
        let shutdownPumpCancelled = false;
        const shutdownPump = pumpHostedLifecycleOperations({
          repo,
          client,
          destinationId: "cloud",
          organizationId: context.organizationId,
          leaseOwner: `runner_${input.config.runnerId}`,
          limit: 1,
          now: clock,
          cancelled: () => shutdownPumpCancelled,
        });
        const settled = await settleWithin(shutdownPump);
        shutdownPumpCancelled = !settled;
        abortController.abort();
        if (settled) closeStoreOnce();
        else void shutdownPump.finally(closeStoreOnce).catch(() => undefined);
      } else {
        abortController.abort();
        closeStoreOnce();
      }
    },
  };
}
