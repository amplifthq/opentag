import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ApprovalDecisionSchema,
  ActionPermissionRequestSchema,
  ActionPermissionResolutionSchema,
  ActionSchema,
  MaterialActionReceiptSchema,
  ApplyIntentOutcomeSchema,
  ApplyPlanSchema,
  ActionHintSchema,
  AdapterMutationMappingSchema,
  ContextPacketSchema,
  conversationKeyFromEvent,
  defaultRunEventMetadata,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  PolicyRuleSchema,
  ProposalLineageSchema,
  preflightMutationIntent,
  evaluateActionPermission,
  grantMatchesAction,
  normalizeMaterialActionRequest,
  formatProjectTargetRef,
  projectTargetRefFromEvent,
  protocolRunFieldsFromEvent,
  RunAdmissionDecisionSchema,
  RunEventImportanceSchema,
  RunEventVisibilitySchema,
  SuggestedChangesSnapshotSchema,
  type ApprovalDecision,
  type Action,
  type ActionPermissionRequest,
  type ActionPermissionResolution,
  type MaterialActionReceipt,
  type Attempt,
  type ApplyIntentOutcome,
  type ApplyPlan,
  type ActionHint,
  type AdapterMutationMapping,
  type MutationIntentActionability,
  type OpenTagEvent,
  type OpenTagRun,
  type OpenTagRunResult,
  type PolicyRule,
  type ProjectTargetRef,
  type ProposalLineage,
  type RunAdmissionDecision,
  type RunEventImportance,
  type RunEventVisibility,
  type SuggestedChangesSnapshot
} from "@opentag/core";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  applyPlans,
  attempts,
  approvalDecisions,
  grants,
  materialActions,
  channelBindings,
  controlPlaneEvents,
  linearOAuthInstallStates,
  linearRelayInstallations,
  repoBindings,
  repoMutationMappings,
  repoPolicyRules,
  callbackDeliveries,
  followUpRequests,
  runEvents,
  sourceDeliveries,
  runners,
  runs,
  suggestedChanges
} from "./schema.js";

export type OpenTagRunWithEvent = {
  run: OpenTagRun;
  event: OpenTagEvent;
};

export type ClaimedOpenTagRun = OpenTagRunWithEvent & {
  attemptId: string;
  attemptNumber: number;
  fencingToken: string;
};

export type OpenTagAuditEvent = {
  id: number;
  runId: string;
  type: string;
  visibility: RunEventVisibility;
  importance: RunEventImportance;
  message?: string;
  payload: unknown;
  createdAt: string;
};

export type AgentWorkLedgerCategory =
  | "source_event"
  | "admission"
  | "context_packet"
  | "executor_capability"
  | "lifecycle"
  | "progress_visibility"
  | "approval_decision"
  | "apply_plan"
  | "artifact"
  | "callback_delivery"
  | "final_outcome"
  | "error"
  | "cancellation"
  | "timeout"
  | "audit";

export type AgentWorkLedgerEntry = OpenTagAuditEvent & {
  sequence: number;
  category: AgentWorkLedgerCategory;
};

export type AgentWorkLedger = {
  runId: string;
  entries: AgentWorkLedgerEntry[];
};

export type CallbackDeliveryKind = "acknowledgement" | "progress" | "final";
export type CallbackDeliveryProvider = string;
export type CallbackDeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

export type CallbackDelivery = {
  id: number;
  runId: string;
  kind: CallbackDeliveryKind;
  provider: CallbackDeliveryProvider;
  uri: string;
  body: string;
  threadKey?: string;
  idempotencyKey?: string;
  agentId?: string;
  statusMessageKey?: string;
  externalMessageId?: string;
  blocks?: unknown[];
  rich?: unknown;
  status: CallbackDeliveryStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RepoBinding = {
  provider: string;
  owner: string;
  repo: string;
  runnerId: string;
  workspacePath?: string;
  defaultExecutor?: string;
  allowedActors?: string[];
};

export type ChannelBinding = {
  provider: string;
  accountId: string;
  conversationId: string;
  metadata?: Record<string, unknown>;
} & (
  | { repoProvider: string; owner: string; repo: string }
  | { repoProvider?: never; owner?: never; repo?: never }
);

export type SlackChannelBinding = {
  teamId: string;
  channelId: string;
  repoProvider?: string;
  owner: string;
  repo: string;
};

export type LinearRelayInstallation = {
  id: string;
  webhookPath: string;
  webhookSecret: string;
  token: string;
  auth?: LinearRelayInstallationAuth;
  graphqlUrl?: string;
  repoProvider: string;
  owner: string;
  repo: string;
  organizationId?: string;
  teamId?: string;
  teamKey?: string;
  createdAt: string;
  updatedAt: string;
};

export type LinearRelayInstallationAuth =
  | {
      method: "api_key";
    }
  | {
      method: "oauth_app";
      actor: "app";
      clientId?: string;
      refreshToken?: string;
      accessTokenExpiresAt?: string;
      appUserId?: string;
      scopes?: string[];
    };

export type LinearOAuthInstallState = {
  state: string;
  installationId: string;
  webhookPath: string;
  webhookSecret: string;
  redirectUri: string;
  graphqlUrl?: string;
  repoProvider: string;
  owner: string;
  repo: string;
  teamId?: string;
  teamKey?: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
};

export type RunnerRegistration = {
  runnerId: string;
  name: string;
  createdAt: string;
  heartbeatAt?: string;
};

export type StoredSuggestedChangesSnapshot = {
  runId: string;
  snapshot: SuggestedChangesSnapshot;
};

export type StoredSuggestedChangesInConversation = StoredSuggestedChangesSnapshot & {
  run: OpenTagRun;
  event: OpenTagEvent;
};

type RunSignatureState = "verified" | "unverified" | "unknown";

type RunProvenance = {
  source: string;
  sourceEventId: string;
  sourceDeliveryId: string | null;
  signatureState: RunSignatureState;
  projectTarget: (ProjectTargetRef & { ref: string }) | null;
  admissionDecision: Pick<RunAdmissionDecision, "action" | "reasonCode" | "eventId" | "activeRunId">;
  expectedRunnerId: string | null;
};

export type ApplyOutcomeCounts = {
  applied: number;
  skipped: number;
  failed: number;
  stale: number;
  unsupported: number;
};

export type CreateRunResult =
  | {
      run: OpenTagRun;
      created: true;
    }
  | {
      run: OpenTagRun;
      created: false;
      replayKind: "source_event" | "source_delivery";
      replayDecision: RunAdmissionDecision;
    };

export type CancelRunOutcome =
  | { outcome: "cancelled"; run: OpenTagRun; event: OpenTagEvent }
  | { outcome: "already_terminal"; run: OpenTagRun; event: OpenTagEvent }
  | { outcome: "not_found" };

export type SourceDeliveryPruneResult = {
  scanned: number;
  pruned: number;
  retainedActive: number;
};

export type FollowUpRequest = {
  id: string;
  sourceEventId: string;
  conversationKey: string;
  activeRunId?: string;
  event: OpenTagEvent;
  decision: RunAdmissionDecision;
  status: "queued" | "promoted" | "cancelled";
  createdRunId?: string;
  createdAt: string;
  updatedAt: string;
};

export type OpenTagRunMetrics = {
  runId: string;
  totalEventCount: number;
  humanEventCount: number;
  auditEventCount: number;
  debugEventCount: number;
  humanCallbackCount: number;
  threadNoiseRatio: number;
  suggestedChangesCount: number;
  approvalDecisionCount: number;
  applyPlanCount: number;
  childRunCount: number;
  applyOutcomeCounts: ApplyOutcomeCounts;
  staleIntentCount: number;
};

export type OpenTagAggregateMetrics = {
  scope: "repo" | "work_thread";
  scopeId: string;
  runCount: number;
  totalEventCount: number;
  humanEventCount: number;
  auditEventCount: number;
  debugEventCount: number;
  humanCallbackCount: number;
  threadNoiseRatio: number;
  suggestedChangesCount: number;
  approvalDecisionCount: number;
  applyPlanCount: number;
  childRunCount: number;
  applyOutcomeCounts: ApplyOutcomeCounts;
  staleIntentCount: number;
};

export type AttemptMutationConflict = "stale_attempt";
export type HeartbeatOutcome = "updated" | AttemptMutationConflict | "not_found";
export type RecordProgressOutcome = "recorded" | "duplicate" | AttemptMutationConflict | "not_found";
export type MarkRunningOutcome = "running" | "duplicate" | AttemptMutationConflict | "not_found";
export type CompleteRunOutcome = "completed" | "duplicate" | AttemptMutationConflict | "not_found";

export type ControlPlaneEventSeverity = "info" | "warn" | "error";

export type ControlPlaneEvent = {
  id: number;
  type: string;
  severity: ControlPlaneEventSeverity;
  subject?: string;
  payload: unknown;
  createdAt: string;
};

export type ControlPlaneAlert = {
  id: string;
  type:
    | "repeated_auth_failures"
    | "repeated_signature_failures"
    | "token_misuse"
    | "repeated_large_payload_rejections"
    | "repeated_invalid_request_body"
    | "repeated_unknown_project_targets"
    | "abnormal_runner_claim_rate";
  severity: ControlPlaneEventSeverity;
  eventType: string;
  count: number;
  threshold: number;
  firstSeenAt: string;
  lastSeenAt: string;
  subject?: string;
  reason: string;
  nextAction: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isIsoExpired(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() <= now.getTime();
}

function newAttemptId(): string {
  return `attempt_${randomUUID()}`;
}

function newFencingToken(): string {
  return randomBytes(32).toString("base64url");
}

function attemptFromRow(row: typeof attempts.$inferSelect): Attempt {
  return {
    id: row.id,
    runId: row.runId,
    number: row.number,
    runnerId: row.runnerId,
    status: row.status as Attempt["status"],
    startedAt: row.startedAt,
    heartbeatAt: row.heartbeatAt,
    leaseExpiresAt: row.leaseExpiresAt,
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    ...(row.resultJson ? { result: OpenTagRunResultSchema.parse(JSON.parse(row.resultJson)) } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function actionFromRow(row: typeof materialActions.$inferSelect): Action {
  return ActionSchema.parse({
    id: row.id,
    runId: row.runId,
    attemptId: row.attemptId,
    actionFamily: row.actionFamily,
    capability: row.capability,
    scope: JSON.parse(row.scopeJson) as unknown,
    target: JSON.parse(row.targetJson) as unknown,
    riskTier: row.riskTier,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    ...(row.proposalId ? { proposalId: row.proposalId } : {}),
    ...(row.proposalHash ? { proposalHash: row.proposalHash } : {}),
    ...(row.decisionSnapshotHash ? { decisionSnapshotHash: row.decisionSnapshotHash } : {}),
    attemptFenceDigest: row.attemptFenceDigest,
    ...(row.receiptJson ? { receipt: JSON.parse(row.receiptJson) as unknown } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableActionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableActionJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableActionJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type AttemptLease = {
  runId: string;
  runnerId: string;
  attemptId: string;
  fencingToken: string;
};

function runFromRow(row: typeof runs.$inferSelect): OpenTagRun {
  const event = OpenTagEventSchema.parse(JSON.parse(row.eventJson));
  const result = row.resultJson ? OpenTagRunResultSchema.parse(JSON.parse(row.resultJson)) : undefined;
  const triggeredByAction = row.triggeredByActionJson ? ActionHintSchema.parse(JSON.parse(row.triggeredByActionJson)) : undefined;
  const protocolFields = protocolRunFieldsFromEvent(event, row.createdAt);
  const contextPacket = row.contextPacketJson
    ? ContextPacketSchema.parse(JSON.parse(row.contextPacketJson))
    : protocolFields.contextPacket;
  return {
    id: row.id,
    eventId: row.eventId,
    status: row.status as OpenTagRun["status"],
    ...(protocolFields.thread ? { thread: protocolFields.thread } : {}),
    contextPacket,
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

function ledgerCategoryForEventType(type: string): AgentWorkLedgerCategory {
  if (type.startsWith("admission.")) return "admission";
  if (type.startsWith("context_packet.")) return "context_packet";
  if (type.startsWith("executor.capability.")) return "executor_capability";
  if (type === "callback.progress.suppressed") return "progress_visibility";
  if (type.startsWith("callback.")) return "callback_delivery";
  if (type.startsWith("source_receipt.")) return "callback_delivery";
  if (type.startsWith("approval.")) return "approval_decision";
  if (type.startsWith("apply_plan.")) return "apply_plan";
  if (type.startsWith("artifact.")) return "artifact";
  if (type.startsWith("proposal.snapshot.")) return "artifact";
  if (type === "run.completed") return "final_outcome";
  if (type === "run.cancelled" || type.includes(".cancel")) return "cancellation";
  if (type.includes("timeout") || type === "run.timed_out") return "timeout";
  if (type === "run.progress") return "progress_visibility";
  if (type.startsWith("run.")) return "lifecycle";
  if (type.startsWith("security.") || type.endsWith(".failed")) return "error";
  return "audit";
}

function sourceContainerMetadataMatches(input: {
  event: OpenTagEvent;
  source: string;
  metadata: Record<string, string>;
}): boolean {
  if (input.event.source !== input.source) return false;
  return Object.entries(input.metadata).every(([key, value]) => input.event.metadata[key] === value);
}

type CallbackDeliveryMetadata = {
  agentId?: string;
  statusMessageKey?: string;
  externalMessageId?: string;
  blocks?: unknown[];
  rich?: unknown;
};

function callbackDeliveryMetadataFromJson(metadataJson: string | null): CallbackDeliveryMetadata | undefined {
  return metadataJson && typeof metadataJson === "string" ? (JSON.parse(metadataJson) as CallbackDeliveryMetadata) : undefined;
}

function callbackDeliveryFromRow(row: typeof callbackDeliveries.$inferSelect): CallbackDelivery {
  const metadata = callbackDeliveryMetadataFromJson(row.metadataJson);
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as CallbackDeliveryKind,
    provider: row.provider as CallbackDeliveryProvider,
    uri: row.uri,
    body: row.body,
    ...(row.threadKey ? { threadKey: row.threadKey } : {}),
    ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    ...(metadata?.agentId ? { agentId: metadata.agentId } : {}),
    ...(metadata?.statusMessageKey ? { statusMessageKey: metadata.statusMessageKey } : {}),
    ...(metadata?.externalMessageId ? { externalMessageId: metadata.externalMessageId } : {}),
    ...(metadata?.blocks ? { blocks: metadata.blocks } : {}),
    ...(metadata && "rich" in metadata ? { rich: metadata.rich } : {}),
    status: row.status as CallbackDeliveryStatus,
    attempts: row.attempts,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function callbackBodyHash(input: { body: string; blocks?: unknown[]; rich?: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify({ body: input.body, blocks: input.blocks ?? [], rich: input.rich ?? null }))
    .digest("hex");
}

function callbackIdempotencyKey(input: {
  runId: string;
  kind: CallbackDeliveryKind;
  provider: CallbackDeliveryProvider;
  uri: string;
  body: string;
  threadKey?: string;
  statusMessageKey?: string;
  blocks?: unknown[];
  rich?: unknown;
}): string {
  return [
    input.runId,
    input.provider,
    input.threadKey ?? input.uri,
    input.kind,
    input.statusMessageKey ?? "",
    callbackBodyHash({ body: input.body, ...(input.blocks ? { blocks: input.blocks } : {}), ...(input.rich !== undefined ? { rich: input.rich } : {}) })
  ].join("|");
}

function followUpRequestFromRow(row: typeof followUpRequests.$inferSelect): FollowUpRequest {
  return {
    id: row.id,
    sourceEventId: row.sourceEventId,
    conversationKey: row.conversationKey,
    ...(row.activeRunId ? { activeRunId: row.activeRunId } : {}),
    event: OpenTagEventSchema.parse(JSON.parse(row.eventJson)),
    decision: RunAdmissionDecisionSchema.parse(JSON.parse(row.decisionJson)),
    status: row.status as FollowUpRequest["status"],
    ...(row.createdRunId ? { createdRunId: row.createdRunId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function runnerFromRow(row: typeof runners.$inferSelect): RunnerRegistration {
  return {
    runnerId: row.runnerId,
    name: row.name,
    createdAt: row.createdAt,
    ...(row.heartbeatAt ? { heartbeatAt: row.heartbeatAt } : {})
  };
}

function recordFromJson(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function metadataString(metadata: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function metadataBoolean(metadata: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function signatureStateFromEvent(event: OpenTagEvent): RunSignatureState {
  const explicitState = metadataString(event.metadata, ["signatureState", "webhookSignatureState"]);
  if (explicitState === "verified" || explicitState === "unverified" || explicitState === "unknown") return explicitState;

  const verified = metadataBoolean(event.metadata, [
    "signatureVerified",
    "verifiedSignature",
    "webhookSignatureVerified",
    "githubSignatureVerified"
  ]);
  if (verified === true) return "verified";
  if (verified === false) return "unverified";
  return "unknown";
}

function sourceDeliveryIdFromEvent(event: OpenTagEvent): string | null {
  return metadataString(event.metadata, [
    "sourceDeliveryId",
    "webhookDeliveryId",
    "deliveryId",
    "githubDeliveryId",
    "githubDeliveryGuid",
    "slackEventId",
    "larkEventId"
  ]);
}

function projectTargetProvenance(ref: ProjectTargetRef | null): RunProvenance["projectTarget"] {
  if (!ref) return null;
  return {
    ref: formatProjectTargetRef(ref),
    ...ref
  };
}

function runProvenance(input: {
  event: OpenTagEvent;
  projectTarget: ProjectTargetRef | null;
  admissionDecision: RunAdmissionDecision;
  expectedRunnerId: string | null;
}): RunProvenance {
  return {
    source: input.event.source,
    sourceEventId: input.event.sourceEventId,
    sourceDeliveryId: sourceDeliveryIdFromEvent(input.event),
    signatureState: signatureStateFromEvent(input.event),
    projectTarget: projectTargetProvenance(input.projectTarget),
    admissionDecision: {
      action: input.admissionDecision.action,
      reasonCode: input.admissionDecision.reasonCode,
      ...(input.admissionDecision.eventId ? { eventId: input.admissionDecision.eventId } : {}),
      ...(input.admissionDecision.activeRunId ? { activeRunId: input.admissionDecision.activeRunId } : {})
    },
    expectedRunnerId: input.expectedRunnerId
  };
}

function channelBindingFromRow(row: typeof channelBindings.$inferSelect): ChannelBinding {
  const metadata = recordFromJson(row.metadataJson);
  const repositoryValues = [row.repoProvider, row.owner, row.repo];
  const repositoryFieldCount = repositoryValues.filter((value) => value !== null).length;
  if (repositoryFieldCount !== 0 && repositoryFieldCount !== 3) {
    throw new Error("Stored channel binding has partial repository fields.");
  }
  return {
    provider: row.provider,
    accountId: row.accountId,
    conversationId: row.conversationId,
    ...(row.repoProvider && row.owner && row.repo
      ? { repoProvider: row.repoProvider, owner: row.owner, repo: row.repo }
      : {}),
    ...(metadata ? { metadata } : {})
  };
}

function channelBindingRepositoryFields(input: ChannelBinding):
  | { repoProvider: string; owner: string; repo: string }
  | { repoProvider: null; owner: null; repo: null } {
  const values = [input.repoProvider, input.owner, input.repo];
  const present = values.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== 3) {
    throw new Error("Channel binding repository fields repoProvider, owner, and repo must be provided together.");
  }
  return input.repoProvider && input.owner && input.repo
    ? { repoProvider: input.repoProvider, owner: input.owner, repo: input.repo }
    : { repoProvider: null, owner: null, repo: null };
}

function stringArrayFromJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  } catch {
    return [];
  }
}

function parseLinearRelayInstallationAuth(value: string | null): LinearRelayInstallationAuth | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.method === "api_key") return { method: "api_key" };
  if (record.method !== "oauth_app" || record.actor !== "app") return undefined;
  const scopes = Array.isArray(record.scopes) ? record.scopes.filter((item): item is string => typeof item === "string" && item.length > 0) : undefined;
  return {
    method: "oauth_app",
    actor: "app",
    ...(typeof record.clientId === "string" && record.clientId.length > 0 ? { clientId: record.clientId } : {}),
    ...(typeof record.refreshToken === "string" && record.refreshToken.length > 0 ? { refreshToken: record.refreshToken } : {}),
    ...(typeof record.accessTokenExpiresAt === "string" && record.accessTokenExpiresAt.length > 0
      ? { accessTokenExpiresAt: record.accessTokenExpiresAt }
      : {}),
    ...(typeof record.appUserId === "string" && record.appUserId.length > 0 ? { appUserId: record.appUserId } : {}),
    ...(scopes?.length ? { scopes } : {})
  };
}

function linearRelayInstallationFromRow(row: typeof linearRelayInstallations.$inferSelect): LinearRelayInstallation {
  const auth = parseLinearRelayInstallationAuth(row.authJson);
  return {
    id: row.id,
    webhookPath: row.webhookPath,
    webhookSecret: row.webhookSecret,
    token: row.token,
    ...(auth ? { auth } : {}),
    ...(row.graphqlUrl ? { graphqlUrl: row.graphqlUrl } : {}),
    repoProvider: row.repoProvider,
    owner: row.owner,
    repo: row.repo,
    ...(row.organizationId ? { organizationId: row.organizationId } : {}),
    ...(row.teamId ? { teamId: row.teamId } : {}),
    ...(row.teamKey ? { teamKey: row.teamKey } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function linearOAuthInstallStateFromRow(row: typeof linearOAuthInstallStates.$inferSelect): LinearOAuthInstallState {
  return {
    state: row.state,
    installationId: row.installationId,
    webhookPath: row.webhookPath,
    webhookSecret: row.webhookSecret,
    redirectUri: row.redirectUri,
    ...(row.graphqlUrl ? { graphqlUrl: row.graphqlUrl } : {}),
    repoProvider: row.repoProvider,
    owner: row.owner,
    repo: row.repo,
    ...(row.teamId ? { teamId: row.teamId } : {}),
    ...(row.teamKey ? { teamKey: row.teamKey } : {}),
    scopes: stringArrayFromJson(row.scopesJson),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {})
  };
}

function syntheticManualApprovalPolicyRules(decision: ApprovalDecision): PolicyRule[] {
  return [
    {
      id: `manual_approval_${decision.id}`,
      scope: "primary_anchor_override",
      effect: "allow",
      reason: "Manual approval decision authorized selected proposal intents."
    }
  ];
}

function executorConditionsFromIntent(intent: { params?: Record<string, unknown> | undefined }): string[] {
  const value = intent.params?.["executorConditions"];
  if (!Array.isArray(value)) return [];
  return value.filter((condition): condition is string => typeof condition === "string" && condition.length > 0);
}

function lineageScopeKey(input: { runId: string; snapshot: SuggestedChangesSnapshot }): string {
  return input.snapshot.workThread?.id ?? `run:${input.runId}`;
}

function computeProposalLineage(snapshots: StoredSuggestedChangesSnapshot[], targetScopeKey: string): ProposalLineage {
  const scoped = snapshots
    .filter((snapshot) => lineageScopeKey(snapshot) === targetScopeKey)
    .sort((left, right) => {
      const timeDelta = new Date(left.snapshot.createdAt).getTime() - new Date(right.snapshot.createdAt).getTime();
      if (timeDelta !== 0) return timeDelta;
      return left.snapshot.proposalId.localeCompare(right.snapshot.proposalId);
    });

  const latestProposalByDomain = new Map<string, string>();
  const explicitSupersession = new Map<string, { proposalId: string; intentId: string }>();
  for (const stored of scoped) {
    const domainsInProposal = new Set<string>();
    for (const intent of stored.snapshot.intents) {
      domainsInProposal.add(intent.domain);
      for (const supersededIntentId of intent.supersedesIntentIds ?? []) {
        explicitSupersession.set(supersededIntentId, { proposalId: stored.snapshot.proposalId, intentId: intent.intentId });
      }
    }
    for (const domain of domainsInProposal) {
      latestProposalByDomain.set(domain, stored.snapshot.proposalId);
    }
  }

  const entries: MutationIntentActionability[] = [];
  for (const stored of scoped) {
    for (const intent of stored.snapshot.intents) {
      const explicit = explicitSupersession.get(intent.intentId);
      const latestProposalId = latestProposalByDomain.get(intent.domain);
      if (explicit) {
        entries.push({
          proposalId: stored.snapshot.proposalId,
          intentId: intent.intentId,
          domain: intent.domain,
          status: "superseded",
          supersededByProposalId: explicit.proposalId,
          supersededByIntentId: explicit.intentId,
          reason: "A later intent explicitly superseded this intent."
        });
      } else if (latestProposalId && latestProposalId !== stored.snapshot.proposalId) {
        const supersedingIntent = scoped
          .find((candidate) => candidate.snapshot.proposalId === latestProposalId)
          ?.snapshot.intents.find((candidateIntent) => candidateIntent.domain === intent.domain);
        entries.push({
          proposalId: stored.snapshot.proposalId,
          intentId: intent.intentId,
          domain: intent.domain,
          status: "superseded",
          supersededByProposalId: latestProposalId,
          ...(supersedingIntent ? { supersededByIntentId: supersedingIntent.intentId } : {}),
          reason: `A newer proposal superseded the ${intent.domain} domain.`
        });
      } else {
        entries.push({
          proposalId: stored.snapshot.proposalId,
          intentId: intent.intentId,
          domain: intent.domain,
          status: "current"
        });
      }
    }
  }

  return ProposalLineageSchema.parse({ scopeKey: targetScopeKey, entries });
}

function emptyApplyOutcomeCounts(): ApplyOutcomeCounts {
  return {
    applied: 0,
    skipped: 0,
    failed: 0,
    stale: 0,
    unsupported: 0
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function payloadString(payload: unknown, path: string[]): string | null {
  let current = payload;
  for (const segment of path) {
    const record = recordFromUnknown(current);
    if (!record) return null;
    current = record[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

function controlPlaneAlertSubject(event: ControlPlaneEvent): string {
  if (event.type === "run.claimed") {
    return payloadString(event.payload, ["runnerId"]) ?? event.subject ?? "unknown-runner";
  }
  if (event.type === "security.auth_failed") {
    return payloadString(event.payload, ["tokenFingerprint"]) ?? event.subject ?? "unknown-token";
  }
  if (event.type === "security.token_misuse") {
    const provider = payloadString(event.payload, ["provider"]);
    const tokenKind = payloadString(event.payload, ["tokenKind"]);
    if (provider && tokenKind) return `${provider}:${tokenKind}`;
    return event.subject ?? "unknown-token";
  }
  if (event.type === "security.signature_failed") {
    const provider = payloadString(event.payload, ["provider"]);
    const endpoint = payloadString(event.payload, ["endpoint"]);
    if (provider && endpoint) return `${provider}:${endpoint}`;
    return event.subject ?? "unknown-signature-source";
  }
  if (event.type === "security.request_body_rejected") {
    return payloadString(event.payload, ["endpoint"]) ?? event.subject ?? "unknown-endpoint";
  }
  if (event.type === "admission.needs_human_decision") {
    const reasonCode = payloadString(event.payload, ["decision", "reasonCode"]) ?? payloadString(event.payload, ["reasonCode"]);
    if (reasonCode === "repo_not_bound" || reasonCode === "repo_context_missing") {
      return payloadString(event.payload, ["projectTarget"]) ?? reasonCode;
    }
  }
  return event.subject ?? event.type;
}

function controlPlaneAlertKind(event: ControlPlaneEvent): ControlPlaneAlert["type"] | null {
  if (event.type === "run.claimed") return "abnormal_runner_claim_rate";
  if (event.type === "security.auth_failed") return "repeated_auth_failures";
  if (event.type === "security.token_misuse") return "token_misuse";
  if (event.type === "security.signature_failed") return "repeated_signature_failures";
  if (event.type === "security.request_body_rejected") {
    return payloadString(event.payload, ["reason"]) === "request_body_too_large"
      ? "repeated_large_payload_rejections"
      : "repeated_invalid_request_body";
  }
  if (event.type === "admission.needs_human_decision") {
    const reasonCode = payloadString(event.payload, ["decision", "reasonCode"]) ?? payloadString(event.payload, ["reasonCode"]);
    if (reasonCode === "repo_not_bound" || reasonCode === "repo_context_missing") return "repeated_unknown_project_targets";
  }
  return null;
}

function controlPlaneAlertMetadata(kind: ControlPlaneAlert["type"]): Pick<ControlPlaneAlert, "reason" | "nextAction" | "severity"> {
  if (kind === "repeated_auth_failures") {
    return {
      severity: "warn",
      reason: "Repeated dispatcher authorization failures were observed.",
      nextAction: "Check for token misuse, stale runner configuration, or a leaked/rotated pairing token."
    };
  }
  if (kind === "token_misuse") {
    return {
      severity: "warn",
      reason: "A platform or relay token failed with a terminal authentication or configuration error.",
      nextAction: "Rotate or replace the affected token, then restart or re-pair the ingress or runner that owns it."
    };
  }
  if (kind === "repeated_large_payload_rejections") {
    return {
      severity: "warn",
      reason: "Repeated oversized dispatcher request bodies were rejected.",
      nextAction: "Check source ingress payload size, request body limits, and whether a client is retrying an invalid payload."
    };
  }
  if (kind === "repeated_invalid_request_body") {
    return {
      severity: "warn",
      reason: "Repeated malformed or schema-invalid request bodies were rejected.",
      nextAction: "Check source webhook payload shape, client versions, and whether unsigned or incompatible traffic is hitting the endpoint."
    };
  }
  if (kind === "repeated_signature_failures") {
    return {
      severity: "warn",
      reason: "Repeated source webhook signature verification failures were observed.",
      nextAction: "Check the source webhook secret, signing configuration, endpoint URL, and whether unsigned traffic is hitting the ingress."
    };
  }
  if (kind === "abnormal_runner_claim_rate") {
    return {
      severity: "warn",
      reason: "Runner claim volume exceeded the local alert threshold.",
      nextAction: "Check for runaway runner loops, token misuse, or an unexpected burst of queued runs for this runner."
    };
  }
  return {
    severity: "warn",
    reason: "Repeated source events resolved to missing or unbound Project Targets.",
    nextAction: "Verify source metadata, Project Target bindings, and runner allowlists before retrying."
  };
}

function controlPlaneAlertThreshold(kind: ControlPlaneAlert["type"], thresholds?: Partial<Record<ControlPlaneAlert["type"], number>>): number {
  return (
    thresholds?.[kind] ??
    (kind === "token_misuse"
      ? 1
      : kind === "repeated_auth_failures" || kind === "repeated_signature_failures"
        ? 3
        : kind === "abnormal_runner_claim_rate"
          ? 10
          : 2)
  );
}

function metricsFromEvents(runId: string, events: OpenTagAuditEvent[]): OpenTagRunMetrics {
  const latestApplyPlans = new Map<string, ApplyPlan>();
  for (const event of events) {
    if (event.type !== "apply_plan.created" && event.type !== "apply_plan.executed") continue;
    const parsed = ApplyPlanSchema.safeParse(event.payload);
    if (parsed.success) {
      latestApplyPlans.set(parsed.data.id, parsed.data);
    }
  }

  const applyOutcomeCounts = emptyApplyOutcomeCounts();
  for (const plan of latestApplyPlans.values()) {
    for (const outcome of plan.outcomes ?? []) {
      applyOutcomeCounts[outcome.outcome] += 1;
    }
  }

  const humanCallbackCount = events.filter((event) => event.visibility === "human" && event.type.startsWith("callback.")).length;
  const auditEventCount = events.filter((event) => event.visibility === "audit").length;
  return {
    runId,
    totalEventCount: events.length,
    humanEventCount: events.filter((event) => event.visibility === "human").length,
    auditEventCount,
    debugEventCount: events.filter((event) => event.visibility === "debug").length,
    humanCallbackCount,
    threadNoiseRatio: auditEventCount === 0 ? humanCallbackCount : humanCallbackCount / auditEventCount,
    suggestedChangesCount: events
      .filter((event) => event.type === "proposal.snapshot.created")
      .reduce((count, event) => {
        const payload = recordFromUnknown(event.payload);
        const intents = payload?.["intents"];
        return count + (Array.isArray(intents) ? intents.length : 1);
      }, 0),
    approvalDecisionCount: events.filter((event) => event.type === "approval.decision.recorded").length,
    applyPlanCount: latestApplyPlans.size,
    childRunCount: events.filter((event) => event.type === "run.child_created").length,
    applyOutcomeCounts,
    staleIntentCount: applyOutcomeCounts.stale
  };
}

function aggregateMetrics(input: {
  scope: OpenTagAggregateMetrics["scope"];
  scopeId: string;
  runs: OpenTagRunMetrics[];
}): OpenTagAggregateMetrics {
  const applyOutcomeCounts = emptyApplyOutcomeCounts();
  for (const run of input.runs) {
    applyOutcomeCounts.applied += run.applyOutcomeCounts.applied;
    applyOutcomeCounts.skipped += run.applyOutcomeCounts.skipped;
    applyOutcomeCounts.failed += run.applyOutcomeCounts.failed;
    applyOutcomeCounts.stale += run.applyOutcomeCounts.stale;
    applyOutcomeCounts.unsupported += run.applyOutcomeCounts.unsupported;
  }
  const auditEventCount = input.runs.reduce((sum, run) => sum + run.auditEventCount, 0);
  const humanCallbackCount = input.runs.reduce((sum, run) => sum + run.humanCallbackCount, 0);
  return {
    scope: input.scope,
    scopeId: input.scopeId,
    runCount: input.runs.length,
    totalEventCount: input.runs.reduce((sum, run) => sum + run.totalEventCount, 0),
    humanEventCount: input.runs.reduce((sum, run) => sum + run.humanEventCount, 0),
    auditEventCount,
    debugEventCount: input.runs.reduce((sum, run) => sum + run.debugEventCount, 0),
    humanCallbackCount,
    threadNoiseRatio: auditEventCount === 0 ? humanCallbackCount : humanCallbackCount / auditEventCount,
    suggestedChangesCount: input.runs.reduce((sum, run) => sum + run.suggestedChangesCount, 0),
    approvalDecisionCount: input.runs.reduce((sum, run) => sum + run.approvalDecisionCount, 0),
    applyPlanCount: input.runs.reduce((sum, run) => sum + run.applyPlanCount, 0),
    childRunCount: input.runs.reduce((sum, run) => sum + run.childRunCount, 0),
    applyOutcomeCounts,
    staleIntentCount: input.runs.reduce((sum, run) => sum + run.staleIntentCount, 0)
  };
}

export function createOpenTagRepository(db: BetterSQLite3Database) {
  function activeAttemptLease(input: AttemptLease):
    | { outcome: "active"; run: typeof runs.$inferSelect; attempt: typeof attempts.$inferSelect }
    | { outcome: "stale_attempt" | "not_found" } {
    const run = db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
    if (!run) return { outcome: "not_found" };
    if (run.currentAttemptId !== input.attemptId || run.assignedRunnerId !== input.runnerId) {
      return { outcome: "stale_attempt" };
    }
    const attempt = db.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
    if (
      !attempt ||
      attempt.runId !== input.runId ||
      attempt.runnerId !== input.runnerId ||
      attempt.fencingToken !== input.fencingToken ||
      (attempt.status !== "assigned" && attempt.status !== "running")
    ) {
      return { outcome: "stale_attempt" };
    }
    return { outcome: "active", run, attempt };
  }

  async function repoBindingRunnerId(projectTarget: ProjectTargetRef | null): Promise<string | null> {
    if (!projectTarget) return null;
    const row = await db
      .select()
      .from(repoBindings)
      .where(
        and(
          eq(repoBindings.provider, projectTarget.provider),
          eq(repoBindings.owner, projectTarget.owner),
          eq(repoBindings.repo, projectTarget.repo)
        )
      )
      .limit(1)
      .get();
    return row?.runnerId ?? null;
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

  async function appendRunEvent(input: Parameters<typeof runEventValues>[0]): Promise<void> {
    await db.insert(runEvents).values(runEventValues(input));
  }

  async function recordCreateRunReplay(input: {
    runRow: typeof runs.$inferSelect;
    requestedRunId: string;
    event: OpenTagEvent;
    projectTarget: ProjectTargetRef | null;
    expectedRunnerId: string | null;
    replayKind: "source_event" | "source_delivery";
    sourceDeliveryId?: string | null;
    createdAt: string;
  }): Promise<Extract<CreateRunResult, { created: false }>> {
    const reason =
      input.replayKind === "source_delivery"
        ? "Source delivery already created a run."
        : "Source event already created a run.";
    const reasonCode = input.replayKind === "source_delivery" ? "duplicate_source_delivery" : "duplicate_source_event";
    const replayDecision = RunAdmissionDecisionSchema.parse({
      action: "drop_duplicate",
      reason,
      reasonCode,
      decidedAt: input.createdAt,
      activeRunId: input.runRow.id,
      eventId: input.event.id
    });
    await appendRunEvent({
      runId: input.runRow.id,
      type: "admission.decided",
      payload: replayDecision,
      visibility: "audit",
      importance: "normal",
      message: replayDecision.reason,
      createdAt: input.createdAt
    });
    await appendRunEvent({
      runId: input.runRow.id,
      type: "run.create_idempotent_replay",
      payload: {
        requestedRunId: input.requestedRunId,
        eventId: input.event.id,
        replayKey:
          input.replayKind === "source_delivery"
            ? { kind: "source_delivery", source: input.event.source, deliveryId: input.sourceDeliveryId }
            : { kind: "source_event", eventId: input.event.id },
        provenance: runProvenance({
          event: input.event,
          projectTarget: input.projectTarget,
          admissionDecision: replayDecision,
          expectedRunnerId: input.expectedRunnerId
        })
      },
      visibility: "audit",
      importance: "low",
      createdAt: input.createdAt
    });
    return {
      run: runFromRow(input.runRow),
      created: false,
      replayKind: input.replayKind,
      replayDecision
    };
  }

  type CreateApplyPlanInput = {
    id: string;
    proposalId: string;
    approvalDecisionId: string;
    selectedIntentIds?: string[];
    adapter?: string;
    policyRules?: PolicyRule[];
  };

  async function buildApplyPlan(input: CreateApplyPlanInput): Promise<{ plan: ApplyPlan; runId: string; createdAt: string } | null> {
    const storedProposalRow = await db
      .select()
      .from(suggestedChanges)
      .where(eq(suggestedChanges.proposalId, input.proposalId))
      .limit(1)
      .get();
    const decisionRow = await db
      .select()
      .from(approvalDecisions)
      .where(eq(approvalDecisions.id, input.approvalDecisionId))
      .limit(1)
      .get();
    const decision = decisionRow ? ApprovalDecisionSchema.parse(JSON.parse(decisionRow.decisionJson)) : null;
    if (!storedProposalRow || !decision || decision.proposalId !== input.proposalId) return null;
    const storedProposal = {
      runId: storedProposalRow.runId,
      snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(storedProposalRow.snapshotJson))
    };

    const runRow = await db.select().from(runs).where(eq(runs.id, storedProposal.runId)).limit(1).get();
    if (!runRow) return null;
    const event = OpenTagEventSchema.parse(JSON.parse(runRow.eventJson));
    const repoKey = projectTargetRefFromEvent(event);
    const storedPolicyRuleRows = repoKey
      ? await db
          .select()
          .from(repoPolicyRules)
          .where(and(eq(repoPolicyRules.provider, repoKey.provider), eq(repoPolicyRules.owner, repoKey.owner), eq(repoPolicyRules.repo, repoKey.repo)))
          .orderBy(asc(repoPolicyRules.createdAt))
      : [];
    const storedPolicyRules = storedPolicyRuleRows.map((row) => PolicyRuleSchema.parse(JSON.parse(row.ruleJson)));
    const storedMappingRows = repoKey
      ? await db
          .select()
          .from(repoMutationMappings)
          .where(
            and(
              eq(repoMutationMappings.provider, repoKey.provider),
              eq(repoMutationMappings.owner, repoKey.owner),
              eq(repoMutationMappings.repo, repoKey.repo)
            )
          )
          .orderBy(asc(repoMutationMappings.createdAt))
      : [];
    const storedMappings = storedMappingRows.map((row) => AdapterMutationMappingSchema.parse(JSON.parse(row.mappingJson)));
    const selectedIntentIds = input.selectedIntentIds ?? decision.approvedIntentIds;
    const approvedIntentIds = new Set(decision.approvedIntentIds);
    const proposalIntents = new Map(storedProposal.snapshot.intents.map((intent) => [intent.intentId, intent]));
    const lineageRows = await db.select().from(suggestedChanges).orderBy(asc(suggestedChanges.createdAt));
    const lineage = computeProposalLineage(
      lineageRows.map((row) => ({
        runId: row.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
      })),
      lineageScopeKey(storedProposal)
    );
    const actionabilityByIntentId = new Map(lineage.entries.map((entry) => [entry.intentId, entry]));
    const policyRules = [...storedPolicyRules, ...(input.policyRules ?? []), ...syntheticManualApprovalPolicyRules(decision)];

    const outcomes = selectedIntentIds.map((intentId) => {
      if (!approvedIntentIds.has(intentId)) {
        return {
          intentId,
          outcome: "skipped" as const,
          message: "Intent was not approved by the approval decision."
        };
      }
      const intent = proposalIntents.get(intentId);
      if (!intent) {
        return {
          intentId,
          outcome: "failed" as const,
          message: "Intent does not exist on the referenced proposal."
        };
      }
      const actionability = actionabilityByIntentId.get(intentId);
      if (actionability?.status !== "current") {
        return {
          intentId,
          outcome: "stale" as const,
          message: actionability?.reason ?? "Intent is no longer current for its mutation domain."
        };
      }
      return preflightMutationIntent({
        intent,
        permissions: event.permissions,
        policyRules,
        executorConditions: executorConditionsFromIntent(intent),
        ...(input.adapter ? { adapter: input.adapter } : {})
      }).outcome;
    });

    return {
      runId: storedProposal.runId,
      createdAt: nowIso(),
      plan: ApplyPlanSchema.parse({
        id: input.id,
        proposalId: input.proposalId,
        approvalDecisionId: input.approvalDecisionId,
        selectedIntentIds,
        ...(input.adapter ? { adapter: input.adapter } : {}),
        adapterPlan: {
          semantics: "preflight first, then per-intent outcome",
          externalWritesExecuted: false,
          mappings: storedMappings
        },
        outcomes
      })
    };
  }

  function applyPlanCreatedEventRow(input: { runId: string; plan: ApplyPlan; createdAt: string }): typeof runEvents.$inferInsert {
    return {
      runId: input.runId,
      type: "apply_plan.created",
      visibility: "audit",
      importance: "high",
      message: `Created apply plan for ${input.plan.selectedIntentIds.length} intent(s).`,
      payloadJson: JSON.stringify(input.plan),
      createdAt: input.createdAt
    };
  }

  async function appendApplyPlanCreatedEvent(input: { runId: string; plan: ApplyPlan; createdAt: string }): Promise<void> {
    await db.insert(runEvents).values(applyPlanCreatedEventRow(input));
  }

  return {
    appendRunEvent,

    async getRunByEventId(input: { eventId: string }): Promise<{ run: OpenTagRun; event: OpenTagEvent } | null> {
      const row = await db.select().from(runs).where(eq(runs.eventId, input.eventId)).limit(1).get();
      if (!row) return null;
      return {
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      };
    },

    async findActiveRunForConversation(input: { conversationKey: string }): Promise<{ run: OpenTagRun; event: OpenTagEvent } | null> {
      const rows = await db
        .select()
        .from(runs)
        .where(and(eq(runs.conversationKey, input.conversationKey), inArray(runs.status, ["assigned", "running", "needs_approval"])))
        .orderBy(asc(runs.createdAt));
      // A permission wait keeps its attempt attached so the runtime can heartbeat
      // and resume it. A completed needs_human run clears the attempt and must not
      // block later work in the same conversation.
      const row = rows.find((candidate) => candidate.status !== "needs_approval" || candidate.currentAttemptId !== null);
      if (!row) return null;
      return {
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      };
    },

    async findCancelableRunForConversation(input: { conversationKeys: string[] }): Promise<{ run: OpenTagRun; event: OpenTagEvent } | null> {
      const keys = [...new Set(input.conversationKeys.filter((key) => key.length > 0))];
      if (keys.length === 0) return null;
      const rows = await db
        .select()
        .from(runs)
        .where(and(inArray(runs.conversationKey, keys), inArray(runs.status, ["queued", "assigned", "running", "needs_approval"])))
        .orderBy(asc(runs.createdAt));
      // A run parked in needs_approval can sit in the conversation indefinitely; the run
      // that is actually executing (or about to) is the one status/stop should target.
      const row = rows.find((candidate) => candidate.status !== "needs_approval") ?? rows[0];
      if (!row) return null;
      return {
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      };
    },

    async findCancelableRunForSourceContainer(input: {
      source: string;
      repoProvider?: string;
      owner?: string;
      repo?: string;
      metadata: Record<string, string>;
    }): Promise<{ run: OpenTagRun; event: OpenTagEvent } | null> {
      const targetFields = [input.repoProvider, input.owner, input.repo];
      const targetFieldCount = targetFields.filter((value) => value !== undefined).length;
      if (targetFieldCount !== 0 && targetFieldCount !== 3) {
        throw new Error("Cancelable source-container lookup repository fields must be provided together.");
      }
      const activeStatus = inArray(runs.status, ["queued", "assigned", "running", "needs_approval"]);
      const rows = input.repoProvider && input.owner && input.repo
        ? await db
            .select()
            .from(runs)
            .where(
              and(
                eq(runs.repoProvider, input.repoProvider),
                eq(runs.repoOwner, input.owner),
                eq(runs.repoName, input.repo),
                activeStatus
              )
            )
            .orderBy(asc(runs.createdAt))
        : await db.select().from(runs).where(activeStatus).orderBy(asc(runs.createdAt));
      for (const row of rows) {
        const event = OpenTagEventSchema.parse(JSON.parse(row.eventJson));
        if (sourceContainerMetadataMatches({ event, source: input.source, metadata: input.metadata })) {
          return { run: runFromRow(row), event };
        }
      }
      return null;
    },

    async cancelRun(input: { runId: string; reason?: string; requestedBy?: string }): Promise<CancelRunOutcome> {
      const row = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      if (!row) return { outcome: "not_found" };
      const event = OpenTagEventSchema.parse(JSON.parse(row.eventJson));
      const existingRun = runFromRow(row);
      if (terminalRunStatus(row.status)) {
        return { outcome: "already_terminal", run: existingRun, event };
      }

      const updatedAt = nowIso();
      const result: OpenTagRunResult = {
        conclusion: "cancelled",
        summary: input.reason ?? "Cancellation was requested by a human.",
        nextAction: "OpenTag will not treat this stop request as a successful completion."
      };
      db.transaction((tx) => {
        const current = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        if (!current || terminalRunStatus(current.status)) return;
        if (current.currentAttemptId) {
          tx.update(attempts)
            .set({ status: "cancelled", finishedAt: updatedAt, resultJson: JSON.stringify(result), updatedAt })
            .where(eq(attempts.id, current.currentAttemptId))
            .run();
        }
        tx.update(runs)
          .set({
            status: "cancelled",
            resultJson: JSON.stringify(result),
            assignedRunnerId: null,
            leasedAt: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            currentAttemptId: null,
            updatedAt
          })
          .where(eq(runs.id, input.runId))
          .run();
      });
      await appendRunEvent({
        runId: input.runId,
        type: "run.cancel_requested",
        payload: {
          previousStatus: row.status,
          previousRunnerId: row.assignedRunnerId,
          terminalReason: "cancelled_by_user",
          terminalSemantics: "A human stop request is not a successful completion and does not auto-promote queued follow-ups.",
          ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
          reason: result.summary
        },
        visibility: "audit",
        importance: "high",
        message: result.summary,
        createdAt: updatedAt
      });
      return {
        outcome: "cancelled",
        run: {
          ...existingRun,
          status: "cancelled",
          assignedRunnerId: undefined,
          updatedAt,
          result
        },
        event
      };
    },

    async createFollowUpRequest(input: {
      id: string;
      event: OpenTagEvent;
      decision: RunAdmissionDecision;
      activeRunId?: string;
    }): Promise<{ followUpRequest: FollowUpRequest; created: boolean }> {
      const event = OpenTagEventSchema.parse(input.event);
      const decision = RunAdmissionDecisionSchema.parse(input.decision);
      const createdAt = nowIso();
      const conversationKey = conversationKeyFromEvent(event);
      const insertResult = await db
        .insert(followUpRequests)
        .values({
          id: input.id,
          sourceEventId: event.id,
          conversationKey,
          activeRunId: input.activeRunId ?? null,
          eventJson: JSON.stringify(event),
          decisionJson: JSON.stringify(decision),
          status: "queued",
          createdRunId: null,
          createdAt,
          updatedAt: createdAt
        })
        .onConflictDoNothing({ target: followUpRequests.sourceEventId });
      if (insertResult.changes === 0) {
        const existing = await db.select().from(followUpRequests).where(eq(followUpRequests.sourceEventId, event.id)).limit(1).get();
        if (!existing) {
          throw new Error(`Follow-up request already exists for event ${event.id}, but it could not be loaded`);
        }
        return { followUpRequest: followUpRequestFromRow(existing), created: false };
      }
      const created = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.id)).limit(1).get();
      if (!created) {
        throw new Error(`Follow-up request ${input.id} was created but could not be loaded`);
      }
      return { followUpRequest: followUpRequestFromRow(created), created: true };
    },

    async getFollowUpRequest(input: { id: string }): Promise<FollowUpRequest | null> {
      const row = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.id)).limit(1).get();
      return row ? followUpRequestFromRow(row) : null;
    },

    async listQueuedFollowUpsForActiveRun(input: { activeRunId: string }): Promise<FollowUpRequest[]> {
      const rows = await db
        .select()
        .from(followUpRequests)
        .where(and(eq(followUpRequests.activeRunId, input.activeRunId), eq(followUpRequests.status, "queued")))
        .orderBy(asc(followUpRequests.createdAt));
      return rows.map(followUpRequestFromRow);
    },

    async createRunFromFollowUpRequest(input: { followUpRequestId: string; runId: string }): Promise<{ followUpRequest: FollowUpRequest; run: OpenTagRun }> {
      const row = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.followUpRequestId)).limit(1).get();
      if (!row) {
        throw new Error(`Follow-up request not found: ${input.followUpRequestId}`);
      }
      if (row.status !== "queued") {
        throw new Error(`Follow-up request ${input.followUpRequestId} is not queued.`);
      }
      const updatedAt = nowIso();
      const promoteResult = await db
        .update(followUpRequests)
        .set({
          status: "promoting",
          updatedAt
        })
        .where(and(eq(followUpRequests.id, input.followUpRequestId), eq(followUpRequests.status, "queued")));
      if (promoteResult.changes === 0) {
        throw new Error(`Follow-up request ${input.followUpRequestId} is not queued.`);
      }
      const followUp = followUpRequestFromRow({ ...row, status: "promoting", updatedAt });
      try {
        const { run, created } = await this.createRun({
          id: input.runId,
          event: followUp.event,
          ...(followUp.activeRunId ? { parentRunId: followUp.activeRunId } : {})
        });
        if (!created) {
          throw new Error(`Run already exists for follow-up request ${input.followUpRequestId}.`);
        }
        await db
          .update(followUpRequests)
          .set({
            status: "promoted",
            createdRunId: run.id,
            updatedAt
          })
          .where(eq(followUpRequests.id, input.followUpRequestId));
        const updated = await db.select().from(followUpRequests).where(eq(followUpRequests.id, input.followUpRequestId)).limit(1).get();
        if (!updated) {
          throw new Error(`Follow-up request ${input.followUpRequestId} was promoted but could not be loaded`);
        }
        if (followUp.activeRunId) {
          await appendRunEvent({
            runId: followUp.activeRunId,
            type: "follow_up_request.promoted",
            payload: { followUpRequestId: followUp.id, createdRunId: run.id, sourceEventId: followUp.sourceEventId },
            visibility: "audit",
            importance: "normal",
            createdAt: updatedAt
          });
        }
        return { followUpRequest: followUpRequestFromRow(updated), run };
      } catch (error) {
        await db
          .update(followUpRequests)
          .set({
            status: "queued",
            updatedAt: nowIso()
          })
          .where(and(eq(followUpRequests.id, input.followUpRequestId), eq(followUpRequests.status, "promoting")));
        throw error;
      }
    },

    async registerRunner(input: { runnerId: string; name: string }): Promise<void> {
      const createdAt = nowIso();
      await db
        .insert(runners)
        .values({ runnerId: input.runnerId, name: input.name, createdAt, heartbeatAt: createdAt })
        .onConflictDoUpdate({
          target: runners.runnerId,
          set: {
            name: input.name,
            heartbeatAt: createdAt
          }
        });
    },

    async getRunner(input: { runnerId: string }): Promise<RunnerRegistration | null> {
      const row = await db.select().from(runners).where(eq(runners.runnerId, input.runnerId)).limit(1).get();
      return row ? runnerFromRow(row) : null;
    },

    async createRepoBinding(input: {
      provider: string;
      owner: string;
      repo: string;
      runnerId: string;
      workspacePath?: string;
      defaultExecutor?: string;
      allowedActors?: string[];
    }): Promise<void> {
      await db
        .insert(repoBindings)
        .values({
          ...input,
          workspacePath: input.workspacePath ?? null,
          defaultExecutor: input.defaultExecutor ?? null,
          allowedActorsJson: input.allowedActors ? JSON.stringify(input.allowedActors) : null,
          createdAt: nowIso()
        })
        .onConflictDoUpdate({
          target: [repoBindings.provider, repoBindings.owner, repoBindings.repo],
          set: {
            runnerId: input.runnerId,
            workspacePath: input.workspacePath ?? null,
            defaultExecutor: input.defaultExecutor ?? null,
            allowedActorsJson: input.allowedActors ? JSON.stringify(input.allowedActors) : null
          }
        });
    },

    async upsertRepoPolicyRule(input: { provider: string; owner: string; repo: string; rule: PolicyRule }): Promise<PolicyRule> {
      const rule = PolicyRuleSchema.parse(input.rule);
      const createdAt = nowIso();
      await db
        .insert(repoPolicyRules)
        .values({
          id: rule.id,
          provider: input.provider,
          owner: input.owner,
          repo: input.repo,
          ruleJson: JSON.stringify(rule),
          createdAt
        })
        .onConflictDoUpdate({
          target: [repoPolicyRules.provider, repoPolicyRules.owner, repoPolicyRules.repo, repoPolicyRules.id],
          set: {
            ruleJson: JSON.stringify(rule),
            createdAt
          }
        });
      return rule;
    },

    async listRepoPolicyRules(input: { provider: string; owner: string; repo: string }): Promise<PolicyRule[]> {
      const rows = await db
        .select()
        .from(repoPolicyRules)
        .where(and(eq(repoPolicyRules.provider, input.provider), eq(repoPolicyRules.owner, input.owner), eq(repoPolicyRules.repo, input.repo)))
        .orderBy(asc(repoPolicyRules.createdAt));
      return rows.map((row) => PolicyRuleSchema.parse(JSON.parse(row.ruleJson)));
    },

    async upsertRepoMutationMapping(input: {
      provider: string;
      owner: string;
      repo: string;
      mapping: AdapterMutationMapping;
    }): Promise<AdapterMutationMapping> {
      const mapping = AdapterMutationMappingSchema.parse(input.mapping);
      const createdAt = nowIso();
      await db
        .insert(repoMutationMappings)
        .values({
          id: mapping.id,
          provider: input.provider,
          owner: input.owner,
          repo: input.repo,
          mappingJson: JSON.stringify(mapping),
          createdAt
        })
        .onConflictDoUpdate({
          target: [repoMutationMappings.provider, repoMutationMappings.owner, repoMutationMappings.repo, repoMutationMappings.id],
          set: {
            mappingJson: JSON.stringify(mapping),
            createdAt
          }
        });
      return mapping;
    },

    async listRepoMutationMappings(input: { provider: string; owner: string; repo: string }): Promise<AdapterMutationMapping[]> {
      const rows = await db
        .select()
        .from(repoMutationMappings)
        .where(and(eq(repoMutationMappings.provider, input.provider), eq(repoMutationMappings.owner, input.owner), eq(repoMutationMappings.repo, input.repo)))
        .orderBy(asc(repoMutationMappings.createdAt));
      return rows.map((row) => AdapterMutationMappingSchema.parse(JSON.parse(row.mappingJson)));
    },

    async upsertLinearRelayInstallation(input: {
      id: string;
      webhookPath: string;
      webhookSecret: string;
      token: string;
      auth?: LinearRelayInstallationAuth;
      graphqlUrl?: string;
      repoProvider: string;
      owner: string;
      repo: string;
      organizationId?: string;
      teamId?: string;
      teamKey?: string;
    }): Promise<LinearRelayInstallation> {
      const createdAt = nowIso();
      const authJson = input.auth ? JSON.stringify(input.auth) : null;
      await db
        .insert(linearRelayInstallations)
        .values({
          id: input.id,
          webhookPath: input.webhookPath,
          webhookSecret: input.webhookSecret,
          token: input.token,
          authJson,
          graphqlUrl: input.graphqlUrl ?? null,
          repoProvider: input.repoProvider,
          owner: input.owner,
          repo: input.repo,
          organizationId: input.organizationId ?? null,
          teamId: input.teamId ?? null,
          teamKey: input.teamKey ?? null,
          createdAt,
          updatedAt: createdAt
        })
        .onConflictDoUpdate({
          target: linearRelayInstallations.id,
          set: {
            webhookPath: input.webhookPath,
            webhookSecret: input.webhookSecret,
            token: input.token,
            authJson,
            graphqlUrl: input.graphqlUrl ?? null,
            repoProvider: input.repoProvider,
            owner: input.owner,
            repo: input.repo,
            organizationId: input.organizationId ?? null,
            teamId: input.teamId ?? null,
            teamKey: input.teamKey ?? null,
            updatedAt: createdAt
          }
        });
      const [row] = await db.select().from(linearRelayInstallations).where(eq(linearRelayInstallations.id, input.id)).limit(1);
      if (!row) {
        throw new Error(`Linear relay installation ${input.id} was not stored.`);
      }
      return linearRelayInstallationFromRow(row);
    },

    async getLinearRelayInstallation(input: { id: string }): Promise<LinearRelayInstallation | null> {
      const [row] = await db.select().from(linearRelayInstallations).where(eq(linearRelayInstallations.id, input.id)).limit(1);
      return row ? linearRelayInstallationFromRow(row) : null;
    },

    async getLinearRelayInstallationByOrganizationId(input: { organizationId: string }): Promise<LinearRelayInstallation | null> {
      const [row] = await db
        .select()
        .from(linearRelayInstallations)
        .where(eq(linearRelayInstallations.organizationId, input.organizationId))
        .limit(1);
      return row ? linearRelayInstallationFromRow(row) : null;
    },

    async getLinearRelayInstallationByWebhookPath(input: { webhookPath: string }): Promise<LinearRelayInstallation | null> {
      const [row] = await db
        .select()
        .from(linearRelayInstallations)
        .where(eq(linearRelayInstallations.webhookPath, input.webhookPath))
        .limit(1);
      return row ? linearRelayInstallationFromRow(row) : null;
    },

    async deleteLinearRelayInstallation(input: { id: string }): Promise<boolean> {
      const result = await db.delete(linearRelayInstallations).where(eq(linearRelayInstallations.id, input.id));
      return result.changes > 0;
    },

    async createLinearOAuthInstallState(input: {
      state: string;
      installationId: string;
      webhookPath: string;
      webhookSecret: string;
      redirectUri: string;
      graphqlUrl?: string;
      repoProvider: string;
      owner: string;
      repo: string;
      teamId?: string;
      teamKey?: string;
      scopes: string[];
      expiresAt: string;
    }): Promise<LinearOAuthInstallState> {
      const createdAt = nowIso();
      await db
        .insert(linearOAuthInstallStates)
        .values({
          state: input.state,
          installationId: input.installationId,
          webhookPath: input.webhookPath,
          webhookSecret: input.webhookSecret,
          redirectUri: input.redirectUri,
          graphqlUrl: input.graphqlUrl ?? null,
          repoProvider: input.repoProvider,
          owner: input.owner,
          repo: input.repo,
          teamId: input.teamId ?? null,
          teamKey: input.teamKey ?? null,
          scopesJson: JSON.stringify(input.scopes),
          createdAt,
          expiresAt: input.expiresAt,
          completedAt: null
        })
        .onConflictDoUpdate({
          target: linearOAuthInstallStates.state,
          set: {
            installationId: input.installationId,
            webhookPath: input.webhookPath,
            webhookSecret: input.webhookSecret,
            redirectUri: input.redirectUri,
            graphqlUrl: input.graphqlUrl ?? null,
            repoProvider: input.repoProvider,
            owner: input.owner,
            repo: input.repo,
            teamId: input.teamId ?? null,
            teamKey: input.teamKey ?? null,
            scopesJson: JSON.stringify(input.scopes),
            createdAt,
            expiresAt: input.expiresAt,
            completedAt: null
          }
        });
      const [row] = await db.select().from(linearOAuthInstallStates).where(eq(linearOAuthInstallStates.state, input.state)).limit(1);
      if (!row) {
        throw new Error(`Linear OAuth install state ${input.state} was not stored.`);
      }
      return linearOAuthInstallStateFromRow(row);
    },

    async getLinearOAuthInstallState(input: { state: string }): Promise<LinearOAuthInstallState | null> {
      const [row] = await db.select().from(linearOAuthInstallStates).where(eq(linearOAuthInstallStates.state, input.state)).limit(1);
      return row ? linearOAuthInstallStateFromRow(row) : null;
    },

    async completeLinearOAuthInstallState(input: { state: string; completedAt?: string }): Promise<void> {
      await db
        .update(linearOAuthInstallStates)
        .set({ completedAt: input.completedAt ?? nowIso() })
        .where(eq(linearOAuthInstallStates.state, input.state));
    },

    async upsertChannelBinding(input: ChannelBinding): Promise<void> {
      const repositoryFields = channelBindingRepositoryFields(input);
      await db
        .insert(channelBindings)
        .values({
          provider: input.provider,
          accountId: input.accountId,
          conversationId: input.conversationId,
          ...repositoryFields,
          metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
          createdAt: nowIso()
        })
        .onConflictDoUpdate({
          target: [channelBindings.provider, channelBindings.accountId, channelBindings.conversationId],
          set: {
            ...repositoryFields,
            metadataJson: input.metadata ? JSON.stringify(input.metadata) : null
          }
        });
    },

    async deleteChannelBinding(input: {
      provider: string;
      accountId: string;
      conversationId: string;
    }): Promise<boolean> {
      const existing = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.provider, input.provider),
            eq(channelBindings.accountId, input.accountId),
            eq(channelBindings.conversationId, input.conversationId)
          )
        )
        .limit(1)
        .get();
      if (!existing) return false;
      await db
        .delete(channelBindings)
        .where(
          and(
            eq(channelBindings.provider, input.provider),
            eq(channelBindings.accountId, input.accountId),
            eq(channelBindings.conversationId, input.conversationId)
          )
        );
      return true;
    },

    async createSlackChannelBinding(input: SlackChannelBinding): Promise<void> {
      const repoProvider = input.repoProvider ?? "github";
      await db
        .insert(channelBindings)
        .values({
          provider: "slack",
          accountId: input.teamId,
          conversationId: input.channelId,
          repoProvider,
          owner: input.owner,
          repo: input.repo,
          metadataJson: null,
          createdAt: nowIso()
        })
        .onConflictDoUpdate({
          target: [channelBindings.provider, channelBindings.accountId, channelBindings.conversationId],
          set: {
            repoProvider,
            owner: input.owner,
            repo: input.repo
          }
        });
    },

    async createRun(input: {
      id: string;
      event: OpenTagEvent;
      parentRunId?: string;
      triggeredByAction?: ActionHint;
      sourceProposalId?: string;
      sourceApplyPlanId?: string;
    }): Promise<CreateRunResult> {
      const event = OpenTagEventSchema.parse(input.event);
      const triggeredByAction = input.triggeredByAction ? ActionHintSchema.parse(input.triggeredByAction) : undefined;
      const createdAt = nowIso();
      const protocolFields = protocolRunFieldsFromEvent(event, createdAt);
      const repoKey = projectTargetRefFromEvent(event);
      const expectedRunnerId = await repoBindingRunnerId(repoKey);
      const sourceDeliveryId = sourceDeliveryIdFromEvent(event);
      if (sourceDeliveryId) {
        const existingDelivery = await db
          .select()
          .from(sourceDeliveries)
          .where(and(eq(sourceDeliveries.source, event.source), eq(sourceDeliveries.deliveryId, sourceDeliveryId)))
          .limit(1)
          .get();
        if (existingDelivery) {
          const existingByDelivery = await db.select().from(runs).where(eq(runs.id, existingDelivery.runId)).limit(1).get();
          if (existingByDelivery) {
            return recordCreateRunReplay({
              runRow: existingByDelivery,
              requestedRunId: input.id,
              event,
              projectTarget: repoKey,
              expectedRunnerId,
              replayKind: "source_delivery",
              sourceDeliveryId,
              createdAt
            });
          }
        }
      }
      const insertResult = await db
        .insert(runs)
        .values({
        id: input.id,
        eventId: event.id,
        status: "queued",
        eventJson: JSON.stringify(event),
        contextPacketJson: JSON.stringify(protocolFields.contextPacket),
        parentRunId: input.parentRunId ?? null,
        triggeredByActionJson: triggeredByAction ? JSON.stringify(triggeredByAction) : null,
        sourceProposalId: input.sourceProposalId ?? null,
        sourceApplyPlanId: input.sourceApplyPlanId ?? null,
        repoProvider: repoKey?.provider ?? null,
        repoOwner: repoKey?.owner ?? null,
        repoName: repoKey?.repo ?? null,
        workThreadId: protocolFields.thread?.id ?? null,
        conversationKey: conversationKeyFromEvent(event),
        createdAt,
        updatedAt: createdAt
        })
        .onConflictDoNothing({ target: runs.eventId });
      if (insertResult.changes === 0) {
        const existingBySourceEvent = await db.select().from(runs).where(eq(runs.eventId, event.id)).limit(1).get();
        if (!existingBySourceEvent) {
          throw new Error(`Run already exists for event ${event.id}, but it could not be loaded`);
        }
        return recordCreateRunReplay({
          runRow: existingBySourceEvent,
          requestedRunId: input.id,
          event,
          projectTarget: repoKey,
          expectedRunnerId,
          replayKind: "source_event",
          sourceDeliveryId,
          createdAt
        });
      }
      const createDecision = RunAdmissionDecisionSchema.parse({
        action: "start",
        reason: "Source event accepted and ready to create a run.",
        reasonCode: "new_event",
        decidedAt: createdAt,
        eventId: event.id
      });
      if (sourceDeliveryId) {
        await db
          .insert(sourceDeliveries)
          .values({
            source: event.source,
            deliveryId: sourceDeliveryId,
            runId: input.id,
            eventId: event.id,
            createdAt
          })
          .onConflictDoNothing({ target: [sourceDeliveries.source, sourceDeliveries.deliveryId] });
      }
      await appendRunEvent({
        runId: input.id,
        type: "admission.decided",
        payload: createDecision,
        visibility: "audit",
        importance: "normal",
        message: createDecision.reason,
        createdAt
      });
      await appendRunEvent({
        runId: input.id,
        type: "run.created",
        payload: {
          eventId: event.id,
          provenance: runProvenance({
            event,
            projectTarget: repoKey,
            admissionDecision: createDecision,
            expectedRunnerId
          })
        },
        visibility: "audit",
        importance: "low",
        createdAt
      });
      await appendRunEvent({
        runId: input.id,
        type: "context_packet.generated",
        payload: {
          contextPacket: protocolFields.contextPacket,
          ...(protocolFields.thread ? { thread: protocolFields.thread } : {})
        },
        visibility: "audit",
        importance: "normal",
        message: protocolFields.contextPacket.summary,
        createdAt
      });
      if (input.parentRunId) {
        await appendRunEvent({
          runId: input.parentRunId,
          type: "run.child_created",
          payload: {
            childRunId: input.id,
            ...(triggeredByAction ? { triggeredByAction } : {}),
            ...(input.sourceProposalId ? { sourceProposalId: input.sourceProposalId } : {}),
            ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {})
          },
          visibility: "audit",
          importance: "normal",
          message: `Created child run ${input.id}.`,
          createdAt
        });
      }
      return {
        run: {
          id: input.id,
          eventId: event.id,
          status: "queued",
          ...protocolFields,
          ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
          ...(triggeredByAction ? { triggeredByAction } : {}),
          ...(input.sourceProposalId ? { sourceProposalId: input.sourceProposalId } : {}),
          ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {}),
          contextPacket: protocolFields.contextPacket,
          createdAt,
          updatedAt: createdAt
        },
        created: true
      };
    },

    async pruneSourceDeliveries(input: { olderThan: string; limit?: number }): Promise<SourceDeliveryPruneResult> {
      const cutoff = new Date(input.olderThan);
      if (!Number.isFinite(cutoff.getTime())) {
        throw new Error("olderThan must be a valid timestamp.");
      }
      const requestedLimit = input.limit ?? 1_000;
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.floor(requestedLimit)) : 1_000;
      const rows = await db
        .select()
        .from(sourceDeliveries)
        .where(lt(sourceDeliveries.createdAt, cutoff.toISOString()))
        .orderBy(asc(sourceDeliveries.createdAt))
        .limit(limit);

      let pruned = 0;
      let retainedActive = 0;
      for (const row of rows) {
        const runRow = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, row.runId)).limit(1).get();
        if (runRow && !terminalRunStatus(runRow.status)) {
          retainedActive += 1;
          continue;
        }
        const result = await db
          .delete(sourceDeliveries)
          .where(and(eq(sourceDeliveries.source, row.source), eq(sourceDeliveries.deliveryId, row.deliveryId)));
        pruned += result.changes;
      }

      return {
        scanned: rows.length,
        pruned,
        retainedActive
      };
    },

    async claimNextRun(input: { runnerId: string; leaseSeconds: number }): Promise<ClaimedOpenTagRun | null> {
      const now = new Date();
      const runnerHeartbeatAt = nowIso();
      const activeRows = await db
        .select()
        .from(runs)
        .where(inArray(runs.status, ["assigned", "running", "needs_approval"]))
        .orderBy(asc(runs.createdAt));
      for (const activeRow of activeRows) {
        if (!isIsoExpired(activeRow.leaseExpiresAt, now)) continue;
        const updatedAt = nowIso();
        const interrupted = db.transaction((tx) => {
          const current = tx.select().from(runs).where(eq(runs.id, activeRow.id)).limit(1).get();
          if (!current || !isIsoExpired(current.leaseExpiresAt, now) || !["assigned", "running", "needs_approval"].includes(current.status)) {
            return false;
          }
          if (current.currentAttemptId) {
            tx.update(attempts)
              .set({
                status: "interrupted",
                finishedAt: updatedAt,
                resultJson: JSON.stringify({ conclusion: "interrupted", summary: "Attempt lease expired." }),
                updatedAt
              })
              .where(and(eq(attempts.id, current.currentAttemptId), inArray(attempts.status, ["assigned", "running"])))
              .run();
          }
          tx.update(runs)
            .set({
              status: "queued",
              assignedRunnerId: null,
              leasedAt: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              currentAttemptId: null,
              updatedAt
            })
            .where(eq(runs.id, current.id))
            .run();
          tx.insert(runEvents)
            .values(
              runEventValues({
                runId: current.id,
                type: "run.lease_expired",
                payload: {
                  previousRunnerId: current.assignedRunnerId,
                  previousAttemptId: current.currentAttemptId,
                  previousLeaseExpiresAt: current.leaseExpiresAt
                },
                visibility: "audit",
                importance: "normal",
                createdAt: updatedAt
              })
            )
            .run();
          return true;
        });
        if (!interrupted) continue;
      }

      const queuedRows = await db.select().from(runs).where(eq(runs.status, "queued")).orderBy(asc(runs.createdAt));
      const row = queuedRows.find((candidate) => {
        const event = OpenTagEventSchema.parse(JSON.parse(candidate.eventJson));
        const repoKey = projectTargetRefFromEvent(event);
        if (!repoKey) {
          return Boolean(db.select().from(runners).where(eq(runners.runnerId, input.runnerId)).limit(1).get());
        }
        const binding = db
          .select()
          .from(repoBindings)
          .where(
            and(
              eq(repoBindings.provider, repoKey.provider),
              eq(repoBindings.owner, repoKey.owner),
              eq(repoBindings.repo, repoKey.repo),
              eq(repoBindings.runnerId, input.runnerId)
            )
          )
          .limit(1)
          .get();
        return Boolean(binding);
      });
      if (!row) {
        await db.update(runners).set({ heartbeatAt: runnerHeartbeatAt }).where(eq(runners.runnerId, input.runnerId));
        return null;
      }

      const updatedAt = nowIso();
      const leasedAt = updatedAt;
      const leaseExpiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
      const attemptId = newAttemptId();
      const fencingToken = newFencingToken();
      const attemptNumber = db.transaction((tx) => {
        const previous = tx
          .select({ number: attempts.number })
          .from(attempts)
          .where(eq(attempts.runId, row.id))
          .orderBy(desc(attempts.number))
          .limit(1)
          .get();
        const number = (previous?.number ?? 0) + 1;
        const updateResult = tx
          .update(runs)
          .set({
            status: "assigned",
            assignedRunnerId: input.runnerId,
            leasedAt,
            leaseExpiresAt,
            heartbeatAt: leasedAt,
            currentAttemptId: attemptId,
            updatedAt
          })
          .where(and(eq(runs.id, row.id), eq(runs.status, "queued")))
          .run();
        if (updateResult.changes === 0) return null;
        tx.insert(attempts)
          .values({
            id: attemptId,
            runId: row.id,
            number,
            runnerId: input.runnerId,
            fencingToken,
            status: "assigned",
            startedAt: leasedAt,
            heartbeatAt: leasedAt,
            leaseExpiresAt,
            createdAt: leasedAt,
            updatedAt
          })
          .run();
        tx.update(runners).set({ heartbeatAt: runnerHeartbeatAt }).where(eq(runners.runnerId, input.runnerId)).run();
        tx.insert(runEvents)
          .values(
            runEventValues({
              runId: row.id,
              type: "run.claimed",
              payload: { runnerId: input.runnerId, attemptId, attemptNumber: number, leasedAt, leaseExpiresAt },
              visibility: "audit",
              importance: "normal",
              createdAt: updatedAt
            })
          )
          .run();
        return number;
      });
      if (attemptNumber === null) return null;

      return {
        run: {
          ...runFromRow({
            ...row,
            status: "assigned",
            assignedRunnerId: input.runnerId,
            updatedAt
          }),
          status: "assigned",
          assignedRunnerId: input.runnerId,
          updatedAt
        },
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson)),
        attemptId,
        attemptNumber,
        fencingToken
      };
    },

    async getRepoBinding(input: { provider: string; owner: string; repo: string }): Promise<RepoBinding | null> {
      const row = await db
        .select()
        .from(repoBindings)
        .where(
          and(eq(repoBindings.provider, input.provider), eq(repoBindings.owner, input.owner), eq(repoBindings.repo, input.repo))
        )
        .limit(1)
        .get();
      if (!row) return null;
      return {
        provider: row.provider,
        owner: row.owner,
        repo: row.repo,
        runnerId: row.runnerId,
        ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
        ...(row.defaultExecutor ? { defaultExecutor: row.defaultExecutor } : {}),
        ...(row.allowedActorsJson ? { allowedActors: JSON.parse(row.allowedActorsJson) as string[] } : {})
      };
    },

    async getChannelBinding(input: {
      provider: string;
      accountId: string;
      conversationId: string;
    }): Promise<ChannelBinding | null> {
      const row = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.provider, input.provider),
            eq(channelBindings.accountId, input.accountId),
            eq(channelBindings.conversationId, input.conversationId)
          )
        )
        .limit(1)
        .get();
      return row ? channelBindingFromRow(row) : null;
    },

    async getSlackChannelBinding(input: { teamId: string; channelId: string }): Promise<SlackChannelBinding | null> {
      const row = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.provider, "slack"),
            eq(channelBindings.accountId, input.teamId),
            eq(channelBindings.conversationId, input.channelId)
          )
        )
        .limit(1)
        .get();
      if (!row) return null;
      const binding = channelBindingFromRow(row);
      if (!binding.repoProvider || !binding.owner || !binding.repo) return null;
      return {
        teamId: binding.accountId,
        channelId: binding.conversationId,
        repoProvider: binding.repoProvider,
        owner: binding.owner,
        repo: binding.repo
      };
    },

    async heartbeat(input: AttemptLease & { leaseSeconds?: number }): Promise<HeartbeatOutcome> {
      const updatedAt = nowIso();
      const lease = activeAttemptLease(input);
      if (lease.outcome !== "active") return lease.outcome;
      const leaseSeconds = input.leaseSeconds ?? 60;
      const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      const updated = db.transaction((tx) => {
        const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        const currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        if (
          !currentRun ||
          !currentAttempt ||
          currentRun.assignedRunnerId !== input.runnerId ||
          currentRun.currentAttemptId !== input.attemptId ||
          !["assigned", "running", "needs_approval"].includes(currentRun.status) ||
          currentAttempt.runId !== input.runId ||
          currentAttempt.runnerId !== input.runnerId ||
          currentAttempt.fencingToken !== input.fencingToken ||
          (currentAttempt.status !== "assigned" && currentAttempt.status !== "running")
        ) {
          return false;
        }
        tx.update(attempts)
          .set({ heartbeatAt: updatedAt, leaseExpiresAt, updatedAt })
          .where(eq(attempts.id, input.attemptId))
          .run();
        tx.update(runs)
          .set({ heartbeatAt: updatedAt, leaseExpiresAt, updatedAt })
          .where(eq(runs.id, input.runId))
          .run();
        tx.update(runners).set({ heartbeatAt: updatedAt }).where(eq(runners.runnerId, input.runnerId)).run();
        return true;
      });
      if (!updated) return "stale_attempt";
      await appendRunEvent({
        runId: input.runId,
        type: "run.heartbeat",
        payload: { runnerId: input.runnerId, attemptId: input.attemptId, heartbeatAt: updatedAt, leaseExpiresAt },
        visibility: "debug",
        importance: "low",
        createdAt: updatedAt
      });
      return "updated";
    },

    async markRunning(input: {
      runId: string;
      executor: string;
      runnerId?: string;
      attemptId?: string;
      fencingToken?: string;
      executorCapability?: unknown;
      runTimeoutMs?: number;
      idempotencyKey?: string;
    }): Promise<MarkRunningOutcome> {
      const updatedAt = nowIso();
      const conditions = [eq(runs.id, input.runId)];
      if (input.runnerId) {
        if (!input.attemptId || !input.fencingToken) return "stale_attempt";
        const lease = activeAttemptLease({
          runId: input.runId,
          runnerId: input.runnerId,
          attemptId: input.attemptId,
          fencingToken: input.fencingToken
        });
        if (lease.outcome !== "active") return lease.outcome;
        conditions.push(eq(runs.assignedRunnerId, input.runnerId));
        conditions.push(eq(runs.currentAttemptId, input.attemptId));
      }
      if (input.idempotencyKey) {
        const existing = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(desc(runEvents.id)).limit(250);
        for (const event of existing) {
          if (event.type !== "run.running") continue;
          const payload = recordFromJson(event.payloadJson);
          if (payload?.["idempotencyKey"] === input.idempotencyKey) return "duplicate";
        }
      }
      const mutationOutcome =
        input.runnerId && input.attemptId && input.fencingToken
          ? db.transaction((tx) => {
              const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
              const currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId!)).limit(1).get();
              if (
                !currentRun ||
                !currentAttempt ||
                currentRun.assignedRunnerId !== input.runnerId ||
                currentRun.currentAttemptId !== input.attemptId ||
                (currentRun.status !== "assigned" && currentRun.status !== "running") ||
                currentAttempt.runId !== input.runId ||
                currentAttempt.runnerId !== input.runnerId ||
                currentAttempt.fencingToken !== input.fencingToken ||
                (currentAttempt.status !== "assigned" && currentAttempt.status !== "running")
              ) {
                return "stale_attempt" as const;
              }
              tx.update(runs)
                .set({ status: "running", executor: input.executor, updatedAt })
                .where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId!)))
                .run();
              tx.update(attempts)
                .set({ status: "running", heartbeatAt: updatedAt, updatedAt })
                .where(eq(attempts.id, input.attemptId!))
                .run();
              return "running" as const;
            })
          : (await db
              .update(runs)
              .set({ status: "running", executor: input.executor, updatedAt })
              .where(and(...conditions))).changes > 0
            ? ("running" as const)
            : ("not_found" as const);
      if (mutationOutcome !== "running") return mutationOutcome;
      await appendRunEvent({
        runId: input.runId,
        type: "run.running",
        payload: {
          ...(input.runnerId ? { runnerId: input.runnerId } : {}),
          ...(input.attemptId ? { attemptId: input.attemptId } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          executor: input.executor,
          ...(input.runTimeoutMs ? { runTimeoutMs: input.runTimeoutMs } : {})
        },
        visibility: "audit",
        importance: "normal",
        createdAt: updatedAt
      });
      if (input.executorCapability) {
        await appendRunEvent({
          runId: input.runId,
          type: "executor.capability.snapshot",
          payload: {
            executor: input.executor,
            capability: input.executorCapability
          },
          visibility: "audit",
          importance: "normal",
          message: `Executor capability snapshot recorded for ${input.executor}.`,
          createdAt: updatedAt
        });
      }
      return "running";
    },

    async completeRun(input: {
      runId: string;
      result: OpenTagRunResult;
      runnerId?: string;
      attemptId?: string;
      fencingToken?: string;
      idempotencyKey?: string;
    }): Promise<CompleteRunOutcome> {
      const parsedResult = OpenTagRunResultSchema.parse(input.result);
      const updatedAt = nowIso();
      const result = OpenTagRunResultSchema.parse({
        ...parsedResult,
        ...(parsedResult.artifacts?.length
          ? {
              artifacts: parsedResult.artifacts.map((artifact, index) => ({
                ...artifact,
                id: artifact.id ?? `${input.runId}:artifact:${index + 1}`,
                sourceRunId: artifact.sourceRunId ?? input.runId,
                createdAt: artifact.createdAt ?? updatedAt
              }))
            }
          : {})
      });
      const status =
        result.conclusion === "success"
          ? "succeeded"
          : result.conclusion === "cancelled"
            ? "cancelled"
            : result.conclusion === "interrupted"
              ? "interrupted"
              : result.conclusion === "timed_out"
                ? "timed_out"
                : result.conclusion === "needs_human"
                  ? "needs_approval"
                  : "failed";
      const runRow = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      if (!runRow) {
        if (input.runnerId) return "not_found";
        throw new Error(`Run not found: ${input.runId}`);
      }
      if (input.runnerId) {
        if (!input.attemptId || !input.fencingToken) return "stale_attempt";
        const attempt = await db.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
        if (
          !attempt ||
          attempt.runId !== input.runId ||
          attempt.runnerId !== input.runnerId ||
          attempt.fencingToken !== input.fencingToken
        ) {
          return "stale_attempt";
        }
        if (attempt.status !== "assigned" && attempt.status !== "running") {
          return attempt.status === "succeeded" ||
            attempt.status === "failed" ||
            attempt.status === "timed_out" ||
            attempt.status === "needs_human"
            ? "duplicate"
            : "stale_attempt";
        }
        if (runRow.currentAttemptId !== input.attemptId) return "stale_attempt";
        if (runRow.assignedRunnerId !== input.runnerId) return "stale_attempt";
      }
      if (input.idempotencyKey) {
        const existing = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(desc(runEvents.id)).limit(250);
        for (const event of existing) {
          if (event.type !== "run.completed") continue;
          const payload = recordFromJson(event.payloadJson);
          if (payload?.["idempotencyKey"] === input.idempotencyKey) return "duplicate";
        }
      }
      if (terminalRunStatus(runRow.status)) {
        return input.runnerId ? "duplicate" : "not_found";
      }
      const runThread = runRow ? protocolRunFieldsFromEvent(OpenTagEventSchema.parse(JSON.parse(runRow.eventJson)), runRow.createdAt).thread : undefined;
      const attemptId = input.attemptId ?? runRow.currentAttemptId ?? undefined;
      const attemptStatus =
        result.conclusion === "success"
          ? "succeeded"
          : result.conclusion === "cancelled"
            ? "cancelled"
            : result.conclusion === "interrupted"
              ? "interrupted"
              : result.conclusion === "timed_out"
                ? "timed_out"
                : result.conclusion === "needs_human"
                  ? "needs_human"
                  : "failed";
      const parsedSnapshots = (result.suggestedChanges ?? []).map((snapshot) =>
        SuggestedChangesSnapshotSchema.parse({
          ...snapshot,
          sourceRunId: snapshot.sourceRunId ?? input.runId,
          ...(snapshot.workThread || !runThread ? {} : { workThread: runThread })
        })
      );
      const completionEvents: Array<typeof runEvents.$inferInsert> = [
        ...parsedSnapshots.map((snapshot) =>
          runEventValues({
            runId: input.runId,
            type: "proposal.snapshot.created",
            payload: snapshot,
            visibility: "audit",
            importance: "high",
            message: snapshot.summary,
            createdAt: updatedAt
          })
        ),
        ...(result.artifacts ?? []).map((artifact) =>
          runEventValues({
            runId: input.runId,
            type: "artifact.created",
            payload: artifact,
            visibility: "audit",
            importance: "normal",
            message: artifact.summary ?? artifact.title,
            createdAt: updatedAt
          })
        ),
        runEventValues({
          runId: input.runId,
          type: "run.completed",
          payload: {
            ...result,
            ...(attemptId ? { attemptId } : {}),
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
          },
          visibility: "audit",
          importance: "high",
          message: result.summary,
          createdAt: updatedAt
        }),
        ...((result.suggestedChanges?.length ?? 0) > 0 || (result.artifacts?.length ?? 0) > 0
          ? [
              runEventValues({
                runId: input.runId,
                type: "success_metric.observed",
                payload: {
                  metric: "time_to_first_useful_artifact",
                  artifactCount: result.artifacts?.length ?? 0,
                  suggestedChangesCount: result.suggestedChanges?.length ?? 0
                },
                visibility: "audit",
                importance: "normal",
                createdAt: updatedAt
              })
            ]
          : [])
      ];
      const completionOutcome = db.transaction((tx) => {
        const currentRun = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
        if (!currentRun) return input.runnerId ? ("not_found" as const) : ("not_found" as const);
        let currentAttempt: typeof attempts.$inferSelect | undefined;
        if (input.runnerId && input.attemptId && input.fencingToken) {
          currentAttempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
          if (
            !currentAttempt ||
            currentAttempt.runId !== input.runId ||
            currentAttempt.runnerId !== input.runnerId ||
            currentAttempt.fencingToken !== input.fencingToken
          ) {
            return "stale_attempt" as const;
          }
          if (currentAttempt.status !== "assigned" && currentAttempt.status !== "running") {
            return currentAttempt.status === "succeeded" ||
              currentAttempt.status === "failed" ||
              currentAttempt.status === "timed_out" ||
              currentAttempt.status === "needs_human"
              ? ("duplicate" as const)
              : ("stale_attempt" as const);
          }
          if (currentRun.currentAttemptId !== input.attemptId || currentRun.assignedRunnerId !== input.runnerId) {
            return "stale_attempt" as const;
          }
          if (currentRun.status !== "assigned" && currentRun.status !== "running") return "stale_attempt" as const;
        } else if (terminalRunStatus(currentRun.status)) {
          return "not_found" as const;
        }
        tx.update(runs)
          .set({
            status,
            resultJson: JSON.stringify(result),
            assignedRunnerId: null,
            leasedAt: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            currentAttemptId: null,
            updatedAt
          })
          .where(eq(runs.id, input.runId))
          .run();
        if (attemptId) {
          tx.update(attempts)
            .set({ status: attemptStatus, finishedAt: updatedAt, resultJson: JSON.stringify(result), updatedAt })
            .where(eq(attempts.id, attemptId))
            .run();
        }
        for (const snapshot of parsedSnapshots) {
          tx.insert(suggestedChanges)
            .values({
              proposalId: snapshot.proposalId,
              runId: input.runId,
              snapshotJson: JSON.stringify(snapshot),
              createdAt: snapshot.createdAt
            })
            .onConflictDoUpdate({
              target: suggestedChanges.proposalId,
              set: {
                runId: input.runId,
                snapshotJson: JSON.stringify(snapshot),
                createdAt: snapshot.createdAt
              }
            })
            .run();
        }
        for (const event of completionEvents) {
          tx.insert(runEvents).values(event).run();
        }
        return "completed" as const;
      });
      if (completionOutcome !== "completed") return completionOutcome;
      return "completed";
    },

    async requestActionPermission(input: {
      runnerId: string;
      runId: string;
      attemptId: string;
      fencingToken: string;
      request: ActionPermissionRequest;
    }): Promise<ActionPermissionResolution | null> {
      const request = ActionPermissionRequestSchema.parse(input.request);
      const attempt = await db.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
      const run = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      if (
        !attempt || !run || attempt.runId !== input.runId || attempt.runnerId !== input.runnerId ||
        attempt.fencingToken !== input.fencingToken || run.currentAttemptId !== input.attemptId ||
        run.assignedRunnerId !== input.runnerId || !["assigned", "running"].includes(attempt.status)
      ) return null;

      const normalized = normalizeMaterialActionRequest({
        title: request.title,
        ...(request.kind ? { kind: request.kind } : {}),
        permissionScopes: request.permissionScopes
      });
      const semanticKey = stableActionJson({
        runId: input.runId,
        actionFamily: normalized.actionFamily,
        scope: normalized.scope,
        target: normalized.target
      });
      const idempotencyKey = `action:${sha256(semanticKey)}`;
      const existing = await db.select().from(materialActions).where(eq(materialActions.idempotencyKey, idempotencyKey)).limit(1).get();
      if (existing) {
        const action = actionFromRow(existing);
        if (action.status === "succeeded" && action.receipt) {
          return ActionPermissionResolutionSchema.parse({ state: "reconciled", action, decision: "deny", receipt: action.receipt, reason: "Known success reused; the ACP tool must not execute again." });
        }
        if (action.status === "unknown") {
          return ActionPermissionResolutionSchema.parse({ state: "unknown", action, reason: "The provider outcome is unknown and requires human reconciliation." });
        }
        if (action.status === "failed") {
          return ActionPermissionResolutionSchema.parse({ state: "denied", action, decision: "deny", reason: "Known failure is not automatically retried without a new policy decision." });
        }
        return this.resolveActionPermission({
          runnerId: input.runnerId,
          runId: input.runId,
          attemptId: input.attemptId,
          fencingToken: input.fencingToken,
          actionId: action.id
        });
      }

      const storedGrants = await db.select().from(grants).where(eq(grants.runId, input.runId));
      const matchingGrant = storedGrants.some((row) => grantMatchesAction({
        runId: row.runId,
        ...(row.attemptId ? { attemptId: row.attemptId } : {}),
        capability: row.capability,
        resourceScope: JSON.parse(row.resourceScopeJson) as Record<string, unknown>,
        ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
        ...(row.revokedAt ? { revokedAt: row.revokedAt } : {})
      }, { runId: input.runId, attemptId: input.attemptId, action: normalized }));
      const policy = evaluateActionPermission({ mode: request.mode, action: normalized, matchingGrant });
      const createdAt = nowIso();
      const actionId = `action_${sha256(semanticKey).slice(0, 24)}`;
      const proposalId = policy.outcome === "needs_approval" ? `proposal_${actionId}` : undefined;
      const proposalHash = proposalId ? sha256(stableActionJson({ actionId, normalized })) : undefined;
      const status = policy.outcome === "authorized" ? "authorized" : policy.outcome === "blocked" ? "cancelled" : "waiting_approval";
      const inserted = await db.insert(materialActions).values({
        id: actionId,
        runId: input.runId,
        attemptId: input.attemptId,
        actionFamily: normalized.actionFamily,
        capability: normalized.actionFamily,
        scopeJson: JSON.stringify(normalized.scope),
        targetJson: JSON.stringify(normalized.target),
        riskTier: normalized.riskTier,
        status,
        idempotencyKey,
        proposalId: proposalId ?? null,
        proposalHash: proposalHash ?? null,
        decisionSnapshotHash: policy.outcome === "authorized" ? sha256(stableActionJson({ mode: request.mode, policy })) : null,
        attemptFenceDigest: sha256(input.fencingToken),
        receiptJson: null,
        createdAt,
        updatedAt: createdAt
      }).onConflictDoNothing();
      if (inserted.changes === 0) {
        return this.requestActionPermission(input);
      }
      if (proposalId && proposalHash) {
        const snapshot = SuggestedChangesSnapshotSchema.parse({
          proposalId,
          sourceRunId: input.runId,
          createdAt,
          summary: `Allow ${request.title}`,
          intents: [{
            intentId: `intent_${actionId}`,
            domain: "agent_permission",
            action: normalized.actionFamily,
            summary: `Allow ${request.title}`,
            params: {
              actionId,
              actionFamily: normalized.actionFamily,
              scope: normalized.scope,
              target: normalized.target,
              riskTier: normalized.riskTier,
              decisions: ["allow_once", "allow_run", "deny"]
            }
          }],
          preconditions: ["The originating Attempt must remain active.", "The normalized action family and scope must not change."],
          metadata: { kind: "acp_permission", actionId, approvalMode: request.mode, proposalHash }
        });
        await db.insert(suggestedChanges).values({ proposalId, runId: input.runId, snapshotJson: JSON.stringify(snapshot), createdAt }).onConflictDoNothing();
        await db.update(runs).set({ status: "needs_approval", updatedAt: createdAt }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId)));
        await appendRunEvent({
          runId: input.runId,
          type: "action.permission.waiting",
          payload: { actionId, proposalId, actionFamily: normalized.actionFamily, scope: normalized.scope, riskTier: normalized.riskTier },
          visibility: "human",
          importance: "high",
          message: snapshot.summary,
          createdAt
        });
      }
      const row = await db.select().from(materialActions).where(eq(materialActions.id, actionId)).limit(1).get();
      if (!row) throw new Error(`Material action ${actionId} was not stored.`);
      const action = actionFromRow(row);
      if (policy.outcome === "blocked") return { state: "denied", action, decision: "deny", reason: policy.reason };
      if (policy.outcome === "authorized") return { state: "authorized", action, decision: matchingGrant ? "allow_run" : "allow_once", reason: policy.reason };
      return { state: "waiting", action, reason: policy.reason };
    },

    async resolveActionPermission(input: {
      runnerId: string;
      runId: string;
      attemptId: string;
      fencingToken: string;
      actionId: string;
    }): Promise<ActionPermissionResolution | null> {
      const attempt = await db.select().from(attempts).where(eq(attempts.id, input.attemptId)).limit(1).get();
      const run = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      const row = await db.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
      if (!row) return null;
      const action = actionFromRow(row);
      if (
        !attempt || !run || attempt.runId !== input.runId || attempt.runnerId !== input.runnerId ||
        attempt.fencingToken !== input.fencingToken || run.currentAttemptId !== input.attemptId ||
        run.assignedRunnerId !== input.runnerId || action.attemptFenceDigest !== sha256(input.fencingToken) ||
        !["assigned", "running"].includes(attempt.status)
      ) return { state: "stale", action, decision: "deny", reason: "The originating Attempt is no longer active." };
      if (action.status === "succeeded" && action.receipt) return { state: "reconciled", action, decision: "deny", receipt: action.receipt };
      if (action.status === "unknown") return { state: "unknown", action, reason: "The action outcome is unknown." };
      if (action.status === "authorized" || action.status === "executing") {
        const activeGrants = await db.select().from(grants).where(eq(grants.runId, action.runId));
        const hasRunGrant = activeGrants.some((grant) => !grant.attemptId && grant.capability === action.actionFamily && stableActionJson(JSON.parse(grant.resourceScopeJson)) === stableActionJson(action.scope));
        await db.update(runs).set({ status: "running", updatedAt: nowIso() }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId)));
        return { state: "authorized", action, decision: hasRunGrant ? "allow_run" : "allow_once" };
      }
      if (action.status === "cancelled" || action.status === "failed") return { state: "denied", action, decision: "deny" };
      if (!action.proposalId) return { state: "denied", action, decision: "deny", reason: "The action has no approval proposal." };
      const decisionRow = await db.select().from(approvalDecisions).where(eq(approvalDecisions.proposalId, action.proposalId)).orderBy(desc(approvalDecisions.createdAt)).limit(1).get();
      if (!decisionRow) return { state: "waiting", action };
      const decision = ApprovalDecisionSchema.parse(JSON.parse(decisionRow.decisionJson));
      const intentId = `intent_${action.id}`;
      const approved = decision.approvedIntentIds.includes(intentId) && !(decision.rejectedIntentIds ?? []).includes(intentId);
      const decisionKind = approved && decision.metadata?.["permissionDecision"] === "allow_run" ? "allow_run" : approved ? "allow_once" : "deny";
      const updatedAt = nowIso();
      if (decisionKind === "deny") {
        await db.update(materialActions).set({ status: "cancelled", decisionSnapshotHash: sha256(stableActionJson(decision)), updatedAt }).where(eq(materialActions.id, action.id));
        await db.update(runs).set({ status: "running", updatedAt }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId)));
        const updated = await db.select().from(materialActions).where(eq(materialActions.id, action.id)).limit(1).get();
        return { state: "denied", action: actionFromRow(updated!), decision: "deny" };
      }
      await db.transaction((tx) => {
        tx.insert(grants).values({
          id: `grant_${sha256(`${decision.id}:${action.id}:${decisionKind}`).slice(0, 24)}`,
          connectionId: `acp:${action.capability}`,
          capability: action.actionFamily,
          resourceScopeJson: JSON.stringify(action.scope),
          runId: action.runId,
          attemptId: decisionKind === "allow_once" ? action.attemptId : null,
          expiresAt: null,
          constraintsJson: JSON.stringify({ decisionId: decision.id, riskTier: action.riskTier }),
          revokedAt: null,
          createdAt: updatedAt
        }).onConflictDoNothing().run();
        tx.update(materialActions).set({ status: "authorized", decisionSnapshotHash: sha256(stableActionJson(decision)), updatedAt }).where(eq(materialActions.id, action.id)).run();
        tx.update(runs).set({ status: "running", updatedAt }).where(and(eq(runs.id, input.runId), eq(runs.currentAttemptId, input.attemptId))).run();
      });
      const updated = await db.select().from(materialActions).where(eq(materialActions.id, action.id)).limit(1).get();
      return { state: "authorized", action: actionFromRow(updated!), decision: decisionKind };
    },

    async recordMaterialActionReceipt(input: {
      runnerId: string;
      runId: string;
      attemptId: string;
      fencingToken: string;
      actionId: string;
      receipt: MaterialActionReceipt;
    }): Promise<ActionPermissionResolution | null> {
      const receipt = MaterialActionReceiptSchema.parse(input.receipt);
      if (receipt.actionId !== input.actionId) throw new Error("Material action receipt actionId must match the governed action.");
      const resolved = await this.resolveActionPermission(input);
      if (!resolved || resolved.state === "stale") return resolved;
      if (resolved.action.receipt) return resolved;
      if (resolved.state !== "authorized") return resolved;
      const status = receipt.outcome === "succeeded" ? "succeeded" : receipt.outcome === "failed" ? "failed" : "unknown";
      const updatedAt = nowIso();
      await db.update(materialActions).set({ status, receiptJson: JSON.stringify(receipt), updatedAt }).where(eq(materialActions.id, input.actionId));
      await appendRunEvent({
        runId: input.runId,
        type: "material_action.receipt.recorded",
        payload: receipt,
        visibility: "human",
        importance: "high",
        message: `Material action ${input.actionId} ${receipt.outcome}.`,
        createdAt: updatedAt
      });
      const updated = await db.select().from(materialActions).where(eq(materialActions.id, input.actionId)).limit(1).get();
      return { state: status === "succeeded" ? "reconciled" : status === "unknown" ? "unknown" : "denied", action: actionFromRow(updated!), ...(status === "succeeded" ? { decision: "deny" as const, receipt } : {}), ...(status === "failed" ? { decision: "deny" as const, receipt } : {}), ...(status === "unknown" ? { receipt } : {}) };
    },

    async getSuggestedChanges(input: { proposalId: string }): Promise<StoredSuggestedChangesSnapshot | null> {
      const row = await db.select().from(suggestedChanges).where(eq(suggestedChanges.proposalId, input.proposalId)).limit(1).get();
      if (!row) return null;
      return {
        runId: row.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
      };
    },

    async listSuggestedChangesForRun(input: { runId: string }): Promise<SuggestedChangesSnapshot[]> {
      const rows = await db.select().from(suggestedChanges).where(eq(suggestedChanges.runId, input.runId)).orderBy(asc(suggestedChanges.createdAt));
      return rows.map((row) => SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson)));
    },

    async listLatestSuggestedChangesForConversation(input: {
      conversationKey: string;
    }): Promise<StoredSuggestedChangesInConversation[]> {
      const runRows = await db
        .select()
        .from(runs)
        .where(eq(runs.conversationKey, input.conversationKey))
        .orderBy(asc(runs.createdAt));
      for (const runRow of [...runRows].reverse()) {
        const proposalRows = await db
          .select()
          .from(suggestedChanges)
          .where(eq(suggestedChanges.runId, runRow.id))
          .orderBy(asc(suggestedChanges.createdAt));
        if (proposalRows.length === 0) continue;
        const run = runFromRow(runRow);
        const event = OpenTagEventSchema.parse(JSON.parse(runRow.eventJson));
        return proposalRows.map((row) => ({
          runId: row.runId,
          run,
          event,
          snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
        }));
      }
      return [];
    },

    async getProposalLineage(input: { proposalId: string }): Promise<ProposalLineage | null> {
      const targetRow = await db.select().from(suggestedChanges).where(eq(suggestedChanges.proposalId, input.proposalId)).limit(1).get();
      if (!targetRow) return null;
      const target = {
        runId: targetRow.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(targetRow.snapshotJson))
      };
      const rows = await db.select().from(suggestedChanges).orderBy(asc(suggestedChanges.createdAt));
      const snapshots = rows.map((row) => ({
        runId: row.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
      }));
      return computeProposalLineage(snapshots, lineageScopeKey(target));
    },

    async listCurrentMutationIntents(input: { proposalId: string }): Promise<MutationIntentActionability[] | null> {
      const targetRow = await db.select().from(suggestedChanges).where(eq(suggestedChanges.proposalId, input.proposalId)).limit(1).get();
      if (!targetRow) return null;
      const rows = await db.select().from(suggestedChanges).orderBy(asc(suggestedChanges.createdAt));
      const lineage = computeProposalLineage(
        rows.map((row) => ({
          runId: row.runId,
          snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
        })),
        lineageScopeKey({
          runId: targetRow.runId,
          snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(targetRow.snapshotJson))
        })
      );
      if (!lineage) return null;
      return lineage.entries.filter((entry) => entry.status === "current");
    },

    async recordApprovalDecision(input: ApprovalDecision): Promise<ApprovalDecision | null> {
      const decision = ApprovalDecisionSchema.parse(input);
      const storedProposalRow = await db
        .select()
        .from(suggestedChanges)
        .where(eq(suggestedChanges.proposalId, decision.proposalId))
        .limit(1)
        .get();
      if (!storedProposalRow) return null;
      await db
        .insert(approvalDecisions)
        .values({
          id: decision.id,
          proposalId: decision.proposalId,
          decisionJson: JSON.stringify(decision),
          createdAt: decision.approvedAt
        })
        .onConflictDoUpdate({
          target: approvalDecisions.id,
          set: {
            proposalId: decision.proposalId,
            decisionJson: JSON.stringify(decision),
            createdAt: decision.approvedAt
          }
        });
      await appendRunEvent({
        runId: storedProposalRow.runId,
        type: "approval.decision.recorded",
        payload: decision,
        visibility: "audit",
        importance: "high",
        message: `Approved ${decision.approvedIntentIds.length} intent(s).`,
        createdAt: decision.approvedAt
      });
      await appendRunEvent({
        runId: storedProposalRow.runId,
        type: "success_metric.observed",
        payload: {
          metric: "external_write_approval_rate",
          proposalId: decision.proposalId,
          approvedIntentCount: decision.approvedIntentIds.length
        },
        visibility: "audit",
        importance: "normal",
        createdAt: decision.approvedAt
      });
      return decision;
    },

    async getApprovalDecision(input: { id: string }): Promise<ApprovalDecision | null> {
      const row = await db.select().from(approvalDecisions).where(eq(approvalDecisions.id, input.id)).limit(1).get();
      return row ? ApprovalDecisionSchema.parse(JSON.parse(row.decisionJson)) : null;
    },

    async createApplyPlan(input: {
      id: string;
      proposalId: string;
      approvalDecisionId: string;
      selectedIntentIds?: string[];
      adapter?: string;
      policyRules?: PolicyRule[];
    }): Promise<ApplyPlan | null> {
      const built = await buildApplyPlan(input);
      if (!built) return null;
      await db
        .insert(applyPlans)
        .values({
          id: built.plan.id,
          proposalId: built.plan.proposalId,
          approvalDecisionId: built.plan.approvalDecisionId,
          planJson: JSON.stringify(built.plan),
          createdAt: built.createdAt
        })
        .onConflictDoUpdate({
          target: applyPlans.id,
          set: {
            proposalId: built.plan.proposalId,
            approvalDecisionId: built.plan.approvalDecisionId,
            planJson: JSON.stringify(built.plan),
            createdAt: built.createdAt
          }
        });
      await appendApplyPlanCreatedEvent(built);
      return built.plan;
    },

    async createApplyPlanOnce(input: {
      id: string;
      proposalId: string;
      approvalDecisionId: string;
      selectedIntentIds?: string[];
      adapter?: string;
      policyRules?: PolicyRule[];
    }): Promise<{ plan: ApplyPlan; created: boolean } | null> {
      const built = await buildApplyPlan(input);
      if (!built) return null;
      const result = db.transaction((tx) => {
        const insertResult = tx
          .insert(applyPlans)
          .values({
            id: built.plan.id,
            proposalId: built.plan.proposalId,
            approvalDecisionId: built.plan.approvalDecisionId,
            planJson: JSON.stringify(built.plan),
            createdAt: built.createdAt
          })
          .onConflictDoNothing({ target: applyPlans.id })
          .run();
        if (insertResult.changes === 0) {
          return { created: false as const };
        }
        tx.insert(runEvents).values(applyPlanCreatedEventRow(built)).run();
        return { created: true as const };
      });
      if (!result.created) {
        const existing = await db.select().from(applyPlans).where(eq(applyPlans.id, input.id)).limit(1).get();
        if (!existing) {
          throw new Error(`Apply plan ${input.id} already exists but could not be loaded`);
        }
        return { plan: ApplyPlanSchema.parse(JSON.parse(existing.planJson)), created: false };
      }
      return { plan: built.plan, created: true };
    },

    async getApplyPlan(input: { id: string }): Promise<ApplyPlan | null> {
      const row = await db.select().from(applyPlans).where(eq(applyPlans.id, input.id)).limit(1).get();
      return row ? ApplyPlanSchema.parse(JSON.parse(row.planJson)) : null;
    },

    async updateApplyPlanOutcomes(input: { id: string; outcomes: ApplyIntentOutcome[]; externalWritesExecuted: boolean }): Promise<ApplyPlan | null> {
      const row = await db.select().from(applyPlans).where(eq(applyPlans.id, input.id)).limit(1).get();
      if (!row) return null;
      const currentPlan = ApplyPlanSchema.parse(JSON.parse(row.planJson));
      const outcomes = input.outcomes.map((outcome) => ApplyIntentOutcomeSchema.parse(outcome));
      const updatedPlan = ApplyPlanSchema.parse({
        ...currentPlan,
        adapterPlan: {
          ...(currentPlan.adapterPlan && typeof currentPlan.adapterPlan === "object" && !Array.isArray(currentPlan.adapterPlan)
            ? currentPlan.adapterPlan
            : {}),
          externalWritesExecuted: input.externalWritesExecuted
        },
        outcomes
      });
      const updatedAt = nowIso();
      await db
        .update(applyPlans)
        .set({ planJson: JSON.stringify(updatedPlan), createdAt: row.createdAt })
        .where(eq(applyPlans.id, input.id));

      const storedProposalRow = await db
        .select()
        .from(suggestedChanges)
        .where(eq(suggestedChanges.proposalId, updatedPlan.proposalId))
        .limit(1)
        .get();
      if (storedProposalRow) {
        await appendRunEvent({
          runId: storedProposalRow.runId,
          type: "apply_plan.executed",
          payload: updatedPlan,
          visibility: "audit",
          importance: "high",
          message: `Executed apply plan with ${outcomes.length} outcome(s).`,
          createdAt: updatedAt
        });
      }
      return updatedPlan;
    },

    async recordProgress(input: {
      runId: string;
      message: string;
      type?: string;
      at?: string;
      visibility?: RunEventVisibility;
      importance?: RunEventImportance;
      runnerId?: string;
      attemptId?: string;
      fencingToken?: string;
      idempotencyKey?: string;
    }): Promise<RecordProgressOutcome> {
      if (input.runnerId) {
        if (!input.attemptId || !input.fencingToken) return "stale_attempt";
        const createdAt = input.at ?? nowIso();
        return db.transaction((tx) => {
          const run = tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
          const attempt = tx.select().from(attempts).where(eq(attempts.id, input.attemptId!)).limit(1).get();
          if (!run) return "not_found" as const;
          if (
            !attempt ||
            run.assignedRunnerId !== input.runnerId ||
            run.currentAttemptId !== input.attemptId ||
            (run.status !== "assigned" && run.status !== "running") ||
            attempt.runId !== input.runId ||
            attempt.runnerId !== input.runnerId ||
            attempt.fencingToken !== input.fencingToken ||
            (attempt.status !== "assigned" && attempt.status !== "running")
          ) {
            return "stale_attempt" as const;
          }
          if (input.idempotencyKey) {
            const existing = tx.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(desc(runEvents.id)).limit(250).all();
            for (const event of existing) {
              if (event.type !== "run.progress") continue;
              const payload = recordFromJson(event.payloadJson);
              if (payload?.["idempotencyKey"] === input.idempotencyKey) return "duplicate" as const;
            }
          }
          tx.insert(runEvents)
            .values({
              runId: input.runId,
              type: "run.progress",
              payloadJson: JSON.stringify({
                runnerId: input.runnerId,
                attemptId: input.attemptId,
                ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                type: input.type ?? "progress",
                message: input.message,
                at: createdAt
              }),
              visibility: input.visibility ?? "audit",
              importance: input.importance ?? "normal",
              message: input.message,
              createdAt
            })
            .run();
          return "recorded" as const;
        });
      }
      if (input.idempotencyKey) {
        const existing = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(desc(runEvents.id)).limit(250);
        for (const event of existing) {
          if (event.type !== "run.progress") continue;
          const payload = recordFromJson(event.payloadJson);
          if (payload?.["idempotencyKey"] === input.idempotencyKey) return "duplicate";
        }
      }
      await appendRunEvent({
        runId: input.runId,
        type: "run.progress",
        payload: {
          ...(input.runnerId ? { runnerId: input.runnerId } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          type: input.type ?? "progress",
          message: input.message,
          at: input.at ?? nowIso()
        },
        visibility: input.visibility ?? "audit",
        importance: input.importance ?? "normal",
        message: input.message,
        createdAt: input.at ?? nowIso()
      });
      return "recorded";
    },

    async listAttempts(input: { runId: string }): Promise<Attempt[]> {
      const rows = await db.select().from(attempts).where(eq(attempts.runId, input.runId)).orderBy(asc(attempts.number));
      return rows.map(attemptFromRow);
    },

    async getRun(input: { runId: string }): Promise<OpenTagRunWithEvent | null> {
      const row = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      if (!row) return null;
      return {
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      };
    },

    async listRunEvents(input: { runId: string }): Promise<OpenTagAuditEvent[]> {
      const rows = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(asc(runEvents.id));
      return rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        type: row.type,
        visibility: RunEventVisibilitySchema.parse(row.visibility),
        importance: RunEventImportanceSchema.parse(row.importance),
        ...(row.message ? { message: row.message } : {}),
        payload: JSON.parse(row.payloadJson) as unknown,
        createdAt: row.createdAt
      }));
    },

    async getRunLedger(input: { runId: string }): Promise<AgentWorkLedger | null> {
      const runRow = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      if (!runRow) return null;
      const event = OpenTagEventSchema.parse(JSON.parse(runRow.eventJson));
      const rows = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(asc(runEvents.id));
      const sourceEntry: AgentWorkLedgerEntry = {
        id: 0,
        sequence: 0,
        runId: input.runId,
        type: "source_event.received",
        visibility: "audit",
        importance: "normal",
        message: `${event.source} source event ${event.sourceEventId} received.`,
        payload: { event },
        createdAt: event.receivedAt,
        category: "source_event"
      };
      return {
        runId: input.runId,
        entries: [
          sourceEntry,
          ...rows.map((row, index) => ({
            id: row.id,
            sequence: index + 1,
            runId: row.runId,
            type: row.type,
            visibility: RunEventVisibilitySchema.parse(row.visibility),
            importance: RunEventImportanceSchema.parse(row.importance),
            ...(row.message ? { message: row.message } : {}),
            payload: row.payloadJson ? (JSON.parse(row.payloadJson) as unknown) : {},
            createdAt: row.createdAt,
            category: ledgerCategoryForEventType(row.type)
          }))
        ]
      };
    },

    async appendControlPlaneEvent(input: {
      type: string;
      severity?: ControlPlaneEventSeverity;
      subject?: string;
      payload?: unknown;
      createdAt?: string;
    }): Promise<void> {
      await db.insert(controlPlaneEvents).values({
        type: input.type,
        severity: input.severity ?? "info",
        subject: input.subject ?? null,
        payloadJson: JSON.stringify(input.payload ?? {}),
        createdAt: input.createdAt ?? nowIso()
      });
    },

    async listControlPlaneEvents(input: { limit?: number; type?: string; severity?: ControlPlaneEventSeverity } = {}): Promise<ControlPlaneEvent[]> {
      const conditions = [
        ...(input.type ? [eq(controlPlaneEvents.type, input.type)] : []),
        ...(input.severity ? [eq(controlPlaneEvents.severity, input.severity)] : [])
      ];
      const rows = await db
        .select()
        .from(controlPlaneEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(controlPlaneEvents.id))
        .limit(input.limit ?? 100);
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        severity: row.severity as ControlPlaneEventSeverity,
        ...(row.subject ? { subject: row.subject } : {}),
        payload: JSON.parse(row.payloadJson) as unknown,
        createdAt: row.createdAt
      }));
    },

    async summarizeControlPlaneAlerts(input: {
      since?: string;
      limit?: number;
      thresholds?: Partial<Record<ControlPlaneAlert["type"], number>>;
    } = {}): Promise<ControlPlaneAlert[]> {
      const limit = input.limit ?? 5_000;
      const rows = await db
        .select()
        .from(controlPlaneEvents)
        .orderBy(desc(controlPlaneEvents.id))
        .limit(limit);
      const claimRows = await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.type, "run.claimed"))
        .orderBy(desc(runEvents.id))
        .limit(limit);
      const groups = new Map<string, { kind: ControlPlaneAlert["type"]; eventType: string; subject: string; events: ControlPlaneEvent[] }>();

      function addEvent(event: ControlPlaneEvent) {
        if (input.since && event.createdAt < input.since) return;
        const kind = controlPlaneAlertKind(event);
        if (!kind) return;
        const subject = controlPlaneAlertSubject(event);
        const key = `${kind}|${event.type}|${subject}`;
        const group = groups.get(key) ?? { kind, eventType: event.type, subject, events: [] };
        group.events.push(event);
        groups.set(key, group);
      }

      for (const row of rows.reverse()) {
        addEvent({
          id: row.id,
          type: row.type,
          severity: row.severity as ControlPlaneEventSeverity,
          ...(row.subject ? { subject: row.subject } : {}),
          payload: JSON.parse(row.payloadJson) as unknown,
          createdAt: row.createdAt
        });
      }
      for (const row of claimRows.reverse()) {
        addEvent({
          id: row.id,
          type: row.type,
          severity: "info",
          subject: row.runId,
          payload: JSON.parse(row.payloadJson) as unknown,
          createdAt: row.createdAt
        });
      }

      return [...groups.values()]
        .flatMap((group): ControlPlaneAlert[] => {
          const threshold = controlPlaneAlertThreshold(group.kind, input.thresholds);
          if (group.events.length < threshold) return [];
          const metadata = controlPlaneAlertMetadata(group.kind);
          const first = group.events[0]!;
          const last = group.events.at(-1)!;
          return [
            {
              id: `${group.kind}:${group.eventType}:${group.subject}`,
              type: group.kind,
              severity: metadata.severity,
              eventType: group.eventType,
              count: group.events.length,
              threshold,
              firstSeenAt: first.createdAt,
              lastSeenAt: last.createdAt,
              subject: group.subject,
              reason: metadata.reason,
              nextAction: metadata.nextAction
            }
          ];
        })
        .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
    },

    async enqueueCallbackDelivery(input: {
      runId: string;
      kind: CallbackDeliveryKind;
      provider: CallbackDeliveryProvider;
      uri: string;
      body: string;
      threadKey?: string;
      agentId?: string;
      statusMessageKey?: string;
      blocks?: unknown[];
      rich?: unknown;
    }): Promise<CallbackDelivery> {
      const createdAt = nowIso();
      const idempotencyKey = callbackIdempotencyKey(input);
      const rows = await db
        .insert(callbackDeliveries)
        .values({
          runId: input.runId,
          kind: input.kind,
          provider: input.provider,
          uri: input.uri,
          body: input.body,
          threadKey: input.threadKey ?? null,
          idempotencyKey,
          metadataJson: JSON.stringify({
            ...(input.agentId ? { agentId: input.agentId } : {}),
            ...(input.statusMessageKey ? { statusMessageKey: input.statusMessageKey } : {}),
            ...(input.blocks ? { blocks: input.blocks } : {}),
            ...(input.rich !== undefined ? { rich: input.rich } : {})
          }),
          status: "pending",
          createdAt,
          updatedAt: createdAt
        })
        .onConflictDoNothing({ target: callbackDeliveries.idempotencyKey })
        .returning();
      const row = rows[0];
      if (!row) {
        const existing = await db.select().from(callbackDeliveries).where(eq(callbackDeliveries.idempotencyKey, idempotencyKey)).limit(1).get();
        if (!existing) throw new Error("callback delivery was not created");
        await appendRunEvent({
          runId: input.runId,
          type: `callback.${input.kind}.duplicate`,
          payload: callbackDeliveryFromRow(existing),
          visibility: "audit",
          importance: "normal",
          message: "Duplicate callback delivery suppressed.",
          createdAt
        });
        return callbackDeliveryFromRow(existing);
      }
      await appendRunEvent({
        runId: input.runId,
        type: `callback.${input.kind}.queued`,
        payload: callbackDeliveryFromRow(row),
        visibility: "audit",
        importance: "normal",
        createdAt
      });
      return callbackDeliveryFromRow(row);
    },

    async markCallbackDelivered(input: { deliveryId: number; externalMessageId?: string }): Promise<void> {
      const updatedAt = nowIso();
      const row = await db
        .select()
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.id, input.deliveryId))
        .limit(1)
        .get();
      if (!row) return;
      const metadata = callbackDeliveryMetadataFromJson(row.metadataJson) ?? {};
      const metadataJson = JSON.stringify({
        ...metadata,
        ...(input.externalMessageId ? { externalMessageId: input.externalMessageId } : {})
      });
      await db
        .update(callbackDeliveries)
        .set({ status: "delivered", attempts: row.attempts + 1, lastError: null, nextAttemptAt: null, metadataJson, updatedAt })
        .where(eq(callbackDeliveries.id, input.deliveryId));
      const deliveredRow = { ...row, metadataJson };
      await appendRunEvent({
        runId: row.runId,
        type: `callback.${row.kind}.delivered`,
        payload: { ...callbackDeliveryFromRow(deliveredRow), status: "delivered", attempts: row.attempts + 1, updatedAt },
        visibility: "human",
        importance: row.kind === "final" ? "high" : "normal",
        message: row.body,
        createdAt: updatedAt
      });
    },

    async findCallbackExternalMessageId(input: {
      runId: string;
      provider: CallbackDeliveryProvider;
      threadKey?: string;
      statusMessageKey: string;
    }): Promise<string | undefined> {
      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(and(eq(callbackDeliveries.runId, input.runId), eq(callbackDeliveries.provider, input.provider), eq(callbackDeliveries.status, "delivered")))
        .orderBy(desc(callbackDeliveries.updatedAt), desc(callbackDeliveries.id));

      for (const row of rows) {
        const delivery = callbackDeliveryFromRow(row);
        if (delivery.statusMessageKey !== input.statusMessageKey) continue;
        if ((delivery.threadKey ?? undefined) !== input.threadKey) continue;
        if (delivery.externalMessageId) return delivery.externalMessageId;
      }
      return undefined;
    },

    async markCallbackFailed(input: { deliveryId: number; error: string; nextAttemptAt?: string; maxAttempts?: number }): Promise<void> {
      const updatedAt = nowIso();
      const row = await db
        .select()
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.id, input.deliveryId))
        .limit(1)
        .get();
      if (!row) return;
      const attempts = row.attempts + 1;
      await db
        .update(callbackDeliveries)
        .set({ status: "failed", attempts, lastError: input.error, nextAttemptAt: input.nextAttemptAt ?? null, updatedAt })
        .where(eq(callbackDeliveries.id, input.deliveryId));
      await appendRunEvent({
        runId: row.runId,
        type: `callback.${row.kind}.failed`,
        payload: {
          ...callbackDeliveryFromRow(row),
          status: "failed",
          attempts,
          lastError: input.error,
          ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
          updatedAt
        },
        visibility: "audit",
        importance: "normal",
        createdAt: updatedAt
      });
      if (input.maxAttempts !== undefined && attempts >= input.maxAttempts && !input.nextAttemptAt) {
        await appendRunEvent({
          runId: row.runId,
          type: `callback.${row.kind}.suppressed`,
          payload: {
            ...callbackDeliveryFromRow(row),
            status: "failed",
            attempts,
            maxAttempts: input.maxAttempts,
            lastError: input.error,
            updatedAt
          },
          visibility: "audit",
          importance: "high",
          message: "Callback delivery retry budget exhausted; further delivery attempts are suppressed to avoid duplicate storms.",
          createdAt: updatedAt
        });
      }
    },

    async listPendingCallbackDeliveries(input: { limit: number; now?: Date; maxAttempts?: number }): Promise<CallbackDelivery[]> {
      const now = input.now ?? new Date();
      const maxAttempts = input.maxAttempts ?? Number.POSITIVE_INFINITY;
      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(inArray(callbackDeliveries.status, ["pending", "failed"]))
        .orderBy(asc(callbackDeliveries.id));
      return rows
        .map(callbackDeliveryFromRow)
        .filter((delivery) => delivery.attempts < maxAttempts)
        .filter((delivery) => !delivery.nextAttemptAt || new Date(delivery.nextAttemptAt).getTime() <= now.getTime())
        .slice(0, input.limit);
    },

    async claimPendingCallbackDeliveries(input: { limit: number; now?: Date; maxAttempts?: number; staleDeliveryThresholdMs?: number }): Promise<CallbackDelivery[]> {
      const now = input.now ?? new Date();
      const maxAttempts = input.maxAttempts ?? Number.POSITIVE_INFINITY;
      const staleThresholdMs = input.staleDeliveryThresholdMs ?? 60_000;
      const staleDeliveryCutoff = new Date(now.getTime() - staleThresholdMs).toISOString();

      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(inArray(callbackDeliveries.status, ["pending", "failed", "delivering"]))
        .orderBy(asc(callbackDeliveries.id));

      const claimed: CallbackDelivery[] = [];
      for (const row of rows) {
        const delivery = callbackDeliveryFromRow(row);
        if (delivery.attempts >= maxAttempts) continue;
        if (delivery.nextAttemptAt && new Date(delivery.nextAttemptAt).getTime() > now.getTime()) continue;
        if (row.status === "delivering" && row.updatedAt > staleDeliveryCutoff) continue;

        const updatedAt = input.now ? input.now.toISOString() : nowIso();
        const claimWhere =
          row.status === "delivering"
            ? and(eq(callbackDeliveries.id, row.id), eq(callbackDeliveries.status, "delivering"), eq(callbackDeliveries.updatedAt, row.updatedAt))
            : and(eq(callbackDeliveries.id, row.id), inArray(callbackDeliveries.status, ["pending", "failed"]));
        const claimResult = await db.update(callbackDeliveries).set({ status: "delivering", updatedAt }).where(claimWhere);
        if (claimResult.changes === 0) continue;

        claimed.push({
          ...delivery,
          status: "delivering",
          updatedAt
        });
        if (claimed.length >= input.limit) break;
      }

      return claimed;
    },

    async getRunMetrics(input: { runId: string }): Promise<OpenTagRunMetrics> {
      const rows = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(asc(runEvents.id));
      const events = rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        type: row.type,
        visibility: RunEventVisibilitySchema.parse(row.visibility),
        importance: RunEventImportanceSchema.parse(row.importance),
        ...(row.message ? { message: row.message } : {}),
        payload: JSON.parse(row.payloadJson) as unknown,
        createdAt: row.createdAt
      }));
      return metricsFromEvents(input.runId, events);
    },

    async getRepoMetrics(input: { provider: string; owner: string; repo: string }): Promise<OpenTagAggregateMetrics> {
      const runRows = await db
        .select()
        .from(runs)
        .where(and(eq(runs.repoProvider, input.provider), eq(runs.repoOwner, input.owner), eq(runs.repoName, input.repo)))
        .orderBy(asc(runs.createdAt));
      const matchingRunIds = runRows.map((row) => row.id);
      const runMetrics = [];
      for (const runId of matchingRunIds) {
        const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.id));
        runMetrics.push(
          metricsFromEvents(
            runId,
            rows.map((row) => ({
              id: row.id,
              runId: row.runId,
              type: row.type,
              visibility: RunEventVisibilitySchema.parse(row.visibility),
              importance: RunEventImportanceSchema.parse(row.importance),
              ...(row.message ? { message: row.message } : {}),
              payload: JSON.parse(row.payloadJson) as unknown,
              createdAt: row.createdAt
            }))
          )
        );
      }
      return aggregateMetrics({
        scope: "repo",
        scopeId: `${input.provider}:${input.owner}/${input.repo}`,
        runs: runMetrics
      });
    },

    async getWorkThreadMetrics(input: { threadId: string }): Promise<OpenTagAggregateMetrics> {
      const runRows = await db.select().from(runs).where(eq(runs.workThreadId, input.threadId)).orderBy(asc(runs.createdAt));
      const matchingRunIds = runRows.map((row) => row.id);
      const runMetrics = [];
      for (const runId of matchingRunIds) {
        const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.id));
        runMetrics.push(
          metricsFromEvents(
            runId,
            rows.map((row) => ({
              id: row.id,
              runId: row.runId,
              type: row.type,
              visibility: RunEventVisibilitySchema.parse(row.visibility),
              importance: RunEventImportanceSchema.parse(row.importance),
              ...(row.message ? { message: row.message } : {}),
              payload: JSON.parse(row.payloadJson) as unknown,
              createdAt: row.createdAt
            }))
          )
        );
      }
      return aggregateMetrics({
        scope: "work_thread",
        scopeId: input.threadId,
        runs: runMetrics
      });
    }
  };
}
