import {
  AdapterMutationMappingSchema,
  ActorIdentitySchema,
  ActionHintSchema,
  type OpenTagEvent,
  createAdapterMutationCompilerRegistry,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  PolicyRuleSchema,
  RunEventImportanceSchema,
  RunEventVisibilitySchema
} from "@opentag/core";
import {
  applyGitHubIssueMutationOperation,
  createGitHubIssueMutationCompiler,
  type FetchLike as GitHubFetchLike
} from "@opentag/github";
import type { GitHubIssueMutationOperation } from "@opentag/github";
import type { SlackBlock } from "@opentag/slack";
import { createOpenTagRepository, migrateSchema } from "@opentag/store";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { z } from "zod";
import { createAdmissionRuntime, type AgentAccessProfileCheck } from "./admission.js";
import { createDefaultCallbackPresentation, type CallbackPresentation } from "./presentation.js";

const CreateRunnerSchema = z.object({
  runnerId: z.string().min(1),
  name: z.string().min(1)
});

const CreateRepoBindingSchema = z.object({
  provider: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  runnerId: z.string().min(1),
  workspacePath: z.string().min(1).optional(),
  defaultExecutor: z.string().min(1).optional(),
  allowedActors: z.array(z.string().min(1)).optional()
});

const CreateSlackChannelBindingSchema = z.object({
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  repoProvider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1)
});

const CreateChannelBindingSchema = z.object({
  provider: z.string().min(1),
  accountId: z.string().min(1),
  conversationId: z.string().min(1),
  repoProvider: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const UpsertPolicyRuleSchema = z.object({
  rule: PolicyRuleSchema
});

const UpsertMutationMappingSchema = z.object({
  mapping: AdapterMutationMappingSchema
});

const CreateRunSchema = z.object({
  runId: z.string().min(1),
  event: OpenTagEventSchema
});

const PromoteFollowUpRequestSchema = z.object({
  runId: z.string().min(1)
});

const CompleteRunSchema = z.object({
  result: OpenTagRunResultSchema
});

const ApprovalDecisionInputSchema = z.object({
  id: z.string().min(1).optional(),
  approvedIntentIds: z.array(z.string().min(1)),
  rejectedIntentIds: z.array(z.string().min(1)).optional(),
  approvedBy: ActorIdentitySchema,
  approvedAt: z.string().datetime().optional(),
  scope: z.enum(["manual", "policy"]).default("manual")
}).refine((value) => {
  const rejected = new Set(value.rejectedIntentIds ?? []);
  return value.approvedIntentIds.every((intentId) => !rejected.has(intentId));
}, {
  message: "approvedIntentIds and rejectedIntentIds must not overlap"
});

const ApplyPlanInputSchema = z.object({
  id: z.string().min(1).optional(),
  approvalDecisionId: z.string().min(1),
  selectedIntentIds: z.array(z.string().min(1)).optional(),
  adapter: z.string().min(1).optional(),
  execute: z.boolean().optional()
});

const ChildRunInputSchema = z.object({
  runId: z.string().min(1),
  action: ActionHintSchema,
  commandText: z.string().min(1).optional(),
  sourceProposalId: z.string().min(1).optional(),
  sourceApplyPlanId: z.string().min(1).optional()
});

const ProgressSchema = z.object({
  type: z.string().min(1).optional(),
  message: z.string().min(1),
  at: z.string().datetime().optional(),
  visibility: RunEventVisibilitySchema.optional(),
  importance: RunEventImportanceSchema.optional()
});

function childEventFromParent(input: {
  parentEvent: OpenTagEvent;
  childRunId: string;
  commandText?: string;
  actionKind: string;
  receivedAt: string;
}): OpenTagEvent {
  return {
    ...input.parentEvent,
    id: `evt_${input.childRunId}`,
    sourceEventId: `${input.parentEvent.sourceEventId}:${input.childRunId}`,
    receivedAt: input.receivedAt,
    command: {
      rawText: input.commandText ?? `Execute next action: ${input.actionKind}`,
      intent: "run",
      args: {
        parentSourceEventId: input.parentEvent.sourceEventId,
        actionKind: input.actionKind
      }
    }
  };
}

function mappingsFromAdapterPlan(adapterPlan: unknown) {
  if (!adapterPlan || typeof adapterPlan !== "object" || Array.isArray(adapterPlan)) return [];
  const mappings = (adapterPlan as { mappings?: unknown }).mappings;
  if (!Array.isArray(mappings)) return [];
  return mappings.map((mapping) => AdapterMutationMappingSchema.parse(mapping));
}

export type CallbackMessage = {
  runId: string;
  kind: "acknowledgement" | "progress" | "final";
  provider: "github" | "slack" | "telegram" | "lark" | "webhook";
  uri: string;
  body: string;
  agentId?: string;
  threadKey?: string;
  statusMessageKey?: string;
  blocks?: SlackBlock[];
};

export type CallbackSink = {
  deliver(message: CallbackMessage): Promise<void>;
};

export type CallbackRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: Date;
};

export type GitHubApplyOptions = {
  token: string;
  fetchImpl?: GitHubFetchLike;
};

const noopCallbackSink: CallbackSink = {
  async deliver() {
    return;
  }
};

function nextCallbackAttemptAt(input: { attempts: number } & CallbackRetryOptions): string | undefined {
  const maxAttempts = input.maxAttempts ?? 5;
  const nextAttempt = input.attempts + 1;
  if (nextAttempt >= maxAttempts) return undefined;

  const baseDelayMs = input.baseDelayMs ?? 5_000;
  const maxDelayMs = input.maxDelayMs ?? 300_000;
  const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, input.attempts));
  return new Date((input.now ?? new Date()).getTime() + delayMs).toISOString();
}

async function deliverCallbackDelivery(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: CallbackSink;
  delivery: import("@opentag/store").CallbackDelivery;
  retry?: CallbackRetryOptions;
}): Promise<boolean> {
  try {
    await input.sink.deliver({
      runId: input.delivery.runId,
      kind: input.delivery.kind,
      provider: input.delivery.provider,
      uri: input.delivery.uri,
      body: input.delivery.body,
      ...(input.delivery.threadKey ? { threadKey: input.delivery.threadKey } : {}),
      ...(input.delivery.agentId ? { agentId: input.delivery.agentId } : {}),
      ...(input.delivery.statusMessageKey ? { statusMessageKey: input.delivery.statusMessageKey } : {}),
      ...(input.delivery.blocks ? { blocks: input.delivery.blocks as SlackBlock[] } : {})
    });
    await input.repo.markCallbackDelivered({ deliveryId: input.delivery.id });
    return true;
  } catch (error) {
    const nextAttemptAt = nextCallbackAttemptAt({ attempts: input.delivery.attempts, ...(input.retry ?? {}) });
    await input.repo.markCallbackFailed({
      deliveryId: input.delivery.id,
      error: error instanceof Error ? error.message : String(error),
      ...(nextAttemptAt ? { nextAttemptAt } : {})
    });
    return false;
  }
}

export async function processPendingCallbacks(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: CallbackSink;
  limit?: number;
  retry?: CallbackRetryOptions;
}): Promise<{ processed: number; delivered: number; failed: number }> {
  const maxAttempts = input.retry?.maxAttempts ?? 5;
  const deliveries = await input.repo.claimPendingCallbackDeliveries({
    limit: input.limit ?? 20,
    ...(input.retry?.now ? { now: input.retry.now } : {}),
    maxAttempts
  });
  const result = { processed: 0, delivered: 0, failed: 0 };
  for (const delivery of deliveries) {
    result.processed += 1;
    const delivered = await deliverCallbackDelivery({
      repo: input.repo,
      sink: input.sink,
      delivery,
      ...(input.retry ? { retry: input.retry } : {})
    });
    if (delivered) {
      result.delivered += 1;
    } else {
      result.failed += 1;
    }
  }
  return result;
}

async function deliverAndAudit(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: CallbackSink;
  message: CallbackMessage;
  retry?: CallbackRetryOptions;
}): Promise<void> {
  const delivery = await input.repo.enqueueCallbackDelivery({
    runId: input.message.runId,
    kind: input.message.kind,
    provider: input.message.provider,
    uri: input.message.uri,
    body: input.message.body,
    ...(input.message.threadKey ? { threadKey: input.message.threadKey } : {}),
    ...(input.message.agentId ? { agentId: input.message.agentId } : {}),
    ...(input.message.statusMessageKey ? { statusMessageKey: input.message.statusMessageKey } : {}),
    ...(input.message.blocks ? { blocks: input.message.blocks } : {})
  });
  await deliverCallbackDelivery({
    repo: input.repo,
    sink: input.sink,
    delivery,
    ...(input.retry ? { retry: input.retry } : {})
  });
}

function isAuthorized(request: Request, pairingToken: string | undefined): boolean {
  if (!pairingToken) return true;
  return request.headers.get("authorization") === `Bearer ${pairingToken}`;
}

export function createDispatcherApp(input: {
  databasePath: string;
  callbackSink?: CallbackSink;
  pairingToken?: string;
  presentation?: CallbackPresentation;
  githubApply?: GitHubApplyOptions;
  callbackRetry?: CallbackRetryOptions;
  agentAccessProfileCheck?: AgentAccessProfileCheck;
}) {
  const sqlite = new Database(input.databasePath);
  migrateSchema(sqlite);
  const repo = createOpenTagRepository(drizzle(sqlite));
  const app = new Hono();
  const callbackSink = input.callbackSink ?? noopCallbackSink;
  const presentation = input.presentation ?? createDefaultCallbackPresentation();
  const callbackRetry = input.callbackRetry ?? {};
  const admission = createAdmissionRuntime({
    repo,
    ...(input.agentAccessProfileCheck ? { agentAccessProfileCheck: input.agentAccessProfileCheck } : {})
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    if (!isAuthorized(c.req.raw, input.pairingToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.post("/v1/runners", async (c) => {
    const parsed = CreateRunnerSchema.parse(await c.req.json());
    await repo.registerRunner(parsed);
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/runners/:runnerId", async (c) => {
    const runner = await repo.getRunner({ runnerId: c.req.param("runnerId") });
    if (!runner) return c.json({ error: "runner_not_found" }, 404);
    return c.json({ runner });
  });

  app.post("/v1/repo-bindings", async (c) => {
    const parsed = CreateRepoBindingSchema.parse(await c.req.json());
    await repo.createRepoBinding({
      provider: parsed.provider,
      owner: parsed.owner,
      repo: parsed.repo,
      runnerId: parsed.runnerId,
      ...(parsed.workspacePath ? { workspacePath: parsed.workspacePath } : {}),
      ...(parsed.defaultExecutor ? { defaultExecutor: parsed.defaultExecutor } : {}),
      ...(parsed.allowedActors?.length ? { allowedActors: parsed.allowedActors } : {})
    });
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo", async (c) => {
    const binding = await repo.getRepoBinding({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    if (!binding) return c.json({ error: "repo_binding_not_found" }, 404);
    return c.json({ binding });
  });

  app.post("/v1/repo-bindings/:provider/:owner/:repo/policy-rules", async (c) => {
    const parsed = UpsertPolicyRuleSchema.parse(await c.req.json());
    const rule = await repo.upsertRepoPolicyRule({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo"),
      rule: parsed.rule
    });
    return c.json({ rule }, 201);
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo/policy-rules", async (c) => {
    const rules = await repo.listRepoPolicyRules({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    return c.json({ rules });
  });

  app.post("/v1/repo-bindings/:provider/:owner/:repo/mutation-mappings", async (c) => {
    const parsed = UpsertMutationMappingSchema.parse(await c.req.json());
    const mapping = await repo.upsertRepoMutationMapping({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo"),
      mapping: parsed.mapping
    });
    return c.json({ mapping }, 201);
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo/mutation-mappings", async (c) => {
    const mappings = await repo.listRepoMutationMappings({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    return c.json({ mappings });
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo/metrics", async (c) => {
    const metrics = await repo.getRepoMetrics({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    return c.json({ metrics });
  });

  app.get("/v1/work-thread-metrics", async (c) => {
    const threadId = c.req.query("threadId");
    if (!threadId) return c.json({ error: "thread_id_required" }, 422);
    const metrics = await repo.getWorkThreadMetrics({ threadId });
    return c.json({ metrics });
  });

  app.post("/v1/channel-bindings", async (c) => {
    const parsed = CreateChannelBindingSchema.parse(await c.req.json());
    await repo.upsertChannelBinding({
      provider: parsed.provider,
      accountId: parsed.accountId,
      conversationId: parsed.conversationId,
      repoProvider: parsed.repoProvider,
      owner: parsed.owner,
      repo: parsed.repo,
      ...(parsed.metadata ? { metadata: parsed.metadata } : {})
    });
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/channel-bindings/:provider/:accountId/:conversationId", async (c) => {
    const binding = await repo.getChannelBinding({
      provider: c.req.param("provider"),
      accountId: c.req.param("accountId"),
      conversationId: c.req.param("conversationId")
    });
    if (!binding) return c.json({ error: "channel_binding_not_found" }, 404);
    return c.json({ binding });
  });

  app.post("/v1/slack-channel-bindings", async (c) => {
    const parsed = CreateSlackChannelBindingSchema.parse(await c.req.json());
    await repo.createSlackChannelBinding(parsed);
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/slack-channel-bindings/:teamId/:channelId", async (c) => {
    const binding = await repo.getSlackChannelBinding({
      teamId: c.req.param("teamId"),
      channelId: c.req.param("channelId")
    });
    if (!binding) return c.json({ error: "slack_channel_binding_not_found" }, 404);
    return c.json({ binding });
  });

  app.post("/v1/runs", async (c) => {
    const parsed = CreateRunSchema.parse(await c.req.json());
    const admitted = await admission.admitRun({ requestId: parsed.runId, event: parsed.event });

    if (admitted.outcome === "needs_human_decision") {
      return c.json({ decision: admitted.decision }, 202);
    }

    if (admitted.outcome === "drop_duplicate") {
      await repo.appendRunEvent({
        runId: admitted.run.id,
        type: "admission.decided",
        payload: admitted.decision,
        visibility: "audit",
        importance: "normal",
        message: admitted.decision.reason
      });
      await repo.appendRunEvent({
        runId: admitted.run.id,
        type: "run.create_idempotent_replay",
        payload: { requestedRunId: parsed.runId, eventId: parsed.event.id },
        visibility: "audit",
        importance: "low"
      });
      return c.json({ decision: admitted.decision, run: admitted.run, idempotentReplay: true }, 200);
    }

    if (admitted.outcome === "follow_up_queued") {
      return c.json({ decision: admitted.decision, followUpRequest: admitted.followUpRequest }, 202);
    }

    const createdRun = await repo.createRun({ id: parsed.runId, event: parsed.event });
    if (!createdRun.created) {
      return c.json(
        {
          decision: {
            ...admitted.decision,
            action: "drop_duplicate",
            reason: "Source event already created a run.",
            reasonCode: "duplicate_source_event",
            activeRunId: createdRun.run.id
          },
          run: createdRun.run,
          idempotentReplay: true
        },
        200
      );
    }
    const { run } = createdRun;
    if (presentation.shouldDeliverAcknowledgement(parsed.event.callback.provider)) {
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: run.id,
          kind: "acknowledgement",
          provider: parsed.event.callback.provider,
          uri: parsed.event.callback.uri,
          body: presentation.acknowledgement({ provider: parsed.event.callback.provider, runId: run.id }),
          ...(parsed.event.target.agentId ? { agentId: parsed.event.target.agentId } : {}),
          ...(parsed.event.callback.threadKey ? { threadKey: parsed.event.callback.threadKey } : {})
        }
      });
    }
    return c.json({ decision: admitted.decision, run }, 201);
  });

  app.get("/v1/follow-up-requests/:id", async (c) => {
    const followUpRequest = await repo.getFollowUpRequest({ id: c.req.param("id") });
    if (!followUpRequest) return c.json({ error: "follow_up_request_not_found" }, 404);
    return c.json({ followUpRequest });
  });

  app.post("/v1/follow-up-requests/:id/create-run", async (c) => {
    const parsed = PromoteFollowUpRequestSchema.parse(await c.req.json());
    let promoted;
    try {
      promoted = await repo.createRunFromFollowUpRequest({
        followUpRequestId: c.req.param("id"),
        runId: parsed.runId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Follow-up request not found:")) {
        return c.json({ error: "follow_up_request_not_found" }, 404);
      }
      if (message.includes("is not queued")) {
        return c.json({ error: "follow_up_request_not_queued" }, 409);
      }
      throw error;
    }
    const followUpRequest = promoted.followUpRequest;
    const event = followUpRequest.event;
    if (presentation.shouldDeliverAcknowledgement(event.callback.provider)) {
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: promoted.run.id,
          kind: "acknowledgement",
          provider: event.callback.provider,
          uri: event.callback.uri,
          body: presentation.acknowledgement({ provider: event.callback.provider, runId: promoted.run.id }),
          ...(event.target.agentId ? { agentId: event.target.agentId } : {}),
          ...(event.callback.threadKey ? { threadKey: event.callback.threadKey } : {})
        }
      });
    }
    return c.json({ followUpRequest, run: promoted.run }, 201);
  });

  app.post("/v1/runners/:runnerId/claim", async (c) => {
    const claimed = await repo.claimNextRun({ runnerId: c.req.param("runnerId"), leaseSeconds: 60 });
    if (!claimed) return c.body(null, 204);
    return c.json(claimed, 200);
  });

  app.post("/v1/runners/:runnerId/runs/:runId/heartbeat", async (c) => {
    const ok = await repo.heartbeat({ runnerId: c.req.param("runnerId"), runId: c.req.param("runId") });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
    return c.json({ ok: true });
  });

  app.post("/v1/runs/:runId/running", async (c) => {
    return c.json({
      error: "runner_scoped_endpoint_required",
      message: "Use /v1/runners/:runnerId/runs/:runId/running, /progress, or /complete."
    }, 410);
  });

  app.post("/v1/runners/:runnerId/runs/:runId/running", async (c) => {
    const body = z.object({ executor: z.string().min(1) }).parse(await c.req.json());
    const ok = await repo.markRunning({
      runId: c.req.param("runId"),
      runnerId: c.req.param("runnerId"),
      executor: body.executor
    });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
    return c.json({ ok: true });
  });

  app.post("/v1/runs/:runId/progress", async () => {
    return new Response(JSON.stringify({
      error: "runner_scoped_endpoint_required",
      message: "Use /v1/runners/:runnerId/runs/:runId/running, /progress, or /complete."
    }), { status: 410, headers: { "content-type": "application/json" } });
  });

  app.post("/v1/runners/:runnerId/runs/:runId/progress", async (c) => {
    const runId = c.req.param("runId");
    const body = ProgressSchema.parse(await c.req.json());
    const ok = await repo.recordProgress({
      runId,
      runnerId: c.req.param("runnerId"),
      message: body.message,
      ...(body.type ? { type: body.type } : {}),
      ...(body.at ? { at: body.at } : {}),
      ...(body.visibility ? { visibility: body.visibility } : {}),
      ...(body.importance ? { importance: body.importance } : {})
    });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    if (presentation.shouldDeliverProgress(stored.event.callback.provider)) {
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId,
          kind: "progress",
          provider: stored.event.callback.provider,
          uri: stored.event.callback.uri,
          body: presentation.progress({ provider: stored.event.callback.provider, runId, message: body.message }),
          ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
          ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
          statusMessageKey: `${runId}:status`
        }
      });
    }
    return c.json({ ok: true });
  });

  app.post("/v1/runs/:runId/complete", async () => {
    return new Response(JSON.stringify({
      error: "runner_scoped_endpoint_required",
      message: "Use /v1/runners/:runnerId/runs/:runId/running, /progress, or /complete."
    }), { status: 410, headers: { "content-type": "application/json" } });
  });

  app.post("/v1/runners/:runnerId/runs/:runId/complete", async (c) => {
    const runId = c.req.param("runId");
    const parsed = CompleteRunSchema.parse(await c.req.json());
    const ok = await repo.completeRun({ runId, runnerId: c.req.param("runnerId"), result: parsed.result });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const finalPresentation = presentation.final({ provider: stored.event.callback.provider, result: parsed.result });
    await deliverAndAudit({
      repo,
      sink: callbackSink,
      retry: callbackRetry,
      message: {
        runId,
        kind: "final",
        provider: stored.event.callback.provider,
        uri: stored.event.callback.uri,
        body: finalPresentation.body,
        ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
        ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
        ...(finalPresentation.blocks?.length ? { blocks: finalPresentation.blocks } : {})
      }
    });
    return c.json({ ok: true });
  });

  app.get("/v1/proposals/:proposalId", async (c) => {
    const proposal = await repo.getSuggestedChanges({ proposalId: c.req.param("proposalId") });
    if (!proposal) return c.json({ error: "proposal_not_found" }, 404);
    return c.json(proposal);
  });

  app.get("/v1/proposals/:proposalId/lineage", async (c) => {
    const lineage = await repo.getProposalLineage({ proposalId: c.req.param("proposalId") });
    if (!lineage) return c.json({ error: "proposal_not_found" }, 404);
    return c.json({ lineage });
  });

  app.get("/v1/proposals/:proposalId/current-intents", async (c) => {
    const intents = await repo.listCurrentMutationIntents({ proposalId: c.req.param("proposalId") });
    if (!intents) return c.json({ error: "proposal_not_found" }, 404);
    return c.json({ intents });
  });

  app.post("/v1/proposals/:proposalId/approvals", async (c) => {
    const proposalId = c.req.param("proposalId");
    const parsedBody = ApprovalDecisionInputSchema.safeParse(await c.req.json());
    if (!parsedBody.success) return c.json({ error: "invalid_approval_decision" }, 400);
    const body = parsedBody.data;
    const decision = await repo.recordApprovalDecision({
      id: body.id ?? `approval_${proposalId}_${Date.now()}`,
      proposalId,
      approvedIntentIds: body.approvedIntentIds,
      ...(body.rejectedIntentIds?.length ? { rejectedIntentIds: body.rejectedIntentIds } : {}),
      approvedBy: body.approvedBy,
      approvedAt: body.approvedAt ?? new Date().toISOString(),
      scope: body.scope
    });
    if (!decision) return c.json({ error: "proposal_not_found" }, 404);
    return c.json({ decision }, 201);
  });

  app.get("/v1/approvals/:approvalDecisionId", async (c) => {
    const decision = await repo.getApprovalDecision({ id: c.req.param("approvalDecisionId") });
    if (!decision) return c.json({ error: "approval_decision_not_found" }, 404);
    return c.json({ decision });
  });

  app.post("/v1/proposals/:proposalId/apply-plans", async (c) => {
    const proposalId = c.req.param("proposalId");
    const body = ApplyPlanInputSchema.parse(await c.req.json());
    let executableTarget:
      | {
          proposal: NonNullable<Awaited<ReturnType<typeof repo.getSuggestedChanges>>>;
          owner: string;
          repoName: string;
          issueNumber: number;
        }
      | undefined;

    if (body.execute) {
      if (body.adapter !== "github") {
        return c.json({ error: "apply_execution_adapter_not_supported" }, 422);
      }
      if (!input.githubApply) {
        return c.json({ error: "github_apply_not_configured" }, 422);
      }
      const proposal = await repo.getSuggestedChanges({ proposalId });
      if (!proposal) return c.json({ error: "proposal_not_found" }, 404);
      const stored = await repo.getRun({ runId: proposal.runId });
      if (!stored) return c.json({ error: "run_not_found" }, 404);
      const owner = stored.event.metadata["owner"];
      const repoName = stored.event.metadata["repo"];
      const issueNumber = stored.event.metadata["issueNumber"];
      if (typeof owner !== "string" || typeof repoName !== "string" || typeof issueNumber !== "number") {
        return c.json({ error: "github_issue_target_missing" }, 422);
      }
      executableTarget = { proposal, owner, repoName, issueNumber };
    }

    const plan = await repo.createApplyPlan({
      id: body.id ?? `apply_${proposalId}_${Date.now()}`,
      proposalId,
      approvalDecisionId: body.approvalDecisionId,
      ...(body.selectedIntentIds !== undefined ? { selectedIntentIds: body.selectedIntentIds } : {}),
      ...(body.adapter ? { adapter: body.adapter } : {})
    });
    if (!plan) return c.json({ error: "proposal_or_approval_not_found" }, 404);
    if (body.execute && executableTarget) {
      const githubApply = input.githubApply;
      if (!githubApply) {
        return c.json({ error: "github_apply_not_configured" }, 422);
      }
      const preflightOutcomeByIntentId = new Map((plan.outcomes ?? []).map((outcome) => [outcome.intentId, outcome]));
      const executableIntents = executableTarget.proposal.snapshot.intents.filter((intent) => {
        const outcome = preflightOutcomeByIntentId.get(intent.intentId);
        return outcome?.outcome === "skipped" && outcome.message?.startsWith("Preflight passed");
      });
      const target = {
        token: githubApply.token,
        owner: executableTarget.owner,
        repo: executableTarget.repoName,
        issueNumber: executableTarget.issueNumber
      };
      const executedOutcomes = [];
      const compilerRegistry = createAdapterMutationCompilerRegistry([
        createGitHubIssueMutationCompiler({ mappings: mappingsFromAdapterPlan(plan.adapterPlan) })
      ]);
      for (const compilation of compilerRegistry.compile("github", executableIntents)) {
        if (!compilation.ok) {
          executedOutcomes.push(compilation.outcome);
          continue;
        }
        executedOutcomes.push(
          await applyGitHubIssueMutationOperation({
            target,
            operation: compilation.operation as GitHubIssueMutationOperation,
            ...(githubApply.fetchImpl ? { fetchImpl: githubApply.fetchImpl } : {})
          })
        );
      }
      const executedOutcomeByIntentId = new Map(executedOutcomes.map((outcome) => [outcome.intentId, outcome]));
      const mergedOutcomes = (plan.outcomes ?? []).map((outcome) => executedOutcomeByIntentId.get(outcome.intentId) ?? outcome);
      const executedPlan = await repo.updateApplyPlanOutcomes({
        id: plan.id,
        outcomes: mergedOutcomes,
        externalWritesExecuted: true
      });
      return c.json({ plan: executedPlan ?? plan }, 201);
    }
    return c.json({ plan }, 201);
  });

  app.get("/v1/apply-plans/:applyPlanId", async (c) => {
    const plan = await repo.getApplyPlan({ id: c.req.param("applyPlanId") });
    if (!plan) return c.json({ error: "apply_plan_not_found" }, 404);
    return c.json({ plan });
  });

  app.post("/v1/runs/:runId/child-runs", async (c) => {
    const parentRunId = c.req.param("runId");
    const body = ChildRunInputSchema.parse(await c.req.json());
    const parent = await repo.getRun({ runId: parentRunId });
    if (!parent) return c.json({ error: "parent_run_not_found" }, 404);
    const receivedAt = new Date().toISOString();
    const sourceProposalId = body.sourceProposalId ?? body.action.targetId;
    const { run } = await repo.createRun({
      id: body.runId,
      event: childEventFromParent({
        parentEvent: parent.event,
        childRunId: body.runId,
        ...(body.commandText ? { commandText: body.commandText } : {}),
        actionKind: body.action.kind,
        receivedAt
      }),
      parentRunId,
      triggeredByAction: body.action,
      ...(sourceProposalId ? { sourceProposalId } : {}),
      ...(body.sourceApplyPlanId ? { sourceApplyPlanId: body.sourceApplyPlanId } : {})
    });
    return c.json({ run }, 201);
  });

  app.get("/v1/runs/:runId", async (c) => {
    const stored = await repo.getRun({ runId: c.req.param("runId") });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    return c.json(stored);
  });

  app.get("/v1/runs/:runId/metrics", async (c) => {
    const runId = c.req.param("runId");
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const metrics = await repo.getRunMetrics({ runId });
    return c.json({ metrics });
  });

  app.get("/v1/runs/:runId/events", async (c) => {
    const events = await repo.listRunEvents({ runId: c.req.param("runId") });
    return c.json({ events });
  });

  return app;
}
