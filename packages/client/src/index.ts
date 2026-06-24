import {
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  OpenTagRunSchema,
  type OpenTagEvent,
  type OpenTagRun,
  type OpenTagRunResult
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
  securityPolicy?: RepoSecurityPolicy;
};

export type RepoSecurityPolicy = {
  readAllowedActors?: string[];
  writeAllowedActors?: string[];
  blockedActors?: string[];
  allowedRunnerIds?: string[];
  approvalRequiredScopes?: string[];
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
};

export type CreateRunInput = {
  runId: string;
  event: OpenTagEvent;
};

export type OpenTagClient = {
  registerRunner(input: { runnerId: string; name?: string }): Promise<void>;
  bindRepository(input: RepoBindingInput): Promise<void>;
  getRepositoryBinding(input: { provider: string; owner: string; repo: string }): Promise<{ binding: RepoBindingInput }>;
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
};

export type DispatcherRunnerClient = {
  claim(): Promise<ClaimedOpenTagRun | null>;
  markRunning(runId: string, executor: string): Promise<void>;
  heartbeat(runId: string): Promise<void>;
  progress(runId: string, input: Required<RunProgressInput>): Promise<void>;
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
          ...(input.at ? { at: input.at } : {})
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
