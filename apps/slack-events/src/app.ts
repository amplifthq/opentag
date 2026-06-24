import { createHmac, timingSafeEqual } from "node:crypto";
import type { OpenTagEvent } from "@opentag/core";
import { normalizeSlackAppMention, type SlackChannelBinding } from "@opentag/slack";
import { Hono } from "hono";

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
  };
  event_id?: string;
  event_time?: number;
  authorizations?: Array<{ user_id?: string }>;
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

export function createSlackEventsApp(input: {
  slackApps: Array<{
    signingSecret: string;
    agentId: string;
    appId?: string;
    callbackUri?: string;
  }>;
  resolveChannelBinding(input: { teamId: string; channelId: string }): Promise<SlackChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  now(): string;
}) {
  const app = new Hono();

  function resolveSlackApp(inputValue: {
    apiAppId?: string;
    rawBody: string;
    signature: string;
    timestamp: string;
  }) {
    const candidates = inputValue.apiAppId
      ? input.slackApps.filter((candidate) => candidate.appId === inputValue.apiAppId)
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
    const rawBody = await c.req.text();
    const timestamp = c.req.header("x-slack-request-timestamp");
    const signature = c.req.header("x-slack-signature");
    if (!timestamp || !signature) {
      return c.json({ error: "missing_signature_headers" }, 401);
    }
    const payload = JSON.parse(rawBody) as SlackEventEnvelope;
    const resolvedSlackApp = resolveSlackApp({
      ...(payload.api_app_id ? { apiAppId: payload.api_app_id } : {}),
      rawBody,
      signature,
      timestamp
    });
    if ("error" in resolvedSlackApp) {
      return c.json({ error: resolvedSlackApp.error }, 401);
    }
    const { slackApp } = resolvedSlackApp;
    if (payload.type === "url_verification") {
      return c.text(payload.challenge ?? "");
    }
    if (payload.type !== "event_callback" || payload.event?.type !== "app_mention") {
      return c.json({ ok: true });
    }
    if (!payload.team_id || !payload.event.channel || !payload.event.user || !payload.event.text || !payload.event.ts || !payload.event_id) {
      return c.json({ error: "invalid_event_payload" }, 400);
    }

    const binding = await input.resolveChannelBinding({
      teamId: payload.team_id,
      channelId: payload.event.channel
    });
    if (!binding) {
      return c.json({ ok: true, ignored: "unbound_channel" });
    }

    const event = normalizeSlackAppMention({
      teamId: payload.team_id,
      channelId: payload.event.channel,
      userId: payload.event.user,
      text: payload.event.text,
      ts: payload.event.ts,
      eventId: payload.event_id,
      eventTime: payload.event_time ?? Math.floor(Date.parse(input.now()) / 1000),
      ...(payload.api_app_id ? { appId: payload.api_app_id } : {}),
      agentId: slackApp.agentId,
      ...(payload.event.thread_ts ? { threadTs: payload.event.thread_ts } : {}),
      ...(payload.authorizations?.[0]?.user_id ? { botUserId: payload.authorizations[0].user_id } : {}),
      ...(slackApp.callbackUri ? { callbackUri: slackApp.callbackUri } : {}),
      binding
    });
    if (!event) {
      return c.json({ ok: true, ignored: "empty_command" });
    }

    await input.createRun(event);
    return c.json({ ok: true });
  });

  return app;
}
