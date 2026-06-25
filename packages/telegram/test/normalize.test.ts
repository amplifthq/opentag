import { describe, expect, it } from "vitest";
import { encodeTelegramThreadKey, normalizeTelegramMessage, parseTelegramThreadKey } from "../src/normalize.js";

describe("Telegram normalization", () => {
  it("normalizes a private Telegram message into an OpenTagEvent", () => {
    const event = normalizeTelegramMessage({
      botId: "bot_123",
      chatId: "456",
      chatType: "private",
      userId: "789",
      text: "fix this",
      messageId: 101,
      updateId: 202,
      agentId: "opentag",
      binding: {
        botId: "bot_123",
        chatId: "456",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event?.source).toBe("telegram");
    expect(event?.command.intent).toBe("fix");
    expect(event?.callback.provider).toBe("telegram");
    expect(event?.metadata).toMatchObject({
      botId: "bot_123",
      chatId: "456",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    });
  });

  it("encodes and decodes Telegram thread keys", () => {
    const key = encodeTelegramThreadKey({
      botId: "bot_123",
      chatId: "456",
      replyToMessageId: 101,
      messageThreadId: 42
    });

    expect(parseTelegramThreadKey(key)).toEqual({
      botId: "bot_123",
      chatId: "456",
      replyToMessageId: 101,
      messageThreadId: 42
    });
  });
});
