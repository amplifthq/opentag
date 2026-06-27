import { describe, expect, it, vi } from "vitest";
import { registerLarkPersonalAgent } from "../src/registration.js";

describe("Lark Personal Agent registration", () => {
  it("registers a Personal Agent and fetches the bot identity", async () => {
    const qrCodes: string[] = [];
    const statuses: string[] = [];
    const registerApp = vi.fn(async (options) => {
      options.onQRCodeReady({ url: "https://scan.example", expireIn: 600 });
      options.onStatusChange?.({ status: "domain_switched" });
      return {
        client_id: "cli_test",
        client_secret: "secret_test",
        user_info: { open_id: "ou_operator", tenant_brand: "lark" as const }
      };
    });
    const request = vi.fn(async () => ({
      bot: { open_id: "ou_bot", app_name: "OpenTag Felix" }
    }));

    const result = await registerLarkPersonalAgent(
      {
        domain: "feishu",
        onQrCode(info) {
          qrCodes.push(info.url);
        },
        onStatus(info) {
          statuses.push(info.status);
        }
      },
      {
        registerApp,
        createBotInfoClient() {
          return { request };
        },
        sleep: vi.fn()
      }
    );

    expect(registerApp).toHaveBeenCalledWith(
      expect.objectContaining({
        createOnly: true,
        source: "opentag",
        addons: expect.objectContaining({
          scopes: expect.objectContaining({
            tenant: expect.arrayContaining(["im:message:send_as_bot"])
          })
        })
      })
    );
    expect(qrCodes).toEqual(["https://scan.example"]);
    expect(statuses).toEqual(["domain_switched"]);
    expect(request).toHaveBeenCalledWith({ url: "/open-apis/bot/v3/info", method: "GET" });
    expect(result).toEqual({
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      operatorOpenId: "ou_operator",
      botOpenId: "ou_bot",
      botName: "OpenTag Felix"
    });
  });

  it("keeps credentials when bot identity lookup fails", async () => {
    const warnings: string[] = [];

    const result = await registerLarkPersonalAgent(
      {
        domain: "lark",
        onQrCode() {},
        onWarning(message) {
          warnings.push(message);
        }
      },
      {
        async registerApp() {
          return {
            client_id: "cli_test",
            client_secret: "secret_test",
            user_info: { tenant_brand: "lark" as const }
          };
        },
        createBotInfoClient() {
          return {
            async request() {
              throw new Error("not ready");
            }
          };
        },
        sleep: vi.fn()
      }
    );

    expect(result).toEqual({
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark"
    });
    expect(warnings[0]).toContain("could not fetch the Lark bot open_id");
  });
});
