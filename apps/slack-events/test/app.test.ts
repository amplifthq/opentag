import { describe, expect, it, vi } from "vitest";
import { computeSlackSignature, createSlackEventsApp } from "../src/app.js";

describe("Slack events app", () => {
  it("handles Slack url_verification", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const timestamp = "1710000000";
    const app = createSlackEventsApp({
      signingSecret: "secret",
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      now: () => "2026-06-24T00:00:00.000Z"
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
      team_id: "T123",
      event_id: "Ev123",
      event_time: 1710000000,
      authorizations: [{ user_id: "U_APP" }],
      event: {
        type: "app_mention",
        user: "U456",
        text: "<@U_APP> fix this",
        ts: "1710000000.000100",
        channel: "C123"
      }
    });
    const timestamp = "1710000000";
    const app = createSlackEventsApp({
      signingSecret: "secret",
      async resolveChannelBinding() {
        return { teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" };
      },
      createRun,
      now: () => "2026-06-24T00:00:00.000Z",
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
  });

  it("rejects invalid Slack signatures", async () => {
    const app = createSlackEventsApp({
      signingSecret: "secret",
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      now: () => "2026-06-24T00:00:00.000Z"
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
});
