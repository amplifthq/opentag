import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCliConfig } from "../src/config.js";
import { runSetupCommand } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

describe("OpenTag CLI setup", () => {
  it("uses Lark scan setup by default instead of prompting for manual credentials", async () => {
    const projectPath = tempDir();
    const configPath = join(tempDir(), "config.json");
    const prompt = vi.fn(async (question: string) => {
      if (question.includes("App ID") || question.includes("App Secret")) {
        throw new Error(`Unexpected manual credential prompt: ${question}`);
      }
      return "";
    });
    const scanLarkPersonalAgent = vi.fn(async () => ({
      appId: "cli_scan",
      appSecret: "secret_scan",
      domain: "lark" as const,
      botOpenId: "ou_bot"
    }));

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        executor: "echo",
        force: true
      },
      {
        prompt,
        scanLarkPersonalAgent
      }
    );

    expect(scanLarkPersonalAgent).toHaveBeenCalledWith({ domain: "lark" });
    expect(readCliConfig(configPath).platforms.lark).toEqual({
      appId: "cli_scan",
      appSecret: "secret_scan",
      domain: "lark",
      botOpenId: "ou_bot"
    });
  });

  it("supports explicit manual Lark credentials", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand({
      config: configPath,
      project: tempDir(),
      executor: "echo",
      larkSetup: "manual",
      larkDomain: "feishu",
      larkAppId: "cli_manual",
      larkAppSecret: "secret_manual",
      larkBotOpenId: "ou_manual_bot",
      force: true
    });

    expect(readCliConfig(configPath).platforms.lark).toEqual({
      appId: "cli_manual",
      appSecret: "secret_manual",
      domain: "feishu",
      botOpenId: "ou_manual_bot"
    });
  });
});
