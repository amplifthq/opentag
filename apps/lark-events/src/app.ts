import type { OpenTagEvent } from "@opentag/core";
import { type LarkChannelBinding, normalizeLarkMessage } from "@opentag/lark";

/**
 * Shape of the `im.message.receive_v1` event payload delivered by
 * @larksuiteoapi/node-sdk's EventDispatcher. Only the fields OpenTag needs are
 * declared; everything is optional because the payload is external input.
 */
export type LarkMention = { key?: string; id?: { open_id?: string }; name?: string };

export type LarkInboundMessageEvent = {
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string;
    tenant_key?: string;
    app_id?: string;
  };
  event?: {
    sender?: {
      sender_id?: { open_id?: string; user_id?: string; union_id?: string };
      sender_type?: string;
      tenant_key?: string;
    };
    message?: {
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: LarkMention[];
    };
  };
};

export type LarkMessageHandlerConfig = {
  agentId: string;
  botOpenId?: string;
  callbackUri?: string;
  resolveChannelBinding(input: { tenantKey: string; chatId: string }): Promise<LarkChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  now?(): number;
};

export type LarkMessageHandlerOutcome = {
  status:
    | "created"
    | "ignored_non_text"
    | "ignored_invalid_payload"
    | "ignored_unbound_chat"
    | "ignored_empty_command";
  runId?: string;
};

function extractText(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function findBotMentionKey(mentions: LarkMention[] | undefined, botOpenId: string | undefined): string | undefined {
  if (!botOpenId || !mentions) return undefined;
  for (const mention of mentions) {
    if (mention.id?.open_id === botOpenId && mention.key) {
      return mention.key;
    }
  }
  return undefined;
}

/**
 * Build a handler for inbound Lark message events. The handler resolves the
 * channel binding, normalizes the message into an OpenTagEvent, and creates a
 * run. It is transport-agnostic so it can be unit-tested without a live socket.
 */
export function createLarkMessageHandler(config: LarkMessageHandlerConfig) {
  return async function handleLarkMessage(data: LarkInboundMessageEvent): Promise<LarkMessageHandlerOutcome> {
    const message = data.event?.message;
    const header = data.header;
    if (!message || message.message_type !== "text") {
      return { status: "ignored_non_text" };
    }

    const tenantKey = header?.tenant_key ?? data.event?.sender?.tenant_key;
    const chatId = message.chat_id;
    const messageId = message.message_id;
    const eventId = header?.event_id;
    const senderOpenId = data.event?.sender?.sender_id?.open_id;
    if (!tenantKey || !chatId || !messageId || !eventId || !senderOpenId) {
      return { status: "ignored_invalid_payload" };
    }

    const binding = await config.resolveChannelBinding({ tenantKey, chatId });
    if (!binding) {
      return { status: "ignored_unbound_chat" };
    }

    const botMentionKey = findBotMentionKey(message.mentions, config.botOpenId);
    const eventTimeMs = header?.create_time ? Number(header.create_time) : (config.now?.() ?? Date.now());

    const event = normalizeLarkMessage({
      tenantKey,
      chatId,
      chatType: message.chat_type ?? "group",
      senderOpenId,
      text: extractText(message.content),
      messageId,
      ...(message.root_id ? { rootId: message.root_id } : {}),
      eventId,
      eventTimeMs,
      agentId: config.agentId,
      ...(config.botOpenId ? { botOpenId: config.botOpenId } : {}),
      ...(botMentionKey ? { botMentionKey } : {}),
      ...(config.callbackUri ? { callbackUri: config.callbackUri } : {}),
      binding
    });
    if (!event) {
      return { status: "ignored_empty_command" };
    }

    const { runId } = await config.createRun(event);
    return { status: "created", runId };
  };
}
