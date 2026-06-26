import type { OpenTagEvent } from "@opentag/core";
import { type LarkChannelBinding, normalizeLarkMessage, stripLarkMention } from "@opentag/lark";

export type LarkMention = { key?: string; id?: { open_id?: string }; name?: string };

// Flattened `im.message.receive_v1` payload as delivered by the SDK EventDispatcher (header fields + message/sender on the top level). All optional (external input).
export type LarkInboundMessageEvent = {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  tenant_key?: string;
  app_id?: string;
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

export type LarkMessageHandlerConfig = {
  agentId: string;
  botOpenId?: string;
  callbackUri?: string;
  defaultRepoBinding?: { repoProvider: string; owner: string; repo: string };
  resolveChannelBinding(input: { tenantKey: string; chatId: string }): Promise<LarkChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  // Self-service binding from within Lark (`/bind owner/repo`); optional so tests can omit it.
  bindChannel?(input: { tenantKey: string; chatId: string; repoProvider: string; owner: string; repo: string }): Promise<void>;
  // Reply into the originating thread (onboarding hints, bind confirmations); optional.
  reply?(input: { messageId: string; text: string }): Promise<void>;
  now?(): number;
};

export type LarkMessageHandlerOutcome = {
  status:
    | "created"
    | "bound"
    | "ignored_non_text"
    | "ignored_invalid_payload"
    | "ignored_group_requires_bot_open_id"
    | "ignored_not_addressed"
    | "ignored_bind_usage"
    | "ignored_unbound_chat"
    | "ignored_empty_command";
  runId?: string;
  tenantKey?: string;
  chatId?: string;
};

const BIND_USAGE = "Usage: /bind <owner>/<repo> — e.g. /bind amplifthq/opentag (or /bind github:amplifthq/opentag).";
const UNBOUND_HINT =
  "👋 This chat isn't connected to a repo yet. @-mention me with `/bind <owner>/<repo>` to connect it — e.g. /bind amplifthq/opentag.";

function extractText(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function mentionsBot(mentions: LarkMention[] | undefined, botOpenId: string): boolean {
  return (mentions ?? []).some((mention) => mention.id?.open_id === botOpenId);
}

// Parse `/bind owner/repo` (or `/bind provider:owner/repo`). null = not a bind command; {ok:false} = malformed.
function parseBindCommand(
  command: string
): { ok: true; repoProvider: string; owner: string; repo: string } | { ok: false } | null {
  if (!/^\/bind(\s|$)/.test(command)) return null;
  const match = command.match(/^\/bind\s+(?:([\w-]+):)?([\w.-]+)\/([\w.-]+)\s*$/);
  if (!match) return { ok: false };
  return { ok: true, repoProvider: match[1] ?? "github", owner: match[2] as string, repo: match[3] as string };
}

// Handle one inbound Lark message: group messages must @-mention the bot, then handle /bind, resolve binding, normalize, create a run.
export function createLarkMessageHandler(config: LarkMessageHandlerConfig) {
  return async function handleLarkMessage(data: LarkInboundMessageEvent): Promise<LarkMessageHandlerOutcome> {
    const message = data.message;
    if (!message || message.message_type !== "text") {
      return { status: "ignored_non_text" };
    }

    const tenantKey = data.tenant_key ?? data.sender?.tenant_key;
    const chatId = message.chat_id;
    const messageId = message.message_id;
    const eventId = data.event_id;
    const senderOpenId = data.sender?.sender_id?.open_id;
    if (!tenantKey || !chatId || !messageId || !eventId || !senderOpenId) {
      return { status: "ignored_invalid_payload" };
    }

    // Group messages must @-mention the bot before triggering a (write-capable) run; p2p is exempt.
    const isDirect = message.chat_type === "p2p";
    if (!isDirect) {
      if (!config.botOpenId) {
        return { status: "ignored_group_requires_bot_open_id", tenantKey, chatId };
      }
      if (!mentionsBot(message.mentions, config.botOpenId)) {
        return { status: "ignored_not_addressed", tenantKey, chatId };
      }
    }

    const command = stripLarkMention(extractText(message.content));

    // Self-service binding: connect this chat to a repo without leaving Lark.
    const bindRequest = parseBindCommand(command);
    if (bindRequest && config.bindChannel) {
      if (!bindRequest.ok) {
        await config.reply?.({ messageId, text: BIND_USAGE });
        return { status: "ignored_bind_usage", tenantKey, chatId };
      }
      await config.bindChannel({
        tenantKey,
        chatId,
        repoProvider: bindRequest.repoProvider,
        owner: bindRequest.owner,
        repo: bindRequest.repo
      });
      await config.reply?.({
        messageId,
        text: `✅ Connected this chat to ${bindRequest.repoProvider}:${bindRequest.owner}/${bindRequest.repo}. @-mention me with a task to start a run.`
      });
      return { status: "bound", tenantKey, chatId };
    }

    let binding = await config.resolveChannelBinding({ tenantKey, chatId });
    if (!binding) {
      if (config.defaultRepoBinding && config.bindChannel) {
        await config.bindChannel({
          tenantKey,
          chatId,
          repoProvider: config.defaultRepoBinding.repoProvider,
          owner: config.defaultRepoBinding.owner,
          repo: config.defaultRepoBinding.repo
        });
        binding = {
          tenantKey,
          chatId,
          repoProvider: config.defaultRepoBinding.repoProvider,
          owner: config.defaultRepoBinding.owner,
          repo: config.defaultRepoBinding.repo
        };
      } else {
        await config.reply?.({ messageId, text: UNBOUND_HINT });
        return { status: "ignored_unbound_chat", tenantKey, chatId };
      }
    }

    const parsedTime = data.create_time ? Number(data.create_time) : Number.NaN;
    const eventTimeMs = Number.isFinite(parsedTime) ? parsedTime : (config.now?.() ?? Date.now());

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
