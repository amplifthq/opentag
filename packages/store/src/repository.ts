import { createHash, randomUUID } from "node:crypto";

import { AgentAccessProfileSnapshotSchema, AttemptSchema, ActionHintSchema, canonicalJsonStringify, computeControlPayloadDigestV1, computeHostedLifecycleRequestDigestV1, computeHostedLifecycleRequestIdV1, computeHostedLifecycleOperationIdV1, computeHostedLifecycleReceiptIdV1, computeHostedClaimFencingTokenDigestV1, ContextPacketSchema, conversationKeyFromEvent, defaultRunEventMetadata, OpenTagEventSchema, OpenTagRunResultSchema, PolicySnapshotProvenanceSchema, containsCredentialLikeData, isCredentialFieldName, sanitizeCredentialLikeValue, projectTargetRefFromEvent, protocolRunFieldsFromEvent, RunnerReadinessReceiptEnvelopeV1Schema, HostedClaimRequestV1Schema, HostedClaimV1Schema, HostedHeartbeatRequestV1Schema, HostedProgressRequestV1Schema, HostedRejectStartRequestV1Schema, HostedRunningRequestV1Schema, HostedCompleteRequestV1Schema, HostedLifecycleRequestV1Schema, HostedLifecycleReceiptEnvelopeV1Schema, WorkThreadSchema, verifyHostedAdmissionEnvelopeDigestV1, verifyHostedClaimFencingTokenDigestV1, verifyHostedLifecycleReceiptV1, type HostedClaimRequestV1, type HostedClaimV1, type HostedCompleteRequestV1, type HostedHeartbeatRequestV1, type HostedProgressRequestV1, type HostedRejectStartRequestV1, type HostedRunningRequestV1, type HostedLifecycleActionV1, type HostedLifecycleRequestV1, type HostedLifecycleReceiptEnvelopeV1, type OpenTagEvent, type OpenTagRun, type OpenTagRunResult, type RunEventImportance, type RunEventVisibility, type RunnerReadinessReceiptEnvelopeV1, type WorkThread } from "@opentag/core";

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";

import { alias } from "drizzle-orm/sqlite-core";

import { canonicalSha256Json } from "./canonical-json.js";

import { attempts, controlPlaneProjectionOutbox, hostedAttemptImports, hostedClaimOperations, hostedLifecycleOperations, hostedRunImports, runEvents, sourceDeliveries, runs, workThreads } from "./schema.js";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

export type ControlPlaneProjectionEnvelope = RunnerReadinessReceiptEnvelopeV1;

export type ControlPlaneProjectionOutboxState = "pending" | "leased" | "acknowledged" | "attention";

export type ControlPlaneProjectionOutboxEntry = {
    receiptId: string;
    destinationId: string;
    organizationId: string;
    runnerId: string;
    receiptKind: ControlPlaneProjectionEnvelope["receiptKind"];
    identity: {
        namespace: string;
        parts: string[];
        key: string;
    };
    operationId: string;
    payloadDigest: string;
    receiptDigest: string;
    envelope: ControlPlaneProjectionEnvelope;
    state: ControlPlaneProjectionOutboxState;
    attemptCount: number;
    nextAttemptAt?: string;
    leaseOwner?: string;
    leaseToken?: string;
    leaseExpiresAt?: string;
    lastReasonCode?: string;
    lastHttpStatus?: number;
    createdAt: string;
    updatedAt: string;
    acknowledgedAt?: string;
};

export type EnqueueControlPlaneProjectionInput = {
    destinationId: string;
    envelope: unknown;
    now?: Date;
};

export type EnqueueControlPlaneProjectionResult = {
    outcome: "created" | "replay";
    entry: ControlPlaneProjectionOutboxEntry;
} | {
    outcome: "conflict";
    conflictOn: "receipt_id" | "identity" | "operation";
    existingReceiptId: string;
};

export type ClaimControlPlaneProjectionsResult = {
    entries: ControlPlaneProjectionOutboxEntry[];
    rejected: Array<{
        receiptId?: string;
        rowIdentityDigest: string;
        reasonCode: "stored_row_invalid";
    }>;
};

export class ControlPlaneProjectionOutboxValidationError extends Error {
    readonly code: "projection_envelope_invalid" | "projection_custody_violation" | "projection_destination_invalid" | "projection_digest_mismatch" | "projection_invalid_unicode";
    constructor(code: ControlPlaneProjectionOutboxValidationError["code"]) {
        super(code);
        this.name = "ControlPlaneProjectionOutboxValidationError";
        this.code = code;
    }
}

export type OpenTagRunWithEvent = {
    run: OpenTagRun;
    event: OpenTagEvent;
};

export type DurableWorkThread = WorkThread & {
    id: string;
};

export const HOSTED_IMPORT_ERROR_CODES = [
    "HOSTED_IMPORT_CLAIM_INVALID",
    "HOSTED_IMPORT_EVENT_MISMATCH",
    "HOSTED_IMPORT_RUN_CONFLICT",
    "HOSTED_IMPORT_ADMISSION_CONFLICT",
    "HOSTED_IMPORT_OPERATION_CONFLICT",
    "HOSTED_IMPORT_ATTEMPT_CONFLICT",
    "HOSTED_IMPORT_FENCE_CONFLICT",
    "HOSTED_IMPORT_SOURCE_DIGEST_CONFLICT",
    "HOSTED_IMPORT_AUTHORITY_CONFLICT",
    "HOSTED_IMPORT_WORK_THREAD_CONFLICT",
    "HOSTED_CLAIM_OPERATION_INVALID",
    "HOSTED_CLAIM_OPERATION_CONFLICT",
    "HOSTED_CLAIM_OPERATION_NOT_PENDING",
    "HOSTED_HEARTBEAT_OPERATION_INVALID",
    "HOSTED_HEARTBEAT_OPERATION_CONFLICT"
] as const;

export type HostedImportErrorCode = (typeof HOSTED_IMPORT_ERROR_CODES)[number];

export class HostedImportConflictError extends Error {
    override readonly name = "HostedImportConflictError";
    constructor(readonly code: HostedImportErrorCode) {
        super(code);
    }
}

export class HostedLifecycleOperationConflictError extends Error {
    override readonly name = "HostedLifecycleOperationConflictError";
    constructor(readonly code: "HOSTED_LIFECYCLE_OPERATION_INVALID" | "HOSTED_LIFECYCLE_OPERATION_CONFLICT" | "HOSTED_LIFECYCLE_PREDECESSOR_NOT_ACKNOWLEDGED" | "HOSTED_LIFECYCLE_ATOMIC_API_REQUIRED") {
        super(code);
    }
}

export type HostedImportAuthority = HostedClaimV1["authority"] & {
    admissionId: string;
    admissionOperationId: string;
    claimOperationId: string;
    admissionEnvelopeDigest: string;
    sourceIdentityDigest: string;
    deliveryPayloadDigest: string;
    policyReceiptId: string;
    policyPayloadDigest: string;
    policyReceiptDigest: string;
    eventDigest: string;
    contextPacketDigest: string;
    workThreadId?: string;
    workThreadDigest?: string;
    claimDigest: string;
    authorityDigest: string;
    importedAt: string;
};

export type HostedAssignedRun = OpenTagRunWithEvent & {
    attemptId: string;
    attemptNumber: number;
    fencingToken: string;
    executorId: string;
};

export type ImportHostedAssignedRunResult = {
    outcome: "created" | "replayed";
    executionState: "ready_to_start" | "already_started" | "superseded" | "terminal";
    executionMayStart: false;
    claimed: HostedAssignedRun | null;
    hostedAuthority: HostedImportAuthority;
};

export type CompleteRunOutcome =
    | "completed"
    | "duplicate"
    | "stale_attempt"
    | "not_found";

export type HostedSourceRedemptionReceipt = {
    provider: "slack";
    providerRepositoryId: string;
    owner: string;
    repo: string;
    sourceThread: HostedClaimV1["hostedAdmission"]["sourceThread"];
    sourceEvent: HostedClaimV1["hostedAdmission"]["sourceEvent"];
    actor: {
        providerUserId: string;
        login: string;
    };
    sourceIdentityDigest: string;
    eventDigest: string;
    redeemedAt: string;
};

export type HostedClaimOperation = {
    operationId: string;
    requestId: string;
    organizationId: string;
    runnerId: string;
    destinationId: string;
    requestDigest: string;
    request: HostedClaimRequestV1;
    state: "pending" | "claimed" | "empty";
    runId?: string;
    createdAt: string;
    updatedAt: string;
    acknowledgedAt?: string;
    executionStartedAt?: string;
    terminalReasonCode?: "stale_control_authority" | "operation_digest_conflict";
};

export type HostedHeartbeatOperation = {
    destinationId: string;
    organizationId: string;
    runnerId: string;
    credentialId: string;
    operationId: string;
    requestId: string;
    runId: string;
    attemptId: string;
    attemptNumber: number;
    fencingTokenDigest: string;
    expectedLeaseExpiresAt: string;
    requestDigest: string;
    request: HostedHeartbeatRequestV1;
    state: "pending" | "acknowledged";
    createdAt: string;
    updatedAt: string;
    receiptDigest?: string;
    receipt?: HostedLifecycleReceiptEnvelopeV1;
    acceptedLeaseExpiresAt?: string;
    acknowledgedAt?: string;
};

export type HostedLifecycleOperationState = "pending" | "leased" | "acknowledged" | "attention";

export type HostedLifecycleOperation = {
    destinationId: string;
    organizationId: string;
    runnerId: string;
    credentialId: string;
    operationId: string;
    requestId: string;
    action: HostedLifecycleActionV1;
    runId: string;
    attemptId: string;
    attemptNumber: number;
    fencingTokenDigest: string;
    requestDigest: string;
    businessKeyDigest: string;
    sequence: number;
    request: HostedLifecycleRequestV1;
    state: HostedLifecycleOperationState;
    attemptCount: number;
    nextAttemptAt?: string;
    leaseOwner?: string;
    leaseToken?: string;
    leaseExpiresAt?: string;
    receiptId?: string;
    receiptDigest?: string;
    receipt?: HostedLifecycleReceiptEnvelopeV1;
    lastReasonCode?: string;
    createdAt: string;
    updatedAt: string;
    acknowledgedAt?: string;
};

export type AttemptMutationConflict = "stale_attempt";

export type MarkRunningOutcome = "running" | "duplicate" | AttemptMutationConflict | "not_found";

export type RejectAttemptStartOutcome = "requeued" | "duplicate" | AttemptMutationConflict | "not_found";

function nowIso(): string {
    return new Date().toISOString();
}

const projectionEnvelopeSchemas = {
    runner_readiness: RunnerReadinessReceiptEnvelopeV1Schema,
} as const;

const PROJECTION_SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/#-]*$/u;

const PROJECTION_FORBIDDEN_FIELD = /^(?:uri|url|body|headers?|comment|credential|path|command|context)$/iu;

function isProjectionTimestamp(value: string): boolean {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertProjectionMutableReference(value: string): void {
    assertProjectionCustodySafe(value);
}

function parseControlPlaneProjectionEnvelope(input: unknown): ControlPlaneProjectionEnvelope {
    const receiptKind = input && typeof input === "object"
        ? (input as {
            receiptKind?: unknown;
        }).receiptKind
        : undefined;
    if (typeof receiptKind !== "string" || !(receiptKind in projectionEnvelopeSchemas)) {
        throw new ControlPlaneProjectionOutboxValidationError("projection_envelope_invalid");
    }
    const parsed = projectionEnvelopeSchemas[receiptKind as keyof typeof projectionEnvelopeSchemas].safeParse(input);
    if (!parsed.success)
        throw new ControlPlaneProjectionOutboxValidationError("projection_envelope_invalid");
    return parsed.data as ControlPlaneProjectionEnvelope;
}

function assertProjectionCustodySafe(value: unknown, path: string[] = []): void {
    if (typeof value === "string") {
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (code >= 0xd800 && code <= 0xdbff) {
                const next = value.charCodeAt(index + 1);
                if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
                    throw new ControlPlaneProjectionOutboxValidationError("projection_invalid_unicode");
                }
                index += 1;
            }
            else if (code >= 0xdc00 && code <= 0xdfff) {
                throw new ControlPlaneProjectionOutboxValidationError("projection_invalid_unicode");
            }
        }
        if (containsCredentialLikeData(value)
            || !PROJECTION_SAFE_REFERENCE.test(value)
            || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)
            || /^(?:\/|~\/|[A-Za-z]:[\\/])/u.test(value)
            || /(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(value)) {
            throw new ControlPlaneProjectionOutboxValidationError("projection_custody_violation");
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((child, index) => assertProjectionCustodySafe(child, [...path, String(index)]));
        return;
    }
    if (!value || typeof value !== "object")
        return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = [...path, key];
        const digestReference = /Digest$/u.test(key);
        const allowedCredentialReference = childPath.join(".") === "producer.credentialId";
        if (PROJECTION_FORBIDDEN_FIELD.test(key)
            || (isCredentialFieldName(key) && !digestReference && !allowedCredentialReference)) {
            throw new ControlPlaneProjectionOutboxValidationError("projection_custody_violation");
        }
        assertProjectionCustodySafe(child, childPath);
    }
}

function projectionIdentityKey(envelope: ControlPlaneProjectionEnvelope): string {
    return canonicalSha256Json({
        namespace: envelope.identity.namespace,
        parts: envelope.identity.parts
    });
}

function assertProjectionDigests(envelope: ControlPlaneProjectionEnvelope): void {
    const payloadDigest = canonicalSha256Json(envelope.payload);
    const { receiptDigest: _receiptDigest, ...receiptContent } = envelope;
    const receiptDigest = canonicalSha256Json(receiptContent);
    if (envelope.payloadDigest !== payloadDigest || envelope.receiptDigest !== receiptDigest) {
        throw new ControlPlaneProjectionOutboxValidationError("projection_digest_mismatch");
    }
}

function projectionOutboxEntryFromRow(row: typeof controlPlaneProjectionOutbox.$inferSelect): ControlPlaneProjectionOutboxEntry {
    const state = row.state as ControlPlaneProjectionOutboxState;
    if (!["pending", "leased", "acknowledged", "attention"].includes(state)) {
        throw new Error("control_plane_projection_outbox_state_invalid");
    }
    let envelope: ControlPlaneProjectionEnvelope;
    try {
        envelope = parseControlPlaneProjectionEnvelope(JSON.parse(row.envelopeJson));
        assertProjectionCustodySafe(envelope);
        assertProjectionDigests(envelope);
    }
    catch {
        throw new Error("control_plane_projection_outbox_row_invalid");
    }
    const runnerId = envelope.payload.runnerId;
    const timestampValues = [
        row.createdAt,
        row.updatedAt,
        ...(row.nextAttemptAt ? [row.nextAttemptAt] : []),
        ...(row.leaseExpiresAt ? [row.leaseExpiresAt] : []),
        ...(row.acknowledgedAt ? [row.acknowledgedAt] : [])
    ];
    const validMutableShape = Number.isInteger(row.attemptCount)
        && row.attemptCount >= 0
        && timestampValues.every(isProjectionTimestamp)
        && row.updatedAt >= row.createdAt
        && (row.lastHttpStatus === null
            || (Number.isInteger(row.lastHttpStatus) && row.lastHttpStatus >= 100 && row.lastHttpStatus <= 599))
        && (state !== "pending" || (row.nextAttemptAt !== null
            && row.nextAttemptAt >= row.updatedAt
            && row.leaseOwner === null
            && row.leaseToken === null
            && row.leaseExpiresAt === null
            && row.acknowledgedAt === null))
        && (state !== "leased" || (row.nextAttemptAt !== null
            && row.leaseOwner !== null
            && row.leaseToken !== null
            && row.leaseExpiresAt !== null
            && row.leaseExpiresAt > row.updatedAt
            && row.acknowledgedAt === null))
        && (state !== "acknowledged" || (row.nextAttemptAt === null
            && row.leaseOwner === null
            && row.leaseToken === null
            && row.leaseExpiresAt === null
            && row.acknowledgedAt !== null
            && row.acknowledgedAt >= row.updatedAt))
        && (state !== "attention" || (row.nextAttemptAt === null
            && row.leaseOwner === null
            && row.leaseToken === null
            && row.leaseExpiresAt === null
            && row.acknowledgedAt === null
            && row.lastReasonCode !== null));
    try {
        if (row.lastReasonCode !== null)
            assertProjectionMutableReference(row.lastReasonCode);
        if (row.leaseOwner !== null)
            assertProjectionMutableReference(row.leaseOwner);
        if (row.leaseToken !== null)
            assertProjectionMutableReference(row.leaseToken);
    }
    catch {
        throw new Error("control_plane_projection_outbox_row_invalid");
    }
    if (!validMutableShape
        || row.receiptId !== envelope.receiptId
        || row.organizationId !== envelope.organizationId
        || row.runnerId !== runnerId
        || row.receiptKind !== envelope.receiptKind
        || row.identityNamespace !== envelope.identity.namespace
        || row.identityPartsJson !== JSON.stringify(envelope.identity.parts)
        || row.identityKey !== projectionIdentityKey(envelope)
        || row.operationId !== envelope.operationId
        || row.payloadDigest !== envelope.payloadDigest
        || row.receiptDigest !== envelope.receiptDigest
        || row.envelopeJson !== canonicalJsonStringify(envelope)) {
        throw new Error("control_plane_projection_outbox_row_invalid");
    }
    return {
        receiptId: row.receiptId,
        destinationId: row.destinationId,
        organizationId: row.organizationId,
        runnerId: row.runnerId,
        receiptKind: row.receiptKind as ControlPlaneProjectionEnvelope["receiptKind"],
        identity: {
            namespace: row.identityNamespace,
            parts: JSON.parse(row.identityPartsJson) as string[],
            key: row.identityKey
        },
        operationId: row.operationId,
        payloadDigest: row.payloadDigest,
        receiptDigest: row.receiptDigest,
        envelope,
        state,
        attemptCount: row.attemptCount,
        ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
        ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
        ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
        ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
        ...(row.lastReasonCode ? { lastReasonCode: row.lastReasonCode } : {}),
        ...(row.lastHttpStatus !== null ? { lastHttpStatus: row.lastHttpStatus } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.acknowledgedAt ? { acknowledgedAt: row.acknowledgedAt } : {})
    };
}

function workThreadCanonicalKey(thread: WorkThread): string {
    const workItem = thread.workItemReference;
    return JSON.stringify([
        workItem.provider,
        workItem.ownerContainer?.provider ?? "",
        workItem.ownerContainer?.id ?? "",
        workItem.kind,
        workItem.externalId
    ]);
}

function conversationAnchorKey(anchor: WorkThread["primaryAnchor"]): string {
    return JSON.stringify([anchor.provider, anchor.kind, anchor.externalId, anchor.threadKey ?? ""]);
}

function mergeWorkThreadAnchors(current: DurableWorkThread, incoming: WorkThread): DurableWorkThread {
    const known = new Set([
        conversationAnchorKey(current.primaryAnchor),
        ...(current.secondaryAnchors ?? []).map(conversationAnchorKey)
    ]);
    const additions = [incoming.primaryAnchor, ...(incoming.secondaryAnchors ?? [])].filter((anchor) => {
        const key = conversationAnchorKey(anchor);
        if (known.has(key))
            return false;
        known.add(key);
        return true;
    });
    return WorkThreadSchema.parse({
        ...current,
        id: current.id,
        workItemReference: incoming.workItemReference,
        primaryAnchor: current.primaryAnchor,
        secondaryAnchors: [...(current.secondaryAnchors ?? []), ...additions]
    }) as DurableWorkThread;
}

function workThreadFromRow(row: typeof workThreads.$inferSelect): DurableWorkThread {
    const thread = WorkThreadSchema.parse(JSON.parse(row.threadJson));
    return { ...thread, id: row.id };
}

function hasActiveAttemptLease(attempt: Pick<typeof attempts.$inferSelect, "leaseExpiresAt">, now = new Date()): boolean {
    const leaseExpiresAt = attempt.leaseExpiresAt;
    const parsed = AttemptSchema.shape.leaseExpiresAt.safeParse(leaseExpiresAt);
    if (!parsed.success)
        return false;
    const expiresAt = Date.parse(parsed.data);
    return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function validatePersistedProposalEvidence(result: OpenTagRunResult): OpenTagRunResult {
    for (const artifact of result.artifacts ?? []) {
        const metadata = artifact.metadata;
        const proposalLike = artifact.id?.endsWith(":proposal-evidence")
            || artifact.title === "Immutable proposal evidence"
            || artifact.uri?.endsWith("/proposal-evidence")
            || Boolean(metadata?.["proposalEvidence"] || metadata?.["evidenceDigest"]);
        if (!proposalLike)
            continue;
        if (!metadata || metadata["readiness"] !== "not_assessed"
            || typeof metadata["evidenceDigest"] !== "string"
            || typeof metadata["artifactDigest"] !== "string"
            || !metadata["proposalEvidence"] || typeof metadata["proposalEvidence"] !== "object") {
            throw new Error("proposal_evidence_invalid");
        }
        if (!artifact.sourceRunId
            || artifact.id !== `${artifact.sourceRunId}:proposal-evidence`
            || artifact.type !== "patch_summary" || artifact.kind !== "patch"
            || artifact.title !== "Immutable proposal evidence"
            || artifact.summary
                !== "Attempt-bound proposal evidence captured; completion readiness is not assessed here."
            || artifact.uri !== `opentag://run/${encodeURIComponent(artifact.sourceRunId)}/proposal-evidence`
            || canonicalJsonStringify(Object.keys(metadata).sort())
                !== canonicalJsonStringify(["artifactDigest", "evidenceDigest", "proposalEvidence", "readiness"])) {
            throw new Error("proposal_evidence_identity_mismatch");
        }
        const evidence = metadata["proposalEvidence"] as Record<string, unknown>;
        const changedFiles = evidence["changedFiles"];
        const evidenceDigest = evidence["evidenceDigest"];
        const digestInput = { ...evidence };
        delete digestInput["evidenceDigest"];
        const computedChangedFilesDigest = Array.isArray(changedFiles)
            ? canonicalSha256Json(changedFiles) : null;
        const computedEvidenceDigest = canonicalSha256Json(digestInput);
        const artifactDigestInput = { ...artifact, metadata: { ...metadata } };
        delete (artifactDigestInput.metadata as Record<string, unknown>)["artifactDigest"];
        const computedArtifactDigest = canonicalSha256Json(artifactDigestInput);
        if (evidence["schemaVersion"] !== 1
            || evidence["kind"] !== "attempt_proposal_evidence"
            || evidence["changedFilesDigest"] !== computedChangedFilesDigest
            || evidenceDigest !== computedEvidenceDigest
            || metadata["evidenceDigest"] !== evidenceDigest
            || metadata["artifactDigest"] !== computedArtifactDigest) {
            throw new Error("proposal_evidence_digest_mismatch");
        }
    }
    return result;
}

function hostedClaimOperationFromRow(row: typeof hostedClaimOperations.$inferSelect): HostedClaimOperation {
    return {
        operationId: row.operationId,
        requestId: row.requestId,
        organizationId: row.organizationId,
        runnerId: row.runnerId,
        destinationId: row.destinationId,
        requestDigest: row.requestDigest,
        request: HostedClaimRequestV1Schema.parse(JSON.parse(row.requestJson)),
        state: row.state as HostedClaimOperation["state"],
        ...(row.runId ? { runId: row.runId } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.acknowledgedAt ? { acknowledgedAt: row.acknowledgedAt } : {}),
        ...(row.executionStartedAt ? { executionStartedAt: row.executionStartedAt } : {}),
        ...(row.terminalReasonCode
            ? { terminalReasonCode: row.terminalReasonCode as "stale_control_authority" | "operation_digest_conflict" }
            : {})
    };
}

function hostedLifecycleOperationFromRow(row: typeof hostedLifecycleOperations.$inferSelect): HostedLifecycleOperation {
    return {
        destinationId: row.destinationId,
        organizationId: row.organizationId,
        runnerId: row.runnerId,
        credentialId: row.credentialId,
        operationId: row.operationId,
        requestId: row.requestId,
        action: row.action as HostedLifecycleActionV1,
        runId: row.runId,
        attemptId: row.attemptId,
        attemptNumber: row.attemptNumber,
        fencingTokenDigest: row.fencingTokenDigest,
        requestDigest: row.requestDigest,
        businessKeyDigest: row.businessKeyDigest,
        sequence: row.sequence,
        request: HostedLifecycleRequestV1Schema.parse(JSON.parse(row.requestJson)),
        state: row.state as HostedLifecycleOperationState,
        attemptCount: row.attemptCount,
        ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
        ...(row.leaseOwner ? { leaseOwner: row.leaseOwner } : {}),
        ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
        ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
        ...(row.receiptId ? { receiptId: row.receiptId } : {}),
        ...(row.receiptDigest ? { receiptDigest: row.receiptDigest } : {}),
        ...(row.receiptJson
            ? { receipt: HostedLifecycleReceiptEnvelopeV1Schema.parse(JSON.parse(row.receiptJson)) }
            : {}),
        ...(row.lastReasonCode ? { lastReasonCode: row.lastReasonCode } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.acknowledgedAt ? { acknowledgedAt: row.acknowledgedAt } : {})
    };
}

function hostedLifecycleRequestDigestSync(input: {
    organizationId: string;
    runnerId: string;
    runId: string;
    action: HostedLifecycleActionV1;
    request: HostedLifecycleRequestV1;
}): string {
    const { request } = input;
    const common = {
        operation: input.action,
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        runId: input.runId,
        schemaVersion: request.schemaVersion,
        protocolVersion: request.protocolVersion,
        requiredCapabilities: request.requiredCapabilities,
        attempt: {
            attemptId: request.attempt.attemptId,
            attemptNumber: request.attempt.attemptNumber,
            epoch: request.attempt.epoch,
            fencingTokenDigest: request.attempt.fencingTokenDigest,
        },
        occurredAt: request.occurredAt,
    };
    const actionFields = input.action === "heartbeat"
        ? {
            expectedLeaseExpiresAt: HostedHeartbeatRequestV1Schema.parse(request).expectedLeaseExpiresAt,
        }
        : input.action === "running"
            ? (() => {
                const value = request as Extract<HostedLifecycleRequestV1, {
                    executorCapabilityDigest: string;
                }>;
                return {
                    executorId: value.executorId,
                    executorCapabilityDigest: value.executorCapabilityDigest,
                    ...(value.runTimeoutMs ? { runTimeoutMs: value.runTimeoutMs } : {}),
                };
            })()
            : input.action === "reject-start"
                ? (() => {
                    const value = request as Extract<HostedLifecycleRequestV1, {
                        reasonCode: string;
                        executorId: string;
                    }>;
                    return { executorId: value.executorId, reasonCode: value.reasonCode };
                })()
                : input.action === "progress"
                    ? (() => {
                        const value = request as Extract<HostedLifecycleRequestV1, {
                            progressId: string;
                        }>;
                        return { progressId: value.progressId, progressDigest: value.progressDigest };
                    })()
                    : (() => {
                        const value = HostedCompleteRequestV1Schema.parse(request);
                        return {
                            conclusion: value.conclusion,
                            reasonCode: value.reasonCode,
                            resultDigest: value.resultDigest,
                            artifactDigests: value.artifactDigests,
                            evidenceDigests: value.evidenceDigests,
                        };
                    })();
    return canonicalSha256Json({ ...common, ...actionFields });
}

function validAcknowledgedLifecycleDependency(row: typeof hostedLifecycleOperations.$inferSelect): boolean {
    try {
        if (row.state !== "acknowledged" || !row.receiptJson)
            return false;
        const action = row.action as HostedLifecycleActionV1;
        const request = HostedLifecycleRequestV1Schema.parse(JSON.parse(row.requestJson));
        const receipt = HostedLifecycleReceiptEnvelopeV1Schema.parse(JSON.parse(row.receiptJson));
        const expectedOperation = action === "reject-start"
            ? "reject_start"
            : action === "complete"
                ? "executor_result"
                : action;
        const expectedRequestDigest = hostedLifecycleRequestDigestSync({
            organizationId: row.organizationId,
            runnerId: row.runnerId,
            runId: row.runId,
            action,
            request,
        });
        const expectedOperationId = computeHostedLifecycleOperationIdV1(expectedRequestDigest);
        const expectedRequestId = `req_${canonicalSha256Json({
            purpose: "opentag-hosted-lifecycle-request-id-v1",
            operationId: expectedOperationId,
            requestDigest: expectedRequestDigest,
        }).slice("sha256:".length)}`;
        const expectedReceiptId = `lifecycle_${canonicalSha256Json({
            organizationId: row.organizationId,
            operationId: expectedOperationId,
        }).slice("sha256:".length)}`;
        const expectedPayload = action === "heartbeat"
            ? {
                operation: expectedOperation,
                occurredAt: request.occurredAt,
                leaseExpiresAt: (receipt.payload as {
                    leaseExpiresAt: string;
                }).leaseExpiresAt,
            }
            : action === "running"
                ? (() => {
                    const value = request as Extract<HostedLifecycleRequestV1, {
                        executorCapabilityDigest: string;
                    }>;
                    return {
                        operation: expectedOperation,
                        occurredAt: value.occurredAt,
                        executorId: value.executorId,
                        executorCapabilityDigest: value.executorCapabilityDigest,
                        ...(value.runTimeoutMs ? { runTimeoutMs: value.runTimeoutMs } : {}),
                    };
                })()
                : action === "reject-start"
                    ? (() => {
                        const value = request as Extract<HostedLifecycleRequestV1, {
                            reasonCode: string;
                            executorId: string;
                        }>;
                        return {
                            operation: expectedOperation,
                            occurredAt: value.occurredAt,
                            executorId: value.executorId,
                            reasonCode: value.reasonCode,
                        };
                    })()
                    : action === "progress"
                        ? (() => {
                            const value = request as Extract<HostedLifecycleRequestV1, {
                                progressId: string;
                            }>;
                            return {
                                operation: expectedOperation,
                                occurredAt: value.occurredAt,
                                progressId: value.progressId,
                                progressDigest: value.progressDigest,
                            };
                        })()
                        : (() => {
                            const value = HostedCompleteRequestV1Schema.parse(request);
                            return {
                                operation: expectedOperation,
                                occurredAt: value.occurredAt,
                                conclusion: value.conclusion,
                                reasonCode: value.reasonCode,
                                resultDigest: value.resultDigest,
                                artifactDigests: value.artifactDigests,
                                evidenceDigests: value.evidenceDigests,
                            };
                        })();
        const { receiptDigest: _receiptDigest, ...receiptWithoutDigest } = receipt;
        return row.requestJson === canonicalJsonStringify(request)
            && row.receiptJson === canonicalJsonStringify(receipt)
            && row.action === action
            && row.operationId === expectedOperationId
            && row.requestId === expectedRequestId
            && row.requestDigest === expectedRequestDigest
            && row.attemptId === request.attempt.attemptId
            && row.attemptNumber === request.attempt.attemptNumber
            && row.fencingTokenDigest === request.attempt.fencingTokenDigest
            && request.requestDigest === expectedRequestDigest
            && request.operationId === expectedOperationId
            && request.requestId === expectedRequestId
            && request.attempt.epoch === request.attempt.attemptNumber
            && row.receiptId === expectedReceiptId
            && row.receiptDigest === receipt.receiptDigest
            && receipt.receiptId === expectedReceiptId
            && receipt.organizationId === row.organizationId
            && receipt.runId === row.runId
            && receipt.operationId === row.operationId
            && receipt.requestId === row.requestId
            && receipt.requestDigest === row.requestDigest
            && receipt.producer.id === row.runnerId
            && receipt.producer.credentialId === row.credentialId
            && receipt.attempt.attemptId === row.attemptId
            && receipt.attempt.attemptNumber === row.attemptNumber
            && receipt.attempt.epoch === row.attemptNumber
            && receipt.attempt.fencingTokenDigest === row.fencingTokenDigest
            && receipt.payload.operation === expectedOperation
            && canonicalJsonStringify(receipt.payload)
                === canonicalJsonStringify(expectedPayload)
            && canonicalJsonStringify(receipt.identity.parts) === canonicalJsonStringify([
                row.organizationId,
                row.runId,
                row.attemptId,
                expectedOperation,
                row.operationId,
            ])
            && receipt.payloadDigest === canonicalSha256Json(receipt.payload)
            && receipt.receiptDigest === canonicalSha256Json(receiptWithoutDigest)
            && (action !== "heartbeat"
                || Date.parse((receipt.payload as {
                    leaseExpiresAt: string;
                }).leaseExpiresAt)
                    > Date.parse(HostedHeartbeatRequestV1Schema.parse(request).expectedLeaseExpiresAt));
    }
    catch {
        return false;
    }
}

function progressIdempotencyDigest(idempotencyKey: string): string {
    return createHash("sha256")
        .update("opentag.progress-idempotency.v1\0", "utf8")
        .update(idempotencyKey, "utf8")
        .digest("hex");
}

function runFromRow(row: typeof runs.$inferSelect): OpenTagRun {
    const event = OpenTagEventSchema.parse(JSON.parse(row.eventJson));
    const result = row.resultJson ? validatePersistedProposalEvidence(OpenTagRunResultSchema.parse(JSON.parse(row.resultJson))) : undefined;
    const triggeredByAction = row.triggeredByActionJson ? ActionHintSchema.parse(JSON.parse(row.triggeredByActionJson)) : undefined;
    const protocolFields = protocolRunFieldsFromEvent(event, row.createdAt);
    const durableThread = protocolFields.thread && row.workThreadId
        ? { ...protocolFields.thread, id: row.workThreadId }
        : protocolFields.thread;
    const contextPacket = row.contextPacketJson
        ? ContextPacketSchema.parse(JSON.parse(row.contextPacketJson))
        : protocolFields.contextPacket;
    const accessProfileSnapshot = row.accessProfileSnapshotJson
        ? AgentAccessProfileSnapshotSchema.parse(JSON.parse(row.accessProfileSnapshotJson))
        : undefined;
    const policySnapshotProvenance = row.policySnapshotProvenanceJson
        ? PolicySnapshotProvenanceSchema.parse(JSON.parse(row.policySnapshotProvenanceJson))
        : undefined;
    return {
        id: row.id,
        eventId: row.eventId,
        status: row.status as OpenTagRun["status"],
        ...(durableThread ? { thread: durableThread } : {}),
        contextPacket,
        ...(accessProfileSnapshot ? { accessProfileSnapshot } : {}),
        ...(policySnapshotProvenance ? { policySnapshotProvenance } : {}),
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        ...(triggeredByAction ? { triggeredByAction } : {}),
        ...(row.sourceProposalId ? { sourceProposalId: row.sourceProposalId } : {}),
        ...(row.sourceApplyPlanId ? { sourceApplyPlanId: row.sourceApplyPlanId } : {}),
        assignedRunnerId: row.assignedRunnerId ?? undefined,
        executor: row.executor ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(result ? { result } : {})
    };
}

function terminalRunStatus(status: string): boolean {
    return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted" || status === "timed_out";
}

function metadataString(metadata: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
        const value = metadata[key];
        if (typeof value !== "string")
            continue;
        const trimmed = value.trim();
        if (trimmed.length > 0)
            return trimmed;
    }
    return null;
}

function sourceDeliveryIdFromEvent(event: OpenTagEvent): string | null {
    return metadataString(event.metadata, [
        "sourceDeliveryId",
        "webhookDeliveryId",
        "deliveryId",
        "githubDeliveryId",
        "githubDeliveryGuid",
        "slackEventId"
    ]);
}

export function createPairedRunnerRepository(db: BetterSQLite3Database) {
    const hostedExecutionPayloads = new Map<string, {
        runId: string;
        fencingToken: string;
        event: OpenTagEvent;
        contextPacket: ReturnType<typeof protocolRunFieldsFromEvent>["contextPacket"];
    }>();
    function evictHostedExecutionPayload(input: {
        attemptId?: string | undefined;
        runId?: string | undefined;
    }): void {
        if (input.attemptId)
            hostedExecutionPayloads.delete(input.attemptId);
        if (input.runId) {
            for (const [attemptId, payload] of hostedExecutionPayloads) {
                if (payload.runId === input.runId)
                    hostedExecutionPayloads.delete(attemptId);
            }
        }
    }
    function evictHostedExecutionPayloadIfFenceChanged(attemptId: string, canonicalFencingToken: string): void {
        const payload = hostedExecutionPayloads.get(attemptId);
        if (payload && payload.fencingToken !== canonicalFencingToken) {
            hostedExecutionPayloads.delete(attemptId);
        }
    }
    function runEventValues(input: {
        runId: string;
        type: string;
        payload: unknown;
        createdAt?: string;
        visibility?: RunEventVisibility;
        importance?: RunEventImportance;
        message?: string;
    }): typeof runEvents.$inferInsert {
        return {
            runId: input.runId,
            type: input.type,
            visibility: input.visibility ?? defaultRunEventMetadata(input.type).visibility,
            importance: input.importance ?? defaultRunEventMetadata(input.type).importance,
            message: input.message ?? null,
            payloadJson: JSON.stringify(input.payload),
            createdAt: input.createdAt ?? nowIso()
        };
    }
    async function attemptFencingTokensForRun(runId: string): Promise<string[]> {
        const knownAttempts = await db
            .select({ fencingToken: attempts.fencingToken })
            .from(attempts)
            .where(eq(attempts.runId, runId));
        return knownAttempts.map((attempt) => attempt.fencingToken);
    }
    async function sanitizeRunnerControlledInputForRun<T>(runId: string, input: T): Promise<T> {
        return sanitizeCredentialLikeValue(input, {
            secrets: await attemptFencingTokensForRun(runId)
        });
    }
    function routingRejectionsFromJson(value: string): Array<{
        runnerId: string;
        executorId: string;
        reason: string;
    }> {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed))
            throw new Error("Persisted routing rejections must be an array.");
        return parsed.map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item))
                throw new Error("Persisted routing rejection is invalid.");
            const rejection = item as Record<string, unknown>;
            if (typeof rejection["runnerId"] !== "string" || typeof rejection["executorId"] !== "string" || typeof rejection["reason"] !== "string") {
                throw new Error("Persisted routing rejection is invalid.");
            }
            return { runnerId: rejection["runnerId"], executorId: rejection["executorId"], reason: rejection["reason"] };
        });
    }
    type ProjectionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
    function evictHostedExecutionPayloadIfDurablyUnrecoverable(tx: ProjectionTransaction, attemptId: string, callerFencingToken: string): void {
        const payload = hostedExecutionPayloads.get(attemptId);
        if (!payload)
            return;
        const importedRun = tx.select().from(hostedRunImports)
            .where(eq(hostedRunImports.runId, payload.runId)).limit(1).get();
        const importedAttempt = tx.select().from(hostedAttemptImports)
            .where(eq(hostedAttemptImports.attemptId, attemptId)).limit(1).get();
        const run = tx.select().from(runs).where(eq(runs.id, payload.runId)).limit(1).get();
        const attempt = tx.select().from(attempts).where(eq(attempts.id, attemptId)).limit(1).get();
        if (attempt
            && attempt.fencingToken !== callerFencingToken
            && attempt.fencingToken === payload.fencingToken)
            return;
        const claim = importedAttempt
            ? tx.select().from(hostedClaimOperations)
                .where(eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId))
                .limit(1).get()
            : undefined;
        const leaseExpiresAt = Date.parse(attempt?.leaseExpiresAt ?? "");
        const recoverable = Boolean(importedRun && importedAttempt && run && attempt && claim
            && importedAttempt.runId === payload.runId
            && importedAttempt.attemptNumber === attempt.number
            && run.currentAttemptId === attemptId
            && run.assignedRunnerId === attempt.runnerId
            && ["assigned", "running", "needs_approval"].includes(run.status)
            && run.leaseExpiresAt === attempt.leaseExpiresAt
            && attempt.runId === payload.runId
            && ["assigned", "running"].includes(attempt.status)
            && attempt.fencingToken === payload.fencingToken
            && Number.isFinite(leaseExpiresAt)
            && leaseExpiresAt > Date.now()
            && claim.state === "claimed"
            && claim.runId === payload.runId
            && claim.attemptId === attemptId
            && claim.attemptNumber === importedAttempt.attemptNumber
            && claim.fencingTokenDigest === importedAttempt.fencingTokenDigest
            && claim.terminalReasonCode === null);
        if (!recoverable)
            hostedExecutionPayloads.delete(attemptId);
    }
    type PreparedHostedLifecycleOperation = {
        destinationId: string;
        organizationId: string;
        runnerId: string;
        credentialId: string;
        runId: string;
        action: HostedLifecycleActionV1;
        request: HostedLifecycleRequestV1;
        requestJson: string;
        businessKeyDigest: string;
        createdAt: string;
    };
    async function prepareHostedLifecycleOperation(input: {
        destinationId: string;
        organizationId: string;
        runnerId: string;
        credentialId: string;
        runId: string;
        action: HostedLifecycleActionV1;
        request: HostedLifecycleRequestV1;
        now?: Date;
    }): Promise<PreparedHostedLifecycleOperation> {
        let request: HostedLifecycleRequestV1;
        try {
            request = HostedLifecycleRequestV1Schema.parse(input.request);
        }
        catch {
            throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
        }
        const requestDigest = await computeHostedLifecycleRequestDigestV1({
            organizationId: input.organizationId,
            runnerId: input.runnerId,
            runId: input.runId,
            action: input.action,
            request
        });
        const requestId = await computeHostedLifecycleRequestIdV1({
            operationId: request.operationId,
            requestDigest: request.requestDigest
        });
        if (request.requestDigest !== requestDigest
            || request.requestId !== requestId
            || request.operationId !== computeHostedLifecycleOperationIdV1(request.requestDigest)
            || request.attempt.attemptId.length === 0
            || request.attempt.attemptNumber !== request.attempt.epoch)
            throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
        const businessKeyDigest = canonicalSha256Json({
            destinationId: input.destinationId,
            organizationId: input.organizationId,
            runnerId: input.runnerId,
            credentialId: input.credentialId,
            runId: input.runId,
            attemptId: request.attempt.attemptId,
            attemptNumber: request.attempt.attemptNumber,
            action: input.action,
            discriminator: input.action === "heartbeat"
                ? (request as HostedHeartbeatRequestV1).expectedLeaseExpiresAt
                : input.action === "progress"
                    ? (request as HostedProgressRequestV1).progressId
                    : "single_action_per_attempt"
        });
        return {
            ...input,
            request,
            requestJson: canonicalJsonStringify(request),
            businessKeyDigest,
            createdAt: (input.now ?? new Date()).toISOString()
        };
    }
    function enqueueHostedLifecycleOperationTx(tx: ProjectionTransaction, input: PreparedHostedLifecycleOperation): {
        outcome: "created" | "replayed";
        operation: HostedLifecycleOperation;
    } {
        const scope = [
            eq(hostedLifecycleOperations.destinationId, input.destinationId),
            eq(hostedLifecycleOperations.organizationId, input.organizationId),
            eq(hostedLifecycleOperations.runnerId, input.runnerId),
            eq(hostedLifecycleOperations.credentialId, input.credentialId)
        ];
        const existing = tx.select().from(hostedLifecycleOperations).where(or(and(...scope, eq(hostedLifecycleOperations.operationId, input.request.operationId)), and(...scope, eq(hostedLifecycleOperations.requestId, input.request.requestId)), and(...scope, eq(hostedLifecycleOperations.businessKeyDigest, input.businessKeyDigest)))).limit(1).get();
        if (existing) {
            const exact = existing.operationId === input.request.operationId
                && existing.requestId === input.request.requestId
                && existing.action === input.action
                && existing.runId === input.runId
                && existing.attemptId === input.request.attempt.attemptId
                && existing.attemptNumber === input.request.attempt.attemptNumber
                && existing.fencingTokenDigest === input.request.attempt.fencingTokenDigest
                && existing.requestDigest === input.request.requestDigest
                && existing.businessKeyDigest === input.businessKeyDigest
                && existing.requestJson === input.requestJson;
            if (!exact)
                throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_CONFLICT");
            return { outcome: "replayed", operation: hostedLifecycleOperationFromRow(existing) };
        }
        const terminal = tx.select({ operationId: hostedLifecycleOperations.operationId })
            .from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), eq(hostedLifecycleOperations.runId, input.runId), eq(hostedLifecycleOperations.attemptId, input.request.attempt.attemptId), inArray(hostedLifecycleOperations.action, ["complete", "reject-start"]))).limit(1).get();
        if (terminal) {
            throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_CONFLICT");
        }
        if (["heartbeat", "progress", "complete"].includes(input.action)) {
            const running = tx.select().from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), eq(hostedLifecycleOperations.runnerId, input.runnerId), eq(hostedLifecycleOperations.credentialId, input.credentialId), eq(hostedLifecycleOperations.runId, input.runId), eq(hostedLifecycleOperations.attemptId, input.request.attempt.attemptId), eq(hostedLifecycleOperations.action, "running"), eq(hostedLifecycleOperations.state, "acknowledged"))).limit(1).get();
            if (!running || !validAcknowledgedLifecycleDependency(running)) {
                throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_PREDECESSOR_NOT_ACKNOWLEDGED");
            }
        }
        const sequenceRow = tx.select({
            value: sql<number> `coalesce(max(${hostedLifecycleOperations.sequence}), 0)`
        }).from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), eq(hostedLifecycleOperations.runId, input.runId), eq(hostedLifecycleOperations.attemptId, input.request.attempt.attemptId))).get();
        tx.insert(hostedLifecycleOperations).values({
            destinationId: input.destinationId,
            organizationId: input.organizationId,
            runnerId: input.runnerId,
            credentialId: input.credentialId,
            operationId: input.request.operationId,
            requestId: input.request.requestId,
            action: input.action,
            runId: input.runId,
            attemptId: input.request.attempt.attemptId,
            attemptNumber: input.request.attempt.attemptNumber,
            fencingTokenDigest: input.request.attempt.fencingTokenDigest,
            requestDigest: input.request.requestDigest,
            businessKeyDigest: input.businessKeyDigest,
            sequence: Number(sequenceRow?.value ?? 0) + 1,
            requestJson: input.requestJson,
            state: "pending",
            attemptCount: 0,
            nextAttemptAt: input.createdAt,
            createdAt: input.createdAt,
            updatedAt: input.createdAt
        }).run();
        const created = tx.select().from(hostedLifecycleOperations).where(and(...scope, eq(hostedLifecycleOperations.operationId, input.request.operationId))).limit(1).get();
        if (!created)
            throw new Error("hosted_lifecycle_operation_insert_lost");
        return { outcome: "created", operation: hostedLifecycleOperationFromRow(created) };
    }
    function projectionDestination(value: string): string {
        if (!PROJECTION_SAFE_REFERENCE.test(value)
            || containsCredentialLikeData(value)
            || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)
            || /(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(value)) {
            throw new ControlPlaneProjectionOutboxValidationError("projection_destination_invalid");
        }
        return value;
    }
    function projectionOrganization(value: string): string {
        return projectionDestination(value);
    }
    function enqueueControlPlaneProjectionTx(tx: ProjectionTransaction, input: EnqueueControlPlaneProjectionInput): EnqueueControlPlaneProjectionResult {
        const destinationId = projectionDestination(input.destinationId);
        const envelope = parseControlPlaneProjectionEnvelope(input.envelope);
        assertProjectionCustodySafe(envelope);
        assertProjectionDigests(envelope);
        const at = (input.now ?? new Date()).toISOString();
        const identityKey = projectionIdentityKey(envelope);
        const envelopeJson = canonicalJsonStringify(envelope);
        const values: typeof controlPlaneProjectionOutbox.$inferInsert = {
            receiptId: envelope.receiptId,
            destinationId,
            organizationId: envelope.organizationId,
            runnerId: envelope.payload.runnerId,
            receiptKind: envelope.receiptKind,
            identityNamespace: envelope.identity.namespace,
            identityPartsJson: JSON.stringify(envelope.identity.parts),
            identityKey,
            operationId: envelope.operationId,
            payloadDigest: envelope.payloadDigest,
            receiptDigest: envelope.receiptDigest,
            envelopeJson,
            state: "pending",
            attemptCount: 0,
            nextAttemptAt: at,
            createdAt: at,
            updatedAt: at
        };
        const byReceipt = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, envelope.organizationId), eq(controlPlaneProjectionOutbox.receiptId, envelope.receiptId))).limit(1).get();
        const byIdentity = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, envelope.organizationId), eq(controlPlaneProjectionOutbox.identityKey, identityKey))).limit(1).get();
        const byOperation = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, envelope.organizationId), eq(controlPlaneProjectionOutbox.operationId, envelope.operationId))).limit(1).get();
        const conflict = byReceipt ?? byIdentity ?? byOperation;
        if (conflict) {
            const exact = conflict.receiptId === values.receiptId
                && conflict.destinationId === values.destinationId
                && conflict.organizationId === values.organizationId
                && conflict.runnerId === values.runnerId
                && conflict.receiptKind === values.receiptKind
                && conflict.identityNamespace === values.identityNamespace
                && conflict.identityPartsJson === values.identityPartsJson
                && conflict.identityKey === values.identityKey
                && conflict.operationId === values.operationId
                && conflict.payloadDigest === values.payloadDigest
                && conflict.receiptDigest === values.receiptDigest
                && conflict.envelopeJson === values.envelopeJson;
            if (exact)
                return { outcome: "replay", entry: projectionOutboxEntryFromRow(conflict) };
            return {
                outcome: "conflict",
                conflictOn: byReceipt ? "receipt_id" : byIdentity ? "identity" : "operation",
                existingReceiptId: conflict.receiptId
            };
        }
        tx.insert(controlPlaneProjectionOutbox).values(values).run();
        const created = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, envelope.organizationId), eq(controlPlaneProjectionOutbox.receiptId, envelope.receiptId))).limit(1).get();
        if (!created)
            throw new Error("control_plane_projection_outbox_insert_lost");
        return { outcome: "created", entry: projectionOutboxEntryFromRow(created) };
    }
    function validProjectionLimit(value: number | undefined): number {
        if (value !== undefined && (!Number.isFinite(value) || value <= 0))
            throw new Error("projection_limit_invalid");
        return Math.min(100, Math.max(1, Math.trunc(value ?? 50)));
    }
    function validProjectionReason(value: string): string {
        try {
            assertProjectionMutableReference(value);
        }
        catch {
            throw new ControlPlaneProjectionOutboxValidationError("projection_custody_violation");
        }
        return value;
    }
    function validProjectionHttpStatus(value: number | undefined): number | undefined {
        if (value !== undefined && (!Number.isInteger(value) || value < 100 || value > 599)) {
            throw new Error("projection_http_status_invalid");
        }
        return value;
    }
    function validProjectionTimestamp(value: string): string {
        if (!isProjectionTimestamp(value)) {
            throw new Error("projection_timestamp_invalid");
        }
        return value;
    }
    function acknowledgeHostedLifecycleOperationTx(input: {
        tx: ProjectionTransaction;
        row: typeof hostedLifecycleOperations.$inferSelect;
        receipt: HostedLifecycleReceiptEnvelopeV1;
        acknowledgedAt: string;
        expectedState: "pending" | "leased";
        leaseToken?: string;
    }): boolean {
        const { tx, row, receipt, acknowledgedAt } = input;
        let preImportRejectClaim: typeof hostedClaimOperations.$inferSelect | undefined;
        if (row.action === "reject-start") {
            const importedAttempt = tx.select().from(hostedAttemptImports).where(and(eq(hostedAttemptImports.attemptId, row.attemptId), eq(hostedAttemptImports.runId, row.runId), eq(hostedAttemptImports.attemptNumber, row.attemptNumber), eq(hostedAttemptImports.fencingTokenDigest, row.fencingTokenDigest))).limit(1).get();
            if (!importedAttempt) {
                preImportRejectClaim = tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.destinationId, row.destinationId), eq(hostedClaimOperations.organizationId, row.organizationId), eq(hostedClaimOperations.runnerId, row.runnerId), eq(hostedClaimOperations.credentialId, row.credentialId), eq(hostedClaimOperations.runId, row.runId), eq(hostedClaimOperations.attemptId, row.attemptId), eq(hostedClaimOperations.attemptNumber, row.attemptNumber), eq(hostedClaimOperations.fencingTokenDigest, row.fencingTokenDigest), eq(hostedClaimOperations.state, "claimed"), isNotNull(hostedClaimOperations.activeKey), isNull(hostedClaimOperations.terminalReasonCode))).limit(1).get();
                if (!preImportRejectClaim) {
                    throw new Error("hosted_reject_start_claim_authority_missing");
                }
            }
        }
        if (row.action === "heartbeat") {
            if (receipt.payload.operation !== "heartbeat")
                return false;
            const request = HostedHeartbeatRequestV1Schema.parse(JSON.parse(row.requestJson));
            const run = tx.select().from(runs).where(eq(runs.id, row.runId)).limit(1).get();
            const attempt = tx.select().from(attempts).where(and(eq(attempts.id, row.attemptId), eq(attempts.runId, row.runId), eq(attempts.fencingToken, request.attempt.fencingToken))).limit(1).get();
            const importedAttempt = tx.select().from(hostedAttemptImports)
                .where(eq(hostedAttemptImports.attemptId, row.attemptId)).limit(1).get();
            const claimOperation = importedAttempt
                ? tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId), eq(hostedClaimOperations.state, "claimed"), isNull(hostedClaimOperations.terminalReasonCode))).limit(1).get()
                : undefined;
            const oldExpiry = Date.parse(request.expectedLeaseExpiresAt);
            const newExpiry = Date.parse(receipt.payload.leaseExpiresAt);
            if (!run || !attempt || !claimOperation
                || run.currentAttemptId !== row.attemptId
                || run.assignedRunnerId !== row.runnerId
                || run.leaseExpiresAt !== request.expectedLeaseExpiresAt
                || attempt.runnerId !== row.runnerId
                || attempt.number !== request.attempt.attemptNumber
                || importedAttempt?.attemptNumber !== request.attempt.attemptNumber
                || request.attempt.epoch !== request.attempt.attemptNumber
                || attempt.leaseExpiresAt !== request.expectedLeaseExpiresAt
                || !["assigned", "running"].includes(attempt.status)
                || !Number.isFinite(oldExpiry) || !Number.isFinite(newExpiry)
                || oldExpiry <= Date.parse(acknowledgedAt)
                || newExpiry <= oldExpiry || newExpiry <= Date.parse(acknowledgedAt)) {
                evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, row.attemptId, request.attempt.fencingToken);
                return false;
            }
            const attemptUpdated = tx.update(attempts).set({
                heartbeatAt: acknowledgedAt,
                leaseExpiresAt: receipt.payload.leaseExpiresAt,
                updatedAt: acknowledgedAt
            }).where(and(eq(attempts.id, row.attemptId), eq(attempts.leaseExpiresAt, request.expectedLeaseExpiresAt))).run();
            const runUpdated = tx.update(runs).set({
                heartbeatAt: acknowledgedAt,
                leaseExpiresAt: receipt.payload.leaseExpiresAt,
                updatedAt: acknowledgedAt
            }).where(and(eq(runs.id, row.runId), eq(runs.currentAttemptId, row.attemptId), eq(runs.leaseExpiresAt, request.expectedLeaseExpiresAt))).run();
            if (attemptUpdated.changes !== 1 || runUpdated.changes !== 1) {
                throw new Error("hosted_heartbeat_lease_update_lost");
            }
        }
        const receiptJson = canonicalJsonStringify(receipt);
        const conditions = [
            eq(hostedLifecycleOperations.destinationId, row.destinationId),
            eq(hostedLifecycleOperations.organizationId, row.organizationId),
            eq(hostedLifecycleOperations.runnerId, row.runnerId),
            eq(hostedLifecycleOperations.credentialId, row.credentialId),
            eq(hostedLifecycleOperations.operationId, row.operationId),
            eq(hostedLifecycleOperations.state, input.expectedState)
        ];
        if (input.expectedState === "leased" && input.leaseToken) {
            conditions.push(eq(hostedLifecycleOperations.leaseToken, input.leaseToken));
            conditions.push(gt(hostedLifecycleOperations.leaseExpiresAt, acknowledgedAt));
        }
        const acknowledged = tx.update(hostedLifecycleOperations).set({
            state: "acknowledged",
            nextAttemptAt: null,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            receiptId: receipt.receiptId,
            receiptDigest: receipt.receiptDigest,
            receiptJson,
            updatedAt: acknowledgedAt,
            acknowledgedAt
        }).where(and(...conditions)).run().changes === 1;
        if (!acknowledged && row.action === "heartbeat") {
            throw new Error("hosted_heartbeat_journal_update_lost");
        }
        if (acknowledged && preImportRejectClaim?.activeKey) {
            const claimUpdated = tx.update(hostedClaimOperations).set({
                activeKey: null,
                updatedAt: acknowledgedAt
            }).where(and(eq(hostedClaimOperations.operationId, preImportRejectClaim.operationId), eq(hostedClaimOperations.destinationId, preImportRejectClaim.destinationId), eq(hostedClaimOperations.organizationId, preImportRejectClaim.organizationId), eq(hostedClaimOperations.runnerId, preImportRejectClaim.runnerId), eq(hostedClaimOperations.credentialId, preImportRejectClaim.credentialId!), eq(hostedClaimOperations.runId, preImportRejectClaim.runId!), eq(hostedClaimOperations.attemptId, preImportRejectClaim.attemptId!), eq(hostedClaimOperations.attemptNumber, preImportRejectClaim.attemptNumber!), eq(hostedClaimOperations.fencingTokenDigest, preImportRejectClaim.fencingTokenDigest!), eq(hostedClaimOperations.activeKey, preImportRejectClaim.activeKey), eq(hostedClaimOperations.state, "claimed"), isNull(hostedClaimOperations.terminalReasonCode))).run();
            if (claimUpdated.changes !== 1) {
                throw new Error("hosted_reject_start_claim_update_lost");
            }
        }
        return acknowledged;
    }
    return {
        async enqueueControlPlaneProjection(input: EnqueueControlPlaneProjectionInput): Promise<EnqueueControlPlaneProjectionResult> {
            return db.transaction((tx) => enqueueControlPlaneProjectionTx(tx, input), { behavior: "immediate" });
        },
        async getControlPlaneProjection(input: {
            destinationId: string;
            organizationId: string;
            receiptId: string;
        }): Promise<ControlPlaneProjectionOutboxEntry | null> {
            const destinationId = projectionDestination(input.destinationId);
            const organizationId = projectionOrganization(input.organizationId);
            const row = await db.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.receiptId, input.receiptId))).limit(1).get();
            return row ? projectionOutboxEntryFromRow(row) : null;
        },
        async getLatestRunnerReadinessProjection(input: {
            destinationId: string;
            organizationId: string;
            runnerId: string;
        }): Promise<ControlPlaneProjectionOutboxEntry | null> {
            const destinationId = projectionDestination(input.destinationId);
            const organizationId = projectionOrganization(input.organizationId);
            const runnerId = projectionDestination(input.runnerId);
            const row = await db.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.runnerId, runnerId), eq(controlPlaneProjectionOutbox.receiptKind, "runner_readiness"))).orderBy(desc(sql<string> `json_extract(${controlPlaneProjectionOutbox.envelopeJson}, '$.payload.observedAt')`), desc(controlPlaneProjectionOutbox.createdAt), desc(controlPlaneProjectionOutbox.receiptId)).limit(1).get();
            return row ? projectionOutboxEntryFromRow(row) : null;
        },
        async claimDueControlPlaneProjections(input: {
            destinationId: string;
            organizationId: string;
            leaseOwner: string;
            leaseSeconds: number;
            limit?: number;
            now?: Date;
        }): Promise<ClaimControlPlaneProjectionsResult> {
            const destinationId = projectionDestination(input.destinationId);
            const organizationId = projectionOrganization(input.organizationId);
            const leaseOwner = projectionDestination(input.leaseOwner);
            if (!Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0)
                throw new Error("projection_lease_seconds_invalid");
            const limit = validProjectionLimit(input.limit);
            const now = input.now ?? new Date();
            const at = now.toISOString();
            const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
            return db.transaction((tx) => {
                const claimed: ControlPlaneProjectionOutboxEntry[] = [];
                const rejected: ClaimControlPlaneProjectionsResult["rejected"] = [];
                let cursor: {
                    nextAttemptAt: string;
                    createdAt: string;
                    receiptId: string;
                } | undefined;
                while (claimed.length < limit) {
                    const cursorCondition = cursor
                        ? or(gt(controlPlaneProjectionOutbox.nextAttemptAt, cursor.nextAttemptAt), and(eq(controlPlaneProjectionOutbox.nextAttemptAt, cursor.nextAttemptAt), gt(controlPlaneProjectionOutbox.createdAt, cursor.createdAt)), and(eq(controlPlaneProjectionOutbox.nextAttemptAt, cursor.nextAttemptAt), eq(controlPlaneProjectionOutbox.createdAt, cursor.createdAt), gt(controlPlaneProjectionOutbox.receiptId, cursor.receiptId)))
                        : undefined;
                    const due = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.state, "pending"), lte(controlPlaneProjectionOutbox.nextAttemptAt, at), cursorCondition)).orderBy(asc(controlPlaneProjectionOutbox.nextAttemptAt), asc(controlPlaneProjectionOutbox.createdAt), asc(controlPlaneProjectionOutbox.receiptId)).limit(100).all();
                    if (due.length === 0)
                        break;
                    for (const row of due) {
                        cursor = {
                            nextAttemptAt: row.nextAttemptAt!,
                            createdAt: row.createdAt,
                            receiptId: row.receiptId
                        };
                        if (claimed.length >= limit)
                            break;
                        try {
                            projectionOutboxEntryFromRow(row);
                        }
                        catch {
                            if (rejected.length < 100) {
                                const safeReceiptId = PROJECTION_SAFE_REFERENCE.test(row.receiptId)
                                    && !containsCredentialLikeData(row.receiptId)
                                    && !/(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(row.receiptId);
                                rejected.push({
                                    ...(safeReceiptId ? { receiptId: row.receiptId } : {}),
                                    rowIdentityDigest: canonicalSha256Json({
                                        destinationId: row.destinationId,
                                        organizationId: row.organizationId,
                                        receiptId: row.receiptId
                                    }),
                                    reasonCode: "stored_row_invalid"
                                });
                            }
                            continue;
                        }
                        const leaseToken = randomUUID();
                        const updated = tx.update(controlPlaneProjectionOutbox).set({
                            state: "leased",
                            leaseOwner,
                            leaseToken,
                            leaseExpiresAt,
                            attemptCount: row.attemptCount + 1,
                            updatedAt: at
                        }).where(and(eq(controlPlaneProjectionOutbox.receiptId, row.receiptId), eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.state, "pending"), lte(controlPlaneProjectionOutbox.nextAttemptAt, at))).run();
                        if (updated.changes !== 1)
                            continue;
                        claimed.push(projectionOutboxEntryFromRow({
                            ...row,
                            state: "leased",
                            leaseOwner,
                            leaseToken,
                            leaseExpiresAt,
                            attemptCount: row.attemptCount + 1,
                            updatedAt: at
                        }));
                    }
                    if (due.length < 100)
                        break;
                }
                return { entries: claimed, rejected };
            }, { behavior: "immediate" });
        },
        async acknowledgeControlPlaneProjection(input: {
            destinationId: string;
            organizationId: string;
            receiptId: string;
            leaseToken: string;
            httpStatus?: number;
            now?: Date;
        }): Promise<{
            outcome: "acknowledged" | "stale_lease" | "not_found";
            entry?: ControlPlaneProjectionOutboxEntry;
        }> {
            const destinationId = projectionDestination(input.destinationId);
            const organizationId = projectionOrganization(input.organizationId);
            const at = (input.now ?? new Date()).toISOString();
            const httpStatus = validProjectionHttpStatus(input.httpStatus);
            return db.transaction((tx) => {
                const row = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.receiptId, input.receiptId))).limit(1).get();
                if (!row)
                    return { outcome: "not_found" as const };
                projectionOutboxEntryFromRow(row);
                if (row.state !== "leased" || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= at) {
                    return { outcome: "stale_lease" as const };
                }
                const updated = tx.update(controlPlaneProjectionOutbox).set({
                    state: "acknowledged",
                    nextAttemptAt: null,
                    leaseOwner: null,
                    leaseToken: null,
                    leaseExpiresAt: null,
                    lastHttpStatus: httpStatus ?? null,
                    updatedAt: at,
                    acknowledgedAt: at
                }).where(and(eq(controlPlaneProjectionOutbox.receiptId, input.receiptId), eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.state, "leased"), eq(controlPlaneProjectionOutbox.leaseToken, input.leaseToken), gt(controlPlaneProjectionOutbox.leaseExpiresAt, at))).run();
                if (updated.changes !== 1)
                    return { outcome: "stale_lease" as const };
                const acknowledged = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.receiptId, input.receiptId))).limit(1).get();
                return { outcome: "acknowledged" as const, entry: projectionOutboxEntryFromRow(acknowledged!) };
            }, { behavior: "immediate" });
        },
        async retryControlPlaneProjection(input: {
            destinationId: string;
            organizationId: string;
            receiptId: string;
            leaseToken: string;
            nextAttemptAt: string;
            reasonCode: string;
            httpStatus?: number;
            now?: Date;
        }): Promise<{
            outcome: "retried" | "stale_lease" | "not_found";
            entry?: ControlPlaneProjectionOutboxEntry;
        }> {
            const destinationId = projectionDestination(input.destinationId);
            const organizationId = projectionOrganization(input.organizationId);
            const at = (input.now ?? new Date()).toISOString();
            const nextAttemptAt = validProjectionTimestamp(input.nextAttemptAt);
            if (nextAttemptAt < at)
                throw new Error("projection_retry_time_in_past");
            const reasonCode = validProjectionReason(input.reasonCode);
            const httpStatus = validProjectionHttpStatus(input.httpStatus);
            return db.transaction((tx) => {
                const row = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.receiptId, input.receiptId))).limit(1).get();
                if (!row)
                    return { outcome: "not_found" as const };
                projectionOutboxEntryFromRow(row);
                if (row.state !== "leased" || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= at) {
                    return { outcome: "stale_lease" as const };
                }
                const updated = tx.update(controlPlaneProjectionOutbox).set({
                    state: "pending",
                    nextAttemptAt,
                    leaseOwner: null,
                    leaseToken: null,
                    leaseExpiresAt: null,
                    lastReasonCode: reasonCode,
                    lastHttpStatus: httpStatus ?? null,
                    updatedAt: at
                }).where(and(eq(controlPlaneProjectionOutbox.receiptId, input.receiptId), eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.state, "leased"), eq(controlPlaneProjectionOutbox.leaseToken, input.leaseToken), gt(controlPlaneProjectionOutbox.leaseExpiresAt, at))).run();
                if (updated.changes !== 1)
                    return { outcome: "stale_lease" as const };
                const retried = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.receiptId, input.receiptId))).limit(1).get();
                return { outcome: "retried" as const, entry: projectionOutboxEntryFromRow(retried!) };
            }, { behavior: "immediate" });
        },
        async markControlPlaneProjectionAttention(input: {
            destinationId: string;
            organizationId: string;
            receiptId: string;
            leaseToken: string;
            reasonCode: string;
            httpStatus?: number;
            now?: Date;
        }): Promise<{
            outcome: "attention" | "stale_lease" | "not_found";
            entry?: ControlPlaneProjectionOutboxEntry;
        }> {
            const destinationId = projectionDestination(input.destinationId);
            const organizationId = projectionOrganization(input.organizationId);
            const at = (input.now ?? new Date()).toISOString();
            const reasonCode = validProjectionReason(input.reasonCode);
            const httpStatus = validProjectionHttpStatus(input.httpStatus);
            return db.transaction((tx) => {
                const row = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.receiptId, input.receiptId))).limit(1).get();
                if (!row)
                    return { outcome: "not_found" as const };
                projectionOutboxEntryFromRow(row);
                if (row.state !== "leased" || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= at) {
                    return { outcome: "stale_lease" as const };
                }
                const updated = tx.update(controlPlaneProjectionOutbox).set({
                    state: "attention",
                    nextAttemptAt: null,
                    leaseOwner: null,
                    leaseToken: null,
                    leaseExpiresAt: null,
                    lastReasonCode: reasonCode,
                    lastHttpStatus: httpStatus ?? null,
                    updatedAt: at
                }).where(and(eq(controlPlaneProjectionOutbox.receiptId, input.receiptId), eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.state, "leased"), eq(controlPlaneProjectionOutbox.leaseToken, input.leaseToken), gt(controlPlaneProjectionOutbox.leaseExpiresAt, at))).run();
                if (updated.changes !== 1)
                    return { outcome: "stale_lease" as const };
                const attention = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.receiptId, input.receiptId))).limit(1).get();
                return { outcome: "attention" as const, entry: projectionOutboxEntryFromRow(attention!) };
            }, { behavior: "immediate" });
        },
        async recoverExpiredControlPlaneProjectionLeases(input: {
            destinationId: string;
            organizationId: string;
            limit?: number;
            now?: Date;
        }): Promise<{
            recovered: number;
            entries: ControlPlaneProjectionOutboxEntry[];
        }> {
            const destinationId = projectionDestination(input.destinationId);
            const organizationId = projectionOrganization(input.organizationId);
            const limit = validProjectionLimit(input.limit);
            const at = (input.now ?? new Date()).toISOString();
            return db.transaction((tx) => {
                const entries: ControlPlaneProjectionOutboxEntry[] = [];
                let cursor: {
                    leaseExpiresAt: string;
                    createdAt: string;
                    receiptId: string;
                } | undefined;
                while (entries.length < limit) {
                    const cursorCondition = cursor
                        ? or(gt(controlPlaneProjectionOutbox.leaseExpiresAt, cursor.leaseExpiresAt), and(eq(controlPlaneProjectionOutbox.leaseExpiresAt, cursor.leaseExpiresAt), gt(controlPlaneProjectionOutbox.createdAt, cursor.createdAt)), and(eq(controlPlaneProjectionOutbox.leaseExpiresAt, cursor.leaseExpiresAt), eq(controlPlaneProjectionOutbox.createdAt, cursor.createdAt), gt(controlPlaneProjectionOutbox.receiptId, cursor.receiptId)))
                        : undefined;
                    const expired = tx.select().from(controlPlaneProjectionOutbox).where(and(eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.state, "leased"), lte(controlPlaneProjectionOutbox.leaseExpiresAt, at), cursorCondition)).orderBy(asc(controlPlaneProjectionOutbox.leaseExpiresAt), asc(controlPlaneProjectionOutbox.createdAt), asc(controlPlaneProjectionOutbox.receiptId)).limit(100).all();
                    if (expired.length === 0)
                        break;
                    for (const row of expired) {
                        cursor = {
                            leaseExpiresAt: row.leaseExpiresAt!,
                            createdAt: row.createdAt,
                            receiptId: row.receiptId
                        };
                        if (entries.length >= limit)
                            break;
                        try {
                            projectionOutboxEntryFromRow(row);
                        }
                        catch {
                            continue;
                        }
                        const updated = tx.update(controlPlaneProjectionOutbox).set({
                            state: "pending",
                            nextAttemptAt: at,
                            leaseOwner: null,
                            leaseToken: null,
                            leaseExpiresAt: null,
                            lastReasonCode: "lease_expired",
                            updatedAt: at
                        }).where(and(eq(controlPlaneProjectionOutbox.receiptId, row.receiptId), eq(controlPlaneProjectionOutbox.destinationId, destinationId), eq(controlPlaneProjectionOutbox.organizationId, organizationId), eq(controlPlaneProjectionOutbox.state, "leased"), lte(controlPlaneProjectionOutbox.leaseExpiresAt, at))).run();
                        if (updated.changes !== 1)
                            continue;
                        entries.push(projectionOutboxEntryFromRow({
                            ...row,
                            state: "pending",
                            nextAttemptAt: at,
                            leaseOwner: null,
                            leaseToken: null,
                            leaseExpiresAt: null,
                            lastReasonCode: "lease_expired",
                            updatedAt: at
                        }));
                    }
                    if (expired.length < 100)
                        break;
                }
                return { recovered: entries.length, entries };
            }, { behavior: "immediate" });
        },
        async beginHostedClaimOperation(input: {
            destinationId: string;
            organizationId: string;
            runnerId: string;
            request: HostedClaimRequestV1;
        }): Promise<{
            outcome: "created" | "replayed";
            operation: HostedClaimOperation;
        }> {
            let request: HostedClaimRequestV1;
            try {
                request = HostedClaimRequestV1Schema.parse(input.request);
            }
            catch {
                throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_INVALID");
            }
            if (!input.destinationId || !input.organizationId || !input.runnerId) {
                throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_INVALID");
            }
            const requestDigest = canonicalSha256Json(request);
            const activeKey = canonicalSha256Json({
                destinationId: input.destinationId,
                organizationId: input.organizationId,
                runnerId: input.runnerId
            });
            const createdAt = nowIso();
            return db.transaction((tx) => {
                const pending = tx.select().from(hostedClaimOperations)
                    .where(eq(hostedClaimOperations.activeKey, activeKey)).limit(1).get();
                if (pending) {
                    return { outcome: "replayed" as const, operation: hostedClaimOperationFromRow(pending) };
                }
                const sameOperation = tx.select().from(hostedClaimOperations)
                    .where(eq(hostedClaimOperations.operationId, request.operationId)).limit(1).get();
                if (sameOperation) {
                    if (sameOperation.requestDigest !== requestDigest
                        || sameOperation.requestId !== request.requestId
                        || sameOperation.destinationId !== input.destinationId
                        || sameOperation.organizationId !== input.organizationId
                        || sameOperation.runnerId !== input.runnerId) {
                        throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
                    }
                    return { outcome: "replayed" as const, operation: hostedClaimOperationFromRow(sameOperation) };
                }
                const sameRequest = tx.select().from(hostedClaimOperations)
                    .where(eq(hostedClaimOperations.requestId, request.requestId)).limit(1).get();
                if (sameRequest)
                    throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
                tx.insert(hostedClaimOperations).values({
                    operationId: request.operationId,
                    requestId: request.requestId,
                    organizationId: input.organizationId,
                    runnerId: input.runnerId,
                    destinationId: input.destinationId,
                    activeKey,
                    requestDigest,
                    requestJson: JSON.stringify(request),
                    state: "pending",
                    createdAt,
                    updatedAt: createdAt
                }).run();
                const row = tx.select().from(hostedClaimOperations)
                    .where(eq(hostedClaimOperations.operationId, request.operationId)).limit(1).get()!;
                return { outcome: "created" as const, operation: hostedClaimOperationFromRow(row) };
            });
        },
        async getHostedClaimOperationForRetry(input: {
            destinationId: string;
            organizationId: string;
            runnerId: string;
        }): Promise<HostedClaimOperation | null> {
            const activeKey = canonicalSha256Json(input);
            const row = await db.select().from(hostedClaimOperations)
                .where(eq(hostedClaimOperations.activeKey, activeKey)).limit(1).get();
            return row ? hostedClaimOperationFromRow(row) : null;
        },
        async getHostedPreImportAuthorityRecovery(input: {
            destinationId: string;
            organizationId: string;
            runnerId: string;
        }): Promise<{
            state: "claim_retry";
            operation: HostedClaimOperation;
        } | {
            state: "reject_pending" | "reject_attention";
            operation: HostedClaimOperation;
            lifecycleOperation: HostedLifecycleOperation;
        } | null> {
            const activeKey = canonicalSha256Json(input);
            const shell = await db.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.activeKey, activeKey), eq(hostedClaimOperations.state, "claimed"))).limit(1).get();
            if (!shell || !shell.runId || !shell.attemptId || !shell.claimDigest || !shell.authorityDigest)
                return null;
            const imported = await db.select({ attemptId: hostedAttemptImports.attemptId })
                .from(hostedAttemptImports)
                .where(eq(hostedAttemptImports.claimOperationId, shell.operationId)).limit(1).get();
            if (imported)
                return null;
            const rejection = await db.select().from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), eq(hostedLifecycleOperations.runnerId, input.runnerId), eq(hostedLifecycleOperations.credentialId, shell.credentialId ?? ""), eq(hostedLifecycleOperations.runId, shell.runId), eq(hostedLifecycleOperations.attemptId, shell.attemptId), eq(hostedLifecycleOperations.action, "reject-start"))).limit(1).get();
            if (!rejection)
                return { state: "claim_retry", operation: hostedClaimOperationFromRow(shell) };
            if (rejection.state === "acknowledged")
                return null;
            return {
                state: rejection.state === "attention" ? "reject_attention" : "reject_pending",
                operation: hostedClaimOperationFromRow(shell),
                lifecycleOperation: hostedLifecycleOperationFromRow(rejection)
            };
        },
        async persistHostedClaimAuthorityShell(input: {
            destinationId: string;
            credentialId: string;
            request: HostedClaimRequestV1;
            claim: HostedClaimV1;
        }): Promise<{
            outcome: "created" | "replayed";
            operation: HostedClaimOperation;
        }> {
            const request = HostedClaimRequestV1Schema.parse(input.request);
            const claim = HostedClaimV1Schema.parse(input.claim);
            if (claim.operationId !== request.operationId
                || claim.requestId !== request.requestId
                || claim.authority.credentialId !== input.credentialId
                || !(await verifyHostedClaimFencingTokenDigestV1(claim)))
                throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
            const claimDigest = canonicalSha256Json(claim);
            const authorityDigest = canonicalSha256Json(claim.authority);
            const authorityJson = canonicalJsonStringify(claim.authority);
            const acknowledgedAt = nowIso();
            return db.transaction((tx) => {
                const current = tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.operationId, request.operationId), eq(hostedClaimOperations.requestId, request.requestId), eq(hostedClaimOperations.destinationId, input.destinationId), eq(hostedClaimOperations.organizationId, claim.organizationId), eq(hostedClaimOperations.runnerId, claim.runnerId))).limit(1).get();
                if (!current)
                    throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
                const exact = current.state === "claimed"
                    && current.runId === claim.runId
                    && current.claimDigest === claimDigest
                    && current.authorityDigest === authorityDigest
                    && current.authorityJson === authorityJson
                    && current.attemptId === claim.attempt.id
                    && current.attemptNumber === claim.attempt.number
                    && current.fencingTokenDigest === claim.attempt.fencingTokenDigest
                    && current.credentialId === input.credentialId
                    && current.leaseExpiresAt === claim.attempt.leaseExpiresAt
                    && current.executorId === claim.executorId;
                if (exact)
                    return { outcome: "replayed" as const, operation: hostedClaimOperationFromRow(current) };
                if (current.state !== "pending") {
                    throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
                }
                const updated = tx.update(hostedClaimOperations).set({
                    state: "claimed",
                    runId: claim.runId,
                    claimDigest,
                    authorityDigest,
                    authorityJson,
                    attemptId: claim.attempt.id,
                    attemptNumber: claim.attempt.number,
                    fencingTokenDigest: claim.attempt.fencingTokenDigest,
                    credentialId: input.credentialId,
                    leaseExpiresAt: claim.attempt.leaseExpiresAt,
                    executorId: claim.executorId,
                    updatedAt: acknowledgedAt,
                    acknowledgedAt
                }).where(and(eq(hostedClaimOperations.operationId, request.operationId), eq(hostedClaimOperations.state, "pending"))).run();
                if (updated.changes !== 1)
                    throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
                const row = tx.select().from(hostedClaimOperations)
                    .where(eq(hostedClaimOperations.operationId, request.operationId)).limit(1).get()!;
                return { outcome: "created" as const, operation: hostedClaimOperationFromRow(row) };
            }, { behavior: "immediate" });
        },
        async getHostedAssignedRunForRecovery(input: {
            destinationId: string;
            organizationId: string;
            runnerId: string;
        }): Promise<{
            claimed: HostedAssignedRun;
            hostedAuthority: HostedImportAuthority;
            leaseExpiresAt: string;
        } | null> {
            const recoveredAt = Date.now();
            const operations = await db.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.destinationId, input.destinationId), eq(hostedClaimOperations.organizationId, input.organizationId), eq(hostedClaimOperations.runnerId, input.runnerId), eq(hostedClaimOperations.state, "claimed"))).orderBy(desc(hostedClaimOperations.acknowledgedAt), desc(hostedClaimOperations.operationId));
            for (const operation of operations) {
                if (operation.terminalReasonCode !== null) {
                    evictHostedExecutionPayload({
                        attemptId: operation.attemptId ?? undefined,
                        ...(operation.runId ? { runId: operation.runId } : {}),
                    });
                    continue;
                }
                if (!operation.runId)
                    continue;
                if (operation.executionStartedAt)
                    continue;
                const runRow = await db.select().from(runs).where(and(eq(runs.id, operation.runId), inArray(runs.status, ["assigned", "running"]), eq(runs.assignedRunnerId, input.runnerId))).limit(1).get();
                if (!runRow?.currentAttemptId) {
                    evictHostedExecutionPayload({
                        attemptId: operation.attemptId ?? undefined,
                        runId: operation.runId,
                    });
                    continue;
                }
                const attemptRow = await db.select().from(attempts).where(and(eq(attempts.id, runRow.currentAttemptId), eq(attempts.runId, runRow.id), inArray(attempts.status, ["assigned", "running"]))).limit(1).get();
                const importRow = await db.select().from(hostedRunImports)
                    .where(eq(hostedRunImports.runId, runRow.id)).limit(1).get();
                const attemptImportRow = attemptRow
                    ? await db.select().from(hostedAttemptImports)
                        .where(eq(hostedAttemptImports.attemptId, attemptRow.id)).limit(1).get()
                    : undefined;
                if (!attemptRow || !importRow || !attemptImportRow || !attemptRow.selectedExecutorId
                    || attemptRow.number !== attemptImportRow.attemptNumber
                    || operation.operationId !== attemptImportRow.claimOperationId) {
                    evictHostedExecutionPayload({
                        attemptId: attemptRow?.id ?? operation.attemptId ?? undefined,
                        runId: runRow.id,
                    });
                    throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                }
                const leaseExpiresAt = Date.parse(attemptRow.leaseExpiresAt);
                if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= recoveredAt) {
                    evictHostedExecutionPayload({ attemptId: attemptRow.id });
                    continue;
                }
                const executionPayload = hostedExecutionPayloads.get(attemptRow.id);
                if (!executionPayload)
                    return null;
                const hostedAuthority: HostedImportAuthority = {
                    ...(JSON.parse(attemptImportRow.authorityJson) as HostedClaimV1["authority"]),
                    admissionId: importRow.admissionId,
                    admissionOperationId: importRow.admissionOperationId,
                    claimOperationId: attemptImportRow.claimOperationId,
                    admissionEnvelopeDigest: importRow.admissionEnvelopeDigest,
                    sourceIdentityDigest: importRow.sourceIdentityDigest,
                    deliveryPayloadDigest: importRow.deliveryPayloadDigest,
                    policyReceiptId: importRow.policyReceiptId,
                    policyPayloadDigest: importRow.policyPayloadDigest,
                    policyReceiptDigest: importRow.policyReceiptDigest,
                    eventDigest: importRow.eventDigest,
                    contextPacketDigest: importRow.contextPacketDigest,
                    ...(importRow.workThreadId ? { workThreadId: importRow.workThreadId } : {}),
                    ...(importRow.workThreadDigest ? { workThreadDigest: importRow.workThreadDigest } : {}),
                    claimDigest: attemptImportRow.claimDigest,
                    authorityDigest: attemptImportRow.authorityDigest,
                    importedAt: attemptImportRow.importedAt
                };
                return {
                    claimed: {
                        run: { ...runFromRow(runRow), contextPacket: executionPayload.contextPacket },
                        event: executionPayload.event,
                        attemptId: attemptRow.id,
                        attemptNumber: attemptRow.number,
                        fencingToken: attemptRow.fencingToken,
                        executorId: attemptRow.selectedExecutorId
                    },
                    hostedAuthority,
                    leaseExpiresAt: attemptRow.leaseExpiresAt
                };
            }
            return null;
        },
        async markHostedRunRunningLocally(input: {
            runId: string;
            runnerId: string;
            attemptId: string;
            fencingToken: string;
            executor: string;
            executorCapability?: unknown;
            runTimeoutMs?: number;
            idempotencyKey?: string;
            destinationId: string;
            organizationId: string;
            credentialId: string;
            request: HostedRunningRequestV1;
        }): Promise<{
            outcome: MarkRunningOutcome;
            operation: HostedLifecycleOperation;
        }> {
            const request = HostedRunningRequestV1Schema.parse(input.request);
            const safeInput = await sanitizeRunnerControlledInputForRun(input.runId, input);
            if (request.attempt.attemptId !== input.attemptId
                || request.attempt.fencingTokenDigest !== await computeHostedClaimFencingTokenDigestV1(input.fencingToken)
                || request.executorId !== safeInput.executor
                || request.runTimeoutMs !== safeInput.runTimeoutMs)
                throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
            const prepared = await prepareHostedLifecycleOperation({
                destinationId: input.destinationId,
                organizationId: input.organizationId,
                runnerId: input.runnerId,
                credentialId: input.credentialId,
                runId: input.runId,
                action: "running",
                request
            });
            return db.transaction((tx) => {
                const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
                const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
                const importedAttempt = tx.select().from(hostedAttemptImports)
                    .where(eq(hostedAttemptImports.attemptId, input.attemptId)).limit(1).get();
                const claim = importedAttempt
                    ? tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId), eq(hostedClaimOperations.destinationId, input.destinationId), eq(hostedClaimOperations.organizationId, input.organizationId), eq(hostedClaimOperations.runnerId, input.runnerId), eq(hostedClaimOperations.runId, input.runId), eq(hostedClaimOperations.state, "claimed"))).limit(1).get()
                    : undefined;
                const authority = importedAttempt
                    ? JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]
                    : undefined;
                if (!run || !attempt || !importedAttempt || !claim || authority?.credentialId !== input.credentialId) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, input.attemptId, input.fencingToken);
                    throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                }
                if (run.assignedRunnerId !== input.runnerId
                    || run.currentAttemptId !== input.attemptId
                    || !["assigned", "running"].includes(run.status)
                    || attempt.runId !== input.runId
                    || attempt.runnerId !== input.runnerId
                    || attempt.fencingToken !== input.fencingToken
                    || !["assigned", "running"].includes(attempt.status)
                    || (attempt.selectedExecutorId !== null && attempt.selectedExecutorId !== safeInput.executor)
                    || !hasActiveAttemptLease(attempt)) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, input.attemptId, input.fencingToken);
                    throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                }
                const journal = enqueueHostedLifecycleOperationTx(tx, prepared);
                const duplicate = run.status === "running" && attempt.status === "running";
                if (!duplicate) {
                    tx.update(runs).set({ status: "running", executor: safeInput.executor, updatedAt: prepared.createdAt })
                        .where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId))).run();
                    tx.update(attempts).set({ status: "running", heartbeatAt: prepared.createdAt, updatedAt: prepared.createdAt })
                        .where(eq(attempts.id, input.attemptId)).run();
                    tx.insert(runEvents).values(runEventValues({
                        runId: input.runId,
                        type: "run.running",
                        payload: {
                            runnerId: input.runnerId,
                            attemptId: input.attemptId,
                            ...(safeInput.idempotencyKey ? { idempotencyKey: safeInput.idempotencyKey } : {}),
                            executor: safeInput.executor,
                            ...(safeInput.runTimeoutMs ? { runTimeoutMs: safeInput.runTimeoutMs } : {})
                        },
                        visibility: "audit",
                        importance: "normal",
                        createdAt: prepared.createdAt
                    })).run();
                    if (safeInput.executorCapability)
                        tx.insert(runEvents).values(runEventValues({
                            runId: input.runId,
                            type: "executor.capability.snapshot",
                            payload: { executor: safeInput.executor, capability: safeInput.executorCapability },
                            visibility: "audit",
                            importance: "normal",
                            message: `Executor capability snapshot recorded for ${safeInput.executor}.`,
                            createdAt: prepared.createdAt
                        })).run();
                }
                return { outcome: duplicate ? "duplicate" : "running", operation: journal.operation };
            }, { behavior: "immediate" });
        },
        async recordHostedProgressLocally(input: {
            runId: string;
            runnerId: string;
            attemptId: string;
            fencingToken: string;
            message: string;
            type?: string;
            at?: string;
            visibility?: RunEventVisibility;
            importance?: RunEventImportance;
            idempotencyKey: string;
            destinationId: string;
            organizationId: string;
            credentialId: string;
            request: HostedProgressRequestV1;
        }): Promise<{
            outcome: "recorded" | "duplicate";
            operation: HostedLifecycleOperation;
        }> {
            const request = HostedProgressRequestV1Schema.parse(input.request);
            const safeInput = await sanitizeRunnerControlledInputForRun(input.runId, input);
            const createdAt = safeInput.at ?? request.occurredAt;
            const expectedProgressDigest = await computeControlPayloadDigestV1({ type: "status", occurredAt: createdAt });
            if (request.attempt.attemptId !== input.attemptId
                || request.attempt.fencingTokenDigest !== await computeHostedClaimFencingTokenDigestV1(input.fencingToken)
                || request.progressDigest !== expectedProgressDigest
                || request.progressId !== `progress_${expectedProgressDigest.slice("sha256:".length)}`)
                throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
            const prepared = await prepareHostedLifecycleOperation({
                destinationId: input.destinationId,
                organizationId: input.organizationId,
                runnerId: input.runnerId,
                credentialId: input.credentialId,
                runId: input.runId,
                action: "progress",
                request
            });
            return db.transaction((tx) => {
                const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
                const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
                const importedAttempt = tx.select().from(hostedAttemptImports)
                    .where(eq(hostedAttemptImports.attemptId, input.attemptId)).limit(1).get();
                const claim = importedAttempt
                    ? tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId), eq(hostedClaimOperations.destinationId, input.destinationId), eq(hostedClaimOperations.organizationId, input.organizationId), eq(hostedClaimOperations.runnerId, input.runnerId), eq(hostedClaimOperations.runId, input.runId), eq(hostedClaimOperations.state, "claimed"))).limit(1).get()
                    : undefined;
                const authority = importedAttempt
                    ? JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]
                    : undefined;
                if (!run || !attempt || !importedAttempt || !claim || authority?.credentialId !== input.credentialId
                    || run.assignedRunnerId !== input.runnerId
                    || run.currentAttemptId !== input.attemptId || run.status !== "running"
                    || attempt.runId !== input.runId || attempt.runnerId !== input.runnerId
                    || attempt.fencingToken !== input.fencingToken || attempt.status !== "running"
                    || !hasActiveAttemptLease(attempt)) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, input.attemptId, input.fencingToken);
                    throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                }
                const journal = enqueueHostedLifecycleOperationTx(tx, prepared);
                const digest = progressIdempotencyDigest(input.idempotencyKey);
                const inserted = tx.insert(runEvents).values({
                    runId: input.runId,
                    type: "run.progress",
                    payloadJson: JSON.stringify({
                        runnerId: input.runnerId,
                        attemptId: input.attemptId,
                        type: safeInput.type ?? "progress",
                        message: safeInput.message,
                        at: createdAt
                    }),
                    progressIdempotencyDigest: digest,
                    visibility: safeInput.visibility ?? "audit",
                    importance: safeInput.importance ?? "normal",
                    message: safeInput.message,
                    createdAt
                }).onConflictDoNothing({ target: [runEvents.runId, runEvents.progressIdempotencyDigest] }).run();
                return { outcome: inserted.changes === 1 ? "recorded" : "duplicate", operation: journal.operation };
            }, { behavior: "immediate" });
        },
        async rejectHostedAttemptStartLocally(input: {
            runId: string;
            runnerId: string;
            attemptId: string;
            fencingToken: string;
            executorId: string;
            reason: string;
            destinationId: string;
            organizationId: string;
            credentialId: string;
            request: HostedRejectStartRequestV1;
        }): Promise<{
            outcome: RejectAttemptStartOutcome | "journaled";
            operation: HostedLifecycleOperation;
        }> {
            const request = HostedRejectStartRequestV1Schema.parse(input.request);
            const safeInput = await sanitizeRunnerControlledInputForRun(input.runId, input);
            if (request.attempt.attemptId !== input.attemptId
                || request.attempt.fencingTokenDigest !== await computeHostedClaimFencingTokenDigestV1(input.fencingToken)
                || request.executorId !== safeInput.executorId)
                throw new HostedLifecycleOperationConflictError("HOSTED_LIFECYCLE_OPERATION_INVALID");
            const prepared = await prepareHostedLifecycleOperation({
                destinationId: input.destinationId,
                organizationId: input.organizationId,
                runnerId: input.runnerId,
                credentialId: input.credentialId,
                runId: input.runId,
                action: "reject-start",
                request
            });
            const rejection = db.transaction((tx) => {
                const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
                const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
                const claim = tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.destinationId, input.destinationId), eq(hostedClaimOperations.organizationId, input.organizationId), eq(hostedClaimOperations.runnerId, input.runnerId), eq(hostedClaimOperations.runId, input.runId), eq(hostedClaimOperations.attemptId, input.attemptId), eq(hostedClaimOperations.attemptNumber, request.attempt.attemptNumber), eq(hostedClaimOperations.fencingTokenDigest, request.attempt.fencingTokenDigest), eq(hostedClaimOperations.credentialId, input.credentialId), eq(hostedClaimOperations.executorId, safeInput.executorId), eq(hostedClaimOperations.state, "claimed"))).limit(1).get();
                const shellAuthority = claim?.authorityJson
                    ? JSON.parse(claim.authorityJson) as HostedClaimV1["authority"]
                    : undefined;
                const validShell = Boolean(claim?.claimDigest && claim.authorityDigest && shellAuthority
                    && canonicalSha256Json(shellAuthority) === claim.authorityDigest
                    && shellAuthority.organizationId === input.organizationId
                    && shellAuthority.runnerId === input.runnerId
                    && shellAuthority.runId === input.runId
                    && shellAuthority.credentialId === input.credentialId
                    && Number.isFinite(Date.parse(claim.leaseExpiresAt ?? ""))
                    && Date.parse(claim.leaseExpiresAt ?? "") > Date.parse(prepared.createdAt));
                if (!run || !attempt) {
                    if (!validShell) {
                        evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, input.attemptId, input.fencingToken);
                        throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                    }
                    const journal = enqueueHostedLifecycleOperationTx(tx, prepared);
                    return { outcome: "journaled" as const, operation: journal.operation };
                }
                const journal = enqueueHostedLifecycleOperationTx(tx, prepared);
                const alreadyRejected = routingRejectionsFromJson(run.routingRejectionsJson).some((rejection) => rejection.runnerId === input.runnerId && rejection.executorId === safeInput.executorId);
                if (alreadyRejected && run.currentAttemptId !== input.attemptId) {
                    return { outcome: "duplicate" as const, operation: journal.operation };
                }
                if (run.status !== "assigned" || run.currentAttemptId !== input.attemptId
                    || run.assignedRunnerId !== input.runnerId || attempt.runId !== input.runId
                    || attempt.runnerId !== input.runnerId || attempt.fencingToken !== input.fencingToken
                    || attempt.status !== "assigned" || attempt.selectedExecutorId !== safeInput.executorId
                    || !hasActiveAttemptLease(attempt)) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, input.attemptId, input.fencingToken);
                    throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                }
                const rejections = routingRejectionsFromJson(run.routingRejectionsJson);
                const stableReason = "hosted_attempt_start_rejected";
                rejections.push({ runnerId: input.runnerId, executorId: safeInput.executorId, reason: stableReason });
                tx.update(attempts).set({
                    status: "interrupted", finishedAt: prepared.createdAt,
                    resultJson: JSON.stringify({ conclusion: "interrupted",
                        summary: "Hosted Attempt start rejected." }),
                    updatedAt: prepared.createdAt
                }).where(eq(attempts.id, input.attemptId)).run();
                tx.update(runs).set({
                    status: "queued", assignedRunnerId: null, executor: null, leasedAt: null,
                    leaseExpiresAt: null, heartbeatAt: null, currentAttemptId: null,
                    currentRoutingDecisionId: null, routingRejectionsJson: JSON.stringify(rejections),
                    updatedAt: prepared.createdAt
                }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId))).run();
                tx.insert(runEvents).values(runEventValues({
                    runId: input.runId,
                    type: "routing.preflight_rejected",
                    payload: {
                        runnerId: input.runnerId, executorId: safeInput.executorId,
                        attemptId: input.attemptId, routingDecisionId: attempt.routingDecisionId,
                        reasonCode: stableReason
                    },
                    visibility: "audit", importance: "blocking",
                    message: "Hosted Attempt start rejected.",
                    createdAt: prepared.createdAt
                })).run();
                return { outcome: "requeued" as const, operation: journal.operation };
            }, { behavior: "immediate" });
            if (["requeued", "duplicate", "journaled"].includes(rejection.outcome)) {
                hostedExecutionPayloads.delete(input.attemptId);
            }
            return rejection;
        },
        async acquireHostedExecutionStart(input: {
            runId: string;
            attemptId: string;
            fencingToken: string;
        }): Promise<boolean> {
            return db.transaction((tx) => {
                const startedAt = nowIso();
                const imported = tx.select().from(hostedRunImports)
                    .where(eq(hostedRunImports.runId, input.runId)).limit(1).get();
                const importedAttempt = tx.select().from(hostedAttemptImports)
                    .where(eq(hostedAttemptImports.attemptId, input.attemptId)).limit(1).get();
                const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
                const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
                const operation = tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.operationId, importedAttempt?.claimOperationId ?? ""), eq(hostedClaimOperations.state, "claimed"), eq(hostedClaimOperations.runId, input.runId))).limit(1).get();
                const credentialId = importedAttempt
                    ? (JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]).credentialId
                    : "";
                const runningOperation = operation
                    ? tx.select().from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, operation.destinationId), eq(hostedLifecycleOperations.organizationId, operation.organizationId), eq(hostedLifecycleOperations.runnerId, operation.runnerId), eq(hostedLifecycleOperations.credentialId, credentialId), eq(hostedLifecycleOperations.runId, input.runId), eq(hostedLifecycleOperations.attemptId, input.attemptId), eq(hostedLifecycleOperations.action, "running"), eq(hostedLifecycleOperations.state, "acknowledged"))).limit(1).get()
                    : undefined;
                if (!imported || !importedAttempt || !run || !attempt || !operation || !runningOperation
                    || importedAttempt.runId !== input.runId
                    || run.status !== "running"
                    || run.currentAttemptId !== input.attemptId
                    || attempt.runId !== input.runId
                    || attempt.status !== "running"
                    || attempt.fencingToken !== input.fencingToken
                    || !validAcknowledgedLifecycleDependency(runningOperation)) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, input.attemptId, input.fencingToken);
                    throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                }
                const leaseExpiresAt = Date.parse(attempt.leaseExpiresAt);
                if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.parse(startedAt)) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, input.attemptId, input.fencingToken);
                    return false;
                }
                if (operation.executionStartedAt)
                    return false;
                const acquired = tx.update(hostedClaimOperations).set({
                    executionStartedAt: startedAt,
                    updatedAt: startedAt
                }).where(and(eq(hostedClaimOperations.operationId, operation.operationId), isNull(hostedClaimOperations.executionStartedAt))).run();
                return acquired.changes === 1;
            });
        },
        async isHostedExecutionCurrent(input: {
            runId: string;
            attemptId: string;
            fencingToken: string;
        }): Promise<boolean> {
            return db.transaction((tx) => {
                const checkedAt = Date.now();
                const importedRun = tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports)
                    .where(eq(hostedRunImports.runId, input.runId)).limit(1).get();
                const importedAttempt = tx.select().from(hostedAttemptImports)
                    .where(eq(hostedAttemptImports.attemptId, input.attemptId)).limit(1).get();
                const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
                const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
                const operation = tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.operationId, importedAttempt?.claimOperationId ?? ""), eq(hostedClaimOperations.state, "claimed"), eq(hostedClaimOperations.runId, input.runId), isNotNull(hostedClaimOperations.executionStartedAt))).limit(1).get();
                if (operation && operation.terminalReasonCode !== null) {
                    evictHostedExecutionPayload({ attemptId: input.attemptId });
                    return false;
                }
                if (!importedRun || !importedAttempt || !run || !attempt || !operation
                    || importedAttempt.runId !== input.runId
                    || attempt.number !== importedAttempt.attemptNumber
                    || run.currentAttemptId !== input.attemptId
                    || !["assigned", "running", "needs_approval"].includes(run.status)
                    || attempt.runId !== input.runId
                    || !["assigned", "running"].includes(attempt.status)) {
                    evictHostedExecutionPayload({ attemptId: input.attemptId });
                    return false;
                }
                if (attempt.fencingToken !== input.fencingToken) {
                    evictHostedExecutionPayloadIfFenceChanged(input.attemptId, attempt.fencingToken);
                    return false;
                }
                const leaseExpiresAt = Date.parse(attempt.leaseExpiresAt);
                const current = Number.isFinite(leaseExpiresAt) && leaseExpiresAt > checkedAt;
                if (!current)
                    evictHostedExecutionPayload({ attemptId: input.attemptId });
                return current;
            });
        },
        async getHostedExecutionLease(input: {
            destinationId: string;
            organizationId: string;
            runnerId: string;
            credentialId: string;
            runId: string;
            attemptId: string;
            fencingToken: string;
        }): Promise<{
            leaseExpiresAt: string;
        } | null> {
            return db.transaction((tx) => {
                const checkedAt = Date.now();
                const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
                const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
                const importedAttempt = tx.select().from(hostedAttemptImports)
                    .where(eq(hostedAttemptImports.attemptId, input.attemptId)).limit(1).get();
                const operation = importedAttempt
                    ? tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId), eq(hostedClaimOperations.destinationId, input.destinationId), eq(hostedClaimOperations.organizationId, input.organizationId), eq(hostedClaimOperations.runnerId, input.runnerId), eq(hostedClaimOperations.state, "claimed"), eq(hostedClaimOperations.runId, input.runId), isNotNull(hostedClaimOperations.executionStartedAt), isNull(hostedClaimOperations.terminalReasonCode))).limit(1).get()
                    : undefined;
                if (!run || !attempt || !importedAttempt || !operation
                    || run.currentAttemptId !== input.attemptId
                    || run.assignedRunnerId !== input.runnerId
                    || !["assigned", "running", "needs_approval"].includes(run.status)
                    || run.leaseExpiresAt !== attempt.leaseExpiresAt
                    || attempt.runId !== input.runId
                    || attempt.runnerId !== input.runnerId
                    || !["assigned", "running"].includes(attempt.status)
                    || attempt.fencingToken !== input.fencingToken
                    || importedAttempt.runId !== input.runId
                    || importedAttempt.attemptNumber !== attempt.number
                    || (JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]).credentialId !== input.credentialId) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, input.attemptId, input.fencingToken);
                    return null;
                }
                const leaseExpiresAt = Date.parse(attempt.leaseExpiresAt);
                if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= checkedAt) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, input.attemptId, input.fencingToken);
                    return null;
                }
                return { leaseExpiresAt: attempt.leaseExpiresAt };
            });
        },
        async claimDueHostedLifecycleOperations(input: {
            destinationId: string;
            organizationId: string;
            leaseOwner: string;
            leaseSeconds: number;
            limit?: number;
            now?: Date;
        }): Promise<HostedLifecycleOperation[]> {
            if (!input.leaseOwner || !Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) {
                throw new Error("hosted_lifecycle_operation_lease_invalid");
            }
            const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50)));
            const now = input.now ?? new Date();
            const at = now.toISOString();
            const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000).toISOString();
            return db.transaction((tx) => {
                const predecessor = alias(hostedLifecycleOperations, "hosted_lifecycle_predecessor");
                const due = tx.select().from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), notExists(tx.select({ operationId: predecessor.operationId })
                    .from(predecessor)
                    .where(and(eq(predecessor.destinationId, hostedLifecycleOperations.destinationId), eq(predecessor.organizationId, hostedLifecycleOperations.organizationId), eq(predecessor.runId, hostedLifecycleOperations.runId), eq(predecessor.attemptId, hostedLifecycleOperations.attemptId), lt(predecessor.sequence, hostedLifecycleOperations.sequence), sql `${predecessor.state} <> 'acknowledged'`))), or(and(eq(hostedLifecycleOperations.state, "pending"), lte(hostedLifecycleOperations.nextAttemptAt, at)), and(eq(hostedLifecycleOperations.state, "leased"), lte(hostedLifecycleOperations.leaseExpiresAt, at))))).orderBy(asc(hostedLifecycleOperations.runId), asc(hostedLifecycleOperations.attemptId), asc(hostedLifecycleOperations.sequence), asc(hostedLifecycleOperations.operationId)).limit(limit).all();
                const claimed: HostedLifecycleOperation[] = [];
                for (const row of due) {
                    const leaseToken = randomUUID();
                    const updated = tx.update(hostedLifecycleOperations).set({
                        state: "leased",
                        attemptCount: row.attemptCount + 1,
                        leaseOwner: input.leaseOwner,
                        leaseToken,
                        leaseExpiresAt,
                        updatedAt: at
                    }).where(and(eq(hostedLifecycleOperations.destinationId, row.destinationId), eq(hostedLifecycleOperations.organizationId, row.organizationId), eq(hostedLifecycleOperations.runnerId, row.runnerId), eq(hostedLifecycleOperations.credentialId, row.credentialId), eq(hostedLifecycleOperations.operationId, row.operationId), or(and(eq(hostedLifecycleOperations.state, "pending"), lte(hostedLifecycleOperations.nextAttemptAt, at)), and(eq(hostedLifecycleOperations.state, "leased"), lte(hostedLifecycleOperations.leaseExpiresAt, at))))).run();
                    if (updated.changes !== 1)
                        continue;
                    claimed.push(hostedLifecycleOperationFromRow({
                        ...row,
                        state: "leased",
                        attemptCount: row.attemptCount + 1,
                        leaseOwner: input.leaseOwner,
                        leaseToken,
                        leaseExpiresAt,
                        updatedAt: at
                    }));
                }
                return claimed;
            }, { behavior: "immediate" });
        },
        async acknowledgeHostedLifecycleOperation(input: {
            destinationId: string;
            organizationId: string;
            operationId: string;
            leaseToken: string;
            receipt: HostedLifecycleReceiptEnvelopeV1;
            now?: Date;
        }): Promise<"acknowledged" | "stale_lease" | "not_found"> {
            const receipt = HostedLifecycleReceiptEnvelopeV1Schema.parse(input.receipt);
            const at = (input.now ?? new Date()).toISOString();
            const preflightRow = await db.select().from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), eq(hostedLifecycleOperations.operationId, input.operationId))).limit(1).get();
            if (!preflightRow)
                return "not_found";
            const request = HostedLifecycleRequestV1Schema.parse(JSON.parse(preflightRow.requestJson));
            const expectedReceiptId = await computeHostedLifecycleReceiptIdV1({
                organizationId: preflightRow.organizationId,
                operationId: preflightRow.operationId
            });
            if (receipt.receiptId !== expectedReceiptId
                || !(await verifyHostedLifecycleReceiptV1({
                    receipt,
                    request,
                    action: preflightRow.action as HostedLifecycleActionV1,
                    organizationId: preflightRow.organizationId,
                    runnerId: preflightRow.runnerId,
                    runId: preflightRow.runId,
                    credentialId: preflightRow.credentialId
                })))
                return "stale_lease";
            return db.transaction((tx) => {
                const row = tx.select().from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), eq(hostedLifecycleOperations.operationId, input.operationId))).limit(1).get();
                if (!row)
                    return "not_found" as const;
                if (row.state === "acknowledged") {
                    return row.receiptId === receipt.receiptId
                        && row.receiptDigest === receipt.receiptDigest
                        && row.receiptJson === canonicalJsonStringify(receipt)
                        ? "acknowledged" as const
                        : "stale_lease" as const;
                }
                if (row.state !== "leased" || row.leaseToken !== input.leaseToken
                    || !row.leaseExpiresAt || row.leaseExpiresAt <= at
                    || receipt.organizationId !== row.organizationId
                    || receipt.runId !== row.runId
                    || receipt.operationId !== row.operationId
                    || receipt.requestId !== row.requestId
                    || receipt.requestDigest !== row.requestDigest
                    || receipt.producer.id !== row.runnerId
                    || receipt.producer.credentialId !== row.credentialId
                    || receipt.attempt.attemptId !== row.attemptId
                    || receipt.attempt.attemptNumber !== row.attemptNumber
                    || receipt.attempt.fencingTokenDigest !== row.fencingTokenDigest)
                    return "stale_lease" as const;
                return acknowledgeHostedLifecycleOperationTx({
                    tx,
                    row,
                    receipt,
                    acknowledgedAt: at,
                    expectedState: "leased",
                    leaseToken: input.leaseToken
                }) ? "acknowledged" as const : "stale_lease" as const;
            }, { behavior: "immediate" });
        },
        async retryHostedLifecycleOperation(input: {
            destinationId: string;
            organizationId: string;
            operationId: string;
            leaseToken: string;
            nextAttemptAt: string;
            reasonCode: string;
            now?: Date;
        }): Promise<"retried" | "stale_lease" | "not_found"> {
            const at = (input.now ?? new Date()).toISOString();
            if (input.nextAttemptAt < at)
                throw new Error("hosted_lifecycle_retry_time_in_past");
            return db.transaction((tx) => {
                const row = tx.select().from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), eq(hostedLifecycleOperations.operationId, input.operationId))).limit(1).get();
                if (!row)
                    return "not_found" as const;
                if (row.state !== "leased" || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= at) {
                    return "stale_lease" as const;
                }
                const updated = tx.update(hostedLifecycleOperations).set({
                    state: "pending",
                    nextAttemptAt: input.nextAttemptAt,
                    leaseOwner: null,
                    leaseToken: null,
                    leaseExpiresAt: null,
                    lastReasonCode: input.reasonCode,
                    updatedAt: at
                }).where(and(eq(hostedLifecycleOperations.operationId, row.operationId), eq(hostedLifecycleOperations.state, "leased"), eq(hostedLifecycleOperations.leaseToken, input.leaseToken), gt(hostedLifecycleOperations.leaseExpiresAt, at))).run();
                return updated.changes === 1 ? "retried" as const : "stale_lease" as const;
            }, { behavior: "immediate" });
        },
        async markHostedLifecycleOperationAttention(input: {
            destinationId: string;
            organizationId: string;
            operationId: string;
            leaseToken: string;
            reasonCode: string;
            now?: Date;
        }): Promise<"attention" | "stale_lease" | "not_found"> {
            const at = (input.now ?? new Date()).toISOString();
            return db.transaction((tx) => {
                const row = tx.select().from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), eq(hostedLifecycleOperations.operationId, input.operationId))).limit(1).get();
                if (!row)
                    return "not_found" as const;
                if (row.state !== "leased" || row.leaseToken !== input.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt <= at) {
                    return "stale_lease" as const;
                }
                const updated = tx.update(hostedLifecycleOperations).set({
                    state: "attention",
                    nextAttemptAt: null,
                    leaseOwner: null,
                    leaseToken: null,
                    leaseExpiresAt: null,
                    lastReasonCode: input.reasonCode,
                    updatedAt: at
                }).where(and(eq(hostedLifecycleOperations.operationId, row.operationId), eq(hostedLifecycleOperations.state, "leased"), eq(hostedLifecycleOperations.leaseToken, input.leaseToken), gt(hostedLifecycleOperations.leaseExpiresAt, at))).run();
                return updated.changes === 1 ? "attention" as const : "stale_lease" as const;
            }, { behavior: "immediate" });
        },
        async recoverExpiredHostedLifecycleOperations(input: {
            destinationId: string;
            organizationId: string;
            now?: Date;
        }): Promise<number> {
            const at = (input.now ?? new Date()).toISOString();
            return db.transaction((tx) => tx.update(hostedLifecycleOperations).set({
                state: "pending",
                nextAttemptAt: at,
                leaseOwner: null,
                leaseToken: null,
                leaseExpiresAt: null,
                lastReasonCode: "lease_expired",
                updatedAt: at
            }).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), eq(hostedLifecycleOperations.state, "leased"), lte(hostedLifecycleOperations.leaseExpiresAt, at))).run().changes, { behavior: "immediate" });
        },
        async beginHostedHeartbeatOperation(input: {
            destinationId: string;
            organizationId: string;
            runnerId: string;
            credentialId: string;
            runId: string;
            attemptId: string;
            fencingToken: string;
            request: HostedHeartbeatRequestV1;
        }): Promise<{
            outcome: "created" | "replayed";
            operation: HostedHeartbeatOperation;
        }> {
            const prepared = await prepareHostedLifecycleOperation({
                destinationId: input.destinationId,
                organizationId: input.organizationId,
                runnerId: input.runnerId,
                credentialId: input.credentialId,
                runId: input.runId,
                action: "heartbeat",
                request: input.request
            });
            const request = prepared.request as HostedHeartbeatRequestV1;
            return db.transaction((tx) => {
                const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
                const attempt = tx.select().from(attempts).where(and(eq(attempts.id, input.attemptId), eq(attempts.runId, input.runId), eq(attempts.runnerId, input.runnerId), eq(attempts.fencingToken, input.fencingToken))).limit(1).get();
                const importedAttempt = tx.select().from(hostedAttemptImports).where(and(eq(hostedAttemptImports.attemptId, input.attemptId), eq(hostedAttemptImports.runId, input.runId))).limit(1).get();
                const claimOperation = importedAttempt
                    ? tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId), eq(hostedClaimOperations.destinationId, input.destinationId), eq(hostedClaimOperations.organizationId, input.organizationId), eq(hostedClaimOperations.runnerId, input.runnerId), eq(hostedClaimOperations.state, "claimed"), eq(hostedClaimOperations.runId, input.runId), isNotNull(hostedClaimOperations.executionStartedAt), isNull(hostedClaimOperations.terminalReasonCode))).limit(1).get()
                    : undefined;
                const authorityCredentialId = importedAttempt
                    ? (JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]).credentialId
                    : undefined;
                if (!run || !attempt || !importedAttempt || !claimOperation
                    || request.attempt.attemptId !== input.attemptId
                    || request.attempt.attemptNumber !== attempt.number
                    || request.attempt.epoch !== attempt.number
                    || request.attempt.fencingToken !== input.fencingToken
                    || request.attempt.fencingTokenDigest !== importedAttempt.fencingTokenDigest
                    || request.expectedLeaseExpiresAt !== attempt.leaseExpiresAt
                    || run.currentAttemptId !== input.attemptId
                    || run.assignedRunnerId !== input.runnerId
                    || !["running", "needs_approval"].includes(run.status)
                    || run.leaseExpiresAt !== attempt.leaseExpiresAt
                    || attempt.status !== "running"
                    || importedAttempt.attemptNumber !== attempt.number
                    || authorityCredentialId !== input.credentialId
                    || !Number.isFinite(Date.parse(attempt.leaseExpiresAt))
                    || Date.parse(attempt.leaseExpiresAt) <= Date.parse(prepared.createdAt)) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(tx, input.attemptId, input.fencingToken);
                    throw new HostedImportConflictError("HOSTED_HEARTBEAT_OPERATION_CONFLICT");
                }
                const result = enqueueHostedLifecycleOperationTx(tx, prepared);
                const operation = result.operation;
                if (operation.state !== "pending" && operation.state !== "acknowledged") {
                    throw new HostedImportConflictError("HOSTED_HEARTBEAT_OPERATION_CONFLICT");
                }
                return {
                    outcome: result.outcome,
                    operation: {
                        destinationId: operation.destinationId,
                        organizationId: operation.organizationId,
                        runnerId: operation.runnerId,
                        credentialId: operation.credentialId,
                        operationId: operation.operationId,
                        requestId: operation.requestId,
                        runId: operation.runId,
                        attemptId: operation.attemptId,
                        attemptNumber: operation.attemptNumber,
                        fencingTokenDigest: operation.fencingTokenDigest,
                        expectedLeaseExpiresAt: request.expectedLeaseExpiresAt,
                        requestDigest: operation.requestDigest,
                        request,
                        state: operation.state,
                        createdAt: operation.createdAt,
                        updatedAt: operation.updatedAt,
                        ...(operation.receiptDigest ? { receiptDigest: operation.receiptDigest } : {}),
                        ...(operation.receipt ? { receipt: operation.receipt } : {}),
                        ...(operation.receipt?.payload.operation === "heartbeat"
                            ? { acceptedLeaseExpiresAt: operation.receipt.payload.leaseExpiresAt }
                            : {}),
                        ...(operation.acknowledgedAt ? { acknowledgedAt: operation.acknowledgedAt } : {})
                    }
                };
            }, { behavior: "immediate" });
        },
        async getHostedHeartbeatOperationForRetry(input: {
            destinationId: string;
            organizationId: string;
            runnerId: string;
            credentialId: string;
            runId: string;
            attemptId: string;
            fencingToken: string;
        }): Promise<HostedHeartbeatOperation | null> {
            const row = await db.select().from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, input.destinationId), eq(hostedLifecycleOperations.organizationId, input.organizationId), eq(hostedLifecycleOperations.runnerId, input.runnerId), eq(hostedLifecycleOperations.credentialId, input.credentialId), eq(hostedLifecycleOperations.runId, input.runId), eq(hostedLifecycleOperations.attemptId, input.attemptId), eq(hostedLifecycleOperations.action, "heartbeat"), eq(hostedLifecycleOperations.state, "pending"))).orderBy(desc(hostedLifecycleOperations.createdAt)).limit(1).get();
            if (!row)
                return null;
            const request = HostedHeartbeatRequestV1Schema.parse(JSON.parse(row.requestJson));
            const lease = await this.getHostedExecutionLease(input);
            if (!lease || request.expectedLeaseExpiresAt !== lease.leaseExpiresAt)
                return null;
            return {
                destinationId: row.destinationId,
                organizationId: row.organizationId,
                runnerId: row.runnerId,
                credentialId: row.credentialId,
                operationId: row.operationId,
                requestId: row.requestId,
                runId: row.runId,
                attemptId: row.attemptId,
                attemptNumber: row.attemptNumber,
                fencingTokenDigest: row.fencingTokenDigest,
                expectedLeaseExpiresAt: request.expectedLeaseExpiresAt,
                requestDigest: row.requestDigest,
                request,
                state: "pending",
                createdAt: row.createdAt,
                updatedAt: row.updatedAt
            };
        },
        async acknowledgeHostedClaimEmpty(input: {
            operationId: string;
            requestId: string;
        }): Promise<HostedClaimOperation> {
            const acknowledgedAt = nowIso();
            return db.transaction((tx) => {
                const current = tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.operationId, input.operationId), eq(hostedClaimOperations.requestId, input.requestId))).limit(1).get();
                if (!current)
                    throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
                if (current.state === "empty")
                    return hostedClaimOperationFromRow(current);
                if (current.state !== "pending") {
                    throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
                }
                tx.update(hostedClaimOperations).set({
                    state: "empty",
                    activeKey: null,
                    updatedAt: acknowledgedAt,
                    acknowledgedAt
                }).where(and(eq(hostedClaimOperations.operationId, input.operationId), eq(hostedClaimOperations.state, "pending"))).run();
                return hostedClaimOperationFromRow(tx.select().from(hostedClaimOperations)
                    .where(eq(hostedClaimOperations.operationId, input.operationId)).limit(1).get()!);
            });
        },
        async abandonHostedClaimOperation(input: {
            operationId: string;
            requestId: string;
            reasonCode: "stale_control_authority" | "operation_digest_conflict";
        }): Promise<HostedClaimOperation> {
            const acknowledgedAt = nowIso();
            return db.transaction((tx) => {
                const current = tx.select().from(hostedClaimOperations).where(and(eq(hostedClaimOperations.operationId, input.operationId), eq(hostedClaimOperations.requestId, input.requestId))).limit(1).get();
                if (!current)
                    throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
                if (current.state === "empty" && current.terminalReasonCode === input.reasonCode) {
                    return hostedClaimOperationFromRow(current);
                }
                if (current.state !== "pending") {
                    throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
                }
                tx.update(hostedClaimOperations).set({
                    state: "empty",
                    activeKey: null,
                    terminalReasonCode: input.reasonCode,
                    updatedAt: acknowledgedAt,
                    acknowledgedAt
                }).where(and(eq(hostedClaimOperations.operationId, input.operationId), eq(hostedClaimOperations.state, "pending"))).run();
                return hostedClaimOperationFromRow(tx.select().from(hostedClaimOperations)
                    .where(eq(hostedClaimOperations.operationId, input.operationId)).limit(1).get()!);
            });
        },
        async getHostedProposalSettlementForRetry(input: {
            destinationId: string;
            organizationId: string;
            runnerId: string;
        }) {
            const candidates = await db.select().from(runs).where(and(
                eq(runs.status, "succeeded"),
                isNotNull(runs.resultJson),
            )).orderBy(runs.updatedAt).all();
            for (const run of candidates) {
                if (!run.resultJson)
                    continue;
                const imported = await db.select().from(hostedRunImports)
                    .where(eq(hostedRunImports.runId, run.id)).limit(1).get();
                const attempt = imported
                    ? await db.select().from(attempts).where(and(
                        eq(attempts.id, imported.attemptId),
                        eq(attempts.runId, run.id),
                        eq(attempts.runnerId, input.runnerId),
                        eq(attempts.status, "succeeded"),
                    )).limit(1).get()
                    : undefined;
                const claim = imported ? await db.select().from(hostedClaimOperations).where(and(
                    eq(hostedClaimOperations.operationId, imported.claimOperationId),
                    eq(hostedClaimOperations.destinationId, input.destinationId),
                    eq(hostedClaimOperations.organizationId, input.organizationId),
                    eq(hostedClaimOperations.runnerId, input.runnerId),
                    eq(hostedClaimOperations.state, "claimed"),
                )).limit(1).get() : undefined;
                const completion = attempt ? await db.select().from(hostedLifecycleOperations).where(and(
                    eq(hostedLifecycleOperations.destinationId, input.destinationId),
                    eq(hostedLifecycleOperations.organizationId, input.organizationId),
                    eq(hostedLifecycleOperations.runnerId, input.runnerId),
                    eq(hostedLifecycleOperations.runId, run.id),
                    eq(hostedLifecycleOperations.attemptId, attempt.id),
                    eq(hostedLifecycleOperations.action, "complete"),
                    eq(hostedLifecycleOperations.state, "acknowledged"),
                )).limit(1).get() : undefined;
                if (!attempt || !imported || !claim || !completion
                    || !validAcknowledgedLifecycleDependency(completion)
                    || attempt.fencingToken === "" || imported.fencingTokenDigest !== completion.fencingTokenDigest) {
                    continue;
                }
                const result = validatePersistedProposalEvidence(OpenTagRunResultSchema.parse(JSON.parse(run.resultJson)));
                const proposalArtifact = result.artifacts?.find((artifact) => artifact.id === `${run.id}:proposal-evidence`);
                const artifactDigest = proposalArtifact?.metadata?.["artifactDigest"];
                if (!proposalArtifact || typeof artifactDigest !== "string")
                    continue;
                const authority = JSON.parse(imported.authorityJson) as HostedClaimV1["authority"];
                const evidence = proposalArtifact.metadata?.["proposalEvidence"] as {
                    branch?: unknown;
                    baseRevision?: unknown;
                    finalRevision?: unknown;
                    finalTree?: unknown;
                } | undefined;
                if (!evidence || typeof evidence.branch !== "string"
                    || typeof evidence.baseRevision !== "string"
                    || typeof evidence.finalRevision !== "string"
                    || typeof evidence.finalTree !== "string")
                    continue;
                return { runId: run.id, attemptId: attempt.id, attemptNumber: attempt.number,
                    fencingToken: attempt.fencingToken, fencingTokenDigest: imported.fencingTokenDigest,
                    runnerGeneration: authority.credentialGeneration,
                    projectTargetId: authority.projectTargetId,
                    targetBindingDigest: authority.targetBindingDigest,
                    candidateId: `candidate_${artifactDigest.slice("sha256:".length, "sha256:".length + 48)}`, branch: evidence.branch,
                    baseRevision: evidence.baseRevision, finalRevision: evidence.finalRevision,
                    finalTree: evidence.finalTree, proposalArtifact };
            }
            return null;
        },
        async getHostedSucceededPublicationAuthority(input: {
            destinationId: string;
            organizationId: string;
            runnerId: string;
            runId: string;
            attemptId: string;
            fencingTokenDigest: string;
        }): Promise<{
            fencingToken: string;
            attemptNumber: number;
        } | null> {
            const run = await db.select().from(runs).where(and(eq(runs.id, input.runId), eq(runs.status, "succeeded"))).limit(1).get();
            const attempt = run ? await db.select().from(attempts).where(and(eq(attempts.id, input.attemptId), eq(attempts.runId, input.runId), eq(attempts.runnerId, input.runnerId), eq(attempts.status, "succeeded"))).limit(1).get() : undefined;
            const runImport = attempt ? await db.select().from(hostedRunImports)
                .where(and(eq(hostedRunImports.runId, input.runId), eq(hostedRunImports.attemptId, input.attemptId), eq(hostedRunImports.fencingTokenDigest, input.fencingTokenDigest)))
                .limit(1).get() : undefined;
            const attemptImport = runImport ? await db.select().from(hostedAttemptImports)
                .where(and(eq(hostedAttemptImports.attemptId, input.attemptId), eq(hostedAttemptImports.runId, input.runId), eq(hostedAttemptImports.attemptNumber, attempt!.number), eq(hostedAttemptImports.fencingTokenDigest, input.fencingTokenDigest)))
                .limit(1).get() : undefined;
            const claim = attemptImport ? await db.select().from(hostedClaimOperations)
                .where(and(eq(hostedClaimOperations.operationId, attemptImport.claimOperationId), eq(hostedClaimOperations.destinationId, input.destinationId), eq(hostedClaimOperations.organizationId, input.organizationId), eq(hostedClaimOperations.runnerId, input.runnerId), eq(hostedClaimOperations.state, "claimed")))
                .limit(1).get() : undefined;
            if (!attempt || !runImport || !attemptImport || !claim
                || attempt.fencingToken === "" || attempt.number !== attemptImport.attemptNumber)
                return null;
            return { fencingToken: attempt.fencingToken, attemptNumber: attempt.number };
        },
        async importHostedAssignedRun(input: {
            event: OpenTagEvent;
            claim: HostedClaimV1;
            sourceReceipt: HostedSourceRedemptionReceipt;
        }): Promise<ImportHostedAssignedRunResult> {
            let event: OpenTagEvent;
            let claim: HostedClaimV1;
            try {
                event = OpenTagEventSchema.parse(input.event);
                claim = HostedClaimV1Schema.parse(input.claim);
            }
            catch {
                throw new HostedImportConflictError("HOSTED_IMPORT_CLAIM_INVALID");
            }
            if (!(await verifyHostedAdmissionEnvelopeDigestV1(claim.hostedAdmission))
                || !(await verifyHostedClaimFencingTokenDigestV1(claim))) {
                throw new HostedImportConflictError("HOSTED_IMPORT_CLAIM_INVALID");
            }
            const admission = claim.hostedAdmission;
            const sourceReceipt = input.sourceReceipt;
            const projectTarget = projectTargetRefFromEvent(event);
            const deliveryId = sourceDeliveryIdFromEvent(event);
            const slackSourceMatches = event.source === "slack" && event.actor.provider === "slack"
                && event.workItem?.provider === "slack" && event.workItem.kind === "thread"
                && event.workItem.externalId === admission.sourceThread.providerThreadId
                && event.metadata["channelId"] === admission.sourceThread.channelId
                && event.metadata["messageTs"] === admission.sourceEvent.messageId;
            if (!slackSourceMatches
                || event.sourceEventId !== admission.sourceEvent.providerEventId
                || event.actor.providerUserId !== admission.verifiedActor.providerUserId
                || event.actor.handle !== admission.verifiedActor.login
                || deliveryId !== admission.deliveryId
                || projectTarget?.provider !== admission.repository.provider
                || projectTarget.owner !== admission.repository.owner
                || projectTarget.repo !== admission.repository.repo) {
                throw new HostedImportConflictError("HOSTED_IMPORT_EVENT_MISMATCH");
            }
            if (sourceReceipt.provider !== admission.provider
                || sourceReceipt.providerRepositoryId !== admission.repository.providerRepositoryId
                || sourceReceipt.owner !== admission.repository.owner
                || sourceReceipt.repo !== admission.repository.repo
                || canonicalSha256Json(sourceReceipt.sourceThread) !== canonicalSha256Json(admission.sourceThread)
                || canonicalSha256Json(sourceReceipt.sourceEvent) !== canonicalSha256Json(admission.sourceEvent)
                || sourceReceipt.actor.providerUserId !== admission.verifiedActor.providerUserId
                || sourceReceipt.actor.login !== admission.verifiedActor.login
                || sourceReceipt.sourceIdentityDigest !== admission.sourceIdentityDigest
                || sourceReceipt.eventDigest !== canonicalSha256Json(event)
                || !Number.isFinite(Date.parse(sourceReceipt.redeemedAt))) {
                throw new HostedImportConflictError("HOSTED_IMPORT_SOURCE_DIGEST_CONFLICT");
            }
            const importedAt = nowIso();
            const protocolFields = protocolRunFieldsFromEvent(event, event.receivedAt);
            const durableMetadata = Object.fromEntries(Object.entries(event.metadata ?? {})
                .filter(([key, value]) => ["owner", "repo", "repoProvider", "issueNumber",
                "pullRequestNumber", "deliveryId", "githubDeliveryId"].includes(key)
                && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")));
            const durableEvent = OpenTagEventSchema.parse({
                ...event,
                command: { rawText: "[redeemed source omitted]", intent: event.command.intent, args: {} },
                context: [],
                permissions: [],
                metadata: durableMetadata,
                ...(event.callback ? { callback: { provider: event.callback.provider,
                        uri: "opentag://hosted-source-callback-omitted" } } : {}),
            });
            const eventDigest = canonicalSha256Json(event);
            const contextPacketDigest = canonicalSha256Json(protocolFields.contextPacket);
            const incomingWorkThreadDigest = protocolFields.thread
                ? canonicalSha256Json(protocolFields.thread)
                : null;
            const claimDigest = canonicalSha256Json(claim);
            const authorityDigest = canonicalSha256Json(claim.authority);
            const result = db.transaction((tx) => {
                const claimOperation = tx.select().from(hostedClaimOperations).where(eq(hostedClaimOperations.operationId, claim.operationId)).limit(1).get();
                if (!claimOperation
                    || claimOperation.requestId !== claim.requestId
                    || claimOperation.organizationId !== claim.organizationId
                    || claimOperation.runnerId !== claim.runnerId) {
                    throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
                }
                const exactAuthorityShell = claimOperation.state === "claimed"
                    && claimOperation.runId === claim.runId
                    && claimOperation.claimDigest === claimDigest
                    && claimOperation.authorityDigest === authorityDigest
                    && claimOperation.authorityJson === canonicalJsonStringify(claim.authority)
                    && claimOperation.attemptId === claim.attempt.id
                    && claimOperation.attemptNumber === claim.attempt.number
                    && claimOperation.fencingTokenDigest === claim.attempt.fencingTokenDigest
                    && claimOperation.credentialId === claim.authority.credentialId
                    && claimOperation.leaseExpiresAt === claim.attempt.leaseExpiresAt
                    && claimOperation.executorId === claim.executorId;
                const claimAuthorityAvailable = claimOperation.state === "pending" || exactAuthorityShell;
                if (exactAuthorityShell) {
                    const rejection = tx.select({ operationId: hostedLifecycleOperations.operationId })
                        .from(hostedLifecycleOperations).where(and(eq(hostedLifecycleOperations.destinationId, claimOperation.destinationId), eq(hostedLifecycleOperations.organizationId, claim.organizationId), eq(hostedLifecycleOperations.runnerId, claim.runnerId), eq(hostedLifecycleOperations.credentialId, claim.authority.credentialId), eq(hostedLifecycleOperations.runId, claim.runId), eq(hostedLifecycleOperations.attemptId, claim.attempt.id), eq(hostedLifecycleOperations.action, "reject-start"))).limit(1).get();
                    if (rejection)
                        throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                }
                const existingImport = tx.select().from(hostedRunImports)
                    .where(eq(hostedRunImports.runId, claim.runId)).limit(1).get();
                if (existingImport) {
                    const importedAttempt = tx.select().from(hostedAttemptImports)
                        .where(eq(hostedAttemptImports.attemptId, claim.attempt.id)).limit(1).get();
                    if (!importedAttempt) {
                        const exactLineage = existingImport.admissionId === admission.admissionId
                            && existingImport.admissionOperationId === admission.operationId
                            && existingImport.sourceIdentityDigest === admission.sourceIdentityDigest
                            && existingImport.deliveryPayloadDigest === admission.deliveryPayloadDigest
                            && existingImport.admissionEnvelopeDigest === admission.envelopeDigest
                            && existingImport.eventDigest === eventDigest
                            && existingImport.contextPacketDigest === contextPacketDigest
                            && existingImport.workThreadDigest === incomingWorkThreadDigest;
                        if (!exactLineage) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_RUN_CONFLICT");
                        }
                        const currentRun = tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1).get();
                        const previousAttempt = currentRun?.currentAttemptId
                            ? tx.select().from(attempts).where(eq(attempts.id, currentRun.currentAttemptId)).limit(1).get()
                            : undefined;
                        const previousHostedAttempt = previousAttempt
                            ? tx.select().from(hostedAttemptImports)
                                .where(eq(hostedAttemptImports.attemptId, previousAttempt.id)).limit(1).get()
                            : undefined;
                        const retryablePreviousAttempt = Boolean(previousAttempt
                            && (["interrupted", "cancelled", "timed_out", "failed"].includes(previousAttempt.status)
                                || Date.parse(previousAttempt.leaseExpiresAt) <= Date.parse(importedAt)));
                        if (!currentRun || !previousAttempt || !previousHostedAttempt
                            || previousHostedAttempt.runId !== claim.runId
                            || previousHostedAttempt.attemptNumber !== previousAttempt.number
                            || terminalRunStatus(currentRun.status)
                            || !retryablePreviousAttempt
                            || !claimAuthorityAvailable
                            || claim.attempt.number !== previousAttempt.number + 1) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_ATTEMPT_CONFLICT");
                        }
                        if (tx.select({ attemptId: hostedAttemptImports.attemptId }).from(hostedAttemptImports)
                            .where(eq(hostedAttemptImports.claimOperationId, claim.operationId)).limit(1).get()) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_OPERATION_CONFLICT");
                        }
                        if (tx.select({ attemptId: hostedAttemptImports.attemptId }).from(hostedAttemptImports)
                            .where(eq(hostedAttemptImports.fencingTokenDigest, claim.attempt.fencingTokenDigest)).limit(1).get()) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_FENCE_CONFLICT");
                        }
                        if (tx.select({ attemptId: hostedAttemptImports.attemptId }).from(hostedAttemptImports)
                            .where(eq(hostedAttemptImports.authorityDigest, authorityDigest)).limit(1).get()) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                        }
                        if (tx.select({ id: attempts.id }).from(attempts).where(or(eq(attempts.id, claim.attempt.id), and(eq(attempts.runId, claim.runId), eq(attempts.number, claim.attempt.number)))).limit(1).get()) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_ATTEMPT_CONFLICT");
                        }
                        if (tx.select({ id: attempts.id }).from(attempts)
                            .where(eq(attempts.fencingToken, claim.attempt.fencingToken)).limit(1).get()) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_FENCE_CONFLICT");
                        }
                        tx.insert(attempts).values({
                            id: claim.attempt.id, runId: claim.runId, number: claim.attempt.number,
                            runnerId: claim.runnerId, runnerLocality: "hosted", selectedExecutorId: claim.executorId,
                            fencingToken: claim.attempt.fencingToken, status: "assigned", startedAt: importedAt,
                            heartbeatAt: importedAt, leaseExpiresAt: claim.attempt.leaseExpiresAt,
                            createdAt: importedAt, updatedAt: importedAt
                        }).run();
                        tx.insert(hostedAttemptImports).values({
                            attemptId: claim.attempt.id, runId: claim.runId, attemptNumber: claim.attempt.number,
                            claimOperationId: claim.operationId, fencingTokenDigest: claim.attempt.fencingTokenDigest,
                            claimDigest, authorityDigest, authorityJson: JSON.stringify(claim.authority), importedAt
                        }).run();
                        const reassigned = tx.update(runs).set({
                            status: "assigned", assignedRunnerId: claim.runnerId, executor: claim.executorId,
                            leasedAt: importedAt, leaseExpiresAt: claim.attempt.leaseExpiresAt, heartbeatAt: importedAt,
                            currentAttemptId: claim.attempt.id, updatedAt: importedAt
                        }).where(and(eq(runs.id, claim.runId), eq(runs.currentAttemptId, previousAttempt.id))).run();
                        if (reassigned.changes !== 1) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                        }
                        if (!exactAuthorityShell) {
                            const acknowledged = tx.update(hostedClaimOperations).set({
                                state: "claimed", activeKey: null, runId: claim.runId,
                                updatedAt: importedAt, acknowledgedAt: importedAt
                            }).where(and(eq(hostedClaimOperations.operationId, claim.operationId), eq(hostedClaimOperations.state, "pending"))).run();
                            if (acknowledged.changes !== 1) {
                                throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
                            }
                        }
                        else {
                            tx.update(hostedClaimOperations).set({ activeKey: null, updatedAt: importedAt })
                                .where(eq(hostedClaimOperations.operationId, claim.operationId)).run();
                        }
                        return {
                            outcome: "created" as const,
                            importRow: existingImport,
                            attemptImportRow: tx.select().from(hostedAttemptImports)
                                .where(eq(hostedAttemptImports.attemptId, claim.attempt.id)).limit(1).get()!,
                            runRow: tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1).get()!,
                            executionStartedAt: null,
                            superseded: false
                        };
                    }
                    const exact = existingImport.admissionId === admission.admissionId
                        && existingImport.admissionOperationId === admission.operationId
                        && importedAttempt.claimOperationId === claim.operationId
                        && importedAttempt.attemptId === claim.attempt.id
                        && importedAttempt.fencingTokenDigest === claim.attempt.fencingTokenDigest
                        && existingImport.sourceIdentityDigest === admission.sourceIdentityDigest
                        && existingImport.deliveryPayloadDigest === admission.deliveryPayloadDigest
                        && existingImport.admissionEnvelopeDigest === admission.envelopeDigest
                        && existingImport.policyReceiptId === claim.admissionPolicySnapshot.receiptId
                        && existingImport.policyPayloadDigest === claim.admissionPolicySnapshot.payloadDigest
                        && existingImport.policyReceiptDigest === claim.admissionPolicySnapshot.receiptDigest
                        && existingImport.eventDigest === eventDigest
                        && existingImport.contextPacketDigest === contextPacketDigest
                        && existingImport.workThreadDigest === incomingWorkThreadDigest
                        && importedAttempt.claimDigest === claimDigest
                        && importedAttempt.authorityDigest === authorityDigest
                        && importedAttempt.authorityJson === JSON.stringify(claim.authority);
                    if (!exact)
                        throw new HostedImportConflictError("HOSTED_IMPORT_RUN_CONFLICT");
                    if (claimOperation.state !== "claimed" || claimOperation.runId !== claim.runId) {
                        throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_CONFLICT");
                    }
                    const runRow = tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1).get();
                    const attemptRow = tx.select().from(attempts).where(eq(attempts.id, claim.attempt.id)).limit(1).get();
                    if (runRow && attemptRow && runRow.currentAttemptId !== claim.attempt.id) {
                        const currentHostedAttempt = runRow.currentAttemptId
                            ? tx.select().from(hostedAttemptImports)
                                .where(eq(hostedAttemptImports.attemptId, runRow.currentAttemptId)).limit(1).get()
                            : undefined;
                        if (!currentHostedAttempt
                            || runRow.eventId !== event.id
                            || runRow.workThreadId !== existingImport.workThreadId
                            || attemptRow.runId !== claim.runId
                            || attemptRow.number !== claim.attempt.number
                            || attemptRow.runnerId !== claim.runnerId
                            || attemptRow.selectedExecutorId !== claim.executorId
                            || attemptRow.fencingToken !== claim.attempt.fencingToken
                            || attemptRow.leaseExpiresAt !== claim.attempt.leaseExpiresAt) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                        }
                        return {
                            outcome: "replayed" as const,
                            importRow: existingImport,
                            attemptImportRow: importedAttempt,
                            runRow,
                            executionStartedAt: claimOperation.executionStartedAt,
                            superseded: true
                        };
                    }
                    if (runRow && attemptRow
                        && (runRow.status !== "assigned" || attemptRow.status !== "assigned")) {
                        if (!claimOperation.executionStartedAt
                            || runRow.eventId !== event.id
                            || runRow.workThreadId !== existingImport.workThreadId
                            || attemptRow.runId !== claim.runId
                            || attemptRow.number !== claim.attempt.number
                            || attemptRow.runnerId !== claim.runnerId
                            || attemptRow.selectedExecutorId !== claim.executorId
                            || attemptRow.fencingToken !== claim.attempt.fencingToken
                            || attemptRow.leaseExpiresAt !== claim.attempt.leaseExpiresAt) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                        }
                        return {
                            outcome: "replayed" as const,
                            importRow: existingImport,
                            attemptImportRow: importedAttempt,
                            runRow,
                            executionStartedAt: claimOperation.executionStartedAt,
                            superseded: false
                        };
                    }
                    if (!runRow || !attemptRow
                        || runRow.status !== "assigned"
                        || runRow.eventId !== event.id
                        || runRow.assignedRunnerId !== claim.runnerId
                        || runRow.executor !== claim.executorId
                        || runRow.currentAttemptId !== claim.attempt.id
                        || runRow.leaseExpiresAt !== claim.attempt.leaseExpiresAt
                        || runRow.workThreadId !== existingImport.workThreadId
                        || attemptRow.runId !== claim.runId
                        || attemptRow.number !== claim.attempt.number
                        || attemptRow.runnerId !== claim.runnerId
                        || attemptRow.selectedExecutorId !== claim.executorId
                        || attemptRow.fencingToken !== claim.attempt.fencingToken
                        || attemptRow.leaseExpiresAt !== claim.attempt.leaseExpiresAt
                        || attemptRow.status !== "assigned") {
                        throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                    }
                    return {
                        outcome: "replayed" as const,
                        importRow: existingImport,
                        attemptImportRow: importedAttempt,
                        runRow,
                        executionStartedAt: claimOperation.executionStartedAt,
                        superseded: false
                    };
                }
                if (!claimAuthorityAvailable) {
                    throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
                }
                if (tx.select({ id: runs.id }).from(runs).where(or(eq(runs.id, claim.runId), eq(runs.eventId, event.id))).limit(1).get()) {
                    throw new HostedImportConflictError("HOSTED_IMPORT_RUN_CONFLICT");
                }
                if (tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports)
                    .where(eq(hostedRunImports.admissionId, admission.admissionId)).limit(1).get()) {
                    throw new HostedImportConflictError("HOSTED_IMPORT_ADMISSION_CONFLICT");
                }
                if (tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports).where(or(eq(hostedRunImports.claimOperationId, claim.operationId), eq(hostedRunImports.claimOperationId, admission.operationId), eq(hostedRunImports.admissionOperationId, claim.operationId), eq(hostedRunImports.admissionOperationId, admission.operationId))).limit(1).get()) {
                    throw new HostedImportConflictError("HOSTED_IMPORT_OPERATION_CONFLICT");
                }
                const collidingAttempt = tx.select().from(attempts).where(or(eq(attempts.id, claim.attempt.id), and(eq(attempts.runId, claim.runId), eq(attempts.number, claim.attempt.number)))).limit(1).get();
                if (collidingAttempt)
                    throw new HostedImportConflictError("HOSTED_IMPORT_ATTEMPT_CONFLICT");
                if (tx.select({ id: attempts.id }).from(attempts)
                    .where(eq(attempts.fencingToken, claim.attempt.fencingToken)).limit(1).get()
                    || tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports)
                        .where(eq(hostedRunImports.fencingTokenDigest, claim.attempt.fencingTokenDigest)).limit(1).get()
                    || tx.select({ attemptId: hostedAttemptImports.attemptId }).from(hostedAttemptImports)
                        .where(eq(hostedAttemptImports.fencingTokenDigest, claim.attempt.fencingTokenDigest)).limit(1).get()) {
                    throw new HostedImportConflictError("HOSTED_IMPORT_FENCE_CONFLICT");
                }
                const sourceCollision = tx.select().from(hostedRunImports).where(eq(hostedRunImports.sourceIdentityDigest, admission.sourceIdentityDigest)).limit(1).get();
                if (sourceCollision)
                    throw new HostedImportConflictError("HOSTED_IMPORT_SOURCE_DIGEST_CONFLICT");
                const deliveryCollision = tx.select().from(sourceDeliveries).where(and(eq(sourceDeliveries.source, event.source), eq(sourceDeliveries.deliveryId, admission.deliveryId))).limit(1).get();
                if (deliveryCollision)
                    throw new HostedImportConflictError("HOSTED_IMPORT_SOURCE_DIGEST_CONFLICT");
                if (tx.select({ runId: hostedRunImports.runId }).from(hostedRunImports)
                    .where(eq(hostedRunImports.authorityDigest, authorityDigest)).limit(1).get()
                    || tx.select({ attemptId: hostedAttemptImports.attemptId }).from(hostedAttemptImports)
                        .where(eq(hostedAttemptImports.authorityDigest, authorityDigest)).limit(1).get()) {
                    throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                }
                let durableThread: DurableWorkThread | undefined;
                if (protocolFields.thread) {
                    const canonicalKey = workThreadCanonicalKey(protocolFields.thread);
                    const existingThread = tx.select().from(workThreads).where(and(eq(workThreads.scopeId, "local"), eq(workThreads.canonicalKey, canonicalKey))).limit(1).get();
                    if (existingThread) {
                        let current: DurableWorkThread;
                        try {
                            current = workThreadFromRow(existingThread);
                        }
                        catch {
                            throw new HostedImportConflictError("HOSTED_IMPORT_WORK_THREAD_CONFLICT");
                        }
                        durableThread = mergeWorkThreadAnchors(current, protocolFields.thread);
                        if (workThreadCanonicalKey(durableThread) !== canonicalKey) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_WORK_THREAD_CONFLICT");
                        }
                        const mergedJson = JSON.stringify(durableThread);
                        if (mergedJson !== existingThread.threadJson) {
                            tx.update(workThreads).set({ threadJson: mergedJson, updatedAt: importedAt })
                                .where(eq(workThreads.id, existingThread.id)).run();
                        }
                    }
                    else {
                        const id = protocolFields.thread.id ?? `thread_${randomUUID()}`;
                        if (tx.select({ id: workThreads.id }).from(workThreads).where(eq(workThreads.id, id)).limit(1).get()) {
                            throw new HostedImportConflictError("HOSTED_IMPORT_WORK_THREAD_CONFLICT");
                        }
                        durableThread = WorkThreadSchema.parse({ ...protocolFields.thread, id }) as DurableWorkThread;
                        tx.insert(workThreads).values({
                            id,
                            scopeId: "local",
                            canonicalKey,
                            provider: durableThread.workItemReference.provider,
                            ownerContainerId: durableThread.workItemReference.ownerContainer?.id ?? "",
                            workItemKind: durableThread.workItemReference.kind,
                            externalId: durableThread.workItemReference.externalId,
                            threadJson: JSON.stringify(durableThread),
                            currentAssessmentId: null,
                            createdAt: importedAt,
                            updatedAt: importedAt
                        }).run();
                    }
                }
                tx.insert(runs).values({
                    id: claim.runId,
                    eventId: event.id,
                    status: "assigned",
                    eventJson: JSON.stringify(durableEvent),
                    contextPacketJson: null,
                    assignedRunnerId: claim.runnerId,
                    executor: claim.executorId,
                    repoProvider: projectTarget.provider,
                    repoOwner: projectTarget.owner,
                    repoName: projectTarget.repo,
                    workThreadId: durableThread?.id ?? null,
                    conversationKey: conversationKeyFromEvent(event),
                    leasedAt: importedAt,
                    leaseExpiresAt: claim.attempt.leaseExpiresAt,
                    heartbeatAt: importedAt,
                    currentAttemptId: claim.attempt.id,
                    routingPolicyJson: JSON.stringify({ runnerIds: [claim.runnerId], executorIds: [claim.executorId] }),
                    routingRunnerIdsJson: JSON.stringify([claim.runnerId]),
                    routingExecutorIdsJson: JSON.stringify([claim.executorId]),
                    routingRejectionsJson: "[]",
                    createdAt: importedAt,
                    updatedAt: importedAt
                }).run();
                tx.insert(attempts).values({
                    id: claim.attempt.id,
                    runId: claim.runId,
                    number: claim.attempt.number,
                    runnerId: claim.runnerId,
                    runnerLocality: "hosted",
                    selectedExecutorId: claim.executorId,
                    fencingToken: claim.attempt.fencingToken,
                    status: "assigned",
                    startedAt: importedAt,
                    heartbeatAt: importedAt,
                    leaseExpiresAt: claim.attempt.leaseExpiresAt,
                    createdAt: importedAt,
                    updatedAt: importedAt
                }).run();
                tx.insert(sourceDeliveries).values({
                    source: event.source,
                    deliveryId: admission.deliveryId,
                    runId: claim.runId,
                    eventId: event.id,
                    createdAt: importedAt
                }).run();
                tx.insert(hostedRunImports).values({
                    runId: claim.runId,
                    admissionId: admission.admissionId,
                    admissionOperationId: admission.operationId,
                    claimOperationId: claim.operationId,
                    attemptId: claim.attempt.id,
                    fencingTokenDigest: claim.attempt.fencingTokenDigest,
                    sourceIdentityDigest: admission.sourceIdentityDigest,
                    deliveryPayloadDigest: admission.deliveryPayloadDigest,
                    admissionEnvelopeDigest: admission.envelopeDigest,
                    policyReceiptId: claim.admissionPolicySnapshot.receiptId,
                    policyPayloadDigest: claim.admissionPolicySnapshot.payloadDigest,
                    policyReceiptDigest: claim.admissionPolicySnapshot.receiptDigest,
                    eventDigest,
                    contextPacketDigest,
                    workThreadId: durableThread?.id ?? null,
                    workThreadDigest: incomingWorkThreadDigest,
                    claimDigest,
                    authorityDigest,
                    authorityJson: JSON.stringify(claim.authority),
                    importedAt
                }).run();
                tx.insert(hostedAttemptImports).values({
                    attemptId: claim.attempt.id,
                    runId: claim.runId,
                    attemptNumber: claim.attempt.number,
                    claimOperationId: claim.operationId,
                    fencingTokenDigest: claim.attempt.fencingTokenDigest,
                    claimDigest,
                    authorityDigest,
                    authorityJson: JSON.stringify(claim.authority),
                    importedAt
                }).run();
                if (!exactAuthorityShell) {
                    const acknowledged = tx.update(hostedClaimOperations).set({
                        state: "claimed",
                        activeKey: null,
                        runId: claim.runId,
                        updatedAt: importedAt,
                        acknowledgedAt: importedAt
                    }).where(and(eq(hostedClaimOperations.operationId, claim.operationId), eq(hostedClaimOperations.state, "pending"))).run();
                    if (acknowledged.changes !== 1) {
                        throw new HostedImportConflictError("HOSTED_CLAIM_OPERATION_NOT_PENDING");
                    }
                }
                else {
                    tx.update(hostedClaimOperations).set({ activeKey: null, updatedAt: importedAt })
                        .where(eq(hostedClaimOperations.operationId, claim.operationId)).run();
                }
                tx.insert(runEvents).values([
                    runEventValues({
                        runId: claim.runId,
                        type: "run.hosted_imported",
                        payload: {
                            admissionId: admission.admissionId,
                            admissionEnvelopeDigest: admission.envelopeDigest,
                            claimOperationId: claim.operationId,
                            authorityDigest,
                            attemptId: claim.attempt.id,
                            attemptNumber: claim.attempt.number
                        },
                        visibility: "audit",
                        importance: "high",
                        createdAt: importedAt
                    }),
                    runEventValues({
                        runId: claim.runId,
                        type: "context_packet.generated",
                        payload: { contextPacketDigest, ...(durableThread ? { thread: durableThread } : {}) },
                        visibility: "audit",
                        importance: "normal",
                        message: "Hosted execution context accepted in memory.",
                        createdAt: importedAt
                    })
                ]).run();
                const runRow = tx.select().from(runs).where(eq(runs.id, claim.runId)).limit(1).get();
                if (!runRow)
                    throw new HostedImportConflictError("HOSTED_IMPORT_AUTHORITY_CONFLICT");
                return {
                    outcome: "created" as const,
                    importRow: tx.select().from(hostedRunImports).where(eq(hostedRunImports.runId, claim.runId)).limit(1).get()!,
                    attemptImportRow: tx.select().from(hostedAttemptImports)
                        .where(eq(hostedAttemptImports.attemptId, claim.attempt.id)).limit(1).get()!,
                    runRow,
                    executionStartedAt: null,
                    superseded: false
                };
            });
            for (const [attemptId, payload] of hostedExecutionPayloads) {
                if (payload.runId === claim.runId && attemptId !== claim.attempt.id) {
                    hostedExecutionPayloads.delete(attemptId);
                }
            }
            if (!result.superseded && !result.executionStartedAt
                && !terminalRunStatus(result.runRow.status)) {
                hostedExecutionPayloads.set(claim.attempt.id, {
                    runId: claim.runId,
                    fencingToken: claim.attempt.fencingToken,
                    event,
                    contextPacket: protocolFields.contextPacket,
                });
            }
            else {
                hostedExecutionPayloads.delete(claim.attempt.id);
            }
            const hostedAuthority: HostedImportAuthority = {
                ...(JSON.parse(result.attemptImportRow.authorityJson) as HostedClaimV1["authority"]),
                admissionId: result.importRow.admissionId,
                admissionOperationId: result.importRow.admissionOperationId,
                claimOperationId: result.attemptImportRow.claimOperationId,
                admissionEnvelopeDigest: result.importRow.admissionEnvelopeDigest,
                sourceIdentityDigest: result.importRow.sourceIdentityDigest,
                deliveryPayloadDigest: result.importRow.deliveryPayloadDigest,
                policyReceiptId: result.importRow.policyReceiptId,
                policyPayloadDigest: result.importRow.policyPayloadDigest,
                policyReceiptDigest: result.importRow.policyReceiptDigest,
                eventDigest: result.importRow.eventDigest,
                contextPacketDigest: result.importRow.contextPacketDigest,
                ...(result.importRow.workThreadId ? { workThreadId: result.importRow.workThreadId } : {}),
                ...(result.importRow.workThreadDigest ? { workThreadDigest: result.importRow.workThreadDigest } : {}),
                claimDigest: result.attemptImportRow.claimDigest,
                authorityDigest: result.attemptImportRow.authorityDigest,
                importedAt: result.attemptImportRow.importedAt
            };
            return {
                outcome: result.outcome,
                executionState: terminalRunStatus(result.runRow.status)
                    ? "terminal"
                    : result.superseded
                        ? "superseded"
                        : result.executionStartedAt
                            ? "already_started"
                            : "ready_to_start",
                executionMayStart: false,
                claimed: result.superseded || result.executionStartedAt || terminalRunStatus(result.runRow.status) ? null : {
                    run: { ...runFromRow(result.runRow), contextPacket: protocolFields.contextPacket },
                    event,
                    attemptId: claim.attempt.id,
                    attemptNumber: claim.attempt.number,
                    fencingToken: claim.attempt.fencingToken,
                    executorId: claim.executorId
                },
                hostedAuthority
            };
        },

        async completeHostedRunLocally(input: {
            runId: string;
            result: OpenTagRunResult;
            runnerId: string;
            attemptId: string;
            fencingToken: string;
            destinationId: string;
            organizationId: string;
            credentialId: string;
            request: HostedCompleteRequestV1;
        }): Promise<CompleteRunOutcome> {
            const safeResult = validatePersistedProposalEvidence(
                OpenTagRunResultSchema.parse(
                    await sanitizeRunnerControlledInputForRun(input.runId, input.result),
                ),
            );
            const request = HostedCompleteRequestV1Schema.parse(input.request);
            if (
                request.resultDigest !== await computeControlPayloadDigestV1(safeResult)
                || request.conclusion !== safeResult.conclusion
                || request.attempt.attemptId !== input.attemptId
                || request.attempt.fencingTokenDigest
                    !== await computeHostedClaimFencingTokenDigestV1(input.fencingToken)
            ) {
                throw new HostedLifecycleOperationConflictError(
                    "HOSTED_LIFECYCLE_OPERATION_INVALID",
                );
            }
            const prepared = await prepareHostedLifecycleOperation({
                destinationId: input.destinationId,
                organizationId: input.organizationId,
                runnerId: input.runnerId,
                credentialId: input.credentialId,
                runId: input.runId,
                action: "complete",
                request,
            });
            const status = safeResult.conclusion === "success"
                ? "succeeded"
                : safeResult.conclusion === "cancelled"
                    ? "cancelled"
                    : safeResult.conclusion === "interrupted"
                        ? "interrupted"
                        : safeResult.conclusion === "timed_out"
                            ? "timed_out"
                            : safeResult.conclusion === "needs_human"
                                ? "needs_approval"
                                : "failed";
            const attemptStatus = safeResult.conclusion === "success"
                ? "succeeded"
                : safeResult.conclusion === "cancelled"
                    ? "cancelled"
                    : safeResult.conclusion === "interrupted"
                        ? "interrupted"
                        : safeResult.conclusion === "timed_out"
                            ? "timed_out"
                            : safeResult.conclusion === "needs_human"
                                ? "needs_human"
                                : "failed";
            const durableResult = OpenTagRunResultSchema.parse({
                conclusion: safeResult.conclusion,
                summary: "Hosted executor result accepted; execution details were not retained locally.",
                nextAction: safeResult.conclusion === "success"
                    ? "Use authoritative hosted receipts and proposal evidence for follow-up."
                    : "Reconcile the hosted Attempt before issuing fresh authority.",
                ...(safeResult.artifacts?.some(
                    (artifact) => artifact.id === `${input.runId}:proposal-evidence`,
                ) ? {
                    artifacts: safeResult.artifacts.filter(
                        (artifact) => artifact.id === `${input.runId}:proposal-evidence`,
                    ),
                } : {}),
            });
            const completedAt = nowIso();
            const outcome = db.transaction((tx) => {
                const run = tx.select().from(runs)
                    .where(eq(runs.id, input.runId)).limit(1).get();
                const attempt = tx.select().from(attempts)
                    .where(eq(attempts.id, input.attemptId)).limit(1).get();
                const importedAttempt = tx.select().from(hostedAttemptImports)
                    .where(eq(hostedAttemptImports.attemptId, input.attemptId))
                    .limit(1).get();
                const claim = importedAttempt
                    ? tx.select().from(hostedClaimOperations).where(and(
                        eq(hostedClaimOperations.operationId, importedAttempt.claimOperationId),
                        eq(hostedClaimOperations.destinationId, input.destinationId),
                        eq(hostedClaimOperations.organizationId, input.organizationId),
                        eq(hostedClaimOperations.runnerId, input.runnerId),
                        eq(hostedClaimOperations.runId, input.runId),
                        eq(hostedClaimOperations.state, "claimed"),
                        isNull(hostedClaimOperations.terminalReasonCode),
                    )).limit(1).get()
                    : undefined;
                const authority = importedAttempt
                    ? JSON.parse(importedAttempt.authorityJson) as HostedClaimV1["authority"]
                    : undefined;
                if (
                    attempt
                    && request.attempt.attemptNumber !== attempt.number
                ) {
                    throw new HostedLifecycleOperationConflictError(
                        "HOSTED_LIFECYCLE_OPERATION_INVALID",
                    );
                }
                if (
                    !run || !attempt || !importedAttempt || !claim
                    || authority?.credentialId !== input.credentialId
                    || importedAttempt.runId !== input.runId
                    || importedAttempt.attemptNumber !== request.attempt.attemptNumber
                    || attempt.runId !== input.runId
                    || attempt.runnerId !== input.runnerId
                    || attempt.number !== request.attempt.attemptNumber
                    || attempt.fencingToken !== input.fencingToken
                ) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(
                        tx,
                        input.attemptId,
                        input.fencingToken,
                    );
                    return "stale_attempt" as const;
                }

                const journal = enqueueHostedLifecycleOperationTx(tx, prepared);
                if (terminalRunStatus(run.status)) {
                    const exactTerminal = run.status === status
                        && attempt.status === attemptStatus
                        && journal.outcome === "replayed";
                    return exactTerminal ? "duplicate" as const : "stale_attempt" as const;
                }
                if (
                    run.status !== "running"
                    || run.currentAttemptId !== input.attemptId
                    || run.assignedRunnerId !== input.runnerId
                    || attempt.status !== "running"
                    || !hasActiveAttemptLease(attempt)
                ) {
                    evictHostedExecutionPayloadIfDurablyUnrecoverable(
                        tx,
                        input.attemptId,
                        input.fencingToken,
                    );
                    return "stale_attempt" as const;
                }

                tx.update(runs).set({
                    status,
                    resultJson: JSON.stringify(durableResult),
                    assignedRunnerId: null,
                    leasedAt: null,
                    leaseExpiresAt: null,
                    heartbeatAt: null,
                    currentAttemptId: null,
                    updatedAt: completedAt,
                }).where(and(
                    eq(runs.id, input.runId),
                    eq(runs.currentAttemptId, input.attemptId),
                )).run();
                tx.update(attempts).set({
                    status: attemptStatus,
                    finishedAt: completedAt,
                    resultJson: JSON.stringify(durableResult),
                    updatedAt: completedAt,
                }).where(eq(attempts.id, input.attemptId)).run();
                tx.insert(runEvents).values(runEventValues({
                    runId: input.runId,
                    type: "run.completed",
                    payload: {
                        attemptId: input.attemptId,
                        conclusion: request.conclusion,
                        reasonCode: request.reasonCode,
                        resultDigest: request.resultDigest,
                        artifactDigests: request.artifactDigests,
                        evidenceDigests: request.evidenceDigests,
                    },
                    visibility: "audit",
                    importance: "high",
                    message: durableResult.summary,
                    createdAt: completedAt,
                })).run();
                return "completed" as const;
            }, { behavior: "immediate" });
            if (outcome === "completed" || outcome === "duplicate") {
                hostedExecutionPayloads.delete(input.attemptId);
            }
            return outcome;
        }
    };
}

export type PairedRunnerRepository = ReturnType<typeof createPairedRunnerRepository>;
