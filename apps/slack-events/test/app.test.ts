import { describe, expect, it, vi } from "vitest";
import { computeSlackSignature, createSlackEventsApp, verifySlackTimestamp } from "../src/app.js";

describe("Slack events app", () => {
  const now = "2024-06-24T00:00:00.000Z";
  const currentTimestamp = "1719187200";
  const currentClock = () => Number(currentTimestamp) * 1000;

  it("handles Slack url_verification", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const timestamp = currentTimestamp;
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
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("abc123");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("creates a run for a signed app_mention in a bound channel", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "Ev123",
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
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "gitlab", owner: "acme", repo: "demo" };
      },
      createRun,
      now: () => now,
      clock: currentClock,
      callbackUri: "http://127.0.0.1:3102/github-comment"
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledOnce();
    const [event] = createRun.mock.calls[0] ?? [];
    expect(event.target.agentId).toBe("gemini");
    expect(event.metadata.repoProvider).toBe("gitlab");
  });

  it("submits source-thread action replies from plain Slack messages", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvAction",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "message",
        user: "U456",
        text: "apply label",
        ts: `${currentTimestamp}.000200`,
        thread_ts: `${currentTimestamp}.000100`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [
        {
          appId: "A_GEMINI",
          signingSecret: "secret",
          agentId: "gemini",
          callbackUri: "http://127.0.0.1:3102/slack-callback"
        }
      ],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      createRun,
      submitThreadAction,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction).toHaveBeenCalledWith({
      id: "approval_slack_EvAction",
      rawText: "apply label",
      actor: {
        provider: "slack",
        providerUserId: "U456",
        handle: "U456",
        organizationId: "T123"
      },
      callback: {
        provider: "slack",
        uri: "http://127.0.0.1:3102/slack-callback",
        threadKey: `T123|C123|${currentTimestamp}.000100`
      },
      metadata: {
        teamId: "T123",
        channelId: "C123",
        messageTs: `${currentTimestamp}.000200`,
        slackAppId: "A_GEMINI",
        slackBotUserId: "U_APP",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });
  });

  it("ignores plain non-action messages before resolving channel bindings", async () => {
    const resolveChannelBinding = vi.fn(async () => ({ teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }));
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvPlain",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "message",
        user: "U456",
        text: "thanks, I will look later",
        ts: `${currentTimestamp}.000300`,
        channel: "C123"
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      resolveChannelBinding,
      createRun,
      submitThreadAction,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    expect(resolveChannelBinding).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction).not.toHaveBeenCalled();
  });

  it("ignores Slack message subtypes before validating user-authored message fields", async () => {
    const resolveChannelBinding = vi.fn(async () => ({ teamId: "T123", channelId: "C123", repoProvider: "github", owner: "acme", repo: "demo" }));
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "EvChanged",
      event_time: Number(currentTimestamp),
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C123",
        message: {
          user: "U456",
          text: "apply 1",
          ts: `${currentTimestamp}.000400`
        },
        ts: `${currentTimestamp}.000400`
      }
    });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      resolveChannelBinding,
      createRun,
      submitThreadAction,
      now: () => now,
      clock: currentClock
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(resolveChannelBinding).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction).not.toHaveBeenCalled();
  });

  it("supports multiple Slack apps with different secrets and agent ids", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_2" }));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_DEEPSEEK",
      team_id: "T123",
      event_id: "Ev456",
      event_time: Number(currentTimestamp) + 100,
      authorizations: [{ user_id: "U_DEEP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_DEEP> explain this",
        ts: `${Number(currentTimestamp) + 100}.000100`,
        channel: "C123"
      }
    });
    const timestamp = String(Number(currentTimestamp) + 100);
    const app = createSlackEventsApp({
      slackApps: [
        { appId: "A_GEMINI", signingSecret: "secret_1", agentId: "gemini" },
        { appId: "A_DEEPSEEK", signingSecret: "secret_2", agentId: "deepseek" }
      ],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" };
      },
      createRun,
      now: () => now,
      clock: () => (Number(currentTimestamp) + 100) * 1000
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret_2",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledOnce();
    const [event] = createRun.mock.calls[0] ?? [];
    expect(event.target.agentId).toBe("deepseek");
  });

  it("handles url_verification for one of multiple Slack apps without api_app_id", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [
        { appId: "A_GEMINI", signingSecret: "secret_1", agentId: "gemini" },
        { appId: "A_DEEPSEEK", signingSecret: "secret_2", agentId: "deepseek" }
      ],
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
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret_2",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("abc123");
  });

  it("returns 400 for malformed JSON payloads", async () => {
    const rawBody = "{not-json";
    const timestamp = currentTimestamp;
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
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
  });

  it("rejects invalid Slack signatures", async () => {
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
        "x-slack-request-timestamp": "1710000000",
        "x-slack-signature": "v0=bad"
      },
      body: JSON.stringify({ type: "url_verification", challenge: "abc123" })
    });

    expect(response.status).toBe(401);
  });

  it("rejects stale Slack timestamps", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const rawBody = JSON.stringify({
      type: "event_callback",
      api_app_id: "A_GEMINI",
      team_id: "T123",
      event_id: "Ev123",
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
    const timestamp = currentTimestamp;
    const app = createSlackEventsApp({
      slackApps: [{ appId: "A_GEMINI", signingSecret: "secret", agentId: "gemini" }],
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" };
      },
      createRun,
      now: () => now,
      clock: () => (Number(currentTimestamp) + 301) * 1000
    });

    const response = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": computeSlackSignature({
          signingSecret: "secret",
          timestamp,
          rawBody
        })
      },
      body: rawBody
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "stale_signature_timestamp" });
    expect(createRun).not.toHaveBeenCalled();
  });

  it("validates timestamp age with a five minute default tolerance", () => {
    expect(verifySlackTimestamp({ timestamp: "1710000000", nowMs: 1710000000 * 1000 })).toBe(true);
    expect(verifySlackTimestamp({ timestamp: "1710000000", nowMs: (1710000000 + 300) * 1000 })).toBe(true);
    expect(verifySlackTimestamp({ timestamp: "1710000000", nowMs: (1710000000 + 301) * 1000 })).toBe(false);
  });
});
