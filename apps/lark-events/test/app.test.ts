import type { OpenTagEvent } from "@opentag/core";
import { describe, expect, it, vi } from "vitest";
import { createLarkMessageHandler, type LarkInboundMessageEvent } from "../src/app.js";

// Mirrors the flattened im.message.receive_v1 payload the SDK delivers.
function messageEvent(overrides?: {
  text?: string;
  messageType?: string;
  chatType?: string;
  chatId?: string;
  tenantKey?: string;
  messageId?: string;
  eventId?: string;
  openId?: string;
  mentionBot?: boolean;
}): LarkInboundMessageEvent {
  const mentionBot = overrides?.mentionBot ?? true;
  return {
    event_id: overrides?.eventId ?? "evt_1",
    event_type: "im.message.receive_v1",
    create_time: "1700000000000",
    tenant_key: overrides?.tenantKey ?? "tk_123",
    sender: {
      sender_id: { open_id: overrides?.openId ?? "ou_user" },
      sender_type: "user",
      tenant_key: overrides?.tenantKey ?? "tk_123"
    },
    message: {
      message_id: overrides?.messageId ?? "om_msg",
      chat_id: overrides?.chatId ?? "oc_chat",
      chat_type: overrides?.chatType ?? "group",
      message_type: overrides?.messageType ?? "text",
      content: JSON.stringify({ text: overrides?.text ?? "@_user_1 fix the bug" }),
      mentions: mentionBot ? [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "OpenTag" }] : []
    }
  };
}

const binding = { tenantKey: "tk_123", chatId: "oc_chat", owner: "acme", repo: "app" };

function makeHandler(opts?: { withBotOpenId?: boolean; createRun?: ReturnType<typeof vi.fn> }) {
  const createRun = opts?.createRun ?? vi.fn(async (_event: OpenTagEvent) => ({ runId: "run_1" }));
  const handler = createLarkMessageHandler({
    agentId: "opentag",
    ...(opts?.withBotOpenId === false ? {} : { botOpenId: "ou_bot" }),
    resolveChannelBinding: async () => binding,
    createRun
  });
  return { handler, createRun };
}

describe("createLarkMessageHandler", () => {
  it("normalizes a group message that @-mentions the bot and creates a run", async () => {
    const { handler, createRun } = makeHandler();
    const outcome = await handler(messageEvent());
    expect(outcome.status).toBe("created");
    expect(outcome.runId).toBe("run_1");
    const event = createRun.mock.calls[0]?.[0];
    expect(event?.source).toBe("lark");
    expect(event?.command.rawText).toBe("fix the bug");
    expect(event?.callback.threadKey).toBe("tk_123|oc_chat|om_msg");
  });

  it("handles a direct (p2p) message without requiring a mention", async () => {
    const { handler } = makeHandler({ withBotOpenId: false });
    const outcome = await handler(messageEvent({ chatType: "p2p", text: "fix the bug", mentionBot: false }));
    expect(outcome.status).toBe("created");
  });

  it("ignores group messages that do not @-mention the bot", async () => {
    const { handler, createRun } = makeHandler();
    const outcome = await handler(messageEvent({ text: "fix the bug", mentionBot: false }));
    expect(outcome.status).toBe("ignored_not_addressed");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("ignores group messages when botOpenId is not configured", async () => {
    const { handler } = makeHandler({ withBotOpenId: false });
    expect((await handler(messageEvent())).status).toBe("ignored_group_requires_bot_open_id");
  });

  it("ignores non-text messages", async () => {
    const { handler } = makeHandler();
    expect((await handler(messageEvent({ messageType: "image" }))).status).toBe("ignored_non_text");
  });

  it("ignores messages from unbound chats and surfaces the ids", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_x" }));
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      botOpenId: "ou_bot",
      resolveChannelBinding: async () => null,
      createRun
    });
    const outcome = await handler(messageEvent());
    expect(outcome.status).toBe("ignored_unbound_chat");
    expect(outcome.tenantKey).toBe("tk_123");
    expect(outcome.chatId).toBe("oc_chat");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("falls back to now() when create_time is malformed", async () => {
    const createRun = vi.fn(async (_event: OpenTagEvent) => ({ runId: "run_1" }));
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      botOpenId: "ou_bot",
      resolveChannelBinding: async () => binding,
      createRun,
      now: () => 1_700_000_000_000
    });
    const evt = messageEvent();
    evt.create_time = "not-a-number";
    const outcome = await handler(evt);
    expect(outcome.status).toBe("created");
    const event = createRun.mock.calls[0]?.[0];
    expect(() => new Date(event!.receivedAt).toISOString()).not.toThrow();
    expect(event?.receivedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("ignores payloads missing required ids", async () => {
    const { handler } = makeHandler();
    const broken = messageEvent();
    broken.message!.chat_id = undefined;
    expect((await handler(broken)).status).toBe("ignored_invalid_payload");
  });

  it("propagates createRun failure instead of silently succeeding", async () => {
    const createRun = vi.fn(async () => {
      throw new Error("dispatcher unreachable");
    });
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      botOpenId: "ou_bot",
      resolveChannelBinding: async () => binding,
      createRun
    });
    await expect(handler(messageEvent())).rejects.toThrow(/dispatcher unreachable/);
  });
});
