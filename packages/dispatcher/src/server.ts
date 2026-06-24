import { OpenTagEventSchema, OpenTagRunResultSchema } from "@opentag/core";
import { renderAcknowledgement, renderFinalResult, renderProgress } from "@opentag/github";
import { createOpenTagRepository, migrateSchema, type CallbackDelivery } from "@opentag/store";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { z } from "zod";

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
  owner: z.string().min(1),
  repo: z.string().min(1)
});

const CreateRunSchema = z.object({
  runId: z.string().min(1),
  event: OpenTagEventSchema
});

const CompleteRunSchema = z.object({
  result: OpenTagRunResultSchema
});

const ProgressSchema = z.object({
  type: z.string().min(1).optional(),
  message: z.string().min(1),
  at: z.string().datetime().optional()
});

const ProcessCallbackDeliveriesSchema = z.object({
  limit: z.number().int().positive().max(100).default(20)
});

function repoKeyFromEvent(event: z.infer<typeof OpenTagEventSchema>): { provider: string; owner: string; repo: string } | null {
  const owner = event.metadata["owner"];
  const repo = event.metadata["repo"];
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  return {
    provider: typeof event.metadata["repoProvider"] === "string" ? (event.metadata["repoProvider"] as string) : "github",
    owner,
    repo
  };
}

function isWriteCapable(event: z.infer<typeof OpenTagEventSchema>): boolean {
  return event.permissions.some((permission) => ["repo:write", "pr:create", "pr:update"].includes(permission.scope));
}

function actorIsAllowed(event: z.infer<typeof OpenTagEventSchema>, allowedActors: string[] | undefined): boolean {
  if (!allowedActors?.length) return true;
  return allowedActors.includes(event.actor.handle ?? "") || allowedActors.includes(event.actor.providerUserId);
}

export type CallbackMessage = {
  runId: string;
  kind: "acknowledgement" | "progress" | "final";
  provider: "github" | "slack" | "lark" | "webhook";
  uri: string;
  body: string;
  threadKey?: string;
};

export type CallbackSink = {
  deliver(message: CallbackMessage): Promise<void>;
};

const noopCallbackSink: CallbackSink = {
  async deliver() {
    return;
  }
};

type OpenTagRepository = ReturnType<typeof createOpenTagRepository>;

export type CallbackRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: Date;
};

export type CallbackProcessResult = {
  processed: number;
  delivered: number;
  failed: number;
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
  repo: OpenTagRepository;
  sink: CallbackSink;
  delivery: CallbackDelivery;
  retry?: CallbackRetryOptions;
}): Promise<boolean> {
  try {
    await input.sink.deliver({
      runId: input.delivery.runId,
      kind: input.delivery.kind,
      provider: input.delivery.provider,
      uri: input.delivery.uri,
      body: input.delivery.body,
      ...(input.delivery.threadKey ? { threadKey: input.delivery.threadKey } : {})
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
  repo: OpenTagRepository;
  sink: CallbackSink;
  limit?: number;
  retry?: CallbackRetryOptions;
}): Promise<CallbackProcessResult> {
  const maxAttempts = input.retry?.maxAttempts ?? 5;
  const deliveries = await input.repo.listPendingCallbackDeliveries({
    limit: input.limit ?? 20,
    ...(input.retry?.now ? { now: input.retry.now } : {}),
    maxAttempts
  });
  const result: CallbackProcessResult = { processed: 0, delivered: 0, failed: 0 };
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
  repo: OpenTagRepository;
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
    ...(input.message.threadKey ? { threadKey: input.message.threadKey } : {})
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

function deprecatedRunnerScopedResponse() {
  return {
    error: "runner_scoped_endpoint_required",
    message: "Use /v1/runners/:runnerId/runs/:runId/running, /progress, or /complete."
  };
}

async function callbackForStoredRun(input: {
  repo: OpenTagRepository;
  sink: CallbackSink;
  runId: string;
  kind: "progress" | "final";
  body: string;
  retry?: CallbackRetryOptions;
}): Promise<void> {
  const stored = await input.repo.getRun({ runId: input.runId });
  if (!stored) return;
  await deliverAndAudit({
    repo: input.repo,
    sink: input.sink,
    message: {
      runId: input.runId,
      kind: input.kind,
      provider: stored.event.callback.provider,
      uri: stored.event.callback.uri,
      body: input.body,
      ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {})
    },
    ...(input.retry ? { retry: input.retry } : {})
  });
}

export function createDispatcherApp(input: {
  databasePath: string;
  callbackSink?: CallbackSink;
  pairingToken?: string;
  callbackRetry?: CallbackRetryOptions;
  callbackWorkerIntervalMs?: number;
  callbackWorkerLimit?: number;
}) {
  const sqlite = new Database(input.databasePath);
  migrateSchema(sqlite);
  const repo = createOpenTagRepository(drizzle(sqlite));
  const app = new Hono();
  const callbackSink = input.callbackSink ?? noopCallbackSink;
  const callbackRetry = input.callbackRetry ?? {};

  if (input.callbackWorkerIntervalMs && input.callbackWorkerIntervalMs > 0) {
    let processing = false;
    const handle = setInterval(() => {
      if (processing) return;
      processing = true;
      void processPendingCallbacks({
        repo,
        sink: callbackSink,
        limit: input.callbackWorkerLimit ?? 20,
        retry: callbackRetry
      })
        .catch((error: unknown) => {
          console.warn("OpenTag callback worker failed:", error);
        })
        .finally(() => {
          processing = false;
        });
    }, input.callbackWorkerIntervalMs);
    const maybeUnref = handle as { unref?: () => void };
    maybeUnref.unref?.();
  }

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
    const repoKey = repoKeyFromEvent(parsed.event);
    if (!repoKey) {
      return c.json({ error: "repo_context_missing" }, 422);
    }
    const binding = await repo.getRepoBinding(repoKey);
    if (!binding) {
      return c.json({ error: "repo_not_bound" }, 403);
    }
    if (isWriteCapable(parsed.event) && !actorIsAllowed(parsed.event, binding.allowedActors)) {
      return c.json({ error: "actor_not_allowed_for_write" }, 403);
    }

    const existing = await repo.getRunBySourceEvent({
      source: parsed.event.source,
      sourceEventId: parsed.event.sourceEventId
    });
    const run = await repo.createRun({ id: parsed.runId, event: parsed.event });
    if (existing) {
      return c.json({ run, duplicate: true }, 200);
    }

    await deliverAndAudit({
      repo,
      sink: callbackSink,
      message: {
        runId: run.id,
        kind: "acknowledgement",
        provider: parsed.event.callback.provider,
        uri: parsed.event.callback.uri,
        body: renderAcknowledgement(run.id),
        ...(parsed.event.callback.threadKey ? { threadKey: parsed.event.callback.threadKey } : {})
      },
      retry: callbackRetry
    });
    return c.json({ run }, 201);
  });

  app.post("/v1/callback-deliveries/process", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as unknown;
    const parsed = ProcessCallbackDeliveriesSchema.parse(body);
    const result = await processPendingCallbacks({
      repo,
      sink: callbackSink,
      limit: parsed.limit,
      retry: callbackRetry
    });
    return c.json(result);
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

  app.post("/v1/runners/:runnerId/runs/:runId/running", async (c) => {
    const body = z.object({ executor: z.string().min(1) }).parse(await c.req.json());
    const ok = await repo.markRunning({
      runnerId: c.req.param("runnerId"),
      runId: c.req.param("runId"),
      executor: body.executor
    });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
    return c.json({ ok: true });
  });

  app.post("/v1/runners/:runnerId/runs/:runId/progress", async (c) => {
    const runId = c.req.param("runId");
    const body = ProgressSchema.parse(await c.req.json());
    const ok = await repo.recordProgress({
      runId,
      runnerId: c.req.param("runnerId"),
      message: body.message,
      ...(body.type ? { type: body.type } : {}),
      ...(body.at ? { at: body.at } : {})
    });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
    await callbackForStoredRun({
      repo,
      sink: callbackSink,
      runId,
      kind: "progress",
      body: renderProgress({ runId, message: body.message }),
      retry: callbackRetry
    });
    return c.json({ ok: true });
  });

  app.post("/v1/runners/:runnerId/runs/:runId/complete", async (c) => {
    const runId = c.req.param("runId");
    const parsed = CompleteRunSchema.parse(await c.req.json());
    const ok = await repo.completeRun({
      runnerId: c.req.param("runnerId"),
      runId,
      result: parsed.result
    });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
    await callbackForStoredRun({
      repo,
      sink: callbackSink,
      runId,
      kind: "final",
      body: renderFinalResult(parsed.result),
      retry: callbackRetry
    });
    return c.json({ ok: true });
  });

  app.post("/v1/runs/:runId/running", (c) => c.json(deprecatedRunnerScopedResponse(), 410));
  app.post("/v1/runs/:runId/progress", (c) => c.json(deprecatedRunnerScopedResponse(), 410));
  app.post("/v1/runs/:runId/complete", (c) => c.json(deprecatedRunnerScopedResponse(), 410));

  app.get("/v1/runs/:runId", async (c) => {
    const stored = await repo.getRun({ runId: c.req.param("runId") });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    return c.json(stored);
  });

  app.get("/v1/runs/:runId/events", async (c) => {
    const events = await repo.listRunEvents({ runId: c.req.param("runId") });
    return c.json({ events });
  });

  return app;
}
