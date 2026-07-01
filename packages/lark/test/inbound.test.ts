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

function idempotentReplay(event: OpenTagEvent): CreateRunResult {
  return {
    ...runCreated(event),
    idempotentReplay: true
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

function createInteractiveHandler(input: {
  result?: (event: OpenTagEvent) => CreateRunResult;
  binding?: { tenantKey: string; chatId: string; repoProvider: string; owner: string; repo: string } | null;
  status?: Parameters<typeof createLarkMessageHandler>[0]["status"];
  doctor?: Parameters<typeof createLarkMessageHandler>[0]["doctor"];
  stopRun?: Parameters<typeof createLarkMessageHandler>[0]["stopRun"] | null;
  canManageBinding?: Parameters<typeof createLarkMessageHandler>[0]["canManageBinding"] | null;
  suppressRunCreatedReply?: boolean;
} = {}) {
  const createRun = vi.fn(async (event: OpenTagEvent) => (input.result ?? runCreated)(event));
  const bindChannel = vi.fn(async () => {});
  const unbindChannel = vi.fn(async () => {});
  const stopRun =
    input.stopRun === null
      ? undefined
      : vi.fn(async (request: { runId?: string }) => {
          if (input.stopRun) return input.stopRun(request as Parameters<NonNullable<typeof input.stopRun>>[0]);
          return { outcome: "cancelled" as const, runId: request.runId ?? "run_active" };
        });
  const reply = vi.fn(async () => {});
  const canManageBinding =
    input.canManageBinding === null ? undefined : vi.fn(input.canManageBinding ?? (async () => true));
  const handler = createLarkMessageHandler({
    agentId: "opentag",
    botOpenId: "ou_bot",
    async resolveChannelBinding() {
      if ("binding" in input) return input.binding ?? null;
      return {
        tenantKey: "tenant_1",
        chatId: "oc_chat",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      };
    },
    createRun,
    bindChannel,
    unbindChannel,
    ...(canManageBinding ? { canManageBinding } : {}),
    ...(stopRun ? { stopRun } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.doctor ? { doctor: input.doctor } : {}),
    ...(input.suppressRunCreatedReply !== undefined ? { suppressRunCreatedReply: input.suppressRunCreatedReply } : {}),
    reply
  });
  return { handler, createRun, bindChannel, unbindChannel, stopRun, canManageBinding, reply };
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

  it("replies with a concise received message for newly-created runs", async () => {
    const { handler, reply } = createInteractiveHandler({ result: runCreated });

    const outcome = await handler(message);

    expect(outcome.status).toBe("created");
    expect(reply).toHaveBeenCalledWith({
      messageId: "om_msg",
      text: expect.stringContaining("Received. Run: run_dispatcher.")
    });
    expect(reply.mock.calls[0]?.[0].text).toContain("/status");
    expect(reply.mock.calls[0]?.[0].text).toContain("opentag status --run run_dispatcher");
  });

  it("does not duplicate the received reply for idempotent replayed run creates", async () => {
    const { handler, reply } = createInteractiveHandler({ result: idempotentReplay });

    const outcome = await handler(message);

    expect(outcome.status).toBe("created");
    expect(outcome.runId).toBe("run_dispatcher");
    expect(reply).not.toHaveBeenCalled();
  });

  it("can suppress the ingress received reply when dispatcher lifecycle callbacks handle acknowledgement", async () => {
    const { handler, reply } = createInteractiveHandler({ result: runCreated, suppressRunCreatedReply: true });

    const outcome = await handler(message);

    expect(outcome.status).toBe("created");
    expect(outcome.runId).toBe("run_dispatcher");
    expect(reply).not.toHaveBeenCalled();
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

  it("replies to /help without creating a run", async () => {
    const { handler, createRun, bindChannel, reply } = createInteractiveHandler();

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /help" }) }
    });

    expect(outcome.status).toBe("self_service_help");
    expect(createRun).not.toHaveBeenCalled();
    expect(bindChannel).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("/bind <owner>/<repo>")
      })
    );
    expect(reply.mock.calls[0]?.[0].text).toContain("Project Targets never use absolute local paths");
  });

  it("replies to /status with Project Target and queue guidance", async () => {
    const { handler, createRun, reply } = createInteractiveHandler();

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /status" }) }
    });

    expect(outcome.status).toBe("self_service_status");
    expect(createRun).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Project Target: github:acme/demo");
    expect(reply.mock.calls[0]?.[0].text).toContain("Queued follow-ups");
    expect(reply.mock.calls[0]?.[0].text).toContain("Stop/timeout");
    expect(reply.mock.calls[0]?.[0].card).toMatchObject({
      header: {
        template: "green",
        title: { content: "OpenTag status" }
      }
    });
  });

  it("replies to /doctor with a redacted readiness summary", async () => {
    const { handler, createRun, reply } = createInteractiveHandler();

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /doctor" }) }
    });

    expect(outcome.status).toBe("self_service_doctor");
    expect(createRun).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("OpenTag doctor (redacted)");
    expect(reply.mock.calls[0]?.[0].text).toContain("launchd running is not the same as connector ready");
    expect(reply.mock.calls[0]?.[0].card).toMatchObject({
      header: {
        template: "yellow",
        title: { content: "OpenTag doctor (redacted)" }
      }
    });
  });

  it("does not bind absolute local paths from chat", async () => {
    const { handler, createRun, bindChannel, reply } = createInteractiveHandler();

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /bind /Users/mingyoo/repos/opentag" }) }
    });

    expect(outcome.status).toBe("ignored_bind_usage");
    expect(bindChannel).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Usage: /bind <owner>/<repo>");
  });

  it("requires explicit confirmation before unbinding a chat", async () => {
    const { handler, createRun, unbindChannel, reply } = createInteractiveHandler();

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /unbind" }) }
    });

    expect(outcome.status).toBe("ignored_unbind_usage");
    expect(unbindChannel).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Usage: /unbind confirm");
  });

  it("denies group /unbind by default before deleting the Project Target binding", async () => {
    const { handler, createRun, unbindChannel, reply } = createInteractiveHandler({ canManageBinding: null });

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /unbind confirm" }) }
    });

    expect(outcome.status).toBe("ignored_unbind_unauthorized");
    expect(createRun).not.toHaveBeenCalled();
    expect(unbindChannel).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Only an authorized Lark binding manager");
  });

  it("unbinds the current Project Target after explicit confirmation", async () => {
    const { handler, createRun, unbindChannel, canManageBinding, reply } = createInteractiveHandler();

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /unbind confirm" }) }
    });

    expect(outcome.status).toBe("unbound");
    expect(createRun).not.toHaveBeenCalled();
    expect(canManageBinding).toHaveBeenCalledWith({
      action: "unbind",
      tenantKey: "tenant_1",
      chatId: "oc_chat",
      chatType: "group",
      senderOpenId: "ou_sender",
      messageId: "om_msg",
      eventId: "evt_lark_1"
    });
    expect(unbindChannel).toHaveBeenCalledWith({ tenantKey: "tenant_1", chatId: "oc_chat" });
    expect(reply.mock.calls[0]?.[0].text).toContain("Disconnected this chat from Project Target github:acme/demo");
  });

  it("does not report unbind success when the chat is not bound", async () => {
    const { handler, createRun, unbindChannel, reply } = createInteractiveHandler({ binding: null });

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /unbind confirm" }) }
    });

    expect(outcome.status).toBe("ignored_unbound_chat");
    expect(createRun).not.toHaveBeenCalled();
    expect(unbindChannel).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("isn't connected to a Project Target");
  });

  it("replies with queue, stop, and timeout UX when a follow-up is queued", async () => {
    const { handler, reply } = createInteractiveHandler({ result: followUpQueued });

    const outcome = await handler(message);

    expect(outcome.status).toBe("follow_up_queued");
    expect(reply.mock.calls[0]?.[0].text).toContain("Queued as a follow-up");
    expect(reply.mock.calls[0]?.[0].text).toContain("Active run: run_active");
    expect(reply.mock.calls[0]?.[0].text).toContain("Stop/timeout");
  });

  it("requests cancellation for a specific run from /stop", async () => {
    const { handler, createRun, stopRun, reply } = createInteractiveHandler();

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /stop run_1" }) }
    });

    expect(outcome.status).toBe("self_service_stop");
    expect(outcome.runId).toBe("run_1");
    expect(stopRun).toHaveBeenCalledWith({
      tenantKey: "tenant_1",
      chatId: "oc_chat",
      runId: "run_1",
      requestedBy: "lark:ou_sender"
    });
    expect(createRun).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Cancellation requested for run run_1");
    expect(reply.mock.calls[0]?.[0].text).toContain("will not treat this stop request as a successful completion");
  });

  it("requests cancellation for the active chat run when /stop has no run id", async () => {
    const { handler, createRun, stopRun, reply } = createInteractiveHandler();

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /stop" }) }
    });

    expect(outcome.status).toBe("self_service_stop");
    expect(outcome.runId).toBe("run_active");
    expect(stopRun).toHaveBeenCalledWith({
      tenantKey: "tenant_1",
      chatId: "oc_chat",
      requestedBy: "lark:ou_sender"
    });
    expect(createRun).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("Cancellation requested for run run_active");
  });

  it("does not create a run for /stop while Lark cancellation is unavailable", async () => {
    const { handler, createRun, reply } = createInteractiveHandler({ stopRun: null });

    const outcome = await handler({
      ...message,
      message: { ...message.message!, content: JSON.stringify({ text: "@_user_1 /stop run_1" }) }
    });

    expect(outcome.status).toBe("self_service_stop_unavailable");
    expect(createRun).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].text).toContain("will not treat a stop request as a successful completion");
  });
});
