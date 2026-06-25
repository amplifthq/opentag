import { createSlackPostMessagePayload, createSlackUpdateMessagePayload, parseSlackThreadKey } from "@opentag/slack";
import { createTelegramSendMessageDraftPayload, createTelegramSendMessagePayload, parseTelegramThreadKey } from "@opentag/telegram";
import type { CallbackMessage, CallbackSink } from "./server.js";

export type FetchLike = typeof fetch;

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

function slackBotTokenFor(input: {
  botToken?: string;
  botTokensByAgentId?: Record<string, string>;
  agentId?: string;
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
        ...(input.botToken ? { botToken: input.botToken } : {}),
        ...(input.botTokensByAgentId ? { botTokensByAgentId: input.botTokensByAgentId } : {}),
        ...(message.agentId ? { agentId: message.agentId } : {})
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
        ...(input.botToken ? { botToken: input.botToken } : {}),
        ...(input.botTokensByAgentId ? { botTokensByAgentId: input.botTokensByAgentId } : {}),
        ...(message.agentId ? { agentId: message.agentId } : {})
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
    async deliver(message: CallbackMessage): Promise<void> {
      for (const sink of sinks) {
        await sink.deliver(message);
      }
    }
  };
}
