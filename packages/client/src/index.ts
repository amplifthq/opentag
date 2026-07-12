import {
  FollowUpRequestSchema,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  OpenTagRunSchema,
  RunAdmissionDecisionSchema,
  type ActorIdentity,
  type ActionHint,
  type AdapterMutationMapping,
  type ApprovalDecision,
  type ApplyPlan,
  type MutationIntentActionability,
  type OpenTagEvent,
  type OpenTagRun,
  type OpenTagRunResult,
  type PolicyRule,
  type ProposalLineage,
  type RunEventImportance,
  type RunEventVisibility,
  type SuggestedChangesSnapshot
} from "@opentag/core";

export type ClaimedOpenTagRun = {
  run: OpenTagRun;
  event: OpenTagEvent;
  attemptId: string;
  attemptNumber: number;
  fencingToken: string;
};

export type OpenTagRunRecord = Pick<ClaimedOpenTagRun, "run" | "event">;

export type AttemptLease = Pick<ClaimedOpenTagRun, "attemptId" | "fencingToken">;

export type RepoBindingInput = {
  provider: string;
  owner: string;
  repo: string;
  runnerId: string;
  workspacePath?: string;
  defaultExecutor?: string;
  allowedActors?: string[];
};

export type RepositoryBindingConfig = {
  provider: string;
  owner: string;
  repo: string;
  checkoutPath: string;
  defaultExecutor?: string;
  baseBranch?: string;
  pushRemote?: string;
  worktreeRoot?: string;
  keepWorktree?: "always" | "on_failure" | "never";
};

export type SlackChannelBindingInput = {
  teamId: string;
  channelId: string;
  repoProvider?: string;
  owner: string;
  repo: string;
};

export type ChannelBindingInput = {
  provider: string;
  accountId: string;
  conversationId: string;
  repoProvider: string;
  owner: string;
  repo: string;
  metadata?: Record<string, unknown>;
};

export type RunnerRegistration = {
  runnerId: string;
  name: string;
  createdAt: string;
  heartbeatAt?: string;
};

export type ControlPlaneAlert = {
  id: string;
  type: string;
  severity: "info" | "warn" | "error";
  eventType: string;
  count: number;
  threshold: number;
  firstSeenAt: string;
  lastSeenAt: string;
  subject?: string;
  reason: string;
  nextAction: string;
};

export type RecordControlPlaneEventInput = {
  type: string;
  severity?: "info" | "warn" | "error";
  subject?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
};

export type PruneSourceDeliveriesInput = {
  olderThan: string;
  limit?: number;
};

export type SourceDeliveryPruneResult = {
  scanned: number;
  pruned: number;
  retainedActive: number;
};

export type OpenTagClientOptions = {
  dispatcherUrl: string;
  pairingToken?: string;
  fetchImpl?: typeof fetch;
};

export type RunnerClientOptions = OpenTagClientOptions & {
  runnerId: string;
};

export type RunProgressInput = {
  type?: string;
  message: string;
  at?: string;
  visibility?: RunEventVisibility;
  importance?: RunEventImportance;
  idempotencyKey?: string;
};

export type RunTimeoutPolicy = {
  hardTimeoutMs?: number;
};

export type CreateRunInput = {
  runId: string;
  event: OpenTagEvent;
};

export type CreateRunResult =
  | {
      outcome: "run_created";
      decision: import("@opentag/core").RunAdmissionDecision;
      run: OpenTagRun;
      idempotentReplay?: boolean;
    }
  | {
      outcome: "follow_up_queued";
      decision: import("@opentag/core").RunAdmissionDecision;
      followUpRequest: import("@opentag/core").FollowUpRequest;
    }
  | {
      outcome: "needs_human_decision";
      decision: import("@opentag/core").RunAdmissionDecision;
    };

export type CompleteRunInput = {
  runnerId: string;
  runId: string;
  attemptId: string;
  fencingToken: string;
  result: OpenTagRunResult;
  idempotencyKey?: string;
};

export type ApprovalDecisionInput = {
  id?: string;
  approvedIntentIds: string[];
  rejectedIntentIds?: string[];
  approvedBy: ActorIdentity;
  approvedAt?: string;
  scope?: "manual" | "policy";
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type ApplyPlanInput = {
  id?: string;
  approvalDecisionId: string;
  selectedIntentIds?: string[];
  adapter?: string;
  execute?: boolean;
};

export type ChildRunInput = {
  runId: string;
  action: ActionHint;
  commandText?: string;
  sourceProposalId?: string;
  sourceApplyPlanId?: string;
};

export type ThreadActionInput = {
  id?: string;
  rawText: string;
  actor: ActorIdentity;
  callback: {
    provider: string;
    uri: string;
    threadKey?: string;
  };
  metadata?: Record<string, unknown>;
};

export type ThreadActionResult = {
  outcome: string;
  message?: string;
  decision?: ApprovalDecision;
  plan?: ApplyPlan;
  run?: OpenTagRun;
};

export type CancelRunResult = {
  outcome: "cancelled";
  run: OpenTagRun;
};

export type ChannelRuntimeStatus = {
  binding: ChannelBindingInput;
  activeRun?: OpenTagRun;
  activeEvent?: OpenTagEvent;
  runTimeoutPolicy?: RunTimeoutPolicy;
  queuedFollowUps: import("@opentag/core").FollowUpRequest[];
};

export type RunMetrics = {
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
  applyOutcomeCounts: {
    applied: number;
    skipped: number;
    failed: number;
    stale: number;
    unsupported: number;
  };
  staleIntentCount: number;
};

export type AggregateMetrics = Omit<RunMetrics, "runId"> & {
  scope: "repo" | "work_thread";
  scopeId: string;
  runCount: number;
};

export type LinearRelayInstallationInput = {
  id: string;
  webhookPath: string;
  webhookSecret: string;
  token: string;
  auth?:
    | { method: "api_key" }
    | {
        method: "oauth_app";
        actor: "app";
        clientId?: string;
        refreshToken?: string;
        accessTokenExpiresAt?: string;
        scopes?: string[];
      };
  graphqlUrl?: string;
  repoProvider: string;
  owner: string;
  repo: string;
  organizationId?: string;
  teamId?: string;
  teamKey?: string;
};

export type CreateLinearOAuthInstallationInput = {
  repoProvider?: string;
  owner: string;
  repo: string;
  teamId?: string;
  teamKey?: string;
  graphqlUrl?: string;
  redirectUri?: string;
  scopes?: string[];
};

export type LinearRelayInstallationSummary = {
  id: string;
  webhookPath: string;
  projectTarget: {
    repoProvider: string;
    owner: string;
    repo: string;
  };
  graphqlUrl?: string;
  organizationId?: string;
  teamId?: string;
  teamKey?: string;
};

export type LinearOAuthInstallationStart = {
  authorizationUrl: string;
  stateExpiresAt: string;
  oauthWebhookPath?: string;
  installation: LinearRelayInstallationSummary;
};

export type OpenTagClient = {
  registerRunner(input: { runnerId: string; name?: string }): Promise<void>;
  getRunner(input: { runnerId: string }): Promise<{ runner: RunnerRegistration }>;
  listControlPlaneAlerts(input?: { limit?: number; since?: string }): Promise<{ alerts: ControlPlaneAlert[] }>;
  recordControlPlaneEvent(input: RecordControlPlaneEventInput): Promise<void>;
  pruneSourceDeliveries(input: PruneSourceDeliveriesInput): Promise<SourceDeliveryPruneResult>;
  bindRepository(input: RepoBindingInput): Promise<void>;
  getRepositoryBinding(input: { provider: string; owner: string; repo: string }): Promise<{ binding: RepoBindingInput }>;
  upsertRepoPolicyRule(input: { provider: string; owner: string; repo: string; rule: PolicyRule }): Promise<{ rule: PolicyRule }>;
  listRepoPolicyRules(input: { provider: string; owner: string; repo: string }): Promise<{ rules: PolicyRule[] }>;
  upsertRepoMutationMapping(input: {
    provider: string;
    owner: string;
    repo: string;
    mapping: AdapterMutationMapping;
  }): Promise<{ mapping: AdapterMutationMapping }>;
  listRepoMutationMappings(input: { provider: string; owner: string; repo: string }): Promise<{ mappings: AdapterMutationMapping[] }>;
  createLinearOAuthInstallation(input: CreateLinearOAuthInstallationInput): Promise<LinearOAuthInstallationStart>;
  upsertLinearRelayInstallation(input: LinearRelayInstallationInput): Promise<{ installation: LinearRelayInstallationSummary }>;
  bindChannel(input: ChannelBindingInput): Promise<void>;
  getChannelBinding(input: { provider: string; accountId: string; conversationId: string }): Promise<{ binding: ChannelBindingInput }>;
  getChannelRuntimeStatus(input: { provider: string; accountId: string; conversationId: string }): Promise<ChannelRuntimeStatus>;
  unbindChannel(input: { provider: string; accountId: string; conversationId: string }): Promise<void>;
  bindSlackChannel(input: SlackChannelBindingInput): Promise<void>;
  getSlackChannelBinding(input: { teamId: string; channelId: string }): Promise<{ binding: SlackChannelBindingInput }>;
  createRun(input: CreateRunInput): Promise<CreateRunResult>;
  getFollowUpRequest(input: { id: string }): Promise<{ followUpRequest: import("@opentag/core").FollowUpRequest }>;
  createRunFromFollowUpRequest(input: { id: string; runId: string }): Promise<{ followUpRequest: import("@opentag/core").FollowUpRequest; run: OpenTagRun }>;
  claim(input: { runnerId: string }): Promise<ClaimedOpenTagRun | null>;
  heartbeat(input: { runnerId: string; runId: string } & AttemptLease): Promise<void>;
  markRunning(input: {
    runnerId: string;
    runId: string;
    attemptId: string;
    fencingToken: string;
    executor: string;
    executorCapability?: Record<string, unknown>;
    runTimeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<void>;
  progress(input: { runnerId: string; runId: string } & AttemptLease & RunProgressInput): Promise<void>;
  complete(input: CompleteRunInput): Promise<void>;
  cancelRun(input: { runId: string; reason?: string; requestedBy?: string }): Promise<CancelRunResult>;
  cancelActiveChannelRun(input: {
    provider: string;
    accountId: string;
    conversationId: string;
    reason?: string;
    requestedBy?: string;
  }): Promise<CancelRunResult>;
  getRun(input: { runId: string }): Promise<OpenTagRunRecord>;
  listRunEvents(input: { runId: string }): Promise<{ events: unknown[] }>;
  getRunLedger(input: { runId: string }): Promise<{ ledger: { runId: string; entries: unknown[] } }>;
  getRunMetrics(input: { runId: string }): Promise<{ metrics: RunMetrics }>;
  getRepoMetrics(input: { provider: string; owner: string; repo: string }): Promise<{ metrics: AggregateMetrics }>;
  getWorkThreadMetrics(input: { threadId: string }): Promise<{ metrics: AggregateMetrics }>;
  getProposal(input: { proposalId: string }): Promise<{ runId: string; snapshot: SuggestedChangesSnapshot }>;
  getProposalLineage(input: { proposalId: string }): Promise<{ lineage: ProposalLineage }>;
  listCurrentMutationIntents(input: { proposalId: string }): Promise<{ intents: MutationIntentActionability[] }>;
  approveProposal(input: { proposalId: string } & ApprovalDecisionInput): Promise<{ decision: ApprovalDecision }>;
  getApprovalDecision(input: { approvalDecisionId: string }): Promise<{ decision: ApprovalDecision }>;
  createApplyPlan(input: { proposalId: string } & ApplyPlanInput): Promise<{ plan: ApplyPlan }>;
  getApplyPlan(input: { applyPlanId: string }): Promise<{ plan: ApplyPlan }>;
  createChildRun(input: { parentRunId: string } & ChildRunInput): Promise<{ run: OpenTagRun }>;
  submitThreadAction(input: ThreadActionInput): Promise<ThreadActionResult>;
};

export type DispatcherRunnerClient = {
  claim(): Promise<ClaimedOpenTagRun | null>;
  markRunning(
    runId: string,
    executor: string,
    lease: AttemptLease,
    options?: { executorCapability?: Record<string, unknown>; runTimeoutMs?: number; idempotencyKey?: string }
  ): Promise<void>;
  heartbeat(runId: string, lease: AttemptLease): Promise<void>;
  progress(runId: string, lease: AttemptLease, input: RunProgressInput & { type: string; at: string }): Promise<void>;
  complete(runId: string, lease: AttemptLease, result: OpenTagRunResult, options?: { idempotencyKey?: string }): Promise<void>;
};

function baseUrlFrom(dispatcherUrl: string): string {
  return dispatcherUrl.replace(/\/$/, "");
}

function authHeaders(pairingToken: string | undefined): Record<string, string> {
  return pairingToken ? { authorization: `Bearer ${pairingToken}` } : {};
}

function jsonHeaders(pairingToken: string | undefined): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders(pairingToken) };
}

function parseRunTimeoutPolicy(value: unknown): RunTimeoutPolicy {
  if (!value || typeof value !== "object") return {};
  const hardTimeoutMs = (value as { hardTimeoutMs?: unknown }).hardTimeoutMs;
  if (hardTimeoutMs === undefined) return {};
  return typeof hardTimeoutMs === "number" && Number.isInteger(hardTimeoutMs) && hardTimeoutMs > 0 ? { hardTimeoutMs } : {};
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${action} failed: ${response.status}${text ? ` ${text}` : ""}`);
  }
}

function parseSourceDeliveryPruneResult(value: unknown): SourceDeliveryPruneResult {
  const result = value as Partial<SourceDeliveryPruneResult> | null;
  if (
    !result ||
    typeof result.scanned !== "number" ||
    typeof result.pruned !== "number" ||
    typeof result.retainedActive !== "number"
  ) {
    throw new Error("pruneSourceDeliveries returned an invalid response.");
  }
  return {
    scanned: result.scanned,
    pruned: result.pruned,
    retainedActive: result.retainedActive
  };
}

function parseClaimedRun(body: {
  run: unknown;
  event: unknown;
  attemptId?: unknown;
  attemptNumber?: unknown;
  fencingToken?: unknown;
}): ClaimedOpenTagRun {
  if (typeof body.attemptId !== "string" || !body.attemptId || typeof body.fencingToken !== "string" || !body.fencingToken) {
    throw new Error("claim returned an invalid attempt lease.");
  }
  if (typeof body.attemptNumber !== "number" || !Number.isInteger(body.attemptNumber) || body.attemptNumber < 1) {
    throw new Error("claim returned an invalid attempt number.");
  }
  return {
    run: OpenTagRunSchema.parse(body.run),
    event: OpenTagEventSchema.parse(body.event),
    attemptId: body.attemptId,
    attemptNumber: body.attemptNumber,
    fencingToken: body.fencingToken
  };
}

export function createOpenTagClient(options: OpenTagClientOptions): OpenTagClient {
  const baseUrl = baseUrlFrom(options.dispatcherUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async registerRunner(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ runnerId: input.runnerId, name: input.name ?? input.runnerId })
      });
      await assertOk(response, "registerRunner");
    },

    async getRunner(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRunner");
      return (await response.json()) as { runner: RunnerRegistration };
    },

    async listControlPlaneAlerts(input = {}) {
      const params = new URLSearchParams();
      if (input.limit !== undefined) params.set("limit", String(input.limit));
      if (input.since) params.set("since", input.since);
      const query = params.toString();
      const response = await fetchImpl(`${baseUrl}/v1/control-plane-alerts${query ? `?${query}` : ""}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listControlPlaneAlerts");
      return (await response.json()) as { alerts: ControlPlaneAlert[] };
    },

    async recordControlPlaneEvent(input) {
      const response = await fetchImpl(`${baseUrl}/v1/control-plane-events`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "recordControlPlaneEvent");
    },

    async pruneSourceDeliveries(input) {
      const response = await fetchImpl(`${baseUrl}/v1/source-deliveries/prune`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "pruneSourceDeliveries");
      const body = (await response.json()) as { result?: unknown };
      return parseSourceDeliveryPruneResult(body.result);
    },

    async bindRepository(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "bindRepository");
    },

    async getRepositoryBinding(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRepositoryBinding");
      return (await response.json()) as { binding: RepoBindingInput };
    },

    async upsertRepoPolicyRule(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}/policy-rules`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ rule: input.rule })
      });
      await assertOk(response, "upsertRepoPolicyRule");
      return (await response.json()) as { rule: PolicyRule };
    },

    async listRepoPolicyRules(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}/policy-rules`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listRepoPolicyRules");
      return (await response.json()) as { rules: PolicyRule[] };
    },

    async upsertRepoMutationMapping(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}/mutation-mappings`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ mapping: input.mapping })
      });
      await assertOk(response, "upsertRepoMutationMapping");
      return (await response.json()) as { mapping: AdapterMutationMapping };
    },

    async listRepoMutationMappings(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}/mutation-mappings`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listRepoMutationMappings");
      return (await response.json()) as { mappings: AdapterMutationMapping[] };
    },

    async createLinearOAuthInstallation(input) {
      const response = await fetchImpl(`${baseUrl}/v1/linear-oauth-installations`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "createLinearOAuthInstallation");
      return (await response.json()) as LinearOAuthInstallationStart;
    },

    async upsertLinearRelayInstallation(input) {
      const response = await fetchImpl(`${baseUrl}/v1/linear-relay-installations`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "upsertLinearRelayInstallation");
      return (await response.json()) as { installation: LinearRelayInstallationSummary };
    },

    async bindChannel(input) {
      const response = await fetchImpl(`${baseUrl}/v1/channel-bindings`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "bindChannel");
    },

    async getChannelBinding(input) {
      const response = await fetchImpl(
        `${baseUrl}/v1/channel-bindings/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.conversationId)}`,
        {
          headers: authHeaders(options.pairingToken)
        }
      );
      await assertOk(response, "getChannelBinding");
      return (await response.json()) as { binding: ChannelBindingInput };
    },

    async getChannelRuntimeStatus(input) {
      const response = await fetchImpl(
        `${baseUrl}/v1/channel-bindings/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.conversationId)}/status`,
        {
          headers: authHeaders(options.pairingToken)
        }
      );
      await assertOk(response, "getChannelRuntimeStatus");
      const body = (await response.json()) as {
        binding: ChannelBindingInput;
        activeRun?: unknown;
        activeEvent?: unknown;
        runTimeoutPolicy?: unknown;
        queuedFollowUps?: unknown[];
      };
      return {
        binding: body.binding,
        ...(body.activeRun ? { activeRun: OpenTagRunSchema.parse(body.activeRun) } : {}),
        ...(body.activeEvent ? { activeEvent: OpenTagEventSchema.parse(body.activeEvent) } : {}),
        ...(body.runTimeoutPolicy ? { runTimeoutPolicy: parseRunTimeoutPolicy(body.runTimeoutPolicy) } : {}),
        queuedFollowUps: (body.queuedFollowUps ?? []).map((followUp) => FollowUpRequestSchema.parse(followUp))
      };
    },

    async unbindChannel(input) {
      const response = await fetchImpl(
        `${baseUrl}/v1/channel-bindings/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.conversationId)}`,
        {
          method: "DELETE",
          headers: authHeaders(options.pairingToken)
        }
      );
      await assertOk(response, "unbindChannel");
    },

    async bindSlackChannel(input) {
      const response = await fetchImpl(`${baseUrl}/v1/slack-channel-bindings`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify(input)
      });
      await assertOk(response, "bindSlackChannel");
    },

    async getSlackChannelBinding(input) {
      const response = await fetchImpl(`${baseUrl}/v1/slack-channel-bindings/${input.teamId}/${input.channelId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getSlackChannelBinding");
      return (await response.json()) as { binding: SlackChannelBindingInput };
    },

    async createRun(input) {
      const event = OpenTagEventSchema.parse(input.event);
      const response = await fetchImpl(`${baseUrl}/v1/runs`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ runId: input.runId, event })
      });
      await assertOk(response, "createRun");
      const body = (await response.json()) as {
        decision: unknown;
        run?: unknown;
        followUpRequest?: unknown;
        idempotentReplay?: unknown;
      };
      const decision = RunAdmissionDecisionSchema.parse(body.decision);
      if (body.run) {
        return {
          outcome: "run_created",
          decision,
          run: OpenTagRunSchema.parse(body.run),
          ...(body.idempotentReplay === true ? { idempotentReplay: true } : {})
        };
      }
      if (body.followUpRequest) {
        return {
          outcome: "follow_up_queued",
          decision,
          followUpRequest: FollowUpRequestSchema.parse(body.followUpRequest)
        };
      }
      return {
        outcome: "needs_human_decision",
        decision
      };
    },

    async getFollowUpRequest(input) {
      const response = await fetchImpl(`${baseUrl}/v1/follow-up-requests/${input.id}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getFollowUpRequest");
      const body = (await response.json()) as { followUpRequest: unknown };
      return { followUpRequest: FollowUpRequestSchema.parse(body.followUpRequest) };
    },

    async createRunFromFollowUpRequest(input) {
      const response = await fetchImpl(`${baseUrl}/v1/follow-up-requests/${input.id}/create-run`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ runId: input.runId })
      });
      await assertOk(response, "createRunFromFollowUpRequest");
      const body = (await response.json()) as { followUpRequest: unknown; run: unknown };
      return {
        followUpRequest: FollowUpRequestSchema.parse(body.followUpRequest),
        run: OpenTagRunSchema.parse(body.run)
      };
    },

    async claim(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/claim`, {
        method: "POST",
        headers: authHeaders(options.pairingToken)
      });
      if (response.status === 204) return null;
      await assertOk(response, "claim");
      return parseClaimedRun((await response.json()) as {
        run: unknown;
        event: unknown;
        attemptId?: unknown;
        attemptNumber?: unknown;
        fencingToken?: unknown;
      });
    },

    async heartbeat(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/heartbeat`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ attemptId: input.attemptId, fencingToken: input.fencingToken })
      });
      await assertOk(response, "heartbeat");
    },

    async markRunning(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/running`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          executor: input.executor,
          attemptId: input.attemptId,
          fencingToken: input.fencingToken,
          ...(input.executorCapability ? { executorCapability: input.executorCapability } : {}),
          ...(input.runTimeoutMs ? { runTimeoutMs: input.runTimeoutMs } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
        })
      });
      await assertOk(response, "markRunning");
    },

    async progress(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/progress`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.type ? { type: input.type } : {}),
          attemptId: input.attemptId,
          fencingToken: input.fencingToken,
          message: input.message,
          ...(input.at ? { at: input.at } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.importance ? { importance: input.importance } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
        })
      });
      await assertOk(response, "progress");
    },

    async complete(input) {
      const result = OpenTagRunResultSchema.parse(input.result);
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/complete`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          result,
          attemptId: input.attemptId,
          fencingToken: input.fencingToken,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
        })
      });
      await assertOk(response, "complete");
    },

    async cancelRun(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/cancel`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.requestedBy ? { requestedBy: input.requestedBy } : {})
        })
      });
      await assertOk(response, "cancelRun");
      const body = (await response.json()) as { outcome: "cancelled"; run: unknown };
      return { outcome: body.outcome, run: OpenTagRunSchema.parse(body.run) };
    },

    async cancelActiveChannelRun(input) {
      const response = await fetchImpl(
        `${baseUrl}/v1/channel-bindings/${encodeURIComponent(input.provider)}/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.conversationId)}/cancel-active-run`,
        {
          method: "POST",
          headers: jsonHeaders(options.pairingToken),
          body: JSON.stringify({
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.requestedBy ? { requestedBy: input.requestedBy } : {})
          })
        }
      );
      await assertOk(response, "cancelActiveChannelRun");
      const body = (await response.json()) as { outcome: "cancelled"; run: unknown };
      return { outcome: body.outcome, run: OpenTagRunSchema.parse(body.run) };
    },

    async getRun(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRun");
      const body = (await response.json()) as { run: unknown; event: unknown };
      return {
        run: OpenTagRunSchema.parse(body.run),
        event: OpenTagEventSchema.parse(body.event)
      };
    },

    async listRunEvents(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/events`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listRunEvents");
      return (await response.json()) as { events: unknown[] };
    },

    async getRunLedger(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/ledger`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRunLedger");
      return (await response.json()) as { ledger: { runId: string; entries: unknown[] } };
    },

    async getRunMetrics(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/metrics`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRunMetrics");
      return (await response.json()) as { metrics: RunMetrics };
    },

    async getRepoMetrics(input) {
      const response = await fetchImpl(`${baseUrl}/v1/repo-bindings/${input.provider}/${input.owner}/${input.repo}/metrics`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRepoMetrics");
      return (await response.json()) as { metrics: AggregateMetrics };
    },

    async getWorkThreadMetrics(input) {
      const response = await fetchImpl(`${baseUrl}/v1/work-thread-metrics?threadId=${encodeURIComponent(input.threadId)}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getWorkThreadMetrics");
      return (await response.json()) as { metrics: AggregateMetrics };
    },

    async getProposal(input) {
      const response = await fetchImpl(`${baseUrl}/v1/proposals/${input.proposalId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getProposal");
      return (await response.json()) as { runId: string; snapshot: SuggestedChangesSnapshot };
    },

    async getProposalLineage(input) {
      const response = await fetchImpl(`${baseUrl}/v1/proposals/${input.proposalId}/lineage`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getProposalLineage");
      return (await response.json()) as { lineage: ProposalLineage };
    },

    async listCurrentMutationIntents(input) {
      const response = await fetchImpl(`${baseUrl}/v1/proposals/${input.proposalId}/current-intents`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listCurrentMutationIntents");
      return (await response.json()) as { intents: MutationIntentActionability[] };
    },

    async approveProposal(input) {
      const response = await fetchImpl(`${baseUrl}/v1/proposals/${input.proposalId}/approvals`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.id ? { id: input.id } : {}),
          approvedIntentIds: input.approvedIntentIds,
          ...(input.rejectedIntentIds?.length ? { rejectedIntentIds: input.rejectedIntentIds } : {}),
          approvedBy: input.approvedBy,
          ...(input.approvedAt ? { approvedAt: input.approvedAt } : {}),
          ...(input.scope ? { scope: input.scope } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {})
        })
      });
      await assertOk(response, "approveProposal");
      return (await response.json()) as { decision: ApprovalDecision };
    },

    async getApprovalDecision(input) {
      const response = await fetchImpl(`${baseUrl}/v1/approvals/${input.approvalDecisionId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getApprovalDecision");
      return (await response.json()) as { decision: ApprovalDecision };
    },

    async createApplyPlan(input) {
      const response = await fetchImpl(`${baseUrl}/v1/proposals/${input.proposalId}/apply-plans`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.id ? { id: input.id } : {}),
          approvalDecisionId: input.approvalDecisionId,
          ...(input.selectedIntentIds !== undefined ? { selectedIntentIds: input.selectedIntentIds } : {}),
          ...(input.adapter ? { adapter: input.adapter } : {}),
          ...(input.execute !== undefined ? { execute: input.execute } : {})
        })
      });
      await assertOk(response, "createApplyPlan");
      return (await response.json()) as { plan: ApplyPlan };
    },

    async getApplyPlan(input) {
      const response = await fetchImpl(`${baseUrl}/v1/apply-plans/${input.applyPlanId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getApplyPlan");
      return (await response.json()) as { plan: ApplyPlan };
    },

    async createChildRun(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.parentRunId}/child-runs`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          runId: input.runId,
          action: input.action,
          ...(input.commandText ? { commandText: input.commandText } : {}),
          ...(input.sourceProposalId ? { sourceProposalId: input.sourceProposalId } : {}),
          ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {})
        })
      });
      await assertOk(response, "createChildRun");
      const body = (await response.json()) as { run: unknown };
      return { run: OpenTagRunSchema.parse(body.run) };
    },

    async submitThreadAction(input) {
      const response = await fetchImpl(`${baseUrl}/v1/thread-actions`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.id ? { id: input.id } : {}),
          rawText: input.rawText,
          actor: input.actor,
          callback: {
            provider: input.callback.provider,
            uri: input.callback.uri,
            ...(input.callback.threadKey ? { threadKey: input.callback.threadKey } : {})
          },
          ...(input.metadata ? { metadata: input.metadata } : {})
        })
      });
      await assertOk(response, "submitThreadAction");
      return (await response.json()) as ThreadActionResult;
    }
  };
}

export function createDispatcherClient(options: RunnerClientOptions): DispatcherRunnerClient {
  const client = createOpenTagClient(options);
  return {
    claim: () => client.claim({ runnerId: options.runnerId }),
    markRunning: (runId, executor, lease, markRunningOptions) =>
      client.markRunning({
        runnerId: options.runnerId,
        runId,
        executor,
        ...lease,
        ...(markRunningOptions?.executorCapability ? { executorCapability: markRunningOptions.executorCapability } : {}),
        ...(markRunningOptions?.runTimeoutMs ? { runTimeoutMs: markRunningOptions.runTimeoutMs } : {}),
        ...(markRunningOptions?.idempotencyKey ? { idempotencyKey: markRunningOptions.idempotencyKey } : {})
      }),
    heartbeat: (runId, lease) => client.heartbeat({ runnerId: options.runnerId, runId, ...lease }),
    progress: (runId, lease, input) => client.progress({ runnerId: options.runnerId, runId, ...lease, ...input }),
    complete: (runId, lease, result, completeOptions) =>
      client.complete({
        runnerId: options.runnerId,
        runId,
        ...lease,
        result,
        ...(completeOptions?.idempotencyKey ? { idempotencyKey: completeOptions.idempotencyKey } : {})
      })
  };
}

export function createDispatcherAdminClient(options: RunnerClientOptions) {
  const client = createOpenTagClient(options);
  return {
    registerRunner(name = options.runnerId): Promise<void> {
      return client.registerRunner({ runnerId: options.runnerId, name });
    },

    bindRepository(binding: RepositoryBindingConfig): Promise<void> {
      return client.bindRepository({
        provider: binding.provider,
        owner: binding.owner,
        repo: binding.repo,
        runnerId: options.runnerId,
        workspacePath: binding.checkoutPath,
        ...(binding.defaultExecutor ? { defaultExecutor: binding.defaultExecutor } : {})
      });
    },

    bindSlackChannel(binding: SlackChannelBindingInput): Promise<void> {
      return client.bindSlackChannel(binding);
    },

    bindChannel(binding: ChannelBindingInput): Promise<void> {
      return client.bindChannel(binding);
    },

    upsertRepoMutationMapping(input: {
      provider: string;
      owner: string;
      repo: string;
      mapping: AdapterMutationMapping;
    }): Promise<{ mapping: AdapterMutationMapping }> {
      return client.upsertRepoMutationMapping(input);
    },

    createLinearOAuthInstallation(input: CreateLinearOAuthInstallationInput): Promise<LinearOAuthInstallationStart> {
      return client.createLinearOAuthInstallation(input);
    },

    upsertLinearRelayInstallation(input: LinearRelayInstallationInput): Promise<{ installation: LinearRelayInstallationSummary }> {
      return client.upsertLinearRelayInstallation(input);
    },

    getChannelBinding(input: {
      provider: string;
      accountId: string;
      conversationId: string;
    }): Promise<{ binding: ChannelBindingInput }> {
      return client.getChannelBinding(input);
    },

    unbindChannel(input: { provider: string; accountId: string; conversationId: string }): Promise<void> {
      return client.unbindChannel(input);
    }
  };
}
