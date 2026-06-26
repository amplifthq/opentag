import { randomUUID } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import { createOpenTagClient } from "@opentag/client";
import { createLarkReplyClient, replyLarkMessage } from "@opentag/lark";
import { createLarkMessageHandler, type LarkInboundMessageEvent, type LarkMessageHandlerOutcome } from "./app.js";

const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;
const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
if (!appId || !appSecret) {
  throw new Error("LARK_APP_ID and LARK_APP_SECRET are required");
}
if (!dispatcherUrl) {
  throw new Error("OPENTAG_DISPATCHER_URL is required");
}

const larkDomain = process.env.LARK_DOMAIN === "feishu" ? "feishu" : "lark";
const dispatcherToken = process.env.OPENTAG_DISPATCHER_TOKEN;
const dispatcherClient = createOpenTagClient({
  dispatcherUrl,
  ...(dispatcherToken ? { pairingToken: dispatcherToken } : {})
});
const replyClient = createLarkReplyClient({ appId, appSecret, domain: larkDomain });

function defaultRepoBindingFromEnv(value: string | undefined) {
  if (!value) return undefined;
  const match = value.match(/^(?:([\w-]+):)?([\w.-]+)\/([\w.-]+)$/);
  if (!match) {
    throw new Error("OPENTAG_LARK_DEFAULT_REPO must be formatted as owner/repo or provider:owner/repo");
  }
  return {
    repoProvider: match[1] ?? "github",
    owner: match[2] as string,
    repo: match[3] as string
  };
}

const defaultRepoBinding = defaultRepoBindingFromEnv(process.env.OPENTAG_LARK_DEFAULT_REPO);

const handler = createLarkMessageHandler({
  agentId: process.env.OPENTAG_LARK_AGENT_ID ?? "opentag",
  ...(process.env.LARK_BOT_OPEN_ID ? { botOpenId: process.env.LARK_BOT_OPEN_ID } : {}),
  ...(defaultRepoBinding ? { defaultRepoBinding } : {}),
  async resolveChannelBinding(input) {
    try {
      const { binding } = await dispatcherClient.getChannelBinding({
        provider: "lark",
        accountId: input.tenantKey,
        conversationId: input.chatId
      });
      return {
        tenantKey: binding.accountId,
        chatId: binding.conversationId,
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
  async bindChannel(input) {
    await dispatcherClient.bindChannel({
      provider: "lark",
      accountId: input.tenantKey,
      conversationId: input.chatId,
      repoProvider: input.repoProvider,
      owner: input.owner,
      repo: input.repo
    });
  },
  async reply(input) {
    await replyLarkMessage(replyClient, input);
  },
  async createRun(event) {
    const runId = `run_${randomUUID()}`;
    await dispatcherClient.createRun({ runId, event });
    return { runId };
  }
});

function logIgnored(outcome: LarkMessageHandlerOutcome): void {
  if (outcome.status === "created" || outcome.status === "bound") return;
  if (outcome.status === "ignored_unbound_chat") {
    console.log(
      `[lark] ignored unbound chat — bind it: provider=lark accountId(tenant_key)=${outcome.tenantKey} conversationId(chat_id)=${outcome.chatId} (reply '/bind owner/repo' in the chat, or POST /v1/channel-bindings)`
    );
    return;
  }
  console.log(`[lark] ignored event: ${outcome.status}${outcome.chatId ? ` chat_id=${outcome.chatId}` : ""}`);
}

const eventDispatcher = new lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    logIgnored(await handler(data as unknown as LarkInboundMessageEvent));
  }
});

const wsClient = new lark.WSClient({
  appId,
  appSecret,
  domain: larkDomain === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark
});
wsClient.start({ eventDispatcher }).catch((error: unknown) => {
  console.error("[lark] failed to start long-connection client:", error);
  process.exit(1);
});

console.log("OpenTag Lark events long-connection ingress started");
