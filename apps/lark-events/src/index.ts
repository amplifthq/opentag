import * as lark from "@larksuiteoapi/node-sdk";
import { createOpenTagClient } from "@opentag/client";
import { createLarkMessageHandler, type LarkInboundMessageEvent } from "./app.js";

const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;
const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
if (!appId || !appSecret) {
  throw new Error("LARK_APP_ID and LARK_APP_SECRET are required");
}
if (!dispatcherUrl) {
  throw new Error("OPENTAG_DISPATCHER_URL is required");
}

const domain = process.env.LARK_DOMAIN === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark;
const dispatcherToken = process.env.OPENTAG_DISPATCHER_TOKEN;
const dispatcherClient = createOpenTagClient({
  dispatcherUrl,
  ...(dispatcherToken ? { pairingToken: dispatcherToken } : {})
});

const handler = createLarkMessageHandler({
  agentId: process.env.OPENTAG_LARK_AGENT_ID ?? "opentag",
  ...(process.env.LARK_BOT_OPEN_ID ? { botOpenId: process.env.LARK_BOT_OPEN_ID } : {}),
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
  async createRun(event) {
    const runId = `run_${Date.now()}`;
    await dispatcherClient.createRun({ runId, event });
    return { runId };
  }
});

const eventDispatcher = new lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    await handler(data as unknown as LarkInboundMessageEvent);
  }
});

const wsClient = new lark.WSClient({ appId, appSecret, domain });
void wsClient.start({ eventDispatcher });

console.log("OpenTag Lark events long-connection ingress started");
