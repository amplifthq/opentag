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
      {},
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
    expect(output).toContain("This link may start on the Feishu bootstrap page");
    expect(output).toContain("OpenTag will save the real Lark / Feishu tenant returned by the platform");
    expect(output).toContain("Terminal QR codes are hidden by default");
    expect(output).not.toContain("Terminal QR code:");
    expect(output).toContain("Tenant: lark");
  });

  it("uses Chinese registration copy when setup language is Chinese", async () => {
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
      { language: "zh-CN" },
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

    expect(output).toContain("打开这个链接创建 Lark/飞书个人代理应用：");
    expect(output).toContain("这个链接可能从飞书 bootstrap 页面开始");
    expect(output).toContain("OpenTag 会保存平台返回的真实 Lark/飞书租户");
    expect(output).toContain("设置链接较长，默认不在终端显示二维码。");
    expect(output).toContain("租户: lark");
    expect(output).not.toContain("Open this URL");
  });
});
