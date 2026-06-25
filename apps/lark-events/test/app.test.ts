import type { OpenTagEvent } from "@opentag/core";
import { describe, expect, it, vi } from "vitest";
import { createLarkMessageHandler, type LarkInboundMessageEvent } from "../src/app.js";

function messageEvent(overrides?: {
  text?: string;
  messageType?: string;
  chatId?: string;
  tenantKey?: string;
  messageId?: string;
  eventId?: string;
  openId?: string;
}): LarkInboundMessageEvent {
  return {
    header: {
      event_id: overrides?.eventId ?? "evt_1",
      event_type: "im.message.receive_v1",
      create_time: "1700000000000",
      tenant_key: overrides?.tenantKey ?? "tk_123"
    },
    event: {
      sender: {
        sender_id: { open_id: overrides?.openId ?? "ou_user" },
        sender_type: "user",
        tenant_key: overrides?.tenantKey ?? "tk_123"
      },
      message: {
        message_id: overrides?.messageId ?? "om_msg",
        chat_id: overrides?.chatId ?? "oc_chat",
        chat_type: "group",
        message_type: overrides?.messageType ?? "text",
        content: JSON.stringify({ text: overrides?.text ?? "@_user_1 fix the bug" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "OpenTag" }]
      }
    }
  };
}

const binding = { tenantKey: "tk_123", chatId: "oc_chat", owner: "acme", repo: "app" };

describe("createLarkMessageHandler", () => {
  it("normalizes a text message and creates a run", async () => {
    const createRun = vi.fn(async (_event: OpenTagEvent) => ({ runId: "run_1" }));
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      botOpenId: "ou_bot",
      resolveChannelBinding: async () => binding,
      createRun
    });

    const outcome = await handler(messageEvent());
    expect(outcome.status).toBe("created");
    expect(outcome.runId).toBe("run_1");
    expect(createRun).toHaveBeenCalledTimes(1);
    const event = createRun.mock.calls[0]?.[0];
    expect(event?.source).toBe("lark");
    expect(event?.command.rawText).toBe("fix the bug");
    expect(event?.callback.threadKey).toBe("tk_123|oc_chat|om_msg");
  });

  it("ignores non-text messages", async () => {
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      resolveChannelBinding: async () => binding,
      createRun: async () => ({ runId: "run_x" })
    });
    expect((await handler(messageEvent({ messageType: "image" }))).status).toBe("ignored_non_text");
  });

  it("ignores messages from unbound chats", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_x" }));
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      resolveChannelBinding: async () => null,
      createRun
    });
    expect((await handler(messageEvent())).status).toBe("ignored_unbound_chat");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("ignores messages whose command is empty after stripping the mention", async () => {
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      botOpenId: "ou_bot",
      resolveChannelBinding: async () => binding,
      createRun: async () => ({ runId: "run_x" })
    });
    expect((await handler(messageEvent({ text: "@_user_1" }))).status).toBe("ignored_empty_command");
  });

  it("ignores payloads missing required ids", async () => {
    const handler = createLarkMessageHandler({
      agentId: "opentag",
      resolveChannelBinding: async () => binding,
      createRun: async () => ({ runId: "run_x" })
    });
    const broken = messageEvent();
    broken.event!.message!.chat_id = undefined;
    expect((await handler(broken)).status).toBe("ignored_invalid_payload");
  });
});
