import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { startSlackSocketModeApp } from "../src/socket-mode.js";

class FakeWebSocket extends EventEmitter {
  readonly sent: string[] = [];
  closeCalled = false;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalled = true;
    this.emit("close");
  }
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

describe("Slack Socket Mode", () => {
  it("acks Socket Mode envelopes and processes app mentions through the shared Slack handler", async () => {
    const socket = new FakeWebSocket();
    let socketCreated = false;
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, url: "wss://slack.example/socket" })) as unknown as typeof fetch;
    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun,
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket(url) {
          expect(url).toBe("wss://slack.example/socket");
          socketCreated = true;
          return socket as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    await eventually(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await eventually(() => expect(socketCreated).toBe(true));
    await Promise.resolve();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "events_api",
          envelope_id: "envelope_1",
          payload: {
            type: "event_callback",
            api_app_id: "A123",
            team_id: "T123",
            event_id: "Ev123",
            event_time: 1719187200,
            authorizations: [{ user_id: "U_APP" }],
            event: {
              type: "app_mention",
              user: "U456",
              text: "<@U_APP> fix this",
              ts: "1719187200.000100",
              channel: "C123"
            }
          }
        })
      )
    );

    await eventually(() => expect(createRun).toHaveBeenCalledOnce());
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: "envelope_1" })]);
    expect(createRun.mock.calls[0]?.[0]).toMatchObject({
      source: "slack",
      target: {
        agentId: "opentag",
        mention: "<@U_APP>"
      },
      metadata: {
        slackAppId: "A123",
        teamId: "T123",
        channelId: "C123"
      }
    });

    await handle.close();
    expect(socket.closeCalled).toBe(true);
  });

  it("retries after a transient apps.connections.open failure instead of rejecting the start promise", async () => {
    const socket = new FakeWebSocket();
    let socketCreated = false;
    // First open attempt fails (Slack returns ok:false), second succeeds. A
    // rejecting startPromise would abort the entire OpenTag daemon, so the loop
    // must swallow the transient failure and retry.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: false, error: "ratelimited" }))
      .mockResolvedValue(Response.json({ ok: true, url: "wss://slack.example/socket" })) as unknown as typeof fetch;

    let rejected = false;
    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun: vi.fn(async () => ({ runId: "run_1" })),
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket() {
          socketCreated = true;
          return socket as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    handle.startPromise.catch(() => {
      rejected = true;
    });

    // The first attempt fails; the second attempt must run and open the socket.
    await eventually(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await eventually(() => expect(socketCreated).toBe(true));
    expect(rejected).toBe(false);

    await handle.close();
    // close() awaits startPromise; if it had rejected, the flag would be set.
    expect(rejected).toBe(false);
  });

  it("rejects the start promise on a terminal auth error instead of retrying forever", async () => {
    let socketCreated = false;
    // Slack returns a terminal auth failure. Retrying would loop forever against
    // the API, so startPromise must reject and the open must not be reattempted.
    const fetchImpl = vi.fn(async () => Response.json({ ok: false, error: "invalid_auth" })) as unknown as typeof fetch;

    const handle = startSlackSocketModeApp(
      {
        appToken: "xapp-bad-token",
        slackApp: {
          agentId: "opentag",
          appId: "A123"
        },
        async resolveChannelBinding() {
          return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
        },
        createRun: vi.fn(async () => ({ runId: "run_1" })),
        now: () => "2024-06-24T00:00:00.000Z"
      },
      {
        fetchImpl,
        reconnectDelayMs: 1,
        createWebSocket() {
          socketCreated = true;
          return new FakeWebSocket() as unknown as WebSocket;
        },
        log() {},
        logError() {}
      }
    );

    await expect(handle.startPromise).rejects.toThrow(/invalid_auth/);
    // A terminal error must not be retried, so only one open attempt happens and
    // no socket is ever created.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(socketCreated).toBe(false);

    // close() must remain safe to call even after a rejected startPromise.
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
