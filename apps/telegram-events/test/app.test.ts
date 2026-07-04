import { describe, expect, it, vi } from "vitest";
import { createTelegramEventsApp } from "../src/app.js";

describe("Telegram events app", () => {
  const now = "2026-06-25T00:00:00.000Z";

  function telegramMessage(text: string, input: { chatType?: "private" | "group" | "supergroup" | "channel" } = {}) {
    return {
      update_id: 1,
      message: {
        message_id: 101,
        from: { id: 789, username: "alice" },
        chat: { id: 456, type: input.chatType ?? "private" },
        text
      }
    };
  }

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
      body: JSON.stringify(telegramMessage("fix this"))
    });

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledOnce();
    const [event] = createRun.mock.calls[0] ?? [];
    expect(event.source).toBe("telegram");
    expect(event.target.agentId).toBe("opentag");
  });

  it("rejects oversized webhook bodies before parsing updates", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      recordControlPlaneEvent,
      maxRequestBodyBytes: 8,
      now: () => now
    });
    const body = JSON.stringify(telegramMessage("fix this"));

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body))
      },
      body
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "request_body_too_large", maxBytes: 8 });
    expect(createRun).not.toHaveBeenCalled();
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.request_body_rejected",
      severity: "warn",
      subject: "telegram:POST /telegram/events/:botId",
      payload: {
        provider: "telegram",
        endpoint: "POST /telegram/events/:botId",
        reason: "request_body_too_large",
        botId: "bot_123",
        maxBytes: 8,
        contentLength: String(Buffer.byteLength(body))
      }
    });
  });

  it("records redacted signature-failure audit events for invalid Telegram secret tokens", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag", secretToken: "expected_secret_token" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      recordControlPlaneEvent,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "wrong_secret_token"
      },
      body: JSON.stringify(telegramMessage("fix this"))
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_secret_token" });
    expect(createRun).not.toHaveBeenCalled();
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.signature_failed",
      severity: "warn",
      subject: "telegram:POST /telegram/events/:botId",
      payload: {
        provider: "telegram",
        endpoint: "POST /telegram/events/:botId",
        reason: "invalid_secret_token",
        botId: "bot_123",
        hasSecretToken: true
      }
    });
    const serializedAudit = JSON.stringify(recordControlPlaneEvent.mock.calls);
    expect(serializedAudit).not.toContain("expected_secret_token");
    expect(serializedAudit).not.toContain("wrong_secret_token");
  });

  it("returns 400 for webhook bodies that do not match the consumed Telegram schema", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const recordControlPlaneEvent = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      recordControlPlaneEvent,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: "not-a-number" })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request_body" });
    expect(createRun).not.toHaveBeenCalled();
    expect(recordControlPlaneEvent).toHaveBeenCalledWith({
      type: "security.request_body_rejected",
      severity: "warn",
      subject: "telegram:POST /telegram/events/:botId",
      payload: {
        provider: "telegram",
        endpoint: "POST /telegram/events/:botId",
        reason: "invalid_request_body",
        botId: "bot_123",
        maxBytes: 1048576,
        contentLength: null
      }
    });
  });

  it("replies to /help without requiring a Project Target binding", async () => {
    const resolveChannelBinding = vi.fn(async () => {
      throw new Error("binding lookup should not be required for help");
    });
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const reply = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      resolveChannelBinding,
      createRun,
      reply,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/help"))
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, command: "help" });
    expect(resolveChannelBinding).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "456",
      messageId: 101,
      text: expect.stringContaining("📚 OpenTag commands")
    }));
    expect(reply.mock.calls[0]?.[0].text).toContain("Project Targets never use absolute local paths");
  });

  it("binds the Telegram chat to a Project Target without creating a run", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const bindChannel = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      async resolveChannelBinding() {
        throw new Error("binding lookup should not be required for bind");
      },
      createRun,
      bindChannel,
      reply,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/bind github:acme/demo"))
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, command: "bind" });
    expect(createRun).not.toHaveBeenCalled();
    expect(bindChannel).toHaveBeenCalledWith({
      botId: "bot_123",
      chatId: "456",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      text: ["🔗 Bound", "", "📌 Target: github:acme/demo", "Send a task to start a run."].join("\n")
    }));
  });

  it("rejects malformed /bind targets and does not expose local paths", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const bindChannel = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      async resolveChannelBinding() {
        throw new Error("binding lookup should not be required for malformed bind");
      },
      createRun,
      bindChannel,
      reply,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/bind /Users/alice/repos/demo"))
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, command: "bind", usage: true });
    expect(createRun).not.toHaveBeenCalled();
    expect(bindChannel).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Usage: /bind <owner>/<repo>");
    expect(reply.mock.calls[0]?.[0].text).toContain("Project Targets never use absolute local paths");
  });

  it("denies group /bind by default before changing the Project Target", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const bindChannel = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      async resolveChannelBinding() {
        throw new Error("binding lookup should not be required for denied bind");
      },
      createRun,
      bindChannel,
      reply,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/opentag /bind github:acme/demo", { chatType: "group" }))
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, command: "bind", unauthorized: true });
    expect(createRun).not.toHaveBeenCalled();
    expect(bindChannel).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Only an authorized Telegram binding manager");
  });

  it("allows group /bind when the host authorizes the binding manager", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const bindChannel = vi.fn(async () => {});
    const canManageBinding = vi.fn(async () => true);
    const reply = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      async resolveChannelBinding() {
        throw new Error("binding lookup should not be required for authorized bind");
      },
      createRun,
      bindChannel,
      canManageBinding,
      reply,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/opentag /bind github:acme/demo", { chatType: "group" }))
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, command: "bind" });
    expect(canManageBinding).toHaveBeenCalledWith(expect.objectContaining({
      action: "bind",
      botId: "bot_123",
      chatId: "456",
      chatType: "group",
      userId: "789",
      username: "alice"
    }));
    expect(bindChannel).toHaveBeenCalledWith({
      botId: "bot_123",
      chatId: "456",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    });
  });

  it("replies to /status through the self-service status hook instead of creating a run", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const status = vi.fn(async () => "OpenTag status:\nProject Target: github:acme/demo\nActive run: run_active (running)");
    const reply = vi.fn(async () => {});
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
      status,
      reply,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/status"))
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, command: "status" });
    expect(createRun).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      botId: "bot_123",
      chatId: "456",
      messageId: 101,
      binding: expect.objectContaining({ owner: "acme", repo: "demo" })
    }));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "456",
      text: expect.stringContaining("run_active")
    }));
  });

  it("routes /stop run_id through the self-service cancellation hook", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const stopRun = vi.fn(async () => ({ outcome: "cancelled" as const, runId: "run_active" }));
    const reply = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      async resolveChannelBinding() {
        throw new Error("binding lookup should not be required for stop");
      },
      createRun,
      stopRun,
      reply,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/stop run_active"))
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, command: "stop", runId: "run_active" });
    expect(createRun).not.toHaveBeenCalled();
    expect(stopRun).toHaveBeenCalledWith({
      botId: "bot_123",
      chatId: "456",
      runId: "run_active",
      requestedBy: "telegram:789"
    });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("⏹️ Cancellation requested")
    }));
    expect(reply.mock.calls[0]?.[0].text).toContain("🆔 Run: run_active");
    expect(reply.mock.calls[0]?.[0].text).toContain("will not treat this stop request as a successful completion");
  });

  it("replies with stop guidance when cancellation is unavailable", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const reply = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      async resolveChannelBinding() {
        throw new Error("binding lookup should not be required for stop");
      },
      createRun,
      reply,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/stop"))
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, command: "stop", unavailable: true });
    expect(createRun).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Run cancellation from this Telegram ingress is not configured.")
    }));
  });

  it("unbinds only after explicit confirmation", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const unbindChannel = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
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
      unbindChannel,
      reply,
      now: () => now
    });

    const usage = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/unbind"))
    });
    expect(usage.status).toBe(200);
    await expect(usage.json()).resolves.toMatchObject({ ok: true, command: "unbind", usage: true });
    expect(unbindChannel).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Usage: /unbind confirm");

    const confirmed = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/unbind confirm"))
    });
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({ ok: true, command: "unbind" });
    expect(createRun).not.toHaveBeenCalled();
    expect(unbindChannel).toHaveBeenCalledWith({ botId: "bot_123", chatId: "456" });
    expect(reply.mock.calls[1]?.[0].text).toContain("🔓 Unbound");
    expect(reply.mock.calls[1]?.[0].text).toContain("Disconnected from github:acme/demo");
  });

  it("denies group /unbind by default before reading or deleting the Project Target binding", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const resolveChannelBinding = vi.fn(async () => {
      throw new Error("binding lookup should not be required for denied unbind");
    });
    const unbindChannel = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      resolveChannelBinding,
      createRun,
      unbindChannel,
      reply,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/opentag /unbind confirm", { chatType: "group" }))
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, command: "unbind", unauthorized: true });
    expect(createRun).not.toHaveBeenCalled();
    expect(resolveChannelBinding).not.toHaveBeenCalled();
    expect(unbindChannel).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Only an authorized Telegram binding manager");
  });

  it("replies to /doctor with a redacted default summary when the chat is unbound", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const reply = vi.fn(async () => {});
    const app = createTelegramEventsApp({
      telegramBots: [{ botId: "bot_123", agentId: "opentag" }],
      async resolveChannelBinding() {
        return null;
      },
      createRun,
      reply,
      now: () => now
    });

    const response = await app.request("/telegram/events/bot_123", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telegramMessage("/doctor"))
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, command: "doctor" });
    expect(createRun).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("🩺 OpenTag doctor (redacted)")
    }));
    expect(reply.mock.calls[0]?.[0].text).toContain("Secrets: redacted");
    expect(reply.mock.calls[0]?.[0].text).not.toContain("secret_token_value");
  });
});
