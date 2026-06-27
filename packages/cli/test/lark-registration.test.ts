import { describe, expect, it, vi } from "vitest";
import { scanLarkPersonalAgent } from "../src/platforms/lark/registration-ui.js";

describe("OpenTag CLI Lark registration UI", () => {
  it("hides the terminal QR code by default", async () => {
    let output = "";
    const register = vi.fn(async (input: { onQrCode(info: { url: string; expireIn: number }): void }) => {
      input.onQrCode({
        url: "https://open.feishu.cn/page/launcher?user_code=test",
        expireIn: 3600
      });
      return {
        appId: "cli_test",
        appSecret: "secret_test",
        domain: "lark" as const
      };
    });

    await scanLarkPersonalAgent(
      { domain: "lark" },
      {
        output: {
          write(chunk: string) {
            output += chunk;
            return true;
          }
        },
        register: register as never
      }
    );

    expect(output).toContain("Open this URL to create the Lark / Feishu Personal Agent app:");
    expect(output).toContain("Terminal QR codes are hidden by default");
    expect(output).not.toContain("Terminal QR code:");
  });
});
