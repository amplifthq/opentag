import { afterEach, describe, expect, it, vi } from "vitest";
import { createLarkCardActionCallbackHandler, startLarkIngress } from "../src/ingress.js";
import type { LarkCardActionEvent, LarkInboundMessageEvent } from "../src/inbound.js";

function larkActionEvent(): LarkInboundMessageEvent {
  return {
    event_id: "evt_lark_ingress_action",
    tenant_key: "tenant_1",
    sender: {
      sender_id: { open_id: "ou_sender" },
      tenant_key: "tenant_1"
    },
    message: {
      message_id: "om_reply",
      root_id: "om_source",
      chat_id: "oc_chat",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "apply 1" }),
      mentions: []
    }
  };
}

function larkCardActionEvent(): LarkCardActionEvent {
  return {
    event_id: "evt_lark_card_action",
    tenant_key: "tenant_1",
    context: {
      open_chat_id: "oc_chat",
      open_message_id: "om_final_card"
    },
    operator: {
      open_id: "ou_sender",
      user_id: "user_sender",
      name: "Mingyou"
    },
    action: {
      tag: "button",
      name: "opentag_apply_1",
      value: {
        opentag: "thread_action",
        version: 1,
        command: "apply 1",
        decision: "apply",
        index: 1,
        proposalId: "proposal_pr",
        intentId: "intent_create_pr"
      }
    }
  };
}

describe("startLarkIngress", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers Lark action replies through the dispatcher thread-actions endpoint", async () => {
    const requests: Array<{ url: string; body?: unknown; principal?: string }> = [];
    let inboundHandler: ((data: LarkInboundMessageEvent) => Promise<void>) | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        const principal = new Headers(init?.headers).get("x-opentag-channel-principal");
        requests.push({ url: href, ...(body ? { body } : {}), ...(principal ? { principal } : {}) });
        if (href === "http://dispatcher.test/v1/channel-bindings/lark/tenant_1/oc_chat") {
          return Response.json({
            binding: {
              provider: "lark",
              accountId: "tenant_1",
              conversationId: "oc_chat",
              repoProvider: "github",
              owner: "acme",
              repo: "demo"
            }
          });
        }
        if (href === "http://dispatcher.test/v1/thread-actions") {
          return Response.json({ outcome: "accepted" }, { status: 201 });
        }
        return Response.json({ error: "unexpected_url" }, { status: 500 });
      })
    );

    const start = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const logIgnored = vi.fn();
    const handle = startLarkIngress(
      {
        appId: "cli_a",
        appSecret: "secret",
        dispatcherUrl: "http://dispatcher.test",
        dispatcherToken: "pair_1",
        channelPrincipalCredential: "lark_principal_456",
        domain: "lark",
        agentId: "opentag",
        botOpenId: "ou_bot"
      },
      {
        createEventDispatcher(handler) {
          inboundHandler = handler;
          return {};
        },
        createWsClient() {
          return { start, close };
        },
        logIgnored
      }
    );

    await handle.startPromise;
    if (!inboundHandler) throw new Error("expected Lark inbound handler");
    await inboundHandler(larkActionEvent());
    await handle.close();

    expect(start).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({ force: true });
    expect(logIgnored).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "thread_action_submitted",
        tenantKey: "tenant_1",
        chatId: "oc_chat"
      })
    );
    expect(requests.map((request) => request.url)).toEqual([
      "http://dispatcher.test/v1/channel-bindings/lark/tenant_1/oc_chat",
      "http://dispatcher.test/v1/thread-actions"
    ]);
    expect(requests.every((request) => request.principal === "lark_principal_456")).toBe(true);
    expect(requests[1]?.body).toMatchObject({
      id: "approval_lark_evt_lark_ingress_action",
      rawText: "apply 1",
      actor: {
        provider: "lark",
        providerUserId: "ou_sender",
        handle: "ou_sender",
        organizationId: "tenant_1"
      },
      callback: {
        provider: "lark",
        uri: "lark://im/v1/messages",
        threadKey: "tenant_1|oc_chat|om_source"
      },
      metadata: {
        source: "lark_reply",
        tenantKey: "tenant_1",
        chatId: "oc_chat",
        messageId: "om_reply",
        rootId: "om_source",
        sourceDeliveryId: "evt_lark_ingress_action",
        larkEventId: "evt_lark_ingress_action",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });
  });

  it("delivers Lark card action callbacks through the dispatcher thread-actions endpoint", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url: href, ...(body ? { body } : {}) });
        if (href === "http://dispatcher.test/v1/channel-bindings/lark/tenant_1/oc_chat") {
          return Response.json({
            binding: {
              provider: "lark",
              accountId: "tenant_1",
              conversationId: "oc_chat",
              repoProvider: "github",
              owner: "acme",
              repo: "demo"
            }
          });
        }
        if (href === "http://dispatcher.test/v1/thread-actions") {
          return Response.json({ outcome: "accepted" }, { status: 201 });
        }
        return Response.json({ error: "unexpected_url" }, { status: 500 });
      })
    );

    const start = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const handle = startLarkIngress(
      {
        appId: "cli_a",
        appSecret: "secret",
        dispatcherUrl: "http://dispatcher.test",
        dispatcherToken: "pair_1",
        domain: "lark",
        agentId: "opentag",
        botOpenId: "ou_bot"
      },
      {
        createEventDispatcher() {
          return {};
        },
        createWsClient() {
          return { start, close };
        }
      }
    );

    await handle.startPromise;
    const outcome = await handle.handleCardAction(larkCardActionEvent());
    await handle.close();

    expect(outcome).toMatchObject({
      status: "card_action_submitted",
      tenantKey: "tenant_1",
      chatId: "oc_chat",
      messageId: "om_final_card"
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://dispatcher.test/v1/channel-bindings/lark/tenant_1/oc_chat",
      "http://dispatcher.test/v1/thread-actions"
    ]);
    expect(requests[1]?.body).toMatchObject({
      id: "approval_lark_card_evt_lark_card_action",
      rawText: "apply 1",
      actor: {
        provider: "lark",
        providerUserId: "ou_sender",
        handle: "Mingyou",
        organizationId: "tenant_1"
      },
      callback: {
        provider: "lark",
        uri: "lark://im/v1/messages",
        threadKey: "tenant_1|oc_chat|om_final_card"
      },
      metadata: {
        source: "lark_card_action",
        tenantKey: "tenant_1",
        chatId: "oc_chat",
        messageId: "om_final_card",
        sourceDeliveryId: "evt_lark_card_action",
        larkEventId: "evt_lark_card_action",
        senderUserId: "user_sender",
        actionTag: "button",
        actionName: "opentag_apply_1",
        proposalId: "proposal_pr",
        intentId: "intent_create_pr",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });
  });
});

describe("createLarkCardActionCallbackHandler", () => {
  it("adapts SDK card action callbacks into the OpenTag Lark card action handler", async () => {
    const handleCardAction = vi.fn(async () => ({
      status: "card_action_submitted" as const,
      tenantKey: "tenant_1",
      chatId: "oc_chat",
      messageId: "om_final_card"
    }));
    const logOutcome = vi.fn();
    const callbackHandler = createLarkCardActionCallbackHandler({
      handleCardAction,
      logOutcome
    });

    await expect(callbackHandler.invoke({ headers: {}, ...larkCardActionEvent() })).resolves.toEqual({});

    expect(handleCardAction).toHaveBeenCalledWith(expect.objectContaining(larkCardActionEvent()));
    expect(logOutcome).toHaveBeenCalledWith({
      status: "card_action_submitted",
      tenantKey: "tenant_1",
      chatId: "oc_chat",
      messageId: "om_final_card"
    });
  });

  it("keeps SDK card action callbacks graceful when OpenTag handling fails", async () => {
    const error = new Error("dispatcher unavailable");
    const handleCardAction = vi.fn(async () => {
      throw error;
    });
    const logOutcome = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const callbackHandler = createLarkCardActionCallbackHandler({
      handleCardAction,
      logOutcome
    });

    await expect(callbackHandler.invoke({ headers: {}, ...larkCardActionEvent() })).resolves.toEqual({});

    expect(handleCardAction).toHaveBeenCalledWith(expect.objectContaining(larkCardActionEvent()));
    expect(logOutcome).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("[lark] failed to handle card action:", error);
    consoleError.mockRestore();
  });
});
