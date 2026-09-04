import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    status: text("status").notNull(),
    eventJson: text("event_json").notNull(),
    contextPacketJson: text("context_packet_json"),
    accessProfileSnapshotJson: text("access_profile_snapshot_json"),
    policySnapshotProvenanceJson: text("policy_snapshot_provenance_json"),
    resultJson: text("result_json"),
    assignedRunnerId: text("assigned_runner_id"),
    executor: text("executor"),
    parentRunId: text("parent_run_id"),
    triggeredByActionJson: text("triggered_by_action_json"),
    sourceProposalId: text("source_proposal_id"),
    sourceApplyPlanId: text("source_apply_plan_id"),
    repoProvider: text("repo_provider"),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    workThreadId: text("work_thread_id"),
    conversationKey: text("conversation_key"),
    leasedAt: text("leased_at"),
    leaseExpiresAt: text("lease_expires_at"),
    heartbeatAt: text("heartbeat_at"),
    currentAttemptId: text("current_attempt_id"),
    currentRoutingDecisionId: text("current_routing_decision_id"),
    routingPolicyJson: text("routing_policy_json"),
    routingRunnerIdsJson: text("routing_runner_ids_json"),
    routingExecutorIdsJson: text("routing_executor_ids_json"),
    routingRejectionsJson: text("routing_rejections_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
}, (table) => ({
    statusIdx: index("runs_status_idx").on(table.status),
    claimQueueIdx: index("runs_claim_queue_idx").on(table.status, table.createdAt, table.id),
    leaseRecoveryIdx: index("runs_lease_recovery_idx").on(table.status, table.leaseExpiresAt, table.createdAt, table.id),
    runnerIdx: index("runs_runner_idx").on(table.assignedRunnerId),
    repoIdx: index("runs_repo_idx").on(table.repoProvider, table.repoOwner, table.repoName),
    workThreadIdx: index("runs_work_thread_idx").on(table.workThreadId),
    workThreadAuthorityIdx: index("runs_work_thread_authority_idx").on(table.workThreadId, table.createdAt, table.id),
    conversationIdx: index("runs_conversation_idx").on(table.conversationKey)
}));

export const attempts = sqliteTable("attempts", {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    number: integer("number").notNull(),
    runnerId: text("runner_id").notNull(),
    runnerLocality: text("runner_locality"),
    selectedExecutorId: text("selected_executor_id"),
    routingDecisionId: text("routing_decision_id"),
    fencingToken: text("fencing_token").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
    leaseExpiresAt: text("lease_expires_at").notNull(),
    finishedAt: text("finished_at"),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
}, (table) => ({
    runNumberIdx: uniqueIndex("attempts_run_number_idx").on(table.runId, table.number),
    runIdx: index("attempts_run_idx").on(table.runId),
    runnerIdx: index("attempts_runner_idx").on(table.runnerId)
}));

export const hostedRunImports = sqliteTable("hosted_run_imports", {
    runId: text("run_id").primaryKey(),
    admissionId: text("admission_id").notNull(),
    admissionOperationId: text("admission_operation_id").notNull(),
    claimOperationId: text("claim_operation_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    fencingTokenDigest: text("fencing_token_digest").notNull(),
    sourceIdentityDigest: text("source_identity_digest").notNull(),
    deliveryPayloadDigest: text("delivery_payload_digest").notNull(),
    admissionEnvelopeDigest: text("admission_envelope_digest").notNull(),
    policyReceiptId: text("policy_receipt_id").notNull(),
    policyPayloadDigest: text("policy_payload_digest").notNull(),
    policyReceiptDigest: text("policy_receipt_digest").notNull(),
    eventDigest: text("event_digest").notNull(),
    contextPacketDigest: text("context_packet_digest").notNull(),
    workThreadId: text("work_thread_id"),
    workThreadDigest: text("work_thread_digest"),
    claimDigest: text("claim_digest").notNull(),
    authorityDigest: text("authority_digest").notNull(),
    authorityJson: text("authority_json").notNull(),
    importedAt: text("imported_at").notNull()
}, (table) => ({
    admissionIdx: uniqueIndex("hosted_run_imports_admission_idx").on(table.admissionId),
    claimOperationIdx: uniqueIndex("hosted_run_imports_claim_operation_idx").on(table.claimOperationId),
    attemptIdx: uniqueIndex("hosted_run_imports_attempt_idx").on(table.attemptId),
    fenceIdx: uniqueIndex("hosted_run_imports_fence_idx").on(table.fencingTokenDigest),
    sourceIdx: uniqueIndex("hosted_run_imports_source_idx").on(table.sourceIdentityDigest),
    authorityIdx: uniqueIndex("hosted_run_imports_authority_idx").on(table.authorityDigest),
    workThreadIdx: index("hosted_run_imports_work_thread_idx").on(table.workThreadId)
}));

export const hostedClaimOperations = sqliteTable("hosted_claim_operations", {
    operationId: text("operation_id").primaryKey(),
    requestId: text("request_id").notNull(),
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    destinationId: text("destination_id").notNull(),
    activeKey: text("active_key"),
    requestDigest: text("request_digest").notNull(),
    requestJson: text("request_json").notNull(),
    state: text("state").notNull(),
    runId: text("run_id"),
    claimDigest: text("claim_digest"),
    authorityDigest: text("authority_digest"),
    authorityJson: text("authority_json"),
    attemptId: text("attempt_id"),
    attemptNumber: integer("attempt_number"),
    fencingTokenDigest: text("fencing_token_digest"),
    credentialId: text("credential_id"),
    leaseExpiresAt: text("lease_expires_at"),
    executorId: text("executor_id"),
    executionStartedAt: text("execution_started_at"),
    terminalReasonCode: text("terminal_reason_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    acknowledgedAt: text("acknowledged_at")
}, (table) => ({
    requestIdx: uniqueIndex("hosted_claim_operations_request_idx").on(table.requestId),
    activeIdx: uniqueIndex("hosted_claim_operations_active_idx").on(table.activeKey),
    runnerStateIdx: index("hosted_claim_operations_runner_state_idx").on(table.destinationId, table.organizationId, table.runnerId, table.state)
}));

export const hostedAttemptImports = sqliteTable("hosted_attempt_imports", {
    attemptId: text("attempt_id").primaryKey(),
    runId: text("run_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    claimOperationId: text("claim_operation_id").notNull(),
    fencingTokenDigest: text("fencing_token_digest").notNull(),
    claimDigest: text("claim_digest").notNull(),
    authorityDigest: text("authority_digest").notNull(),
    authorityJson: text("authority_json").notNull(),
    importedAt: text("imported_at").notNull()
}, (table) => ({
    runNumberIdx: uniqueIndex("hosted_attempt_imports_run_number_idx").on(table.runId, table.attemptNumber),
    operationIdx: uniqueIndex("hosted_attempt_imports_operation_idx").on(table.claimOperationId),
    fenceIdx: uniqueIndex("hosted_attempt_imports_fence_idx").on(table.fencingTokenDigest),
    authorityIdx: uniqueIndex("hosted_attempt_imports_authority_idx").on(table.authorityDigest),
    runIdx: index("hosted_attempt_imports_run_idx").on(table.runId)
}));

export const hostedLifecycleOperations = sqliteTable("hosted_lifecycle_operations", {
    destinationId: text("destination_id").notNull(),
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    credentialId: text("credential_id").notNull(),
    operationId: text("operation_id").notNull(),
    requestId: text("request_id").notNull(),
    action: text("action").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    fencingTokenDigest: text("fencing_token_digest").notNull(),
    requestDigest: text("request_digest").notNull(),
    businessKeyDigest: text("business_key_digest").notNull(),
    sequence: integer("sequence").notNull(),
    requestJson: text("request_json").notNull(),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    receiptId: text("receipt_id"),
    receiptDigest: text("receipt_digest"),
    receiptJson: text("receipt_json"),
    lastReasonCode: text("last_reason_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    acknowledgedAt: text("acknowledged_at")
}, (table) => ({
    pk: primaryKey({ columns: [
            table.destinationId,
            table.organizationId,
            table.runnerId,
            table.credentialId,
            table.operationId
        ] }),
    requestIdx: uniqueIndex("hosted_lifecycle_operations_request_idx").on(table.destinationId, table.organizationId, table.runnerId, table.credentialId, table.requestId),
    businessIdx: uniqueIndex("hosted_lifecycle_operations_business_idx").on(table.destinationId, table.organizationId, table.runnerId, table.credentialId, table.businessKeyDigest),
    sequenceIdx: uniqueIndex("hosted_lifecycle_operations_sequence_idx").on(table.destinationId, table.organizationId, table.runId, table.attemptId, table.sequence),
    dueIdx: index("hosted_lifecycle_operations_due_idx").on(table.destinationId, table.organizationId, table.state, table.nextAttemptAt, table.createdAt),
    attemptIdx: index("hosted_lifecycle_operations_attempt_idx").on(table.runId, table.attemptId, table.state)
}));

export const runEvents = sqliteTable("run_events", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    type: text("type").notNull(),
    visibility: text("visibility").notNull().default("audit"),
    importance: text("importance").notNull().default("normal"),
    message: text("message"),
    payloadJson: text("payload_json").notNull(),
    progressIdempotencyDigest: text("progress_idempotency_digest"),
    createdAt: text("created_at").notNull()
}, (table) => ({
    runIdx: index("run_events_run_idx").on(table.runId),
    routingLatestIdx: index("run_events_routing_latest_idx").on(table.runId, table.type, table.id),
    progressIdempotencyIdx: uniqueIndex("run_events_progress_idempotency_idx").on(table.runId, table.progressIdempotencyDigest)
}));

export const sourceDeliveries = sqliteTable("source_deliveries", {
    source: text("source").notNull(),
    deliveryId: text("delivery_id").notNull(),
    runId: text("run_id").notNull(),
    eventId: text("event_id").notNull(),
    createdAt: text("created_at").notNull()
}, (table) => ({
    pk: primaryKey({ columns: [table.source, table.deliveryId] }),
    runIdx: index("source_deliveries_run_idx").on(table.runId)
}));

export const workThreads = sqliteTable("work_threads", {
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    provider: text("provider").notNull(),
    ownerContainerId: text("owner_container_id").notNull(),
    workItemKind: text("work_item_kind").notNull(),
    externalId: text("external_id").notNull(),
    threadJson: text("thread_json").notNull(),
    currentAssessmentId: text("current_assessment_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
}, (table) => ({
    canonicalKeyIdx: uniqueIndex("work_threads_scope_canonical_key_idx").on(table.scopeId, table.canonicalKey),
    currentAssessmentIdx: index("work_threads_current_assessment_idx").on(table.currentAssessmentId)
}));

export const controlPlaneProjectionOutbox = sqliteTable("control_plane_projection_outbox", {
    receiptId: text("receipt_id").notNull(),
    destinationId: text("destination_id").notNull(),
    organizationId: text("organization_id").notNull(),
    runnerId: text("runner_id").notNull(),
    receiptKind: text("receipt_kind").notNull(),
    identityNamespace: text("identity_namespace").notNull(),
    identityPartsJson: text("identity_parts_json").notNull(),
    identityKey: text("identity_key").notNull(),
    operationId: text("operation_id").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    receiptDigest: text("receipt_digest").notNull(),
    envelopeJson: text("envelope_json").notNull(),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at"),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    lastReasonCode: text("last_reason_code"),
    lastHttpStatus: integer("last_http_status"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    acknowledgedAt: text("acknowledged_at")
}, (table) => ({
    pk: primaryKey({
        name: "control_plane_projection_outbox_pk",
        columns: [table.destinationId, table.organizationId, table.receiptId]
    }),
    destinationIdentityIdx: uniqueIndex("control_plane_projection_outbox_destination_identity_idx").on(table.destinationId, table.organizationId, table.identityKey),
    destinationOperationIdx: uniqueIndex("control_plane_projection_outbox_destination_operation_idx").on(table.destinationId, table.organizationId, table.operationId),
    dueIdx: index("control_plane_projection_outbox_due_idx").on(table.destinationId, table.state, table.nextAttemptAt, table.leaseExpiresAt, table.createdAt, table.receiptId),
    tenantIdx: index("control_plane_projection_outbox_tenant_idx").on(table.destinationId, table.organizationId, table.state, table.createdAt),
    attemptCountCheck: check("control_plane_projection_outbox_attempt_count_check", sql `typeof(${table.attemptCount}) = 'integer' AND ${table.attemptCount} >= 0`),
    httpStatusCheck: check("control_plane_projection_outbox_http_status_check", sql `${table.lastHttpStatus} IS NULL OR (typeof(${table.lastHttpStatus}) = 'integer' AND ${table.lastHttpStatus} >= 100 AND ${table.lastHttpStatus} <= 599)`),
    receiptKindCheck: check("control_plane_projection_outbox_receipt_kind_check", sql `${table.receiptKind} = 'runner_readiness'`),
    jsonShapeCheck: check("control_plane_projection_outbox_json_shape_check", sql `json_valid(${table.identityPartsJson}) AND json_type(${table.identityPartsJson}) = 'array' AND json_valid(${table.envelopeJson}) AND json_type(${table.envelopeJson}) = 'object'`),
    digestShapeCheck: check("control_plane_projection_outbox_digest_shape_check", sql `length(${table.payloadDigest}) = 71 AND substr(${table.payloadDigest}, 1, 7) = 'sha256:' AND substr(${table.payloadDigest}, 8) NOT GLOB '*[^0-9a-f]*' AND length(${table.receiptDigest}) = 71 AND substr(${table.receiptDigest}, 1, 7) = 'sha256:' AND substr(${table.receiptDigest}, 8) NOT GLOB '*[^0-9a-f]*'`),
    stateShapeCheck: check("control_plane_projection_outbox_state_shape_check", sql `(
        (${table.state} = 'pending' AND ${table.nextAttemptAt} IS NOT NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.acknowledgedAt} IS NULL)
        OR (${table.state} = 'leased' AND ${table.nextAttemptAt} IS NOT NULL AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.acknowledgedAt} IS NULL)
        OR (${table.state} = 'acknowledged' AND ${table.nextAttemptAt} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.acknowledgedAt} IS NOT NULL)
        OR (${table.state} = 'attention' AND ${table.nextAttemptAt} IS NULL AND ${table.leaseOwner} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.acknowledgedAt} IS NULL AND ${table.lastReasonCode} IS NOT NULL)
      )`)
}));

const PAIRED_RUNNER_SCHEMA_VERSION = 1;
const PAIRED_RUNNER_SCHEMA_MIGRATIONS = [
  "2026-08-08-control-plane-projection-outbox-v1",
  "2026-08-10-hosted-attempt-import-v1",
  "2026-08-10-hosted-claim-authority-shell-v1",
  "2026-08-10-hosted-execution-start-v1",
  "2026-08-10-hosted-lifecycle-operation-v1",
  "2026-08-10-hosted-run-import-v1",
] as const;

const PAIRED_RUNNER_SCHEMA_SQL = `
CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        runner_id TEXT NOT NULL,
        runner_locality TEXT,
        selected_executor_id TEXT,
        routing_decision_id TEXT,
        fencing_token TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        finished_at TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE control_plane_projection_outbox (
        receipt_id TEXT NOT NULL,
        destination_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        receipt_kind TEXT NOT NULL,
        identity_namespace TEXT NOT NULL,
        identity_parts_json TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        receipt_digest TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        last_reason_code TEXT,
        last_http_status INTEGER CHECK (last_http_status IS NULL OR (typeof(last_http_status) = 'integer' AND last_http_status >= 100 AND last_http_status <= 599)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT,
        CONSTRAINT control_plane_projection_outbox_pk PRIMARY KEY (destination_id, organization_id, receipt_id),
        CONSTRAINT control_plane_projection_outbox_receipt_kind_check CHECK (
          receipt_kind IN (
            'runner_readiness'
          )
        ),
        CONSTRAINT control_plane_projection_outbox_json_shape_check CHECK (
          json_valid(identity_parts_json) AND json_type(identity_parts_json) = 'array'
          AND json_valid(envelope_json) AND json_type(envelope_json) = 'object'
        ),
        CONSTRAINT control_plane_projection_outbox_digest_shape_check CHECK (
          length(payload_digest) = 71 AND substr(payload_digest, 1, 7) = 'sha256:'
          AND substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'
          AND length(receipt_digest) = 71 AND substr(receipt_digest, 1, 7) = 'sha256:'
          AND substr(receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'
        ),
        CONSTRAINT control_plane_projection_outbox_state_shape_check CHECK (
          (state = 'pending' AND next_attempt_at IS NOT NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND acknowledged_at IS NULL)
          OR (state = 'leased' AND next_attempt_at IS NOT NULL AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND acknowledged_at IS NULL)
          OR (state = 'acknowledged' AND next_attempt_at IS NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND acknowledged_at IS NOT NULL)
          OR (state = 'attention' AND next_attempt_at IS NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND acknowledged_at IS NULL AND last_reason_code IS NOT NULL)
        )
      );

CREATE TABLE hosted_attempt_imports (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        claim_operation_id TEXT NOT NULL,
        fencing_token_digest TEXT NOT NULL,
        claim_digest TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        authority_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );

CREATE TABLE hosted_claim_operations (
        operation_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        destination_id TEXT NOT NULL,
        active_key TEXT,
        request_digest TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'empty')),
        run_id TEXT,
        terminal_reason_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT
      , execution_started_at TEXT, claim_digest TEXT, authority_digest TEXT, authority_json TEXT, attempt_id TEXT, attempt_number INTEGER, fencing_token_digest TEXT, credential_id TEXT, lease_expires_at TEXT, executor_id TEXT);

CREATE TABLE hosted_lifecycle_operations (
        destination_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('heartbeat', 'running', 'reject-start', 'progress', 'complete')),
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        fencing_token_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        business_key_digest TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        request_json TEXT NOT NULL CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
        state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'acknowledged', 'attention')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        receipt_id TEXT,
        receipt_digest TEXT,
        receipt_json TEXT CHECK (receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
        last_reason_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        acknowledged_at TEXT,
        PRIMARY KEY (destination_id, organization_id, runner_id, credential_id, operation_id),
        CHECK (
          (state = 'pending' AND next_attempt_at IS NOT NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND receipt_id IS NULL AND receipt_digest IS NULL AND receipt_json IS NULL AND acknowledged_at IS NULL)
          OR (state = 'leased' AND next_attempt_at IS NOT NULL AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND receipt_id IS NULL AND receipt_digest IS NULL AND receipt_json IS NULL AND acknowledged_at IS NULL)
          OR (state = 'acknowledged' AND next_attempt_at IS NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND receipt_id IS NOT NULL AND receipt_digest IS NOT NULL AND receipt_json IS NOT NULL AND acknowledged_at IS NOT NULL)
          OR (state = 'attention' AND next_attempt_at IS NULL AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND receipt_id IS NULL AND receipt_digest IS NULL AND receipt_json IS NULL AND last_reason_code IS NOT NULL AND acknowledged_at IS NULL)
        )
      );

CREATE TABLE hosted_run_imports (
        run_id TEXT PRIMARY KEY,
        admission_id TEXT NOT NULL,
        admission_operation_id TEXT NOT NULL,
        claim_operation_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        fencing_token_digest TEXT NOT NULL,
        source_identity_digest TEXT NOT NULL,
        delivery_payload_digest TEXT NOT NULL,
        admission_envelope_digest TEXT NOT NULL,
        policy_receipt_id TEXT NOT NULL,
        policy_payload_digest TEXT NOT NULL,
        policy_receipt_digest TEXT NOT NULL,
        event_digest TEXT NOT NULL,
        context_packet_digest TEXT NOT NULL,
        work_thread_id TEXT,
        work_thread_digest TEXT,
        claim_digest TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        authority_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );

CREATE TABLE opentag_paired_runner_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('initializing', 'ready')),
        fingerprint TEXT,
        initialized_at TEXT NOT NULL,
        CHECK ((state = 'initializing' AND fingerprint IS NULL)
          OR (state = 'ready' AND fingerprint IS NOT NULL))
      );

CREATE TABLE opentag_schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

CREATE TABLE run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'audit',
        importance TEXT NOT NULL DEFAULT 'normal',
        message TEXT,
        payload_json TEXT NOT NULL,
        progress_idempotency_digest TEXT,
        created_at TEXT NOT NULL
      );

CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        event_json TEXT NOT NULL,
        context_packet_json TEXT,
        access_profile_snapshot_json TEXT,
        policy_snapshot_provenance_json TEXT,
        result_json TEXT,
        assigned_runner_id TEXT,
        executor TEXT,
        parent_run_id TEXT,
        triggered_by_action_json TEXT,
        source_proposal_id TEXT,
        source_apply_plan_id TEXT,
        repo_provider TEXT,
        repo_owner TEXT,
        repo_name TEXT,
        work_thread_id TEXT,
        conversation_key TEXT,
        leased_at TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        current_attempt_id TEXT,
        current_routing_decision_id TEXT,
        routing_policy_json TEXT,
        routing_runner_ids_json TEXT,
        routing_executor_ids_json TEXT,
        routing_rejections_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE source_deliveries (
        source TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source, delivery_id)
      );

CREATE TABLE work_threads (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        owner_container_id TEXT NOT NULL,
        work_item_kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        thread_json TEXT NOT NULL,
        current_assessment_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE INDEX attempts_run_idx ON attempts(run_id);

CREATE UNIQUE INDEX attempts_run_number_idx ON attempts(run_id, number);

CREATE INDEX attempts_runner_idx ON attempts(runner_id);

CREATE UNIQUE INDEX control_plane_projection_outbox_destination_identity_idx
        ON control_plane_projection_outbox(destination_id, organization_id, identity_key);

CREATE UNIQUE INDEX control_plane_projection_outbox_destination_operation_idx
        ON control_plane_projection_outbox(destination_id, organization_id, operation_id);

CREATE INDEX control_plane_projection_outbox_due_idx
        ON control_plane_projection_outbox(destination_id, state, next_attempt_at, lease_expires_at, created_at, receipt_id);

CREATE INDEX control_plane_projection_outbox_tenant_idx
        ON control_plane_projection_outbox(destination_id, organization_id, state, created_at);

CREATE UNIQUE INDEX hosted_attempt_imports_authority_idx
        ON hosted_attempt_imports(authority_digest);

CREATE UNIQUE INDEX hosted_attempt_imports_fence_idx
        ON hosted_attempt_imports(fencing_token_digest);

CREATE UNIQUE INDEX hosted_attempt_imports_operation_idx
        ON hosted_attempt_imports(claim_operation_id);

CREATE INDEX hosted_attempt_imports_run_idx
        ON hosted_attempt_imports(run_id);

CREATE UNIQUE INDEX hosted_attempt_imports_run_number_idx
        ON hosted_attempt_imports(run_id, attempt_number);

CREATE UNIQUE INDEX hosted_claim_operations_active_idx
        ON hosted_claim_operations(active_key);

CREATE UNIQUE INDEX hosted_claim_operations_request_idx
        ON hosted_claim_operations(request_id);

CREATE INDEX hosted_claim_operations_runner_state_idx
        ON hosted_claim_operations(destination_id, organization_id, runner_id, state);

CREATE INDEX hosted_lifecycle_operations_attempt_idx
        ON hosted_lifecycle_operations(run_id, attempt_id, state);

CREATE UNIQUE INDEX hosted_lifecycle_operations_business_idx
        ON hosted_lifecycle_operations(destination_id, organization_id, runner_id, credential_id, business_key_digest);

CREATE INDEX hosted_lifecycle_operations_due_idx
        ON hosted_lifecycle_operations(destination_id, organization_id, state, next_attempt_at, created_at);

CREATE UNIQUE INDEX hosted_lifecycle_operations_request_idx
        ON hosted_lifecycle_operations(destination_id, organization_id, runner_id, credential_id, request_id);

CREATE UNIQUE INDEX hosted_lifecycle_operations_sequence_idx
        ON hosted_lifecycle_operations(destination_id, organization_id, run_id, attempt_id, sequence);

CREATE UNIQUE INDEX hosted_run_imports_admission_idx
        ON hosted_run_imports(admission_id);

CREATE UNIQUE INDEX hosted_run_imports_attempt_idx
        ON hosted_run_imports(attempt_id);

CREATE UNIQUE INDEX hosted_run_imports_authority_idx
        ON hosted_run_imports(authority_digest);

CREATE UNIQUE INDEX hosted_run_imports_claim_operation_idx
        ON hosted_run_imports(claim_operation_id);

CREATE UNIQUE INDEX hosted_run_imports_fence_idx
        ON hosted_run_imports(fencing_token_digest);

CREATE UNIQUE INDEX hosted_run_imports_source_idx
        ON hosted_run_imports(source_identity_digest);

CREATE INDEX hosted_run_imports_work_thread_idx
        ON hosted_run_imports(work_thread_id);

CREATE UNIQUE INDEX run_events_progress_idempotency_idx
        ON run_events(run_id, progress_idempotency_digest);

CREATE INDEX run_events_routing_latest_idx ON run_events(run_id, type, id);

CREATE INDEX run_events_run_idx ON run_events(run_id);

CREATE INDEX runs_claim_queue_idx ON runs(status, created_at, id);

CREATE INDEX runs_conversation_idx ON runs(conversation_key);

CREATE INDEX runs_lease_recovery_idx ON runs(status, lease_expires_at, created_at, id);

CREATE INDEX runs_repo_idx ON runs(repo_provider, repo_owner, repo_name);

CREATE INDEX runs_runner_idx ON runs(assigned_runner_id);

CREATE INDEX runs_status_idx ON runs(status);

CREATE INDEX runs_work_thread_authority_idx ON runs(work_thread_id, created_at, id);

CREATE INDEX runs_work_thread_idx ON runs(work_thread_id);

CREATE INDEX source_deliveries_run_idx ON source_deliveries(run_id);

CREATE INDEX work_threads_current_assessment_idx
        ON work_threads(current_assessment_id);

CREATE UNIQUE INDEX work_threads_scope_canonical_key_idx
        ON work_threads(scope_id, canonical_key);

CREATE TRIGGER control_plane_projection_outbox_delete_guard
      BEFORE DELETE ON control_plane_projection_outbox
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_delete_forbidden');
      END;

CREATE TRIGGER control_plane_projection_outbox_duplicate_insert_guard
      BEFORE INSERT ON control_plane_projection_outbox
      WHEN EXISTS (
        SELECT 1 FROM control_plane_projection_outbox existing
        WHERE (
            existing.destination_id = NEW.destination_id
            AND existing.organization_id = NEW.organization_id
            AND existing.receipt_id = NEW.receipt_id
          )
          OR (
            existing.destination_id = NEW.destination_id
            AND existing.organization_id = NEW.organization_id
            AND existing.identity_key = NEW.identity_key
          )
          OR (
            existing.destination_id = NEW.destination_id
            AND existing.organization_id = NEW.organization_id
            AND existing.operation_id = NEW.operation_id
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_duplicate_insert');
      END;

CREATE TRIGGER control_plane_projection_outbox_immutable_update_guard
      BEFORE UPDATE OF
        receipt_id, destination_id, organization_id, runner_id,
        receipt_kind, identity_namespace, identity_parts_json, identity_key, operation_id,
        payload_digest, receipt_digest, envelope_json, created_at
      ON control_plane_projection_outbox
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_immutable');
      END;

CREATE TRIGGER control_plane_projection_outbox_insert_guard
      BEFORE INSERT ON control_plane_projection_outbox
      WHEN (
        NEW.state = 'pending'
        AND NEW.attempt_count = 0
        AND NEW.next_attempt_at IS NOT NULL
        AND NEW.lease_owner IS NULL
        AND NEW.lease_token IS NULL
        AND NEW.lease_expires_at IS NULL
        AND NEW.last_reason_code IS NULL
        AND NEW.last_http_status IS NULL
        AND NEW.acknowledged_at IS NULL
        AND NEW.created_at = NEW.updated_at
        AND length(NEW.created_at) = 24
        AND NEW.created_at GLOB '????-??-??T??:??:??.???Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at) = NEW.created_at
        AND length(NEW.next_attempt_at) = 24
        AND NEW.next_attempt_at GLOB '????-??-??T??:??:??.???Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.next_attempt_at) = NEW.next_attempt_at
        AND NEW.next_attempt_at >= NEW.created_at
        AND json_extract(NEW.envelope_json, '$.receiptId') = NEW.receipt_id
        AND json_extract(NEW.envelope_json, '$.organizationId') = NEW.organization_id
        AND json_extract(NEW.envelope_json, '$.receiptKind') = NEW.receipt_kind
        AND json_extract(NEW.envelope_json, '$.identity.namespace') = NEW.identity_namespace
        AND json_extract(NEW.envelope_json, '$.identity.parts') = json(NEW.identity_parts_json)
        AND json_extract(NEW.envelope_json, '$.operationId') = NEW.operation_id
        AND json_extract(NEW.envelope_json, '$.payloadDigest') = NEW.payload_digest
        AND json_extract(NEW.envelope_json, '$.receiptDigest') = NEW.receipt_digest
        AND json_extract(NEW.envelope_json, '$.payload.runnerId') = NEW.runner_id
      ) IS NOT TRUE
      AND NOT EXISTS (
        SELECT 1 FROM control_plane_projection_outbox existing
        WHERE existing.destination_id = NEW.destination_id
          AND existing.organization_id = NEW.organization_id
          AND (
            existing.receipt_id = NEW.receipt_id
            OR existing.identity_key = NEW.identity_key
            OR existing.operation_id = NEW.operation_id
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_insert_invalid');
      END;

CREATE TRIGGER control_plane_projection_outbox_transition_guard
      BEFORE UPDATE OF
        state, attempt_count, next_attempt_at, lease_owner, lease_token,
        lease_expires_at, last_reason_code, last_http_status, updated_at,
      acknowledged_at
      ON control_plane_projection_outbox
      WHEN (
        length(NEW.updated_at) = 24
        AND NEW.updated_at GLOB '????-??-??T??:??:??.???Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at) = NEW.updated_at
        AND NEW.updated_at >= OLD.updated_at
        AND (NEW.last_http_status IS NULL OR (typeof(NEW.last_http_status) = 'integer' AND NEW.last_http_status >= 100 AND NEW.last_http_status <= 599))
        AND (
          NEW.last_reason_code IS NULL
          OR (
            length(NEW.last_reason_code) > 0
            AND NEW.last_reason_code NOT GLOB '*[^A-Za-z0-9._:@/#-]*'
            AND instr(lower(NEW.last_reason_code), '://') = 0
            AND NEW.last_reason_code NOT LIKE '../%'
            AND NEW.last_reason_code NOT LIKE '%/../%'
            AND NEW.last_reason_code NOT LIKE '%/..'
          )
        )
        AND (
          NEW.lease_owner IS NULL
          OR (
            length(NEW.lease_owner) > 0
            AND NEW.lease_owner NOT GLOB '*[^A-Za-z0-9._:@/#-]*'
            AND instr(lower(NEW.lease_owner), '://') = 0
            AND NEW.lease_owner NOT LIKE '../%'
            AND NEW.lease_owner NOT LIKE '%/../%'
            AND NEW.lease_owner NOT LIKE '%/..'
          )
        )
        AND (
          (
            OLD.state = 'pending' AND NEW.state = 'leased'
            AND NEW.attempt_count = OLD.attempt_count + 1
            AND NEW.next_attempt_at IS OLD.next_attempt_at
            AND length(NEW.next_attempt_at) = 24
            AND NEW.next_attempt_at GLOB '????-??-??T??:??:??.???Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.next_attempt_at) = NEW.next_attempt_at
            AND NEW.lease_owner IS NOT NULL
            AND NEW.lease_token IS NOT NULL
            AND NEW.lease_expires_at IS NOT NULL
            AND length(NEW.lease_expires_at) = 24
            AND NEW.lease_expires_at GLOB '????-??-??T??:??:??.???Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.lease_expires_at) = NEW.lease_expires_at
            AND NEW.lease_expires_at > NEW.updated_at
            AND NEW.last_reason_code IS OLD.last_reason_code
            AND NEW.last_http_status IS OLD.last_http_status
            AND NEW.acknowledged_at IS NULL
          )
          OR (
            OLD.state = 'leased' AND NEW.state = 'pending'
            AND NEW.attempt_count = OLD.attempt_count
            AND NEW.next_attempt_at IS NOT NULL
            AND length(NEW.next_attempt_at) = 24
            AND NEW.next_attempt_at GLOB '????-??-??T??:??:??.???Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.next_attempt_at) = NEW.next_attempt_at
            AND NEW.next_attempt_at >= NEW.updated_at
            AND NEW.lease_owner IS NULL AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
            AND NEW.last_reason_code IS NOT NULL
            AND NEW.acknowledged_at IS NULL
          )
          OR (
            OLD.state = 'leased' AND NEW.state = 'acknowledged'
            AND NEW.attempt_count = OLD.attempt_count
            AND NEW.next_attempt_at IS NULL
            AND NEW.lease_owner IS NULL AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
            AND NEW.last_reason_code IS OLD.last_reason_code
            AND NEW.acknowledged_at = NEW.updated_at
          )
          OR (
            OLD.state = 'leased' AND NEW.state = 'attention'
            AND NEW.attempt_count = OLD.attempt_count
            AND NEW.next_attempt_at IS NULL
            AND NEW.lease_owner IS NULL AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
            AND NEW.last_reason_code IS NOT NULL
            AND NEW.acknowledged_at IS NULL
          )
        )
      ) IS NOT TRUE
      BEGIN
        SELECT RAISE(ABORT, 'control_plane_projection_outbox_transition_invalid');
      END;

CREATE TRIGGER hosted_attempt_imports_delete_guard
      BEFORE DELETE ON hosted_attempt_imports
      BEGIN
        SELECT RAISE(ABORT, 'hosted_attempt_imports_delete_forbidden');
      END;

CREATE TRIGGER hosted_attempt_imports_immutable_update_guard
      BEFORE UPDATE ON hosted_attempt_imports
      BEGIN
        SELECT RAISE(ABORT, 'hosted_attempt_imports_immutable');
      END;

CREATE TRIGGER hosted_claim_authority_shell_immutable_guard
      BEFORE UPDATE OF claim_digest, authority_digest, authority_json, attempt_id,
        attempt_number, fencing_token_digest, credential_id, lease_expires_at, executor_id
      ON hosted_claim_operations
      WHEN OLD.claim_digest IS NOT NULL AND (
        NEW.claim_digest IS NOT OLD.claim_digest
        OR NEW.authority_digest IS NOT OLD.authority_digest
        OR NEW.authority_json IS NOT OLD.authority_json
        OR NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.attempt_number IS NOT OLD.attempt_number
        OR NEW.fencing_token_digest IS NOT OLD.fencing_token_digest
        OR NEW.credential_id IS NOT OLD.credential_id
        OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
        OR NEW.executor_id IS NOT OLD.executor_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'hosted_claim_authority_shell_immutable');
      END;

CREATE TRIGGER hosted_lifecycle_operations_delete_guard
      BEFORE DELETE ON hosted_lifecycle_operations
      BEGIN
        SELECT RAISE(ABORT, 'hosted_lifecycle_operations_delete_forbidden');
      END;

CREATE TRIGGER hosted_lifecycle_operations_immutable_guard
      BEFORE UPDATE OF destination_id, organization_id, runner_id, credential_id, operation_id,
        request_id, action, run_id, attempt_id, attempt_number, fencing_token_digest,
        request_digest, business_key_digest, sequence, request_json, created_at
      ON hosted_lifecycle_operations
      BEGIN
        SELECT RAISE(ABORT, 'hosted_lifecycle_operations_immutable');
      END;

CREATE TRIGGER hosted_run_imports_delete_guard
      BEFORE DELETE ON hosted_run_imports
      BEGIN
        SELECT RAISE(ABORT, 'hosted_run_imports_delete_forbidden');
      END;

CREATE TRIGGER hosted_run_imports_immutable_update_guard
      BEFORE UPDATE ON hosted_run_imports
      BEGIN
        SELECT RAISE(ABORT, 'hosted_run_imports_immutable');
      END;
`;

type PairedRunnerSchemaMarker = {
  version: number;
  state: string;
  fingerprint: string | null;
};

function pairedRunnerSchemaFingerprint(sqlite: Database.Database): string {
  const objects = sqlite.prepare(`
    SELECT type, name, tbl_name AS tableName, COALESCE(sql, '') AS sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
      AND name <> 'opentag_paired_runner_schema'
    ORDER BY type, name
  `).all();
  return createHash("sha256").update(JSON.stringify(objects), "utf8").digest("hex");
}

function validatePairedRunnerSchema(sqlite: Database.Database): void {
  const marker = sqlite.prepare(`
    SELECT version, state, fingerprint
    FROM opentag_paired_runner_schema
    WHERE singleton = 1
  `).get() as PairedRunnerSchemaMarker | undefined;
  if (
    !marker
    || marker.version !== PAIRED_RUNNER_SCHEMA_VERSION
    || marker.state !== "ready"
    || marker.fingerprint !== pairedRunnerSchemaFingerprint(sqlite)
  ) {
    throw new Error("paired_runner_schema_incompatible");
  }
  const migrationIds = (sqlite.prepare(
    "SELECT id FROM opentag_schema_migrations ORDER BY id",
  ).all() as Array<{ id: string }>).map(({ id }) => id);
  if (
    JSON.stringify(migrationIds)
      !== JSON.stringify([...PAIRED_RUNNER_SCHEMA_MIGRATIONS].sort())
  ) {
    throw new Error("paired_runner_schema_incompatible");
  }
}

/**
 * Initializes only a fresh paired Runner database. Existing databases are
 * inspected but never upgraded, converted, or dropped.
 */
export function migratePairedRunnerSchema(sqlite: Database.Database): void {
  const markerTable = sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'opentag_paired_runner_schema'
  `).get();
  if (markerTable) {
    validatePairedRunnerSchema(sqlite);
    return;
  }
  const existing = sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    LIMIT 1
  `).get();
  if (existing) {
    throw new Error("paired_runner_schema_incompatible_existing_database");
  }

  sqlite.transaction(() => {
    sqlite.exec(PAIRED_RUNNER_SCHEMA_SQL);
    const initializedAt = new Date().toISOString();
    const insertMigration = sqlite.prepare(
      "INSERT INTO opentag_schema_migrations (id, applied_at) VALUES (?, ?)",
    );
    for (const migrationId of PAIRED_RUNNER_SCHEMA_MIGRATIONS) {
      insertMigration.run(migrationId, initializedAt);
    }
    sqlite.prepare(`
      INSERT INTO opentag_paired_runner_schema(
        singleton, version, state, fingerprint, initialized_at
      ) VALUES(1, ?, 'ready', ?, ?)
    `).run(
      PAIRED_RUNNER_SCHEMA_VERSION,
      pairedRunnerSchemaFingerprint(sqlite),
      initializedAt,
    );
  })();
  validatePairedRunnerSchema(sqlite);
}
