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
  createLinearAgentActivity,
  createLinearIssueCommentRecord,
  linearAgentSessionIdFromCallbackUri,
  linearIssueIdFromCallbackUri,
  linearParentCommentIdFromCallbackUri,
  updateLinearAgentSession,
  updateLinearComment,
  type FetchLike as LinearFetchLike
} from "@opentag/linear";
import {
  createSlackPostMessagePayload,
  createSlackReactionPayload,
  createSlackUpdateMessagePayload,
  parseSlackThreadKey,
  slackSourceReceiptReactionName
} from "@opentag/slack";
import {
  createTelegramEditMessageTextPayload,
  createTelegramSendMessagePayload,
  parseTelegramThreadKey,
  telegramMessageRichPayloadFromUnknown
} from "@opentag/telegram";
import { createTeamsConnector, createTeamsTokenProvider, parseTeamsThreadKey } from "@opentag/teams";
import type { CallbackDeliveryResult, CallbackMessage, CallbackSink, SourceReceipt, SourceReceiptSink } from "./server.js";

export type FetchLike = typeof fetch;
export type LinearTokenProvider = () => Promise<string | undefined> | string | undefined;

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

async function resolveLinearToken(input: { token?: string; getToken?: LinearTokenProvider }): Promise<string | undefined> {
  const token = input.getToken ? await input.getToken() : input.token;
  const trimmed = token?.trim();
  return trimmed ? trimmed : undefined;
}

function linearAgentSessionPlanFor(message: CallbackMessage) {
  const completed = message.kind === "final";
  return [
    {
      content: "Accept the Linear agent session",
      status: "completed" as const
    },
    {
      content: "Run OpenTag on the paired local checkout",
      status: completed ? ("completed" as const) : ("inProgress" as const)
    },
    {
      content: "Report the result back to Linear",
      status: completed ? ("completed" as const) : ("pending" as const)
    }
  ];
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

export function createLinearCallbackSink(input: {
  token?: string;
  getToken?: LinearTokenProvider;
  graphqlUrl?: string;
  fetchImpl?: LinearFetchLike;
}): CallbackSink {
  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult | void> {
      if (message.provider !== "linear") return;
      const token = await resolveLinearToken(input);
      if (!token) return;
      const agentSessionId = linearAgentSessionIdFromCallbackUri(message.uri);
      if (agentSessionId) {
        await updateLinearAgentSession({
          token,
          ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
          agentSessionId,
          plan: linearAgentSessionPlanFor(message),
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
        });
        const activityId = await createLinearAgentActivity({
          token,
          ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
          activity: {
            agentSessionId,
            type: message.kind === "final" ? "response" : "thought",
            body: message.body,
            ephemeral: message.kind === "progress"
          },
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
        });
        return activityId ? { externalMessageId: activityId } : undefined;
      }
      const issueId = linearIssueIdFromCallbackUri(message.uri);
      if (!issueId) {
        throw new Error(`deliver Linear callback failed: invalid callback URI ${message.uri}`);
      }
      if (message.statusMessageKey && message.externalMessageId) {
        await updateLinearComment({
          token,
          commentId: message.externalMessageId,
          body: message.body,
          ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
        });
        return { externalMessageId: message.externalMessageId };
      }
      const comment = await createLinearIssueCommentRecord({
        token,
        issueId,
        body: message.body,
        ...(linearParentCommentIdFromCallbackUri(message.uri) ? { parentId: linearParentCommentIdFromCallbackUri(message.uri)! } : {}),
        ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
      });
      return message.statusMessageKey && comment.id ? { externalMessageId: comment.id } : undefined;
    }
  };
}

// Discord rejects message content longer than 2000 characters with a 400 (code 50035),
// which would fail the whole delivery. Truncate so long summaries/diffs still post.
const DISCORD_MAX_CONTENT = 2000;

function truncateDiscordContent(body: string): string {
  return body.length > DISCORD_MAX_CONTENT ? `${body.slice(0, DISCORD_MAX_CONTENT - 3)}...` : body;
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
      // Swallow a prior failure so a transient error on one update does not permanently
      // break the edit chain for the subsequent progress/final messages of the same run.
      const current = previous.catch(() => {}).then(async () => {
        const existingMessageId = messageIdByKey.get(statusKey);
        // status_update edit chain: POST the first message, PATCH the same one after.
        // message.uri is the channel `/messages` endpoint, so the edit URL appends the id.
        const response = await fetchImpl(existingMessageId ? `${message.uri.replace(/\/$/, "")}/${existingMessageId}` : message.uri, {
          method: existingMessageId ? "PATCH" : "POST",
          headers: {
            authorization: `Bot ${token}`,
            "content-type": "application/json"
          },
          // allowed_mentions suppresses @everyone/role/user pings that may appear
          // in executor output or user-provided text echoed into the summary.
          body: JSON.stringify({ content: truncateDiscordContent(message.body), allowed_mentions: { parse: [] } }),
          // Bound the request so a hung POST/PATCH can't stall every later status
          // update for this run (deliveries are serialized through the edit chain).
          signal: AbortSignal.timeout(10_000)
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

export function createTeamsCallbackSink(input: {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  fetchImpl?: FetchLike;
}): CallbackSink {
  // Reject partial credentials so a misconfigured sink fails at startup, not silently.
  if (Boolean(input.appId) !== Boolean(input.appPassword)) {
    throw new Error("Teams callback sink requires both appId and appPassword (or neither).");
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const tokenProvider =
    input.appId && input.appPassword
      ? createTeamsTokenProvider({
          appId: input.appId,
          appPassword: input.appPassword,
          ...(input.tenantId ? { tenantId: input.tenantId } : {}),
          fetchImpl
        })
      : undefined;
  const connector = tokenProvider ? createTeamsConnector({ getToken: () => tokenProvider.getToken(), fetchImpl }) : undefined;
  const activityIdByKey = new Map<string, string>();
  const deliveryByKey = new Map<string, Promise<void>>();

  return {
    async deliver(message: CallbackMessage): Promise<void> {
      if (message.provider !== "teams") return;
      if (!connector) return;
      if (!message.threadKey) {
        throw new Error("Teams callback message is missing threadKey.");
      }

      const { serviceUrl, conversationId } = parseTeamsThreadKey(message.threadKey);
      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      const previous = deliveryByKey.get(statusKey) ?? Promise.resolve();
      // Swallow a prior failure so a transient error on one update does not permanently
      // break the edit chain for the subsequent progress/final messages of the same run.
      const current = previous.catch(() => {}).then(async () => {
        try {
          const existingActivityId = activityIdByKey.get(statusKey);
          // status_update edit chain: POST the first message, PUT (edit) the same one after.
          if (existingActivityId) {
            await connector.updateMessage({ serviceUrl, conversationId, activityId: existingActivityId, text: message.body });
          } else {
            const { activityId } = await connector.postMessage({ serviceUrl, conversationId, text: message.body });
            activityIdByKey.set(statusKey, activityId);
          }
        } finally {
          if (message.kind === "final") {
            activityIdByKey.delete(statusKey);
          }
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
  const messageIdByKey = new Map<string, string>();

  return {
    async deliver(message: CallbackMessage): Promise<CallbackDeliveryResult | void> {
      if (message.provider !== "telegram") return;
      const botToken = slackBotTokenFor({
        botToken: input.botToken,
        botTokensByAgentId: input.botTokensByAgentId,
        agentId: message.agentId
      });
      if (!botToken) return;

      const thread = parseTelegramThreadKey(message.threadKey ?? "");
      const statusKey = message.statusMessageKey ?? `${message.runId}:status`;
      const rich =
        message.rich?.provider === "telegram" ? telegramMessageRichPayloadFromUnknown(message.rich.payload) ?? undefined : undefined;
      const existingMessageId = message.externalMessageId ?? messageIdByKey.get(statusKey);
      const parsedExistingMessageId = existingMessageId ? Number(existingMessageId) : undefined;
      const canEdit = parsedExistingMessageId !== undefined && Number.isInteger(parsedExistingMessageId) && parsedExistingMessageId > 0;

      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${canEdit ? "editMessageText" : "sendMessage"}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          canEdit
            ? createTelegramEditMessageTextPayload({
                chatId: thread.chatId,
                messageId: parsedExistingMessageId,
                text: message.body,
                ...(rich ? { rich } : {})
              })
            : createTelegramSendMessagePayload({
                chatId: thread.chatId,
                text: message.body,
                ...(rich ? { rich } : {}),
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
      if (canEdit) {
        if (message.kind === "final") {
          messageIdByKey.delete(statusKey);
        }
        return { externalMessageId: String(parsedExistingMessageId) };
      }
      const result = (body as { result?: { message_id?: unknown } }).result;
      const deliveredMessageId = typeof result?.message_id === "number" ? String(result.message_id) : undefined;
      if (deliveredMessageId && message.statusMessageKey) {
        messageIdByKey.set(statusKey, deliveredMessageId);
      }
      if (message.kind === "final") {
        messageIdByKey.delete(statusKey);
      }
      return deliveredMessageId ? { externalMessageId: deliveredMessageId } : undefined;
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
