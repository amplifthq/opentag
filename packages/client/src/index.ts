import {
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  OpenTagRunSchema,
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
};

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
};

export type SlackChannelBindingInput = {
  teamId: string;
  channelId: string;
  owner: string;
  repo: string;
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
};

export type CreateRunInput = {
  runId: string;
  event: OpenTagEvent;
};

export type ApprovalDecisionInput = {
  id?: string;
  approvedIntentIds: string[];
  rejectedIntentIds?: string[];
  approvedBy: ActorIdentity;
  approvedAt?: string;
  scope?: "manual" | "policy";
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

export type OpenTagClient = {
  registerRunner(input: { runnerId: string; name?: string }): Promise<void>;
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
  bindSlackChannel(input: SlackChannelBindingInput): Promise<void>;
  getSlackChannelBinding(input: { teamId: string; channelId: string }): Promise<{ binding: SlackChannelBindingInput }>;
  createRun(input: CreateRunInput): Promise<{ run: OpenTagRun }>;
  claim(input: { runnerId: string }): Promise<ClaimedOpenTagRun | null>;
  heartbeat(input: { runnerId: string; runId: string }): Promise<void>;
  markRunning(input: { runId: string; executor: string }): Promise<void>;
  progress(input: { runId: string } & RunProgressInput): Promise<void>;
  complete(input: { runId: string; result: OpenTagRunResult }): Promise<void>;
  getRun(input: { runId: string }): Promise<ClaimedOpenTagRun>;
  listRunEvents(input: { runId: string }): Promise<{ events: unknown[] }>;
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
};

export type DispatcherRunnerClient = {
  claim(): Promise<ClaimedOpenTagRun | null>;
  markRunning(runId: string, executor: string): Promise<void>;
  heartbeat(runId: string): Promise<void>;
  progress(runId: string, input: RunProgressInput & { type: string; at: string }): Promise<void>;
  complete(runId: string, result: OpenTagRunResult): Promise<void>;
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

async function assertOk(response: Response, action: string): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${action} failed: ${response.status}${text ? ` ${text}` : ""}`);
  }
}

function parseClaimedRun(body: { run: unknown; event: unknown }): ClaimedOpenTagRun {
  return {
    run: OpenTagRunSchema.parse(body.run),
    event: OpenTagEventSchema.parse(body.event)
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
      const body = (await response.json()) as { run: unknown };
      return { run: OpenTagRunSchema.parse(body.run) };
    },

    async claim(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/claim`, {
        method: "POST",
        headers: authHeaders(options.pairingToken)
      });
      if (response.status === 204) return null;
      await assertOk(response, "claim");
      return parseClaimedRun((await response.json()) as { run: unknown; event: unknown });
    },

    async heartbeat(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runners/${input.runnerId}/runs/${input.runId}/heartbeat`, {
        method: "POST",
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "heartbeat");
    },

    async markRunning(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/running`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ executor: input.executor })
      });
      await assertOk(response, "markRunning");
    },

    async progress(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/progress`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({
          ...(input.type ? { type: input.type } : {}),
          message: input.message,
          ...(input.at ? { at: input.at } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.importance ? { importance: input.importance } : {})
        })
      });
      await assertOk(response, "progress");
    },

    async complete(input) {
      const result = OpenTagRunResultSchema.parse(input.result);
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/complete`, {
        method: "POST",
        headers: jsonHeaders(options.pairingToken),
        body: JSON.stringify({ result })
      });
      await assertOk(response, "complete");
    },

    async getRun(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "getRun");
      return parseClaimedRun((await response.json()) as { run: unknown; event: unknown });
    },

    async listRunEvents(input) {
      const response = await fetchImpl(`${baseUrl}/v1/runs/${input.runId}/events`, {
        headers: authHeaders(options.pairingToken)
      });
      await assertOk(response, "listRunEvents");
      return (await response.json()) as { events: unknown[] };
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
          ...(input.scope ? { scope: input.scope } : {})
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
          ...(input.selectedIntentIds?.length ? { selectedIntentIds: input.selectedIntentIds } : {}),
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
    }
  };
}

export function createDispatcherClient(options: RunnerClientOptions): DispatcherRunnerClient {
  const client = createOpenTagClient(options);
  return {
    claim: () => client.claim({ runnerId: options.runnerId }),
    markRunning: (runId, executor) => client.markRunning({ runId, executor }),
    heartbeat: (runId) => client.heartbeat({ runnerId: options.runnerId, runId }),
    progress: (runId, input) => client.progress({ runId, ...input }),
    complete: (runId, result) => client.complete({ runId, result })
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
    }
  };
}
