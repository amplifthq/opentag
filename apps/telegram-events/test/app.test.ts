import { describe, expect, it, vi } from "vitest";
import { createTelegramEventsApp } from "../src/app.js";

describe("Telegram events app", () => {
  const now = "2026-06-25T00:00:00.000Z";

  it("creates a run for a bound Telegram private message", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      async resolveChannelBinding() {
        return {
          botId: "bot_123",
          chatId: "456",
          repoProvider: "github",
          owner: "acme",
          repo: "demo"
        };
      },
      createRun,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 101,
          from: { id: 789, username: "alice" },
          chat: { id: 456, type: "private" },
          text: "fix this"
        }
      })
    });

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledOnce();
    const [event] = createRun.mock.calls[0] ?? [];
    expect(event.source).toBe("telegram");
    expect(event.target.agentId).toBe("opentag");
  });
});
