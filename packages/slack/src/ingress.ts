import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import { parseThreadActionCommand, type OpenTagEvent } from "@opentag/core";
import { Hono } from "hono";
import { encodeSlackThreadKey, normalizeSlackAppMention, stripSlackAppMention, type SlackChannelBinding } from "./normalize.js";

export type SlackThreadActionInput = {
  id: string;
  rawText: string;
  actor: {
    provider: "slack";
    providerUserId: string;
    handle: string;
    organizationId: string;
  };
  callback: {
    provider: "slack";
    uri: string;
    threadKey: string;
  };
  metadata: Record<string, unknown>;
};

export type SlackEventEnvelope = {
  token?: string;
  type: "url_verification" | "event_callback";
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: {
    type: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    channel?: string;
    subtype?: string;
    bot_id?: string;
  };
  event_id?: string;
  event_time?: number;
  authorizations?: Array<{ user_id?: string }>;
};

export type SlackEventsAppInput = {
  slackApps: Array<{
    signingSecret: string;
    agentId: string;
    appId?: string;
    callbackUri?: string;
  }>;
  resolveChannelBinding(input: { teamId: string; channelId: string }): Promise<SlackChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  submitThreadAction?(action: SlackThreadActionInput): Promise<unknown>;
  now(): string;
  clock?: () => number;
};

export type SlackIngressConfig = {
  signingSecret: string;
  dispatcherUrl: string;
  dispatcherToken?: string;
  port?: number;
  agentId?: string;
  appId?: string;
  callbackUri?: string;
};

export type SlackIngressHandle = {
  url: string;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
};

export function computeSlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
}): string {
  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const digest = createHmac("sha256", input.signingSecret).update(base).digest("hex");
  return `v0=${digest}`;
}

export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
}): boolean {
  const expected = computeSlackSignature(input);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(input.signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifySlackTimestamp(input: { timestamp: string; nowMs: number; toleranceSeconds?: number }): boolean {
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  const ageSeconds = Math.abs(Math.floor(input.nowMs / 1000) - timestampSeconds);
  return ageSeconds <= toleranceSeconds;
}

export function createSlackEventsApp(input: SlackEventsAppInput) {
  const app = new Hono();

  function parseSlackPayload(rawBody: string): SlackEventEnvelope | null {
    try {
      return JSON.parse(rawBody) as SlackEventEnvelope;
    } catch {
      return null;
    }
  }

  function resolveSlackApp(inputValue: {
    apiAppId?: string;
    rawBody: string;
    signature: string;
    timestamp: string;
  }) {
    const candidates = inputValue.apiAppId
      ? input.slackApps.filter((candidate) => !candidate.appId || candidate.appId === inputValue.apiAppId)
      : input.slackApps;
    if (candidates.length === 0) {
      return { error: "unknown_slack_app" as const };
    }
    const slackApp = candidates.find((candidate) =>
      verifySlackSignature({
        signingSecret: candidate.signingSecret,
        timestamp: inputValue.timestamp,
        rawBody: inputValue.rawBody,
        signature: inputValue.signature
      })
    );
    return slackApp ? { slackApp } : { error: "invalid_signature" as const };
  }

  app.post("/slack/events", async (c) => {
    const timestamp = c.req.header("x-slack-request-timestamp");
    const signature = c.req.header("x-slack-signature");
    if (!timestamp || !signature) {
      return c.json({ error: "missing_signature_headers" }, 401);
    }
    if (!verifySlackTimestamp({ timestamp, nowMs: input.clock?.() ?? Date.now() })) {
      return c.json({ error: "stale_signature_timestamp" }, 401);
    }
    const rawBody = await c.req.text();
    const payload = parseSlackPayload(rawBody);
    if (!payload) {
      return c.json({ error: "invalid_json" }, 400);
    }
    const resolvedSlackApp = resolveSlackApp({
      rawBody,
      signature,
      timestamp,
      ...(payload.api_app_id ? { apiAppId: payload.api_app_id } : {})
    });
    if ("error" in resolvedSlackApp) {
      return c.json({ error: resolvedSlackApp.error }, 401);
    }
    const { slackApp } = resolvedSlackApp;
    if (payload.type === "url_verification") {
      return c.text(payload.challenge ?? "");
    }
    if (payload.type !== "event_callback" || !payload.event || !["app_mention", "message"].includes(payload.event.type)) {
      return c.json({ ok: true });
    }
    if (!payload.team_id || !payload.event.channel || !payload.event.user || !payload.event.text || !payload.event.ts || !payload.event_id) {
      return c.json({ error: "invalid_event_payload" }, 400);
    }
    if (payload.event.type === "message" && (payload.event.subtype || payload.event.bot_id)) {
      return c.json({ ok: true });
    }

    const rawThreadActionText =
      payload.event.type === "app_mention"
        ? stripSlackAppMention(payload.event.text, payload.authorizations?.[0]?.user_id)
        : payload.event.text.trim();
    if (payload.event.type === "message" && (!rawThreadActionText || !parseThreadActionCommand(rawThreadActionText))) {
      return c.json({ ok: true });
    }

    const binding = await input.resolveChannelBinding({
      teamId: payload.team_id,
      channelId: payload.event.channel
    });
    if (!binding) {
      return c.json({ ok: true, ignored: "unbound_channel" });
    }

    if (rawThreadActionText && parseThreadActionCommand(rawThreadActionText) && input.submitThreadAction) {
      await input.submitThreadAction({
        id: `approval_slack_${payload.event_id}`,
        rawText: rawThreadActionText,
        actor: {
          provider: "slack",
          providerUserId: payload.event.user,
          handle: payload.event.user,
          organizationId: payload.team_id
        },
        callback: {
          provider: "slack",
          uri: slackApp.callbackUri ?? "https://slack.com/api/chat.postMessage",
          threadKey: encodeSlackThreadKey({
            teamId: payload.team_id,
            channelId: payload.event.channel,
            threadTs: payload.event.thread_ts ?? payload.event.ts
          })
        },
        metadata: {
          teamId: payload.team_id,
          channelId: payload.event.channel,
          messageTs: payload.event.ts,
          ...(payload.api_app_id ? { slackAppId: payload.api_app_id } : {}),
          ...(payload.authorizations?.[0]?.user_id ? { slackBotUserId: payload.authorizations[0].user_id } : {}),
          repoProvider: binding.repoProvider ?? "github",
          owner: binding.owner,
          repo: binding.repo
        }
      });
      return c.json({ ok: true });
    }

    if (payload.event.type !== "app_mention") {
      return c.json({ ok: true });
    }

    const event = normalizeSlackAppMention({
      teamId: payload.team_id,
      channelId: payload.event.channel,
      userId: payload.event.user,
      text: payload.event.text,
      ts: payload.event.ts,
      eventId: payload.event_id,
      eventTime: payload.event_time ?? Math.floor(Date.parse(input.now()) / 1000),
      agentId: slackApp.agentId,
      binding,
      ...(payload.api_app_id ? { appId: payload.api_app_id } : {}),
      ...(payload.event.thread_ts ? { threadTs: payload.event.thread_ts } : {}),
      ...(payload.authorizations?.[0]?.user_id ? { botUserId: payload.authorizations[0].user_id } : {}),
      ...(slackApp.callbackUri ? { callbackUri: slackApp.callbackUri } : {})
    });
    if (!event) {
      return c.json({ ok: true, ignored: "empty_command" });
    }

    await input.createRun(event);
    return c.json({ ok: true });
  });

  return app;
}

export function startSlackIngress(config: SlackIngressConfig): SlackIngressHandle {
  const dispatcherClient = createOpenTagClient({
    dispatcherUrl: config.dispatcherUrl,
    ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {})
  });
  const port = config.port ?? 3040;
  const server = serve({
    fetch: createSlackEventsApp({
      slackApps: [
        {
          signingSecret: config.signingSecret,
          agentId: config.agentId ?? "opentag",
          ...(config.appId ? { appId: config.appId } : {}),
          ...(config.callbackUri ? { callbackUri: config.callbackUri } : {})
        }
      ],
      async resolveChannelBinding(input) {
        try {
          const { binding } = await dispatcherClient.getChannelBinding({
            provider: "slack",
            accountId: input.teamId,
            conversationId: input.channelId
          });
          return {
            teamId: binding.accountId,
            channelId: binding.conversationId,
            repoProvider: binding.repoProvider,
            owner: binding.owner,
            repo: binding.repo
          };
        } catch (error) {
          if (error instanceof Error && error.message.includes("channel_binding_not_found")) {
            return null;
          }
          throw error;
        }
      },
      async createRun(event) {
        const runId = `run_${randomUUID()}`;
        const created = await dispatcherClient.createRun({ runId, event });
        return created.outcome === "run_created" ? { runId: created.run.id } : { runId };
      },
      async submitThreadAction(action) {
        await dispatcherClient.submitThreadAction(action);
      },
      now: () => new Date().toISOString()
    }).fetch,
    port
  });

  return {
    url: `http://localhost:${port}`,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
