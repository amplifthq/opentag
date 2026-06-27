import type { CreateRunResult } from "@opentag/client";
import type { OpenTagEvent } from "@opentag/core";
import { describe, expect, it, vi } from "vitest";
import { createLarkMessageHandler, type LarkInboundMessageEvent } from "../src/inbound.js";

const timestamp = "2026-06-24T00:00:00.000Z";

const message: LarkInboundMessageEvent = {
  event_id: "evt_lark_1",
  tenant_key: "tenant_1",
  sender: {
    sender_id: { open_id: "ou_sender" },
    tenant_key: "tenant_1"
  },
  message: {
    message_id: "om_msg",
    chat_id: "oc_chat",
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "@_user_1 fix this" }),
    mentions: [{ id: { open_id: "ou_bot" } }]
  }
};

function decision(action: CreateRunResult["decision"]["action"], reasonCode: CreateRunResult["decision"]["reasonCode"]) {
  return {
    action,
    reason: `${action} reason`,
    reasonCode,
    decidedAt: timestamp,
    ...(action === "queue_follow_up" ? { activeRunId: "run_active" } : {})
  };
}

function runCreated(event: OpenTagEvent): CreateRunResult {
  return {
    outcome: "run_created",
    decision: decision("start", "new_event"),
    run: {
      id: "run_dispatcher",
      eventId: event.id,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp
    }
  };
}

function followUpQueued(event: OpenTagEvent): CreateRunResult {
  return {
    outcome: "follow_up_queued",
    decision: decision("queue_follow_up", "active_run_same_thread"),
    followUpRequest: {
      id: "follow_up_1",
      sourceEventId: event.sourceEventId,
      conversationKey: "lark:tenant_1/oc_chat",
      activeRunId: "run_active",
      event,
      decision: decision("queue_follow_up", "active_run_same_thread"),
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp
    }
  };
}

function needsHumanDecision(): CreateRunResult {
  return {
    outcome: "needs_human_decision",
    decision: decision("needs_human_decision", "scope_change_requires_decision")
  };
}

function createHandler(result: (event: OpenTagEvent) => CreateRunResult) {
  return createLarkMessageHandler({
    agentId: "opentag",
    botOpenId: "ou_bot",
    async resolveChannelBinding() {
      return {
        tenantKey: "tenant_1",
        chatId: "oc_chat",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      };
    },
    createRun: vi.fn(async (event: OpenTagEvent) => result(event))
  });
}

describe("createLarkMessageHandler", () => {
  it("reports created only when dispatcher creates a run", async () => {
    const outcome = await createHandler(runCreated)(message);

    expect(outcome).toMatchObject({
      status: "created",
      runId: "run_dispatcher",
      tenantKey: "tenant_1",
      chatId: "oc_chat"
    });
  });

  it("preserves a queued follow-up admission outcome", async () => {
    const outcome = await createHandler(followUpQueued)(message);

    expect(outcome).toMatchObject({
      status: "follow_up_queued",
      followUpRequestId: "follow_up_1",
      runId: "run_active",
      tenantKey: "tenant_1",
      chatId: "oc_chat"
    });
  });

  it("preserves a needs-human admission outcome", async () => {
    const outcome = await createHandler(() => needsHumanDecision())(message);

    expect(outcome).toMatchObject({
      status: "needs_human_decision",
      reason: "needs_human_decision reason",
      tenantKey: "tenant_1",
      chatId: "oc_chat"
    });
  });
});
