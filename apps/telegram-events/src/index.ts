import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import { createTelegramEventsApp } from "./app.js";

const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
if (!dispatcherUrl) {
  throw new Error("OPENTAG_DISPATCHER_URL is required");
}

const dispatcherToken = process.env.OPENTAG_DISPATCHER_TOKEN;
const port = Number(process.env.PORT ?? "3050");
const dispatcherClient = createOpenTagClient({
  dispatcherUrl,
  ...(dispatcherToken ? { pairingToken: dispatcherToken } : {})
});

type TelegramBotConfig = {
  botId: string;
  agentId: string;
  botUsername?: string;
  secretToken?: string;
  callbackUri?: string;
};

function telegramBotsFromEnv(): TelegramBotConfig[] {
  const botsJson = process.env.OPENTAG_TELEGRAM_BOTS_JSON;
  if (botsJson) {
    try {
      const parsed = JSON.parse(botsJson);
      if (!Array.isArray(parsed)) {
        throw new Error("Value is not a JSON array");
      }
      return parsed.filter(
        (candidate): candidate is TelegramBotConfig =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          typeof candidate.botId === "string" &&
          typeof candidate.agentId === "string"
      );
    } catch (error) {
      throw new Error(
        `Failed to parse OPENTAG_TELEGRAM_BOTS_JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!process.env.OPENTAG_TELEGRAM_BOT_ID) {
    return [];
  }

  return [
    {
      botId: process.env.OPENTAG_TELEGRAM_BOT_ID,
      agentId: process.env.OPENTAG_TELEGRAM_AGENT_ID ?? "opentag",
      ...(process.env.OPENTAG_TELEGRAM_BOT_USERNAME ? { botUsername: process.env.OPENTAG_TELEGRAM_BOT_USERNAME } : {}),
      ...(process.env.OPENTAG_TELEGRAM_SECRET_TOKEN ? { secretToken: process.env.OPENTAG_TELEGRAM_SECRET_TOKEN } : {}),
      ...(process.env.OPENTAG_TELEGRAM_CALLBACK_URI ? { callbackUri: process.env.OPENTAG_TELEGRAM_CALLBACK_URI } : {})
    }
  ];
}

const telegramBots = telegramBotsFromEnv();
if (telegramBots.length === 0) {
  throw new Error("Configure OPENTAG_TELEGRAM_BOT_ID or OPENTAG_TELEGRAM_BOTS_JSON");
}

serve({
  fetch: createTelegramEventsApp({
    telegramBots,
    async resolveChannelBinding(input) {
      try {
        const { binding } = await dispatcherClient.getChannelBinding({
          provider: "telegram",
          accountId: input.botId,
          conversationId: input.chatId
        });
        return {
          botId: binding.accountId,
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
      const runId = `run_${randomUUID()}`;
      await dispatcherClient.createRun({ runId, event });
      return { runId };
    },
    now: () => new Date().toISOString()
  }).fetch,
  port
});

console.log(`OpenTag Telegram events ingress listening on http://localhost:${port}`);
