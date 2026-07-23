import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSlackSignature, createSlackEventsApp, startSlackIngress } from "../src/ingress.js";

describe("Slack Events API ack-then-async", () => {
  const now = "2024-06-24T00:00:00.000Z";
  const currentTimestamp = "1719187200";
  const currentClock = () => Number(currentTimestamp) * 1000;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sign(rawBody: string, timestamp = currentTimestamp) {
    return computeSlackSignature({ signingSecret: "secret", timestamp, rawBody });
  }

  it("keeps url_verification synchronous and echoes the challenge", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": currentTimestamp,
        "x-slack-signature": sign(rawBody)
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("abc123");
  });

  it("acks an event_callback with {ok:true} before a slow handler finishes, then still runs it", async () => {
    const timeline: string[] = [];
    let releaseCreateRun!: () => void;
    const createRunGate = new Promise<void>((resolve) => {
      releaseCreateRun = resolve;
    });
    const createRun = vi.fn(async () => {
      await createRunGate;
      timeline.push("createRun_finished");
      return { runId: "run_1" };
    });
    const rawBody = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event_id: "EvSlow1",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> fix this",
        ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      createRun,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": currentTimestamp,
        "x-slack-signature": sign(rawBody)
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(timeline).toHaveLength(0);

    releaseCreateRun();
    await vi.waitFor(() => {
      expect(timeline).toEqual(["createRun_finished"]);
      expect(createRun).toHaveBeenCalledOnce();
    });
  });

  it("logs and swallows an error from asynchronous event processing without changing the ack response", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("boom");
    const createRun = vi.fn(async () => {
      throw failure;
    });
    const rawBody = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event_id: "EvFail1",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> fix this",
        ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      createRun,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": currentTimestamp,
        "x-slack-signature": sign(rawBody)
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    await vi.waitFor(() => {
      expect(createRun).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith("[slack] async event processing failed:", failure);
    });
  });

  it("acks a block_actions interactive payload with {ok:true} immediately", async () => {
    const submitThreadAction = vi.fn(async () => ({}));
    const interactivePayload = {
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "U456", username: "alice" },
      channel: { id: "C123" },
      message: { ts: `${currentTimestamp}.000500`, thread_ts: `${currentTimestamp}.000100` },
      trigger_id: "trigger_apply_1",
      actions: [
        {
          type: "button",
          action_id: "opentag:apply:1",
          value: JSON.stringify({ version: 1, command: "apply 1", proposalId: "proposal_1", intentId: "intent_1" })
        }
      ]
    };
    const rawBody = new URLSearchParams({ payload: JSON.stringify(interactivePayload) }).toString();
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      async createRun() {
        return { runId: "run_1" };
      },
      submitThreadAction,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": currentTimestamp,
        "x-slack-signature": sign(rawBody)
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    await vi.waitFor(() => expect(submitThreadAction).toHaveBeenCalledOnce());
  });

  it.each([
    ["maxAsyncConcurrency", { maxAsyncConcurrency: 0 }],
    ["maxAsyncOutstanding", { maxAsyncOutstanding: 0 }]
  ])("preserves a zero %s setting so startup validation rejects it", (name, limits) => {
    expect(() =>
      startSlackIngress({
        signingSecret: "secret",
        dispatcherUrl: "http://127.0.0.1:1",
        port: -1,
        ...limits
      })
    ).toThrow(`${name} must be a positive integer.`);
  });

  it("bounds active plus queued event processing and returns 503 without starting overflow work", async () => {
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const audits: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      maxAsyncConcurrency: 1,
      maxAsyncOutstanding: 2,
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      async createRun(event) {
        const eventId = String(event.metadata.sourceDeliveryId);
        started.push(eventId);
        await new Promise<void>((resolve) => releases.push(resolve));
        return { runId: `run_${eventId}` };
      },
      async recordControlPlaneEvent(event) {
        audits.push(event);
      },
      now: () => now,
      clock: currentClock
    });

    async function deliver(eventId: string) {
      const rawBody = JSON.stringify({
        type: "event_callback",
        team_id: "T123",
        event_id: eventId,
        event_time: Number(currentTimestamp),
        authorizations: [{ user_id: "U_APP" }],
        event: {
          type: "app_mention",
          user: "U456",
          text: "<@U_APP> fix this",
          ts: `${currentTimestamp}.${eventId.slice(-1).padStart(6, "0")}`,
          channel: "C123"
        }
      });
      return app.request("/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": currentTimestamp,
          "x-slack-signature": sign(rawBody)
        },
        body: rawBody
      });
    }

    const first = await deliver("EvBound1");
    const second = await deliver("EvBound2");
    const overflow = await deliver("EvBound3");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(overflow.status).toBe(503);
    await expect(overflow.json()).resolves.toEqual({ error: "slack_async_queue_full" });
    await vi.waitFor(() => expect(started).toEqual(["EvBound1"]));
    expect(started).not.toContain("EvBound3");
    await vi.waitFor(() => expect(audits).toContainEqual(expect.objectContaining({
      type: "availability.backpressure",
      payload: expect.objectContaining({ reason: "async_queue_full", maxAsyncOutstanding: 2 })
    })));

    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(["EvBound1", "EvBound2"]));
    releases.shift()?.();
  });

  it("keeps a queue-full 503 response safe when backpressure auditing rejects", async () => {
    const release = new Promise<void>(() => {});
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      maxAsyncConcurrency: 1,
      maxAsyncOutstanding: 1,
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      async createRun() {
        await release;
        return { runId: "never" };
      },
      async recordControlPlaneEvent() {
        throw new Error("audit unavailable");
      },
      now: () => now,
      clock: currentClock
    });
    async function deliver(eventId: string) {
      const rawBody = JSON.stringify({
        type: "event_callback",
        team_id: "T123",
        event_id: eventId,
        authorizations: [{ user_id: "U_APP" }],
        event: { type: "app_mention", user: "U456", text: "<@U_APP> fix", ts: `${currentTimestamp}.1`, channel: "C123" }
      });
      return app.request("/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": currentTimestamp,
          "x-slack-signature": sign(rawBody)
        },
        body: rawBody
      });
    }

    expect((await deliver("EvAudit1")).status).toBe(200);
    const overflow = await deliver("EvAudit2");
    expect(overflow.status).toBe(503);
    await expect(overflow.json()).resolves.toEqual({ error: "slack_async_queue_full" });
  });

  it("releases an async slot after rejected processing so later deliveries can run", async () => {
    let attempts = 0;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      maxAsyncConcurrency: 1,
      maxAsyncOutstanding: 1,
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      async createRun() {
        attempts += 1;
        if (attempts === 1) throw new Error("first failed");
        return { runId: "run_ok" };
      },
      now: () => now,
      clock: currentClock
    });

    async function deliver(eventId: string) {
      const rawBody = JSON.stringify({
        type: "event_callback",
        team_id: "T123",
        event_id: eventId,
        authorizations: [{ user_id: "U_APP" }],
        event: { type: "app_mention", user: "U456", text: "<@U_APP> fix", ts: `${currentTimestamp}.1`, channel: "C123" }
      });
      return app.request("/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": currentTimestamp,
          "x-slack-signature": sign(rawBody)
        },
        body: rawBody
      });
    }

    expect((await deliver("EvRelease1")).status).toBe(200);
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect((await deliver("EvRelease2")).status).toBe(200);
    await vi.waitFor(() => expect(attempts).toBe(2));
  });

  it("still returns 400 synchronously for malformed JSON without invoking the processor", async () => {
    const rawBody = "{not-json";
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const app = createSlackEventsApp({
      slackApps: [{ signingSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": currentTimestamp,
        "x-slack-signature": sign(rawBody)
      },
      body: rawBody
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
    expect(createRun).not.toHaveBeenCalled();
  });
});
