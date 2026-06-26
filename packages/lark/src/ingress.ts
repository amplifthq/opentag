import { randomUUID } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import { createOpenTagClient } from "@opentag/client";
import { parseProjectTargetRef, type OpenTagEvent } from "@opentag/core";
import { createLarkReplyClient, replyLarkMessage } from "./outbound.js";
import { createLarkMessageHandler, type LarkInboundMessageEvent, type LarkMessageHandlerOutcome } from "./inbound.js";

export const DEFAULT_AGENT_ID = "opentag";

export type LarkIngressConfig = {
  appId: string;
  appSecret: string;
  dispatcherUrl: string;
  dispatcherToken?: string;
  domain: "lark" | "feishu";
  agentId: string;
  botOpenId?: string;
  defaultRepoBinding?: { repoProvider: string; owner: string; repo: string };
};

export type LarkWsClient = {
  start(input: { eventDispatcher: unknown }): Promise<void>;
  close?(input?: { force?: boolean }): void | Promise<void>;
};

export type LarkIngressDependencies = {
  createWsClient?(config: LarkIngressConfig): LarkWsClient;
  createEventDispatcher?(handler: (data: LarkInboundMessageEvent) => Promise<void>): unknown;
  reply?(input: { messageId: string; text: string }): Promise<void>;
  logIgnored?(outcome: LarkMessageHandlerOutcome): void;
};

export type LarkIngressHandle = {
  startPromise: Promise<void>;
  close(): Promise<void>;
};

function defaultRepoBindingFromEnv(value: string | undefined): LarkIngressConfig["defaultRepoBinding"] {
  if (!value) return undefined;
  try {
    const ref = parseProjectTargetRef(value);
    return {
      repoProvider: ref.provider,
      owner: ref.owner,
      repo: ref.repo
    };
  } catch {
    throw new Error("OPENTAG_LARK_DEFAULT_REPO must be formatted as owner/repo or provider:owner/repo");
  }
}

function domainFromEnv(value: string | undefined): LarkIngressConfig["domain"] {
  const domain = value ?? "lark";
  if (domain !== "lark" && domain !== "feishu") {
    throw new Error("LARK_DOMAIN must be either lark or feishu");
  }
  return domain;
}

export function larkIngressConfigFromEnv(env: NodeJS.ProcessEnv): LarkIngressConfig {
  const appId = env.LARK_APP_ID;
  const appSecret = env.LARK_APP_SECRET;
  const dispatcherUrl = env.OPENTAG_DISPATCHER_URL;
  if (!appId || !appSecret) {
    throw new Error("LARK_APP_ID and LARK_APP_SECRET are required");
  }
  if (!dispatcherUrl) {
    throw new Error("OPENTAG_DISPATCHER_URL is required");
  }

  const defaultRepoBinding = defaultRepoBindingFromEnv(env.OPENTAG_LARK_DEFAULT_REPO);

  return {
    appId,
    appSecret,
    dispatcherUrl,
    domain: domainFromEnv(env.LARK_DOMAIN),
    agentId: env.OPENTAG_LARK_AGENT_ID ?? DEFAULT_AGENT_ID,
    ...(env.OPENTAG_DISPATCHER_TOKEN ? { dispatcherToken: env.OPENTAG_DISPATCHER_TOKEN } : {}),
    ...(env.LARK_BOT_OPEN_ID ? { botOpenId: env.LARK_BOT_OPEN_ID } : {}),
    ...(defaultRepoBinding ? { defaultRepoBinding } : {})
  };
}

function createDefaultWsClient(config: LarkIngressConfig): LarkWsClient {
  return new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain === "feishu" ? lark.Domain.Feishu : lark.Domain.Lark
  });
}

function createDefaultEventDispatcher(handler: (data: LarkInboundMessageEvent) => Promise<void>): unknown {
  return new lark.EventDispatcher({}).register({
    "im.message.receive_v1": (data) => handler(data as unknown as LarkInboundMessageEvent)
  });
}

function logIgnored(outcome: LarkMessageHandlerOutcome): void {
  if (outcome.status === "created" || outcome.status === "bound") return;
  if (outcome.status === "ignored_unbound_chat") {
    console.log(
      `[lark] ignored unbound chat - bind it: provider=lark accountId(tenant_key)=${outcome.tenantKey} conversationId(chat_id)=${outcome.chatId} (reply '/bind owner/repo' with a Project Target ref, or POST /v1/channel-bindings)`
    );
    return;
  }
  console.log(`[lark] ignored event: ${outcome.status}${outcome.chatId ? ` chat_id=${outcome.chatId}` : ""}`);
}

export function startLarkIngress(config: LarkIngressConfig, dependencies: LarkIngressDependencies = {}): LarkIngressHandle {
  const dispatcherClient = createOpenTagClient({
    dispatcherUrl: config.dispatcherUrl,
    ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {})
  });
  let replyClient: ReturnType<typeof createLarkReplyClient> | undefined;
  const reply =
    dependencies.reply ??
    ((input: { messageId: string; text: string }) => {
      replyClient ??= createLarkReplyClient({ appId: config.appId, appSecret: config.appSecret, domain: config.domain });
      return replyLarkMessage(replyClient, input);
    });

  const handler = createLarkMessageHandler({
    agentId: config.agentId,
    ...(config.botOpenId ? { botOpenId: config.botOpenId } : {}),
    ...(config.defaultRepoBinding ? { defaultRepoBinding: config.defaultRepoBinding } : {}),
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
      await reply(input);
    },
    async createRun(event: OpenTagEvent) {
      const runId = `run_${randomUUID()}`;
      await dispatcherClient.createRun({ runId, event });
      return { runId };
    }
  });

  const eventDispatcher = (dependencies.createEventDispatcher ?? createDefaultEventDispatcher)(async (data) => {
    try {
      (dependencies.logIgnored ?? logIgnored)(await handler(data));
    } catch (error) {
      console.error("[lark] failed to handle inbound message:", error);
    }
  });
  const wsClient = (dependencies.createWsClient ?? createDefaultWsClient)(config);

  return {
    startPromise: wsClient.start({ eventDispatcher }),
    async close() {
      await wsClient.close?.({ force: true });
    }
  };
}
