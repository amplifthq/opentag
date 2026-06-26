import { describe, expect, it, vi } from "vitest";
import type { LarkInboundMessageEvent } from "../src/app.js";
import { DEFAULT_AGENT_ID, larkIngressConfigFromEnv, startLarkIngress } from "../src/ingress.js";

describe("Lark ingress runtime", () => {
  it("fails clearly when required environment values are missing", () => {
    expect(() => larkIngressConfigFromEnv({})).toThrow("LARK_APP_ID and LARK_APP_SECRET are required");
    expect(() =>
      larkIngressConfigFromEnv({
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test"
      })
    ).toThrow("OPENTAG_DISPATCHER_URL is required");
  });

  it("normalizes environment values into an ingress config", () => {
    expect(
      larkIngressConfigFromEnv({
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test",
        LARK_DOMAIN: "feishu",
        LARK_BOT_OPEN_ID: "ou_bot",
        OPENTAG_DISPATCHER_URL: "http://localhost:3030",
        OPENTAG_DISPATCHER_TOKEN: "pairing_test",
        OPENTAG_LARK_DEFAULT_REPO: "local:path_abc/opentag"
      })
    ).toEqual({
      appId: "cli_test",
      appSecret: "secret_test",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: "pairing_test",
      domain: "feishu",
      agentId: DEFAULT_AGENT_ID,
      botOpenId: "ou_bot",
      defaultRepoBinding: {
        repoProvider: "local",
        owner: "path_abc",
        repo: "opentag"
      }
    });
  });

  it("rejects invalid Lark domains instead of silently defaulting", () => {
    expect(() =>
      larkIngressConfigFromEnv({
        LARK_APP_ID: "cli_test",
        LARK_APP_SECRET: "secret_test",
        LARK_DOMAIN: "feishu ",
        OPENTAG_DISPATCHER_URL: "http://localhost:3030"
      })
    ).toThrow("LARK_DOMAIN must be either lark or feishu");
  });

  it("starts the long-connection client through injectable SDK boundaries", async () => {
    let capturedHandler: ((data: LarkInboundMessageEvent) => Promise<void>) | undefined;
    const eventDispatcher = { registered: true };
    const start = vi.fn(async () => {});
    const logIgnored = vi.fn();

    const handle = startLarkIngress(
      {
        appId: "cli_test",
        appSecret: "secret_test",
        dispatcherUrl: "http://localhost:3030",
        domain: "lark",
        agentId: DEFAULT_AGENT_ID
      },
      {
        createEventDispatcher(handler) {
          capturedHandler = handler;
          return eventDispatcher;
        },
        createWsClient(config) {
          expect(config.appId).toBe("cli_test");
          return { start };
        },
        reply: vi.fn(async () => {}),
        logIgnored
      }
    );

    await handle.startPromise;

    expect(start).toHaveBeenCalledWith({ eventDispatcher });
    await capturedHandler?.({
      message: { message_type: "image" }
    });
    expect(logIgnored).toHaveBeenCalledWith({ status: "ignored_non_text" });
  });

  it("logs inbound handler failures without rejecting the event dispatcher callback", async () => {
    let capturedHandler: ((data: LarkInboundMessageEvent) => Promise<void>) | undefined;
    const start = vi.fn(async () => {});
    const error = new Error("log failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    startLarkIngress(
      {
        appId: "cli_test",
        appSecret: "secret_test",
        dispatcherUrl: "http://localhost:3030",
        domain: "lark",
        agentId: DEFAULT_AGENT_ID
      },
      {
        createEventDispatcher(handler) {
          capturedHandler = handler;
          return {};
        },
        createWsClient() {
          return { start };
        },
        reply: vi.fn(async () => {}),
        logIgnored() {
          throw error;
        }
      }
    );

    try {
      expect(capturedHandler).toBeDefined();
      await expect(capturedHandler!({ message: { message_type: "image" } })).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith("[lark] failed to handle inbound message:", error);
    } finally {
      consoleError.mockRestore();
    }
  });
});
