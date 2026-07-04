import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import { DEFAULT_MAX_REQUEST_BODY_BYTES, RequestBodyTooLargeError, readRequestTextWithLimit, type OpenTagEvent } from "@opentag/core";
import { Hono } from "hono";
import {
  lineConversationIdFromSource,
  lineSourceType,
  normalizeLineMessage,
  type LineChannelBinding,
  type LineMention,
  type LineSource
} from "./normalize.js";
import { verifyLineSignature } from "./signature.js";

export const DEFAULT_LINE_WEBHOOK_PORT = 3070;
export const LINE_AUTO_CONVERSATION_ID = "auto";

export type LineAccountConfig = {
  accountId: string;
  channelSecret: string;
  agentId: string;
  callbackUri?: string;
};

export type LineWebhookPayload = {
  destination?: string;
  events: LineWebhookEvent[];
};

export type LineWebhookEvent = {
  type?: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: LineSource;
  message?: {
    id?: string;
    type?: string;
    text?: string;
    mention?: LineMention;
  };
};

export type LineEventsAppInput = {
  lineAccounts: LineAccountConfig[];
  resolveChannelBinding(input: { accountId: string; conversationId: string }): Promise<LineChannelBinding | null>;
  bindChannel?(binding: LineChannelBinding): Promise<void>;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  recordControlPlaneEvent?(event: {
    type: string;
    severity?: "info" | "warn" | "error";
    subject?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  maxRequestBodyBytes?: number;
  now(): string;
};

export type LineIngressConfig = {
  accountId: string;
  channelSecret: string;
  dispatcherUrl: string;
  dispatcherToken?: string;
  port?: number;
  agentId?: string;
  callbackUri?: string;
  maxRequestBodyBytes?: number;
};

export type LineIngressHandle = {
  url: string;
  webhookPath: string;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLineMention(value: unknown): value is LineMention {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.mentionees === undefined) return true;
  return Array.isArray(value.mentionees) && value.mentionees.every((mentionee) => {
    return (
      isRecord(mentionee) &&
      (mentionee.isSelf === undefined || typeof mentionee.isSelf === "boolean") &&
      (mentionee.index === undefined || typeof mentionee.index === "number") &&
      (mentionee.length === undefined || typeof mentionee.length === "number")
    );
  });
}

function isLineSource(value: unknown): value is LineSource {
  return (
    isRecord(value) &&
    (value.type === "user" || value.type === "group" || value.type === "room") &&
    (value.userId === undefined || typeof value.userId === "string") &&
    (value.groupId === undefined || typeof value.groupId === "string") &&
    (value.roomId === undefined || typeof value.roomId === "string")
  );
}

function isLineWebhookEvent(value: unknown): value is LineWebhookEvent {
  if (!isRecord(value)) return false;
  if (value.type !== undefined && typeof value.type !== "string") return false;
  if (value.webhookEventId !== undefined && typeof value.webhookEventId !== "string") return false;
  if (value.replyToken !== undefined && typeof value.replyToken !== "string") return false;
  if (value.source !== undefined && !isLineSource(value.source)) return false;
  if (value.message === undefined) return true;
  if (!isRecord(value.message)) return false;
  if (value.message.id !== undefined && typeof value.message.id !== "string") return false;
  if (value.message.type !== undefined && typeof value.message.type !== "string") return false;
  if (value.message.text !== undefined && typeof value.message.text !== "string") return false;
  return isLineMention(value.message.mention);
}

export function isLineWebhookPayload(value: unknown): value is LineWebhookPayload {
  return (
    isRecord(value) &&
    (value.destination === undefined || typeof value.destination === "string") &&
    Array.isArray(value.events) &&
    value.events.every(isLineWebhookEvent)
  );
}

async function recordLineSignatureFailure(input: {
  recordControlPlaneEvent?: LineEventsAppInput["recordControlPlaneEvent"];
  accountId: string;
  reason: "missing_signature" | "invalid_signature";
  hasSignature: boolean;
}): Promise<void> {
  try {
    await input.recordControlPlaneEvent?.({
      type: "security.signature_failed",
      severity: "warn",
      subject: "line:POST /line/events/:accountId",
      payload: {
        provider: "line",
        endpoint: "POST /line/events/:accountId",
        accountId: input.accountId,
        reason: input.reason,
        hasSignature: input.hasSignature
      }
    });
  } catch {}
}

async function recordLineRequestBodyRejected(input: {
  recordControlPlaneEvent?: LineEventsAppInput["recordControlPlaneEvent"];
  accountId: string;
  reason: "request_body_too_large" | "invalid_json_body" | "invalid_request_body";
  maxBytes?: number;
  contentLength: string | null;
}): Promise<void> {
  try {
    await input.recordControlPlaneEvent?.({
      type: "security.request_body_rejected",
      severity: "warn",
      subject: "line:POST /line/events/:accountId",
      payload: {
        provider: "line",
        endpoint: "POST /line/events/:accountId",
        accountId: input.accountId,
        reason: input.reason,
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
        contentLength: input.contentLength
      }
    });
  } catch {}
}

async function recordLineUnboundConversation(input: {
  recordControlPlaneEvent?: LineEventsAppInput["recordControlPlaneEvent"];
  accountId: string;
  conversationId: string;
  sourceType: string | null;
  webhookEventId?: string;
}): Promise<void> {
  try {
    await input.recordControlPlaneEvent?.({
      type: "admission.needs_human_decision",
      severity: "info",
      subject: `line:${input.accountId}/${input.conversationId}`,
      payload: {
        provider: "line",
        accountId: input.accountId,
        conversationId: input.conversationId,
        sourceType: input.sourceType,
        decision: { reasonCode: "repo_not_bound" },
        projectTarget: `line:${input.accountId}/${input.conversationId}`,
        ...(input.webhookEventId ? { webhookEventId: input.webhookEventId } : {})
      }
    });
  } catch {}
}

function lineMessageInputFromEvent(input: {
  event: LineWebhookEvent;
  account: LineAccountConfig;
  binding: LineChannelBinding;
  receivedAt: string;
}) {
  const { event, account, binding } = input;
  if (event.type !== "message" || event.message?.type !== "text" || !event.message.id || !event.message.text || !event.source) {
    return null;
  }
  const sourceType = lineSourceType(event.source);
  const conversationId = lineConversationIdFromSource(event.source);
  if (!sourceType || !conversationId || !event.source.userId) return null;
  return {
    accountId: account.accountId,
    conversationId,
    sourceType,
    userId: event.source.userId,
    text: event.message.text,
    messageId: event.message.id,
    ...(event.webhookEventId ? { webhookEventId: event.webhookEventId } : {}),
    webhookSignatureVerified: true,
    ...(event.replyToken ? { replyToken: event.replyToken } : {}),
    ...(event.message.mention ? { mention: event.message.mention } : {}),
    receivedAt: input.receivedAt,
    agentId: account.agentId,
    ...(account.callbackUri ? { callbackUri: account.callbackUri } : {}),
    binding
  };
}

function hasLineInvocation(event: LineWebhookEvent): boolean {
  if (event.type !== "message" || event.message?.type !== "text") return false;
  return (
    /^\/opentag(?:\s+|$)/i.test(event.message.text?.trim() ?? "") ||
    event.message.mention?.mentionees?.some((mentionee) => mentionee.isSelf === true) === true
  );
}

function shouldResolveLineBinding(event: LineWebhookEvent): boolean {
  const sourceType = event.source ? lineSourceType(event.source) : null;
  if (sourceType === "user") return event.type === "follow" || event.type === "message";
  return event.type === "join" || hasLineInvocation(event);
}

async function resolveLineChannelBinding(input: {
  app: LineEventsAppInput;
  accountId: string;
  conversationId: string;
  autoBind: boolean;
}): Promise<LineChannelBinding | null> {
  const binding = await input.app.resolveChannelBinding({
    accountId: input.accountId,
    conversationId: input.conversationId
  });
  if (binding || !input.autoBind || input.conversationId === LINE_AUTO_CONVERSATION_ID || !input.app.bindChannel) return binding;

  const template = await input.app.resolveChannelBinding({
    accountId: input.accountId,
    conversationId: LINE_AUTO_CONVERSATION_ID
  });
  if (!template) return null;

  const autoBinding = {
    ...template,
    accountId: input.accountId,
    conversationId: input.conversationId
  };
  await input.app.bindChannel(autoBinding);
  return autoBinding;
}

export function createLineEventsApp(input: LineEventsAppInput) {
  const app = new Hono();
  const maxRequestBodyBytes = input.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;

  app.get("/line/events/:accountId", (c) => c.json({ ok: true }));
  app.on("HEAD", "/line/events/:accountId", (c) => c.body(null, 204));

  app.post("/line/events/:accountId", async (c) => {
    const accountId = c.req.param("accountId");
    const account = input.lineAccounts.find((candidate) => candidate.accountId === accountId);
    if (!account) return c.json({ error: "unknown_line_account" }, 404);

    const signature = c.req.header("x-line-signature");
    if (!signature) {
      await recordLineSignatureFailure({ recordControlPlaneEvent: input.recordControlPlaneEvent, accountId, reason: "missing_signature", hasSignature: false });
      return c.json({ error: "missing_signature" }, 400);
    }

    let rawBody: string;
    try {
      rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes: maxRequestBodyBytes });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        await recordLineRequestBodyRejected({
          recordControlPlaneEvent: input.recordControlPlaneEvent,
          accountId,
          reason: "request_body_too_large",
          maxBytes: error.maxBytes,
          contentLength: c.req.raw.headers.get("content-length")
        });
        return c.json({ error: "request_body_too_large", maxBytes: error.maxBytes }, 413);
      }
      throw error;
    }

    if (!verifyLineSignature({ channelSecret: account.channelSecret, rawBody, signature })) {
      await recordLineSignatureFailure({ recordControlPlaneEvent: input.recordControlPlaneEvent, accountId, reason: "invalid_signature", hasSignature: true });
      return c.json({ error: "invalid_signature" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      await recordLineRequestBodyRejected({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        accountId,
        reason: "invalid_json_body",
        contentLength: c.req.raw.headers.get("content-length")
      });
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!isLineWebhookPayload(payload)) {
      await recordLineRequestBodyRejected({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        accountId,
        reason: "invalid_request_body",
        contentLength: c.req.raw.headers.get("content-length")
      });
      return c.json({ error: "invalid_request_body" }, 400);
    }

    for (const event of payload.events) {
      const source = event.source;
      const conversationId = source ? lineConversationIdFromSource(source) : null;
      if (!conversationId) continue;
      if (!shouldResolveLineBinding(event)) continue;
      const binding = await resolveLineChannelBinding({ app: input, accountId, conversationId, autoBind: true });
      if (!binding) {
        await recordLineUnboundConversation({
          recordControlPlaneEvent: input.recordControlPlaneEvent,
          accountId,
          conversationId,
          sourceType: source ? lineSourceType(source) : null,
          ...(event.webhookEventId ? { webhookEventId: event.webhookEventId } : {})
        });
        continue;
      }
      const normalizedInput = lineMessageInputFromEvent({ event, account, binding, receivedAt: input.now() });
      if (!normalizedInput) continue;
      const normalizedEvent = normalizeLineMessage(normalizedInput);
      if (normalizedEvent) await input.createRun(normalizedEvent);
    }

    return c.json({ ok: true });
  });

  return app;
}

export function startLineIngress(config: LineIngressConfig): LineIngressHandle {
  const port = config.port ?? DEFAULT_LINE_WEBHOOK_PORT;
  const dispatcherClient = createOpenTagClient({
    dispatcherUrl: config.dispatcherUrl,
    ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {})
  });
  const webhookPath = `/line/events/${config.accountId}`;
  const server = serve({
    fetch: createLineEventsApp({
      lineAccounts: [
        {
          accountId: config.accountId,
          channelSecret: config.channelSecret,
          agentId: config.agentId ?? "opentag",
          ...(config.callbackUri ? { callbackUri: config.callbackUri } : {})
        }
      ],
      ...(config.maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes: config.maxRequestBodyBytes } : {}),
      async resolveChannelBinding(inputValue) {
        try {
          const { binding } = await dispatcherClient.getChannelBinding({
            provider: "line",
            accountId: inputValue.accountId,
            conversationId: inputValue.conversationId
          });
          return {
            accountId: binding.accountId,
            conversationId: binding.conversationId,
            repoProvider: binding.repoProvider,
            owner: binding.owner,
            repo: binding.repo
          };
        } catch (error) {
          if (error instanceof Error && error.message.includes("channel_binding_not_found")) return null;
          throw error;
        }
      },
      async bindChannel(binding) {
        await dispatcherClient.bindChannel({
          provider: "line",
          accountId: binding.accountId,
          conversationId: binding.conversationId,
          repoProvider: binding.repoProvider ?? "github",
          owner: binding.owner,
          repo: binding.repo
        });
      },
      async createRun(event) {
        const runId = `run_${randomUUID()}`;
        await dispatcherClient.createRun({ runId, event });
        return { runId };
      },
      async recordControlPlaneEvent(event) {
        await dispatcherClient.recordControlPlaneEvent(event);
      },
      now: () => new Date().toISOString()
    }).fetch,
    port
  });

  return {
    url: `http://localhost:${port}`,
    webhookPath,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}
