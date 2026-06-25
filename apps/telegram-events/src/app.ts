import type { OpenTagEvent } from "@opentag/core";
import { type TelegramChannelBinding, normalizeTelegramMessage } from "@opentag/telegram";
import { Hono } from "hono";

type TelegramBotConfig = {
  botId: string;
  agentId: string;
  botUsername?: string;
  secretToken?: string;
  callbackUri?: string;
};

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    message_thread_id?: number;
    text?: string;
    from?: {
      id?: number;
      username?: string;
    };
    chat?: {
      id?: number;
      type?: "private" | "group" | "supergroup" | "channel";
    };
  };
};

export function createTelegramEventsApp(input: {
  telegramBots: TelegramBotConfig[];
  resolveChannelBinding(input: { botId: string; chatId: string }): Promise<TelegramChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  now(): string;
}) {
  const app = new Hono();

  app.post("/telegram/events/:botId", async (c) => {
    const botId = c.req.param("botId");
    const bot = input.telegramBots.find((candidate) => candidate.botId === botId);
    if (!bot) {
      return c.json({ error: "unknown_telegram_bot" }, 404);
    }
    if (bot.secretToken) {
      const actual = c.req.header("x-telegram-bot-api-secret-token");
      if (actual !== bot.secretToken) {
        return c.json({ error: "invalid_secret_token" }, 401);
      }
    }

    let payload: TelegramUpdate;
    try {
      payload = (await c.req.json()) as TelegramUpdate;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const message = payload.message;
    if (!message?.message_id || !message.chat?.id || !message.chat.type || !message.from?.id || !message.text) {
      return c.json({ ok: true, ignored: "unsupported_update" });
    }

    const chatId = String(message.chat.id);
    const binding = await input.resolveChannelBinding({ botId, chatId });
    if (!binding) {
      return c.json({ ok: true, ignored: "unbound_chat" });
    }

    const event = normalizeTelegramMessage({
      botId,
      chatId,
      chatType: message.chat.type,
      userId: String(message.from.id),
      ...(message.from.username ? { username: message.from.username } : {}),
      ...(bot.botUsername ? { botUsername: bot.botUsername } : {}),
      text: message.text,
      messageId: message.message_id,
      ...(payload.update_id ? { updateId: payload.update_id } : {}),
      ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {}),
      receivedAt: input.now(),
      agentId: bot.agentId,
      ...(bot.callbackUri ? { callbackUri: bot.callbackUri } : {}),
      binding
    });
    if (!event) {
      return c.json({ ok: true, ignored: "empty_command" });
    }

    await input.createRun(event);
    return c.json({ ok: true });
  });

  return app;
}
