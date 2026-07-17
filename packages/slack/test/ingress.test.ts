import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSlackSignature, createSlackEventsApp } from "../src/ingress.js";

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
    const createRun = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
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

    const start = Date.now();
    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": currentTimestamp,
        "x-slack-signature": sign(rawBody)
      },
      body: rawBody
    });
    const elapsedMs = Date.now() - start;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(elapsedMs).toBeLessThan(30);
    expect(timeline).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(timeline).toEqual(["createRun_finished"]);
    expect(createRun).toHaveBeenCalledOnce();
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

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(createRun).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith("[slack] async event processing failed:", failure);
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

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(submitThreadAction).toHaveBeenCalledOnce();
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
