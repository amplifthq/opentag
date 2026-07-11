import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  parseThreadActionCommand,
  parseThreadControlCommand,
  readRequestTextWithLimit,
  type OpenTagEvent
} from "@opentag/core";
import { Hono } from "hono";
import { acknowledgeLinearAgentSession, linearAgentActivityBody, normalizeLinearAgentSessionEvent, type LinearAgentSessionEventPayload } from "./agent.js";
import { DEFAULT_LINEAR_GRAPHQL_URL, normalizeLinearIssueComment, type LinearProjectTarget } from "./normalize.js";

type LinearUser = {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  email?: unknown;
};

type LinearTeam = {
  id?: unknown;
  key?: unknown;
  name?: unknown;
};

type LinearIssue = {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  url?: unknown;
  team?: LinearTeam;
};

type LinearCommentData = {
  id?: unknown;
  body?: unknown;
  url?: unknown;
  parentId?: unknown;
  isArtificialAgentSessionRoot?: unknown;
  userId?: unknown;
  issue?: LinearIssue;
  user?: LinearUser;
  creator?: LinearUser;
};

type LinearCommentCreateData = LinearCommentData & {
  id: string;
  body: string;
  issue: LinearIssue & {
    id: string;
    identifier: string;
    url: string;
    team: LinearTeam & {
      id: string;
    };
  };
};

export type LinearWebhookPayload = {
  type?: unknown;
  action?: unknown;
  webhookId?: unknown;
  organizationId?: unknown;
  createdAt?: unknown;
  webhookTimestamp?: unknown;
  data?: unknown;
  agentActivity?: unknown;
  agentSession?: unknown;
  appUserId?: unknown;
  guidance?: unknown;
  oauthClientId?: unknown;
  previousComments?: unknown;
  promptContext?: unknown;
};

export type LinearThreadActionInput = {
  id: string;
  rawText: string;
  actor: {
    provider: "linear";
    providerUserId: string;
    handle?: string;
    displayName?: string;
    organizationId?: string;
  };
  callback: {
    provider: "linear";
    uri: string;
    threadKey: string;
  };
  metadata: Record<string, unknown>;
};

type LinearThreadActionContext = Omit<LinearThreadActionInput, "id">;

export type LinearWebhookAppInput = {
  webhookSecret: string;
  webhookPath?: string;
  graphqlUrl?: string;
  projectTarget?: LinearProjectTarget;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: LinearThreadActionInput): Promise<unknown>;
  onAgentSessionAccepted?(input: { agentSessionId: string; runId?: string; action?: string }): Promise<unknown> | unknown;
  maxRequestBodyBytes?: number;
  maxWebhookTimestampSkewMs?: number;
  appUserId?: string;
  commentRunDeferMs?: number;
  now(): string;
};

export const DEFAULT_LINEAR_COMMENT_RUN_DEFER_MS = 2_500;

export type LinearIngressConfig = {
  webhookSecret: string;
  dispatcherUrl: string;
  dispatcherToken?: string;
  linearToken?: string;
  getLinearToken?: () => Promise<string | undefined> | string | undefined;
  graphqlUrl?: string;
  projectTarget?: LinearProjectTarget;
  port?: number;
  hostname?: string;
  webhookPath?: string;
  maxRequestBodyBytes?: number;
  maxWebhookTimestampSkewMs?: number;
  appUserId?: string;
  commentRunDeferMs?: number;
};

export type LinearIngressHandle = {
  url: string;
  webhookPath: string;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
};

export function computeLinearSignature(input: { webhookSecret: string; rawBody: string }): string {
  return createHmac("sha256", input.webhookSecret).update(input.rawBody).digest("hex");
}

export function verifyLinearSignature(input: { webhookSecret: string; rawBody: string; signature: string }): boolean {
  const actual = input.signature.startsWith("sha256=") ? input.signature.slice("sha256=".length) : input.signature;
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  const expected = computeLinearSignature(input);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export const DEFAULT_LINEAR_WEBHOOK_TIMESTAMP_SKEW_MS = 60_000;

export function verifyLinearWebhookTimestamp(input: { timestampMs: number | null; nowMs: number; maxSkewMs?: number }): boolean {
  if (!Number.isFinite(input.timestampMs)) return false;
  const maxSkewMs = input.maxSkewMs ?? DEFAULT_LINEAR_WEBHOOK_TIMESTAMP_SKEW_MS;
  return Math.abs(input.nowMs - input.timestampMs!) <= maxSkewMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function linearUserHandle(user: LinearUser | undefined): string | undefined {
  return stringValue(user?.displayName) ?? stringValue(user?.name) ?? stringValue(user?.email);
}

function isCommentCreatePayload(payload: LinearWebhookPayload): payload is LinearWebhookPayload & { data: LinearCommentCreateData } {
  if (payload.type !== "Comment") return false;
  if (payload.action !== undefined && payload.action !== "create" && payload.action !== "created") return false;
  if (!isRecord(payload.data)) return false;
  const data = payload.data as LinearCommentData;
  return (
    typeof data.id === "string" &&
    typeof data.body === "string" &&
    isRecord(data.issue) &&
    typeof data.issue.id === "string" &&
    typeof data.issue.identifier === "string" &&
    typeof data.issue.url === "string" &&
    isRecord(data.issue.team) &&
    typeof data.issue.team.id === "string"
  );
}

function isAgentSessionEventPayload(payload: LinearWebhookPayload): payload is LinearWebhookPayload & LinearAgentSessionEventPayload {
  return payload.type === "AgentSessionEvent" && isRecord(payload.agentSession);
}

function agentSessionIdFromPayload(payload: LinearWebhookPayload): string | undefined {
  if (!isAgentSessionEventPayload(payload)) return undefined;
  const agentSession = isRecord(payload.agentSession) ? payload.agentSession : undefined;
  return stringValue(agentSession?.id);
}

function agentActivitySignal(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringValue(value.signal);
}

function agentActivityIdFromPayload(payload: LinearWebhookPayload): string | undefined {
  if (!isRecord(payload.agentActivity)) return undefined;
  return stringValue(payload.agentActivity.id);
}

function agentSessionRootCommentIdFromPayload(payload: LinearWebhookPayload): string | undefined {
  if (payload.type !== "AgentSessionEvent" || !isRecord(payload.agentSession)) return undefined;
  return stringValue(payload.agentSession.commentId);
}

// OAuth app actors post with a synthetic @oauthapp.linear.app email. Comments they author —
// our own callbacks included — must never be treated as new invocations, or a final summary
// that quotes "@opentag" re-triggers a run and the loop never ends.
const LINEAR_OAUTH_APP_ACTOR_EMAIL_SUFFIX = "@oauthapp.linear.app";

function isLinearAppActorComment(input: { data: LinearCommentData; appUserId?: string }): boolean {
  const author = input.data.user ?? input.data.creator;
  const authorId = stringValue(author?.id) ?? stringValue(input.data.userId);
  if (input.appUserId && authorId === input.appUserId) return true;
  const email = stringValue(author?.email);
  return typeof email === "string" && email.toLowerCase().endsWith(LINEAR_OAUTH_APP_ACTOR_EMAIL_SUFFIX);
}

function isAgentSessionStopSignalPayload(payload: LinearWebhookPayload): boolean {
  return isAgentSessionEventPayload(payload) && agentActivitySignal(payload.agentActivity) === "stop";
}

function normalizePayload(input: { payload: LinearWebhookPayload; app: LinearWebhookAppInput }): OpenTagEvent | null {
  if (isCommentCreatePayload(input.payload)) {
    const data = input.payload.data;
    // Linear marks the mention comment with isArtificialAgentSessionRoot=true when it
    // also created an Agent Session for it; the AgentSessionEvent channel owns that
    // invocation, so the comment channel must not start a second run.
    if (data.isArtificialAgentSessionRoot === true) return null;
    if (isLinearAppActorComment({ data, ...(input.app.appUserId ? { appUserId: input.app.appUserId } : {}) })) return null;
    const issue = data.issue!;
    const team = issue.team!;
    const actor = data.user ?? data.creator;
    const actorId = stringValue(actor?.id) ?? "unknown";
    return normalizeLinearIssueComment({
      id: data.id!,
      ...(stringValue(data.parentId) ? { parentCommentId: stringValue(data.parentId)! } : {}),
      commentBody: data.body!,
      ...(stringValue(data.url) ? { commentUrl: stringValue(data.url)! } : {}),
      issueId: issue.id!,
      issueIdentifier: issue.identifier!,
      ...(stringValue(issue.title) ? { issueTitle: stringValue(issue.title)! } : {}),
      issueUrl: issue.url!,
      teamId: team.id!,
      ...(stringValue(team.key) ? { teamKey: stringValue(team.key)! } : {}),
      ...(stringValue(team.name) ? { teamName: stringValue(team.name)! } : {}),
      ...(stringValue(input.payload.organizationId) ? { organizationId: stringValue(input.payload.organizationId)! } : {}),
      actorId,
      ...(stringValue(actor?.name) ? { actorName: stringValue(actor?.name)! } : {}),
      ...(stringValue(actor?.displayName) ? { actorDisplayName: stringValue(actor?.displayName)! } : {}),
      ...(stringValue(actor?.email) ? { actorEmail: stringValue(actor?.email)! } : {}),
      receivedAt: stringValue(input.payload.createdAt) ?? input.app.now(),
      ...(input.app.projectTarget ? { projectTarget: input.app.projectTarget } : {}),
      graphqlUrl: input.app.graphqlUrl ?? DEFAULT_LINEAR_GRAPHQL_URL
    });
  }
  if (isAgentSessionEventPayload(input.payload)) {
    return normalizeLinearAgentSessionEvent({
      payload: input.payload,
      ...(input.app.projectTarget ? { projectTarget: input.app.projectTarget } : {}),
      graphqlUrl: input.app.graphqlUrl ?? DEFAULT_LINEAR_GRAPHQL_URL
    });
  }
  return null;
}

function agentSessionStopContext(input: { payload: LinearWebhookPayload; app: LinearWebhookAppInput }): LinearThreadActionContext | null {
  if (!isAgentSessionStopSignalPayload(input.payload)) return null;
  return agentSessionActionContext({ ...input, rawText: "/stop", metadata: { linearAgentActivitySignal: "stop" } });
}

// A prompted Agent Activity whose body is a thread action ("apply 1") must resolve against
// the issue's pending proposals instead of spawning a run that executes the literal text.
function agentSessionPromptedActionContext(input: { payload: LinearWebhookPayload; app: LinearWebhookAppInput }): LinearThreadActionContext | null {
  if (!isAgentSessionEventPayload(input.payload)) return null;
  if (stringValue(input.payload.action) !== "prompted") return null;
  if (isAgentSessionStopSignalPayload(input.payload)) return null;
  const body = linearAgentActivityBody(input.payload.agentActivity);
  if (!body) return null;
  return agentSessionActionContext({ ...input, rawText: body, metadata: {} });
}

function agentSessionActionContext(input: {
  payload: LinearWebhookPayload;
  app: LinearWebhookAppInput;
  rawText: string;
  metadata: Record<string, unknown>;
}): LinearThreadActionContext | null {
  const event = normalizeLinearAgentSessionEvent({
    payload: input.payload as LinearWebhookPayload & LinearAgentSessionEventPayload,
    ...(input.app.projectTarget ? { projectTarget: input.app.projectTarget } : {}),
    graphqlUrl: input.app.graphqlUrl ?? DEFAULT_LINEAR_GRAPHQL_URL
  });
  if (!event) return null;
  const organizationId = stringValue(input.payload.organizationId);
  const threadKey = event.callback.threadKey;
  if (!threadKey) return null;
  return {
    rawText: input.rawText,
    actor: {
      provider: "linear" as const,
      providerUserId: event.actor.providerUserId,
      ...(event.actor.handle ? { handle: event.actor.handle } : {}),
      ...(event.actor.displayName ? { displayName: event.actor.displayName } : {}),
      ...(organizationId ? { organizationId } : {})
    },
    callback: {
      provider: "linear" as const,
      uri: event.callback.uri,
      threadKey
    },
    metadata: {
      ...event.metadata,
      ...input.metadata
    }
  };
}

function commentPayloadContext(input: { payload: LinearWebhookPayload; app: LinearWebhookAppInput }): LinearThreadActionContext | null {
  if (!isCommentCreatePayload(input.payload)) return null;
  const data = input.payload.data;
  if (isLinearAppActorComment({ data, ...(input.app.appUserId ? { appUserId: input.app.appUserId } : {}) })) return null;
  const issue = data.issue;
  const team = issue.team;
  const actor = data.user ?? data.creator;
  const issueId = issue.id;
  const issueIdentifier = issue.identifier;
  const teamId = team.id;
  const teamKey = stringValue(team.key);
  const threadKey = `${teamKey ?? teamId}|issue|${issueIdentifier || issueId}`;
  const actorId = stringValue(actor?.id) ?? "unknown";
  const actorHandle = linearUserHandle(actor);
  const actorDisplayName = stringValue(actor?.displayName);
  const organizationId = stringValue(input.payload.organizationId);
  return {
    rawText: data.body,
    actor: {
      provider: "linear" as const,
      providerUserId: actorId,
      ...(actorHandle ? { handle: actorHandle } : {}),
      ...(actorDisplayName ? { displayName: actorDisplayName } : {}),
      ...(organizationId ? { organizationId } : {})
    },
    callback: {
      provider: "linear" as const,
      uri: `linear://issue/${encodeURIComponent(issueId)}/comments`,
      threadKey
    },
    metadata: {
      repoProvider: input.app.projectTarget?.repoProvider,
      owner: input.app.projectTarget?.owner,
      repo: input.app.projectTarget?.repo,
      issueId,
      issueIdentifier,
      ...(stringValue(issue.title) ? { issueTitle: stringValue(issue.title)! } : {}),
      teamId,
      ...(teamKey ? { teamKey } : {}),
      ...(stringValue(team.name) ? { teamName: stringValue(team.name)! } : {}),
      ...(organizationId ? { organizationId } : {}),
      graphqlUrl: input.app.graphqlUrl ?? DEFAULT_LINEAR_GRAPHQL_URL
    }
  };
}

function parseJsonPayload(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function timestampMsFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function nowMsFrom(input: LinearWebhookAppInput): number {
  const parsed = Date.parse(input.now());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function createLinearWebhookApp(input: LinearWebhookAppInput): Hono {
  const app = new Hono();
  const webhookPath = input.webhookPath ?? "/linear/webhooks";
  const maxBytes = input.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  // Comment-vs-AgentSession dedupe: a real user mention arrives twice when Agent session
  // events are enabled — first as a Comment webhook, then (~1s later) as an AgentSessionEvent
  // whose agentSession.commentId points back at the mention comment. The Comment event carries
  // no marker of its own, so when commentRunDeferMs > 0 mention runs are deferred briefly and
  // dropped if the session claims the comment inside the window.
  const commentRunDeferMs = input.commentRunDeferMs ?? 0;
  const pendingCommentRuns = new Map<string, ReturnType<typeof setTimeout>>();
  const sessionClaimedComments = new Map<string, number>();
  const SESSION_COMMENT_CLAIM_TTL_MS = 60_000;
  function claimCommentForAgentSession(commentId: string): void {
    const nowMs = nowMsFrom(input);
    for (const [id, expiresAt] of sessionClaimedComments) {
      if (expiresAt <= nowMs) sessionClaimedComments.delete(id);
    }
    sessionClaimedComments.set(commentId, nowMs + SESSION_COMMENT_CLAIM_TTL_MS);
    const pending = pendingCommentRuns.get(commentId);
    if (pending) {
      clearTimeout(pending);
      pendingCommentRuns.delete(commentId);
    }
  }
  function commentClaimedByAgentSession(commentId: string): boolean {
    const expiresAt = sessionClaimedComments.get(commentId);
    return typeof expiresAt === "number" && expiresAt > nowMsFrom(input);
  }

  app.post(webhookPath, async (c) => {
    let rawBody: string;
    try {
      rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return c.json({ error: "request_body_too_large", maxBytes: error.maxBytes }, 413);
      }
      throw error;
    }

    const signature = c.req.header("linear-signature") ?? c.req.header("Linear-Signature");
    if (!signature || !verifyLinearSignature({ webhookSecret: input.webhookSecret, rawBody, signature })) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    const payload = parseJsonPayload(rawBody);
    if (!payload || typeof payload !== "object") {
      return c.json({ error: "invalid_json_body" }, 400);
    }

    const linearPayload = payload as LinearWebhookPayload;
    const timestampMs = timestampMsFrom(linearPayload.webhookTimestamp);
    if (
      !verifyLinearWebhookTimestamp({
        timestampMs,
        nowMs: nowMsFrom(input),
        ...(input.maxWebhookTimestampSkewMs ? { maxSkewMs: input.maxWebhookTimestampSkewMs } : {})
      })
    ) {
      return c.json({ error: "invalid_timestamp" }, 400);
    }

    const agentStopContext = agentSessionStopContext({ payload: linearPayload, app: input });
    if (agentStopContext) {
      if (input.submitThreadAction) {
        try {
          await input.submitThreadAction({
            id: `linear_control_${agentActivityIdFromPayload(linearPayload) ?? agentSessionIdFromPayload(linearPayload) ?? randomUUID()}`,
            rawText: agentStopContext.rawText,
            actor: agentStopContext.actor,
            callback: agentStopContext.callback,
            metadata: agentStopContext.metadata
          });
        } catch (error) {
          // A rejected thread action (no active run, stale proposal, dispatcher 4xx) is a
          // user-level outcome, not a delivery failure — never let it escape the webhook.
          console.error(`Linear stop control failed: ${error instanceof Error ? error.message : String(error)}`);
          return c.json({ ok: false, action: "stop", error: "thread_action_failed" });
        }
      }
      return c.json({ ok: true, action: "stop" });
    }

    const threadContext =
      commentPayloadContext({ payload: linearPayload, app: input }) ??
      agentSessionPromptedActionContext({ payload: linearPayload, app: input });
    const control = threadContext ? parseThreadControlCommand(threadContext.rawText) : null;
    const action = threadContext ? parseThreadActionCommand(threadContext.rawText) : null;
    if ((control || action) && threadContext && input.submitThreadAction) {
      const actionIdSuffix = isCommentCreatePayload(linearPayload)
        ? linearPayload.data.id
        : (agentActivityIdFromPayload(linearPayload) ?? randomUUID());
      try {
        await input.submitThreadAction({
          id: `linear_${control ? "control" : "action"}_${actionIdSuffix}`,
          rawText: threadContext.rawText,
          actor: threadContext.actor,
          callback: threadContext.callback,
          metadata: threadContext.metadata
        });
      } catch (error) {
        console.error(`Linear thread action failed: ${error instanceof Error ? error.message : String(error)}`);
        return c.json({ ok: false, action: control?.verb ?? action?.verb, error: "thread_action_failed" });
      }
      return c.json({ ok: true, action: control?.verb ?? action?.verb });
    }

    const event = normalizePayload({ payload: linearPayload, app: input });
    if (!event) return c.json({ ok: true, ignored: true });

    const sessionRootCommentId = agentSessionRootCommentIdFromPayload(linearPayload);
    if (sessionRootCommentId) {
      claimCommentForAgentSession(sessionRootCommentId);
    }

    if (commentRunDeferMs > 0 && isCommentCreatePayload(linearPayload)) {
      const commentId = linearPayload.data.id;
      if (commentClaimedByAgentSession(commentId)) {
        return c.json({ ok: true, ignored: true, reason: "agent_session_owns_comment" });
      }
      const timer = setTimeout(() => {
        pendingCommentRuns.delete(commentId);
        if (commentClaimedByAgentSession(commentId)) return;
        void input.createRun(event).catch(() => {});
      }, commentRunDeferMs);
      pendingCommentRuns.set(commentId, timer);
      return c.json({ ok: true, deferred: true });
    }

    const created = await input.createRun(event);
    const agentSessionId = agentSessionIdFromPayload(linearPayload);
    if (agentSessionId && input.onAgentSessionAccepted) {
      const action = stringValue(linearPayload.action);
      void Promise.resolve(
        input.onAgentSessionAccepted({
          agentSessionId,
          ...(created.runId ? { runId: created.runId } : {}),
          ...(action ? { action } : {})
        })
      ).catch(() => undefined);
    }
    return c.json({ ok: true, runId: created.runId });
  });

  return app;
}

async function resolveLinearIngressToken(config: LinearIngressConfig): Promise<string | undefined> {
  const token = config.getLinearToken ? await config.getLinearToken() : config.linearToken;
  return token?.trim() ? token : undefined;
}

export function startLinearIngress(config: LinearIngressConfig): LinearIngressHandle {
  const webhookPath = config.webhookPath ?? "/linear/webhooks";
  const app = createLinearWebhookApp({
    webhookSecret: config.webhookSecret,
    ...(config.graphqlUrl ? { graphqlUrl: config.graphqlUrl } : {}),
    ...(config.projectTarget ? { projectTarget: config.projectTarget } : {}),
    webhookPath,
    ...(config.maxRequestBodyBytes ? { maxRequestBodyBytes: config.maxRequestBodyBytes } : {}),
    ...(config.maxWebhookTimestampSkewMs ? { maxWebhookTimestampSkewMs: config.maxWebhookTimestampSkewMs } : {}),
    ...(config.appUserId ? { appUserId: config.appUserId } : {}),
    ...(config.commentRunDeferMs !== undefined ? { commentRunDeferMs: config.commentRunDeferMs } : {}),
    ...(config.linearToken || config.getLinearToken
      ? {
          onAgentSessionAccepted: async ({ agentSessionId, runId }) => {
            const token = await resolveLinearIngressToken(config);
            if (!token) return;
            await acknowledgeLinearAgentSession({
              token,
              agentSessionId,
              ...(runId ? { runId } : {}),
              ...(config.graphqlUrl ? { graphqlUrl: config.graphqlUrl } : {})
            });
          }
        }
      : {}),
    createRun: async (event) => {
      const client = createOpenTagClient({
        dispatcherUrl: config.dispatcherUrl,
        ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {})
      });
      const runId = `run_${randomUUID()}`;
      const created = await client.createRun({ runId, event });
      return created.outcome === "run_created" ? { runId: created.run.id } : {};
    },
    submitThreadAction: async (action) => {
      const client = createOpenTagClient({
        dispatcherUrl: config.dispatcherUrl,
        ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {})
      });
      await client.submitThreadAction(action);
    },
    now: () => new Date().toISOString()
  });
  const port = config.port ?? 3070;
  const hostname = config.hostname ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, port, hostname });
  return {
    url: `http://${hostname}:${port}`,
    webhookPath,
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
