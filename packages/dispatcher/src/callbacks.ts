import {
  addLarkMessageReaction,
  createLarkReplyClient,
  patchLarkMessageCard,
  type LarkCard,
  type LarkReplyClient,
  parseLarkThreadKey,
  replyLarkMessage,
  updateLarkTextMessage
} from "@opentag/lark";
import {
  createSlackPostMessagePayload,
  createSlackReactionPayload,
  createSlackUpdateMessagePayload,
  parseSlackThreadKey,
  slackSourceReceiptReactionName
} from "@opentag/slack";
import { createTelegramSendMessageDraftPayload, createTelegramSendMessagePayload, parseTelegramThreadKey } from "@opentag/telegram";
import type { CallbackDeliveryResult, CallbackMessage, CallbackSink, SourceReceipt, SourceReceiptSink } from "./server.js";

export type FetchLike = typeof fetch;

const DEFAULT_SLACK_SOURCE_RECEIPT_TIMEOUT_MS = 5_000;
const DEFAULT_LARK_RECEIVED_REACTION = "Typing";

function slackUpdateUriFrom(postMessageUri: string): string {
  return postMessageUri.replace(/\/chat\.postMessage$/, "/chat.update");
}

function githubCommentUriFrom(input: { commentsUri: string; responseBody: { id?: number; url?: string } }): string | undefined {
  if (input.responseBody.url) return input.responseBody.url;
  if (typeof input.responseBody.id === "number") {
    return input.commentsUri.replace(/\/comments$/, `/comments/${input.responseBody.id}`);
  }
  return undefined;
}

function gitlabNoteUriFrom(input: { notesUri: string; responseBody: { id?: number | string } | null | undefined }): string | undefined {
  if (input.responseBody && (typeof input.responseBody.id === "number" || typeof input.responseBody.id === "string")) {
    return `${input.notesUri.replace(/\/$/, "")}/${encodeURIComponent(String(input.responseBody.id))}`;
  }
  return undefined;
}

function slackBotTokenFor(input: {
  botToken?: string | undefined;
  botTokensByAgentId?: Record<string, string> | undefined;
  agentId?: string | undefined;
}): string | undefined {
  if (
    input.agentId &&
    input.botTokensByAgentId &&
    Object.hasOwn(input.botTokensByAgentId, input.agentId) &&
    typeof input.botTokensByAgentId[input.agentId] === "string"
  ) {
    return input.botTokensByAgentId[input.agentId];
  }
  return input.botToken;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function slackSourceMessageTarget(receipt: SourceReceipt): { channelId: string; messageTs: string } | null {
  if (receipt.provider !== "slack") return null;
  const channelId = metadataString(receipt.event.metadata, "channelId");
  const messageTs = metadataString(receipt.event.metadata, "messageTs");
  return channelId && messageTs ? { channelId, messageTs } : null;
}

function larkSourceMessageTarget(receipt: SourceReceipt): { messageId: string } | null {
  if (receipt.provider !== "lark" || receipt.state !== "received") return null;
  const threadKey = receipt.event.callback.threadKey;
  if (!threadKey) return null;
  return { messageId: parseLarkThreadKey(threadKey).messageId };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function fetchWithTimeout(input: {
  fetchImpl: FetchLike;
  uri: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    return await input.fetchImpl(input.uri, { ...input.init, signal: controller.signal });
  } catch (error) {
    if (isAbortError(error)) return null;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function createGitHubCallbackSink(input: { token?: string; fetchImpl?: FetchLike }): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const commentUriByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<void>>();

  return {
    async deliver(message: CallbackMessage): Promise<void> {
      if (message.provider !== "github") return;
      if (!input.token) return;

      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      const previous = deliveryByKey.get(statusKey) ?? Promise.resolve();
      const current = previous.then(async () => {
        const existingCommentUri = commentUriByKey.get(statusKey);
        const response = await fetchImpl(existingCommentUri ?? message.uri, {
          method: existingCommentUri ? "PATCH" : "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${input.token}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28"
          },
          body: JSON.stringify({ body: message.body })
        });

        if (!response.ok) {
          throw new Error(`deliver GitHub callback failed: ${response.status} ${await response.text()}`);
        }
        if (!existingCommentUri) {
          const body = (await response.json()) as { id?: number; url?: string };
          const commentUri = githubCommentUriFrom({ commentsUri: message.uri, responseBody: body });
          if (commentUri) {
            commentUriByKey.set(statusKey, commentUri);
          }
        }
        if (message.kind === "final") {
          commentUriByKey.delete(statusKey);
        }
      });
      deliveryByKey.set(statusKey, current);
      await current.finally(() => {
        if (deliveryByKey.get(statusKey) === current) {
          deliveryByKey.delete(statusKey);
        }
      });
    }
  };
}

export function createGitLabCallbackSink(input: { token?: string; fetchImpl?: FetchLike }): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const noteUriByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<void>>();

  return {
    async deliver(message: CallbackMessage): Promise<void> {
      if (message.provider !== "gitlab") return;
      const token = input.token;
      if (!token) return;

      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      const previous = deliveryByKey.get(statusKey) ?? Promise.resolve();
      const current = previous.then(async () => {
        const existingNoteUri = noteUriByKey.get(statusKey);
        const response = await fetchImpl(existingNoteUri ?? message.uri, {
          method: existingNoteUri ? "PUT" : "POST",
          headers: {
            "PRIVATE-TOKEN": token,
            "content-type": "application/json"
          },
          body: JSON.stringify({ body: message.body })
        });

        if (!response.ok) {
          throw new Error(`deliver GitLab callback failed: ${response.status} ${await response.text()}`);
        }
        if (!existingNoteUri) {
          const body = (await response.json()) as { id?: number | string } | null;
          const noteUri = gitlabNoteUriFrom({ notesUri: message.uri, responseBody: body });
          if (noteUri) {
            noteUriByKey.set(statusKey, noteUri);
          }
        }
        if (message.kind === "final") {
          noteUriByKey.delete(statusKey);
        }
      });
      deliveryByKey.set(statusKey, current);
      await current.finally(() => {
        if (deliveryByKey.get(statusKey) === current) {
          deliveryByKey.delete(statusKey);
        }
      });
    }
  };
}

export function createDiscordCallbackSink(input: { token?: string; fetchImpl?: FetchLike }): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const messageIdByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<void>>();

  return {
    async deliver(message: CallbackMessage): Promise<void> {
      if (message.provider !== "discord") return;
      const token = input.token;
      if (!token) return;

      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      const previous = deliveryByKey.get(statusKey) ?? Promise.resolve();
      const current = previous.then(async () => {
        const existingMessageId = messageIdByKey.get(statusKey);
        // status_update edit chain: POST the first message, PATCH the same one after.
        // message.uri is the channel `/messages` endpoint, so the edit URL appends the id.
        const response = await fetchImpl(existingMessageId ? `${message.uri.replace(/\/$/, "")}/${existingMessageId}` : message.uri, {
          method: existingMessageId ? "PATCH" : "POST",
          headers: {
            authorization: `Bot ${token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ content: message.body })
        });

        if (!response.ok) {
          throw new Error(`deliver Discord callback failed: ${response.status} ${await response.text()}`);
        }
        if (!existingMessageId) {
          const body = (await response.json()) as { id?: string } | null;
          if (body && typeof body.id === "string") {
            messageIdByKey.set(statusKey, body.id);
          }
        }
        if (message.kind === "final") {
          messageIdByKey.delete(statusKey);
        }
      });
      deliveryByKey.set(statusKey, current);
      await current.finally(() => {
        if (deliveryByKey.get(statusKey) === current) {
          deliveryByKey.delete(statusKey);
        }
      });
    }
  };
}

export function createSlackCallbackSink(input: {
  botToken?: string;
  botTokensByAgentId?: Record<string, string>;
  fetchImpl?: FetchLike;
}): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const statusMessageTsByKey = new Map<string, string>();

  return {
    async deliver(message: CallbackMessage): Promise<void> {
      if (message.provider !== "slack") return;
      const botToken = slackBotTokenFor({
        botToken: input.botToken,
        botTokensByAgentId: input.botTokensByAgentId,
        agentId: message.agentId
      });
      if (!botToken) return;

      const thread = parseSlackThreadKey(message.threadKey ?? "");
      const existingStatusTs = message.statusMessageKey ? statusMessageTsByKey.get(message.statusMessageKey) : undefined;
      const response = await fetchImpl(existingStatusTs ? slackUpdateUriFrom(message.uri) : message.uri, {
        method: "POST",
        headers: {
          authorization: `Bearer ${botToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(
          existingStatusTs
            ? createSlackUpdateMessagePayload({
                channelId: thread.channelId,
                text: message.body,
                messageTs: existingStatusTs,
                ...(message.blocks?.length ? { blocks: message.blocks } : {})
              })
            : createSlackPostMessagePayload({
                channelId: thread.channelId,
                text: message.body,
                threadTs: thread.threadTs,
                ...(message.blocks?.length ? { blocks: message.blocks } : {})
              })
        )
      });

      if (!response.ok) {
        throw new Error(`deliver Slack callback failed: ${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as { ok?: boolean; error?: string; ts?: string };
      if (body.ok === false) {
        throw new Error(`deliver Slack callback failed: ${body.error ?? "unknown_error"}`);
      }
      if (message.statusMessageKey && !existingStatusTs && body.ts) {
        statusMessageTsByKey.set(message.statusMessageKey, body.ts);
      }
      if (message.kind === "final") {
        for (const key of statusMessageTsByKey.keys()) {
          if (key.startsWith(`${message.runId}:`)) {
            statusMessageTsByKey.delete(key);
          }
        }
      }
    }
  };
}

export function createSlackSourceReceiptSink(input: {
  botToken?: string;
  botTokensByAgentId?: Record<string, string>;
  fetchImpl?: FetchLike;
  reactionsAddUri?: string;
  timeoutMs?: number;
}): SourceReceiptSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const reactionsAddUri = input.reactionsAddUri ?? "https://slack.com/api/reactions.add";
  const timeoutMs = input.timeoutMs ?? DEFAULT_SLACK_SOURCE_RECEIPT_TIMEOUT_MS;

  return {
    async deliver(receipt: SourceReceipt) {
      const target = slackSourceMessageTarget(receipt);
      if (!target) return { delivered: false };

      const botToken = slackBotTokenFor({
        botToken: input.botToken,
        botTokensByAgentId: input.botTokensByAgentId,
        agentId: receipt.agentId
      });
      if (!botToken) return { delivered: false };

      const response = await fetchWithTimeout({
        fetchImpl,
        uri: reactionsAddUri,
        timeoutMs,
        init: {
          method: "POST",
          headers: {
            authorization: `Bearer ${botToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createSlackReactionPayload({
              channelId: target.channelId,
              messageTs: target.messageTs,
              name: slackSourceReceiptReactionName(receipt.state)
            })
          )
        }
      });
      if (!response) return { delivered: false };

      if (!response.ok) {
        throw new Error(`deliver Slack source receipt failed: ${response.status} ${await response.text()}`);
      }
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } | null;
      if (body?.ok === false && body.error !== "already_reacted") {
        throw new Error(`deliver Slack source receipt failed: ${body?.error ?? "unknown_error"}`);
      }
      return { delivered: true };
    }
  };
}

export function createLarkSourceReceiptSink(input: {
  appId?: string;
  appSecret?: string;
  domain?: "lark" | "feishu";
  client?: LarkReplyClient;
  receivedEmojiType?: string;
}): SourceReceiptSink {
  if (!input.client && Boolean(input.appId) !== Boolean(input.appSecret)) {
    throw new Error("Lark source receipt sink requires both appId and appSecret (or neither).");
  }

  const client: LarkReplyClient | undefined =
    input.client ??
    (input.appId && input.appSecret
      ? createLarkReplyClient({ appId: input.appId, appSecret: input.appSecret, ...(input.domain ? { domain: input.domain } : {}) })
      : undefined);
  const receivedEmojiType = input.receivedEmojiType ?? DEFAULT_LARK_RECEIVED_REACTION;

  return {
    async deliver(receipt: SourceReceipt) {
      const target = larkSourceMessageTarget(receipt);
      if (!target || !client) return { delivered: false };
      await addLarkMessageReaction(client, {
        messageId: target.messageId,
        emojiType: receivedEmojiType
      });
      return { delivered: true };
    }
  };
}

export function createLarkCallbackSink(input: {
  appId?: string;
  appSecret?: string;
  domain?: "lark" | "feishu";
  client?: LarkReplyClient;
}): CallbackSink {
  // Reject partial credentials so a misconfigured sink fails at startup, not silently.
  if (!input.client && Boolean(input.appId) !== Boolean(input.appSecret)) {
    throw new Error("Lark callback sink requires both appId and appSecret (or neither).");
  }

  const client: LarkReplyClient | undefined =
    input.client ??
    (input.appId && input.appSecret
      ? createLarkReplyClient({ appId: input.appId, appSecret: input.appSecret, ...(input.domain ? { domain: input.domain } : {}) })
      : undefined);

  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult | void> {
      if (message.provider !== "lark") return;
      // A lark run was accepted, so a missing client/threadKey is a real failure, not a silent success.
      if (!client) {
        throw new Error("Lark callback sink received a lark message but has no client configured (missing appId/appSecret).");
      }
      if (!message.threadKey) {
        throw new Error("Lark callback message is missing threadKey.");
      }
      if (message.externalMessageId) {
        if (message.rich?.provider === "lark") {
          await patchLarkMessageCard(client, {
            messageId: message.externalMessageId,
            card: message.rich.payload as LarkCard
          });
        } else {
          await updateLarkTextMessage(client, {
            messageId: message.externalMessageId,
            text: message.body
          });
        }
        return { externalMessageId: message.externalMessageId };
      }
      const { messageId } = parseLarkThreadKey(message.threadKey);
      const reply = await replyLarkMessage(client, {
        messageId,
        text: message.body,
        ...(message.rich?.provider === "lark" ? { card: message.rich.payload as LarkCard } : {})
      });
      return reply.messageId ? { externalMessageId: reply.messageId } : undefined;
    }
  };
}

export function createTelegramCallbackSink(input: {
  botToken?: string;
  botTokensByAgentId?: Record<string, string>;
  fetchImpl?: FetchLike;
}): CallbackSink {
  const fetchImpl = input.fetchImpl ?? fetch;
  const draftIdByKey = new Map<string, number>();
  let nextDraftId = 1;

  return {
    async deliver(message: CallbackMessage): Promise<void> {
      if (message.provider !== "telegram") return;
      const botToken = slackBotTokenFor({
        botToken: input.botToken,
        botTokensByAgentId: input.botTokensByAgentId,
        agentId: message.agentId
      });
      if (!botToken) return;

      const thread = parseTelegramThreadKey(message.threadKey ?? "");
      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      const isDraft = message.kind === "progress";
      const draftId = isDraft ? (draftIdByKey.get(statusKey) ?? nextDraftId++) : undefined;
      if (isDraft && draftId && !draftIdByKey.has(statusKey)) {
        draftIdByKey.set(statusKey, draftId);
      }

      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${isDraft ? "sendMessageDraft" : "sendMessage"}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          isDraft
            ? createTelegramSendMessageDraftPayload({
                chatId: thread.chatId,
                text: message.body,
                draftId: draftId!,
                ...(thread.messageThreadId ? { messageThreadId: thread.messageThreadId } : {})
              })
            : createTelegramSendMessagePayload({
                chatId: thread.chatId,
                text: message.body,
                replyToMessageId: thread.replyToMessageId,
                ...(thread.messageThreadId ? { messageThreadId: thread.messageThreadId } : {})
              })
        )
      });

      if (!response.ok) {
        throw new Error(`deliver Telegram callback failed: ${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as { ok?: boolean; description?: string };
      if (body.ok === false) {
        throw new Error(`deliver Telegram callback failed: ${body.description ?? "unknown_error"}`);
      }
      if (message.kind === "final") {
        draftIdByKey.delete(statusKey);
      }
    }
  };
}

export function createCompositeCallbackSink(sinks: CallbackSink[]): CallbackSink {
  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult | void> {
      let result: CallbackDeliveryResult | undefined;
      let delivered = false;
      const failures: unknown[] = [];
      for (const sink of sinks) {
        try {
          const deliveredResult = await sink.deliver(message);
          delivered = true;
          if (deliveredResult?.externalMessageId && !result?.externalMessageId) {
            result = { externalMessageId: deliveredResult.externalMessageId };
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (!delivered && failures.length > 0) {
        throw new AggregateError(failures, "Composite callback delivery failed for every sink.");
      }
      return result;
    }
  };
}

export function createCompositeSourceReceiptSink(sinks: SourceReceiptSink[]): SourceReceiptSink {
  return {
    async deliver(receipt: SourceReceipt) {
      let delivered = false;
      const failures: unknown[] = [];
      for (const sink of sinks) {
        try {
          const result = await sink.deliver(receipt);
          delivered ||= result.delivered;
        } catch (error) {
          failures.push(error);
        }
      }
      if (!delivered && failures.length > 0) {
        throw new AggregateError(failures, "Composite source receipt delivery failed for every sink.");
      }
      return { delivered };
    }
  };
}
