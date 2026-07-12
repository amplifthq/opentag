import { z } from "zod";

export const ProviderSchema = z.string().min(1);
export const SourceSchema = ProviderSchema;
export const ContextPointerKindSchema = z.string().min(1).refine((kind) => !kind.includes("."), {
  message: "Context pointer kind must not include a provider prefix; use the provider field instead."
});
export const ExecutorHintSchema = z.enum(["claude-code", "codex", "hermes", "openclaw", "custom"]);
export const PermissionScopeSchema = z.string().min(1);
export const CommandArgValueSchema = z.union([z.string(), z.boolean(), z.number()]);
export const CommandFlagValueSchema = z.union([CommandArgValueSchema, z.array(CommandArgValueSchema)]);

export const CommandReferenceSchema = z.object({
  kind: z.enum(["file", "path", "line", "range", "url", "text"]),
  uri: z.string().min(1),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  title: z.string().min(1).optional()
});

export const CommandParseDiagnosticSchema = z.object({
  level: z.enum(["warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  token: z.string().min(1).optional()
});

export const ParsedOpenTagCommandSchema = z.object({
  version: z.literal("v1"),
  prompt: z.string(),
  flags: z.record(CommandFlagValueSchema),
  references: z.array(CommandReferenceSchema),
  requestedScopes: z.array(PermissionScopeSchema),
  approval: z.enum(["auto", "required", "never"]).optional(),
  network: z.enum(["restricted"]).optional(),
  executorHint: ExecutorHintSchema.optional(),
  diagnostics: z.array(CommandParseDiagnosticSchema)
});

export const ActorIdentitySchema = z.object({
  provider: ProviderSchema,
  providerUserId: z.string().min(1),
  handle: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  /** Platform-reported write access to the source repository (for example,
   * GitHub's collaborator permission API). Absent when the platform does not
   * report it; admission treats absent as "no write access" on public repos. */
  writeAccess: z.boolean().optional()
});

export const AgentTargetSchema = z.object({
  mention: z.string().min(1),
  agentId: z.string().min(1),
  executorHint: ExecutorHintSchema.optional(),
  workspaceHint: z.string().min(1).optional()
});

export const OpenTagCommandSchema = z.object({
  rawText: z.string(),
  intent: z.enum(["fix", "review", "investigate", "explain", "run", "unknown"]),
  args: z.record(CommandArgValueSchema),
  parsed: ParsedOpenTagCommandSchema.optional()
});

export const ContextPointerSchema = z.object({
  provider: ProviderSchema.optional(),
  kind: ContextPointerKindSchema,
  uri: z.string().min(1),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  title: z.string().min(1).optional(),
  visibility: z.enum(["public", "private", "organization"])
});

export const ContextPacketAssemblyStageSchema = z.enum(["collect", "classify", "filter", "preserve", "summarize", "budget", "emit"]);

export const ContextPacketIntentSchema = z.object({
  rawText: z.string().min(1),
  normalizedIntent: z.string().min(1),
  requestedBy: ActorIdentitySchema
});

export const ContextPacketSourceRoleSchema = z.enum(["primary", "supporting", "background"]);

export const ContextPacketSourceSchema = z.object({
  pointer: ContextPointerSchema,
  role: ContextPacketSourceRoleSchema,
  included: z.boolean(),
  reason: z.string().min(1)
});

export const ContextPacketFactConfidenceSchema = z.enum(["observed", "inferred", "uncertain"]);

export const ContextPacketSchema = z.object({
  summary: z.string().min(1),
  sourcePointers: z.array(ContextPointerSchema),
  intent: ContextPacketIntentSchema.optional(),
  sources: z.array(ContextPacketSourceSchema).optional(),
  facts: z
    .array(
      z.object({
        text: z.string().min(1),
        sourceUri: z.string().min(1).optional(),
        source: ContextPointerSchema.optional(),
        confidence: ContextPacketFactConfidenceSchema.optional()
      })
    )
    .optional(),
  risks: z.array(z.string().min(1)).optional(),
  exclusions: z.array(z.string().min(1)).optional(),
  mustPreserve: z.array(z.string().min(1)).optional(),
  redactions: z
    .array(
      z.object({
        reason: z.string().min(1),
        sourceUri: z.string().min(1).optional()
      })
    )
    .optional(),
  assembly: z
    .object({
      stages: z.array(ContextPacketAssemblyStageSchema),
      budgetTokens: z.number().int().positive().optional(),
      emittedAt: z.string().datetime().optional()
    })
    .optional()
});

export const PermissionGrantSchema = z.object({
  scope: PermissionScopeSchema,
  reason: z.string().min(1),
  expiresAt: z.string().datetime().optional()
});

/** An opaque reference to connector credentials held outside the durable run model. */
export const ConnectionRefSchema = z
  .object({
    id: z.string().min(1),
    provider: ProviderSchema,
    custody: z.enum(["agent", "opentag", "operator"]),
    brokerRef: z.string().min(1),
    declaredCapabilities: z.array(z.string().min(1))
  })
  .strict();

export const VerificationEvidenceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    assurance: z.enum(["verified", "reported", "unverifiable"]),
    subjectRef: z.string().min(1),
    summary: z.string().min(1),
    sourceRef: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    metadata: z.record(z.unknown()).optional()
  })
  .strict();

export const AttemptStatusSchema = z.enum([
  "assigned",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "timed_out",
  "needs_human"
]);

export const AttemptSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    number: z.number().int().positive(),
    runnerId: z.string().min(1),
    status: AttemptStatusSchema,
    startedAt: z.string().datetime(),
    heartbeatAt: z.string().datetime(),
    leaseExpiresAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    result: z.lazy(() => OpenTagRunResultSchema).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const GrantSchema = z
  .object({
    id: z.string().min(1),
    connectionId: z.string().min(1),
    capability: z.string().min(1),
    resourceScope: z.record(z.unknown()),
    runId: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    expiresAt: z.string().datetime().optional(),
    constraints: z.record(z.unknown()).optional(),
    revokedAt: z.string().datetime().optional()
  })
  .strict();

export const MaterialActionReceiptSchema = z
  .object({
    id: z.string().min(1),
    actionId: z.string().min(1),
    provider: ProviderSchema,
    receiptRef: z.string().min(1),
    outcome: z.enum(["succeeded", "failed", "unknown"]),
    externalId: z.string().min(1).optional(),
    externalUri: z.string().url().optional(),
    observedAt: z.string().datetime(),
    evidence: z.array(VerificationEvidenceSchema).optional(),
    metadata: z.record(z.unknown()).optional()
  })
  .strict();

export const ActionSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    attemptId: z.string().min(1),
    capability: z.string().min(1),
    target: z.record(z.unknown()),
    status: z.enum(["proposed", "waiting_approval", "authorized", "executing", "succeeded", "failed", "unknown", "cancelled"]),
    idempotencyKey: z.string().min(1),
    proposalHash: z.string().min(1).optional(),
    receipt: MaterialActionReceiptSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const ArtifactSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    kind: z.string().min(1),
    title: z.string().min(1),
    uri: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    evidence: z.array(VerificationEvidenceSchema).optional(),
    createdAt: z.string().datetime(),
    metadata: z.record(z.unknown()).optional()
  })
  .strict();

export const CapabilityClassSchema = z.enum(["read_only", "callback", "external_write"]);

export const CapabilityContractSchema = z.object({
  id: z.string().min(1),
  semanticAction: z.string().min(1),
  capabilityClass: CapabilityClassSchema,
  requiresExplicitIntent: z.boolean(),
  mayAutoApplyByPolicy: z.boolean(),
  adapterTargets: z.array(z.string().min(1)).optional(),
  requiredPermissionScopes: z.array(PermissionGrantSchema.shape.scope),
  requiredExecutorConditions: z.array(z.string().min(1)).optional()
});

export const PolicyScopeSchema = z.enum([
  "organization_default",
  "adapter_surface_default",
  "work_context_owner_container",
  "work_item_override",
  "primary_anchor_override"
]);

export const PolicyEffectSchema = z.enum(["allow", "deny"]);

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  scope: PolicyScopeSchema,
  effect: PolicyEffectSchema,
  capabilityId: z.string().min(1).optional(),
  mutationDomain: z.string().min(1).optional(),
  reason: z.string().min(1)
});

export const PolicyResolutionSchema = z.object({
  capabilityId: z.string().min(1),
  decision: PolicyEffectSchema,
  resolvedBy: PolicyScopeSchema,
  rules: z.array(PolicyRuleSchema),
  reason: z.string().min(1)
});

export const AdapterMutationMappingSchema = z.object({
  id: z.string().min(1),
  adapter: z.string().min(1),
  domain: z.string().min(1),
  strategy: z.string().min(1),
  values: z.record(z.string().min(1)),
  description: z.string().min(1).optional()
});

export const SuccessMetricNameSchema = z.enum([
  "time_to_first_useful_artifact",
  "thread_noise_ratio",
  "artifact_acceptance_rate",
  "context_reuse_rate",
  "external_write_approval_rate",
  "stale_proposal_rate"
]);

export const CallbackRouteSchema = z.object({
  provider: ProviderSchema,
  uri: z.string().min(1),
  threadKey: z.string().min(1).optional()
});

export const WorkItemReferenceSchema = z.object({
  provider: z.string().min(1),
  kind: z.string().min(1),
  externalId: z.string().min(1),
  uri: z.string().min(1),
  title: z.string().min(1).optional(),
  ownerContainer: z
    .object({
      provider: z.string().min(1),
      id: z.string().min(1),
      uri: z.string().min(1).optional()
    })
    .optional(),
  metadata: z.record(z.unknown()).optional()
});

export const ConversationAnchorSchema = z.object({
  provider: ProviderSchema,
  kind: z.string().min(1),
  externalId: z.string().min(1),
  uri: z.string().min(1),
  threadKey: z.string().min(1).optional(),
  controlPlane: z.boolean().optional(),
  canApprove: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const WorkThreadSchema = z.object({
  id: z.string().min(1).optional(),
  workItemReference: WorkItemReferenceSchema,
  primaryAnchor: ConversationAnchorSchema,
  secondaryAnchors: z.array(ConversationAnchorSchema).optional()
});

export const RunAdmissionActionSchema = z.enum([
  "start",
  "drop_duplicate",
  "queue_follow_up",
  "attach_to_active_run",
  "needs_human_decision"
]);

export const RunAdmissionReasonCodeSchema = z.enum([
  "new_event",
  "duplicate_source_event",
  "duplicate_source_delivery",
  "active_run_same_thread",
  "active_write_run_same_thread",
  "scope_change_requires_decision",
  "policy_rejected",
  "repo_context_missing",
  "repo_not_bound",
  "actor_not_allowed_for_write",
  "actor_not_authorized_for_public_repo",
  "agent_access_profile_denied"
]);

export const RunAdmissionDecisionSchema = z.object({
  action: RunAdmissionActionSchema,
  reason: z.string().min(1),
  reasonCode: RunAdmissionReasonCodeSchema,
  decidedAt: z.string().datetime(),
  activeRunId: z.string().min(1).optional(),
  eventId: z.string().min(1).optional()
});

export const FollowUpRequestStatusSchema = z.enum(["queued", "promoting", "promoted", "cancelled"]);

export const FollowUpRequestSchema = z.object({
  id: z.string().min(1),
  sourceEventId: z.string().min(1),
  conversationKey: z.string().min(1),
  activeRunId: z.string().min(1).optional(),
  event: z.lazy(() => OpenTagEventSchema),
  decision: RunAdmissionDecisionSchema,
  status: FollowUpRequestStatusSchema,
  createdRunId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const RunEventVisibilitySchema = z.enum(["human", "audit", "debug"]);
export const RunEventImportanceSchema = z.enum(["low", "normal", "high", "blocking"]);

export const RunEventSchema = z.object({
  id: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
  runId: z.string().min(1),
  type: z.string().min(1),
  createdAt: z.string().datetime(),
  visibility: RunEventVisibilitySchema,
  importance: RunEventImportanceSchema,
  message: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  sourcePointer: ContextPointerSchema.optional()
});

export const ArtifactKindSchema = z.enum([
  "root_cause_note",
  "suggested_changes_snapshot",
  "verification_summary",
  "patch",
  "report",
  "screenshot",
  "log_summary",
  "pull_request",
  "risk_note",
  "follow_up_task",
  "audit_trail",
  "decision_record"
]);

export const RunArtifactTypeSchema = z.enum([
  "suggested_changes_snapshot",
  "next_action",
  "apply_plan",
  "patch_summary",
  "diagnosis_report",
  "pr_intent",
  "patch",
  "report",
  "log_summary",
  "pull_request",
  "verification_summary",
  "custom"
]);

export const ActionHintSchema = z.object({
  kind: z.enum([
    "apply_suggested_changes",
    "generate_patch",
    "request_human_decision",
    "link_to_work_item",
    "request_review",
    "create_pull_request",
    "none"
  ]),
  targetId: z.string().min(1).optional(),
  selectedIntentIds: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional()
});

export const NextActionSchema = z.union([
  z.string().min(1),
  z.object({
    summary: z.string().min(1),
    hint: ActionHintSchema
  })
]);

export const CanonicalMutationDomainSchema = z.enum([
  "status",
  "assignee",
  "priority",
  "labels",
  "schedule",
  "review",
  "artifact_links",
  "issue",
  "pull_request"
]);

export const MutationIntentSchema = z.object({
  intentId: z.string().min(1),
  domain: z.union([CanonicalMutationDomainSchema, z.string().min(1)]),
  action: z.string().min(1),
  summary: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  supersedesIntentIds: z.array(z.string().min(1)).optional(),
  sourcePointer: ContextPointerSchema.optional()
});

export const SuggestedChangesSnapshotSchema = z.object({
  proposalId: z.string().min(1),
  createdAt: z.string().datetime(),
  sourceRunId: z.string().min(1).optional(),
  workThread: WorkThreadSchema.optional(),
  summary: z.string().min(1),
  intents: z.array(MutationIntentSchema).min(1),
  preconditions: z.array(z.string().min(1)).optional(),
  supersedesProposalIds: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional()
});

export const MutationIntentActionabilitySchema = z.object({
  proposalId: z.string().min(1),
  intentId: z.string().min(1),
  domain: z.union([CanonicalMutationDomainSchema, z.string().min(1)]),
  status: z.enum(["current", "superseded", "stale", "conflicted"]),
  supersededByProposalId: z.string().min(1).optional(),
  supersededByIntentId: z.string().min(1).optional(),
  reason: z.string().min(1).optional()
});

export const ProposalLineageSchema = z.object({
  scopeKey: z.string().min(1),
  entries: z.array(MutationIntentActionabilitySchema)
});

export const ApprovalDecisionSchema = z.object({
  id: z.string().min(1),
  proposalId: z.string().min(1),
  approvedIntentIds: z.array(z.string().min(1)),
  rejectedIntentIds: z.array(z.string().min(1)).optional(),
  approvedBy: ActorIdentitySchema,
  approvedAt: z.string().datetime(),
  scope: z.enum(["manual", "policy"]),
  reason: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional()
});

export const ApplyIntentOutcomeSchema = z.object({
  intentId: z.string().min(1),
  outcome: z.enum(["applied", "skipped", "failed", "stale", "unsupported"]),
  message: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  externalUri: z.string().min(1).optional(),
  error: z.string().min(1).optional()
});

export const ApplyPlanSchema = z.object({
  id: z.string().min(1),
  proposalId: z.string().min(1),
  approvalDecisionId: z.string().min(1),
  selectedIntentIds: z.array(z.string().min(1)),
  mode: z.enum(["preflight_then_per_intent", "atomic"]).default("preflight_then_per_intent"),
  adapter: z.string().min(1).optional(),
  adapterPlan: z.unknown().optional(),
  outcomes: z.array(ApplyIntentOutcomeSchema).optional()
});

export const OpenTagEventSchema = z.object({
  id: z.string().min(1),
  source: SourceSchema,
  sourceEventId: z.string().min(1),
  receivedAt: z.string().datetime(),
  actor: ActorIdentitySchema,
  target: AgentTargetSchema,
  command: OpenTagCommandSchema,
  context: z.array(ContextPointerSchema),
  workItem: WorkItemReferenceSchema.optional(),
  permissions: z.array(PermissionGrantSchema),
  callback: CallbackRouteSchema,
  metadata: z.record(z.unknown())
});

export const ResultArtifactSchema = z.object({
  id: z.string().min(1).optional(),
  type: RunArtifactTypeSchema.optional(),
  kind: ArtifactKindSchema.optional(),
  title: z.string(),
  uri: z.string(),
  summary: z.string().min(1).optional(),
  sourceRunId: z.string().min(1).optional(),
  createdAt: z.string().datetime().optional(),
  relatedIds: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional()
});

export const OpenTagRunResultSchema = z.object({
  conclusion: z.enum(["success", "failure", "cancelled", "interrupted", "timed_out", "needs_human"]),
  summary: z.string(),
  changedFiles: z.array(z.string()).optional(),
  createdPullRequestUrl: z.string().url().optional(),
  artifacts: z.array(ResultArtifactSchema).optional(),
  suggestedChanges: z.array(SuggestedChangesSnapshotSchema).optional(),
  approvalDecision: ApprovalDecisionSchema.optional(),
  applyPlan: ApplyPlanSchema.optional(),
  verification: z
    .array(
      z.object({
        command: z.string(),
        outcome: z.enum(["passed", "failed", "not_run"]),
        excerpt: z.string().optional()
      })
    )
    .optional(),
  nextAction: NextActionSchema.optional()
});

export const OpenTagRunSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  status: z.enum(["queued", "assigned", "running", "needs_approval", "succeeded", "failed", "cancelled", "interrupted", "timed_out"]),
  thread: WorkThreadSchema.optional(),
  parentRunId: z.string().min(1).optional(),
  triggeredByAction: ActionHintSchema.optional(),
  sourceProposalId: z.string().min(1).optional(),
  sourceApplyPlanId: z.string().min(1).optional(),
  contextPacket: ContextPacketSchema.optional(),
  assignedRunnerId: z.string().min(1).optional(),
  executor: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  result: OpenTagRunResultSchema.optional()
});

export type ActorIdentity = z.infer<typeof ActorIdentitySchema>;
export type AgentTarget = z.infer<typeof AgentTargetSchema>;
export type OpenTagCommand = z.infer<typeof OpenTagCommandSchema>;
export type ParsedOpenTagCommand = z.infer<typeof ParsedOpenTagCommandSchema>;
export type CommandParseDiagnostic = z.infer<typeof CommandParseDiagnosticSchema>;
export type CommandReference = z.infer<typeof CommandReferenceSchema>;
export type ContextPointer = z.infer<typeof ContextPointerSchema>;
export type ContextPacketAssemblyStage = z.infer<typeof ContextPacketAssemblyStageSchema>;
export type ContextPacketIntent = z.infer<typeof ContextPacketIntentSchema>;
export type ContextPacketSourceRole = z.infer<typeof ContextPacketSourceRoleSchema>;
export type ContextPacketSource = z.infer<typeof ContextPacketSourceSchema>;
export type ContextPacketFactConfidence = z.infer<typeof ContextPacketFactConfidenceSchema>;
export type ContextPacket = z.infer<typeof ContextPacketSchema>;
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;
export type ConnectionRef = z.infer<typeof ConnectionRefSchema>;
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type Grant = z.infer<typeof GrantSchema>;
export type MaterialActionReceipt = z.infer<typeof MaterialActionReceiptSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type CapabilityClass = z.infer<typeof CapabilityClassSchema>;
export type CapabilityContract = z.infer<typeof CapabilityContractSchema>;
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicyResolution = z.infer<typeof PolicyResolutionSchema>;
export type AdapterMutationMapping = z.infer<typeof AdapterMutationMappingSchema>;
export type SuccessMetricName = z.infer<typeof SuccessMetricNameSchema>;
export type CallbackRoute = z.infer<typeof CallbackRouteSchema>;
export type WorkItemReference = z.infer<typeof WorkItemReferenceSchema>;
export type ConversationAnchor = z.infer<typeof ConversationAnchorSchema>;
export type WorkThread = z.infer<typeof WorkThreadSchema>;
export type RunAdmissionAction = z.infer<typeof RunAdmissionActionSchema>;
export type RunAdmissionReasonCode = z.infer<typeof RunAdmissionReasonCodeSchema>;
export type RunAdmissionDecision = z.infer<typeof RunAdmissionDecisionSchema>;
export type FollowUpRequestStatus = z.infer<typeof FollowUpRequestStatusSchema>;
export type FollowUpRequest = z.infer<typeof FollowUpRequestSchema>;
export type RunEventVisibility = z.infer<typeof RunEventVisibilitySchema>;
export type RunEventImportance = z.infer<typeof RunEventImportanceSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type RunArtifactType = z.infer<typeof RunArtifactTypeSchema>;
export type ActionHint = z.infer<typeof ActionHintSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;
export type CanonicalMutationDomain = z.infer<typeof CanonicalMutationDomainSchema>;
export type MutationIntent = z.infer<typeof MutationIntentSchema>;
export type SuggestedChangesSnapshot = z.infer<typeof SuggestedChangesSnapshotSchema>;
export type MutationIntentActionability = z.infer<typeof MutationIntentActionabilitySchema>;
export type ProposalLineage = z.infer<typeof ProposalLineageSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type ApplyIntentOutcome = z.infer<typeof ApplyIntentOutcomeSchema>;
export type ApplyPlan = z.infer<typeof ApplyPlanSchema>;
export type ResultArtifact = z.infer<typeof ResultArtifactSchema>;
export type OpenTagEvent = z.infer<typeof OpenTagEventSchema>;
export type OpenTagRun = z.infer<typeof OpenTagRunSchema>;
export type OpenTagRunResult = z.infer<typeof OpenTagRunResultSchema>;
