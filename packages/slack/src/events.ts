import { parseThreadActionCommand, type OpenTagEvent } from "@opentag/core";
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

export type SlackAppRuntimeConfig = {
  agentId: string;
  appId?: string;
  callbackUri?: string;
};

export type SlackEventProcessorInput = {
  resolveChannelBinding(input: { teamId: string; channelId: string }): Promise<SlackChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  submitThreadAction?(action: SlackThreadActionInput): Promise<unknown>;
  now(): string;
};

export type SlackEventProcessorStatus = 200 | 400;

export type SlackEventProcessorResult =
  | {
      kind: "json";
      status: SlackEventProcessorStatus;
      body: Record<string, unknown>;
    }
  | {
      kind: "text";
      status: SlackEventProcessorStatus;
      body: string;
    };

function json(body: Record<string, unknown>, status: SlackEventProcessorStatus = 200): SlackEventProcessorResult {
  return { kind: "json", status, body };
}

function text(body: string, status: SlackEventProcessorStatus = 200): SlackEventProcessorResult {
  return { kind: "text", status, body };
}

export function createSlackEventProcessor(input: SlackEventProcessorInput) {
  return {
    async process(payload: SlackEventEnvelope, slackApp: SlackAppRuntimeConfig): Promise<SlackEventProcessorResult> {
      if (payload.type === "url_verification") {
        return text(payload.challenge ?? "");
      }
      if (payload.type !== "event_callback" || !payload.event || !["app_mention", "message"].includes(payload.event.type)) {
        return json({ ok: true });
      }
      if (!payload.team_id || !payload.event.channel || !payload.event.user || !payload.event.text || !payload.event.ts || !payload.event_id) {
        return json({ error: "invalid_event_payload" }, 400);
      }
      if (payload.event.type === "message" && (payload.event.subtype || payload.event.bot_id)) {
        return json({ ok: true });
      }

      const rawThreadActionText =
        payload.event.type === "app_mention"
          ? stripSlackAppMention(payload.event.text, payload.authorizations?.[0]?.user_id)
          : payload.event.text.trim();
      if (payload.event.type === "message" && (!rawThreadActionText || !parseThreadActionCommand(rawThreadActionText))) {
        return json({ ok: true });
      }

      const binding = await input.resolveChannelBinding({
        teamId: payload.team_id,
        channelId: payload.event.channel
      });
      if (!binding) {
        return json({ ok: true, ignored: "unbound_channel" });
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
        return json({ ok: true });
      }

      if (payload.event.type !== "app_mention") {
        return json({ ok: true });
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
        return json({ ok: true, ignored: "empty_command" });
      }

      await input.createRun(event);
      return json({ ok: true });
    }
  };
}
