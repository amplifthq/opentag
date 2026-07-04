import { computeLineSignature } from "@opentag/line";
import { describe, expect, it, vi } from "vitest";
import { createLineEventsApp } from "../src/app.js";

function signedHeaders(rawBody: string) {
  return {
    "content-type": "application/json",
    "x-line-signature": computeLineSignature({ channelSecret: "secret", rawBody })
  };
}

function lineRunId(sourceEventId: string): string {
  return `run_line_${Buffer.from(sourceEventId, "utf8").toString("base64url")}`;
}

describe("LINE events app", () => {
  it("rejects unknown accounts", async () => {
    const app = createLineEventsApp({
      lineAccounts: [{ accountId: "line_main", channelSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      now: () => "2026-07-02T00:00:00.000Z"
    });

    const response = await app.request("/line/events/unknown", { method: "POST", body: JSON.stringify({ events: [] }) });
    expect(response.status).toBe(404);
  });

  it("rejects missing and invalid signatures", async () => {
    const app = createLineEventsApp({
      lineAccounts: [{ accountId: "line_main", channelSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      now: () => "2026-07-02T00:00:00.000Z"
    });

    expect((await app.request("/line/events/line_main", { method: "POST", body: "{}" })).status).toBe(400);
    expect(
      (
        await app.request("/line/events/line_main", {
          method: "POST",
          headers: { "x-line-signature": "bad" },
          body: "{}"
        })
      ).status
    ).toBe(401);
  });

  it("accepts valid empty event batches", async () => {
    const rawBody = JSON.stringify({ events: [] });
    const app = createLineEventsApp({
      lineAccounts: [{ accountId: "line_main", channelSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      async createRun() {
        return { runId: "run_1" };
      },
      now: () => "2026-07-02T00:00:00.000Z"
    });

    const response = await app.request("/line/events/line_main", { method: "POST", headers: signedHeaders(rawBody), body: rawBody });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("creates runs for bound text messages", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const rawBody = JSON.stringify({
      events: [
        {
          type: "message",
          webhookEventId: "webhook_1",
          replyToken: "reply_1",
          source: { type: "user", userId: "U123" },
          message: { id: "msg_1", type: "text", text: "fix this" }
        }
      ]
    });
    const app = createLineEventsApp({
      lineAccounts: [{ accountId: "line_main", channelSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return { accountId: "line_main", conversationId: "U123", repoProvider: "github", owner: "acme", repo: "demo" };
      },
      createRun,
      now: () => "2026-07-02T00:00:00.000Z"
    });

    const response = await app.request("/line/events/line_main", { method: "POST", headers: signedHeaders(rawBody), body: rawBody });
    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledOnce();
    expect(createRun.mock.calls[0]?.[0]).toMatchObject({ source: "line", sourceEventId: "webhook_1", metadata: { webhookSignatureVerified: true } });
    expect(createRun.mock.calls[0]?.[1]).toEqual({ runId: lineRunId("webhook_1") });
  });

  it("continues processing later events when one LINE event fails", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const recordControlPlaneEvent = vi.fn(async () => undefined);
    const rawBody = JSON.stringify({
      events: [
        {
          type: "message",
          webhookEventId: "webhook_bad",
          source: { type: "user", userId: "Ubad" },
          message: { id: "msg_bad", type: "text", text: "fix bad" }
        },
        {
          type: "message",
          source: { type: "user", userId: "Uok" },
          message: { id: "msg_ok", type: "text", text: "fix ok" }
        }
      ]
    });
    const app = createLineEventsApp({
      lineAccounts: [{ accountId: "line_main", channelSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding(input) {
        if (input.conversationId === "Ubad") throw new Error("lookup failed");
        return { accountId: "line_main", conversationId: input.conversationId, repoProvider: "github", owner: "acme", repo: "demo" };
      },
      createRun,
      recordControlPlaneEvent,
      now: () => "2026-07-02T00:00:00.000Z"
    });

    const response = await app.request("/line/events/line_main", { method: "POST", headers: signedHeaders(rawBody), body: rawBody });

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledOnce();
    expect(createRun.mock.calls[0]?.[0]).toMatchObject({ source: "line", sourceEventId: "msg_ok" });
    expect(createRun.mock.calls[0]?.[1]).toEqual({ runId: lineRunId("msg_ok") });
    expect(recordControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "line.webhook_event_failed",
        subject: "line:line_main/Ubad",
        payload: expect.objectContaining({ webhookEventId: "webhook_bad", messageId: "msg_bad", error: "lookup failed" })
      })
    );
  });

  it("records unbound LINE conversations for setup discovery", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const recordControlPlaneEvent = vi.fn(async () => undefined);
    const rawBody = JSON.stringify({
      events: [
        {
          type: "message",
          webhookEventId: "webhook_1",
          source: { type: "group", groupId: "G123", userId: "U123" },
          message: { id: "msg_1", type: "text", text: "/opentag fix this" }
        }
      ]
    });
    const app = createLineEventsApp({
      lineAccounts: [{ accountId: "line_main", channelSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      recordControlPlaneEvent,
      now: () => "2026-07-02T00:00:00.000Z"
    });

    const response = await app.request("/line/events/line_main", { method: "POST", headers: signedHeaders(rawBody), body: rawBody });
    expect(response.status).toBe(200);
    expect(createRun).not.toHaveBeenCalled();
    expect(recordControlPlaneEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admission.needs_human_decision",
        subject: "line:line_main/G123",
        payload: expect.objectContaining({ accountId: "line_main", conversationId: "G123", projectTarget: "line:line_main/G123" })
      })
    );
  });

  it("auto-binds group and room joins plus direct messages from the auto template", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const bindChannel = vi.fn(async () => undefined);
    const template = { accountId: "line_main", conversationId: "auto", repoProvider: "github", owner: "acme", repo: "demo" };
    const rawBody = JSON.stringify({
      events: [
        {
          type: "join",
          webhookEventId: "webhook_join",
          source: { type: "group", groupId: "G123" }
        },
        {
          type: "join",
          webhookEventId: "webhook_room_join",
          source: { type: "room", roomId: "R123" }
        },
        {
          type: "message",
          webhookEventId: "webhook_dm",
          source: { type: "user", userId: "U123" },
          message: { id: "msg_1", type: "text", text: "fix this" }
        }
      ]
    });
    const app = createLineEventsApp({
      lineAccounts: [{ accountId: "line_main", channelSecret: "secret", agentId: "opentag" }],
      async resolveChannelBinding(input) {
        return input.conversationId === "auto" ? template : null;
      },
      bindChannel,
      createRun,
      now: () => "2026-07-02T00:00:00.000Z"
    });

    const response = await app.request("/line/events/line_main", { method: "POST", headers: signedHeaders(rawBody), body: rawBody });

    expect(response.status).toBe(200);
    expect(bindChannel).toHaveBeenCalledTimes(3);
    expect(bindChannel).toHaveBeenNthCalledWith(1, { ...template, conversationId: "G123" });
    expect(bindChannel).toHaveBeenNthCalledWith(2, { ...template, conversationId: "R123" });
    expect(bindChannel).toHaveBeenNthCalledWith(3, { ...template, conversationId: "U123" });
    expect(createRun).toHaveBeenCalledOnce();
    expect(createRun.mock.calls[0]?.[0]).toMatchObject({ source: "line", metadata: { conversationId: "U123" } });
  });

  it("ignores uninvoked group messages without binding or recording discovery noise", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const bindChannel = vi.fn(async () => undefined);
    const resolveChannelBinding = vi.fn(async () => null);
    const recordControlPlaneEvent = vi.fn(async () => undefined);
    const rawBody = JSON.stringify({
      events: [
        {
          type: "message",
          webhookEventId: "webhook_group_chatter",
          source: { type: "group", groupId: "G123", userId: "U123" },
          message: { id: "msg_1", type: "text", text: "hello team" }
        }
      ]
    });
    const app = createLineEventsApp({
      lineAccounts: [{ accountId: "line_main", channelSecret: "secret", agentId: "opentag" }],
      resolveChannelBinding,
      bindChannel,
      createRun,
      recordControlPlaneEvent,
      now: () => "2026-07-02T00:00:00.000Z"
    });

    const response = await app.request("/line/events/line_main", { method: "POST", headers: signedHeaders(rawBody), body: rawBody });

    expect(response.status).toBe(200);
    expect(resolveChannelBinding).not.toHaveBeenCalled();
    expect(bindChannel).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(recordControlPlaneEvent).not.toHaveBeenCalled();
  });
});
