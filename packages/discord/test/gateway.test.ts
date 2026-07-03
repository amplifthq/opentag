import { describe, expect, it, vi } from "vitest";
import { startDiscordGateway, type DiscordGatewayWebSocket } from "../src/gateway.js";
import type { DiscordChannelBinding } from "../src/normalize.js";

class FakeWebSocket implements DiscordGatewayWebSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.({});
  }

  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const binding: DiscordChannelBinding = {
  applicationId: "app_1",
  guildId: "guild_1",
  channelId: "chan_1",
  owner: "acme",
  repo: "demo"
};

describe("Discord Gateway", () => {
  it("identifies and handles INTERACTION_CREATE slash commands without an HTTP endpoint", async () => {
    const socket = new FakeWebSocket();
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const handle = startDiscordGateway(
      {
        botToken: "discord_bot_token",
        async resolveChannelBinding() {
          return binding;
        },
        createRun,
        now: () => "2026-07-03T00:00:00.000Z"
      },
      {
        createWebSocket: () => socket,
        fetchImpl,
        reconnectDelayMs: 1,
        log() {},
        logError() {}
      }
    );

    try {
      socket.open();
      socket.message({ op: 10, d: { heartbeat_interval: 1_000_000 } });
      expect(socket.sent.map((entry) => JSON.parse(entry))).toContainEqual(
        expect.objectContaining({
          op: 2,
          d: expect.objectContaining({ token: "discord_bot_token", intents: 0 })
        })
      );

      socket.message({
        op: 0,
        s: 1,
        t: "INTERACTION_CREATE",
        d: {
          id: "int_1",
          token: "interaction_token",
          type: 2,
          application_id: "app_1",
          guild_id: "guild_1",
          channel_id: "chan_1",
          member: { user: { id: "user_1", username: "alice" } },
          data: {
            options: [{ name: "prompt", value: "fix this failing test" }]
          }
        }
      });

      await vi.waitFor(() => {
        expect(fetchImpl).toHaveBeenCalledWith(
          "https://discord.com/api/v10/interactions/int_1/interaction_token/callback",
          expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({ authorization: "Bot discord_bot_token" })
          })
        );
      });
      await vi.waitFor(() => {
        expect(createRun).toHaveBeenCalledWith(
          expect.objectContaining({
            source: "discord",
            sourceEventId: "int_1",
            metadata: expect.objectContaining({ owner: "acme", repo: "demo" })
          })
        );
      });
    } finally {
      await handle.close();
    }
  });
});
