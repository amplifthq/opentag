import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readCliConfig } from "../src/config.js";
import { runSetupCommand } from "../src/setup.js";
import type { PromptAdapter, PromptOption } from "../src/ui/prompts.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function testPrompts(overrides: Partial<PromptAdapter> = {}): PromptAdapter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    async select<Value extends string>(input: { options: Array<PromptOption<Value>>; initialValue?: Value }): Promise<Value> {
      return input.initialValue ?? input.options[0]!.value;
    },
    async text(input) {
      return input.initialValue ?? "";
    },
    async password() {
      return "secret_prompt";
    },
    async confirm() {
      return true;
    },
    ...overrides
  };
}

describe("OpenTag CLI setup", () => {
  it("uses Lark scan setup by default instead of prompting for manual credentials", async () => {
    const projectPath = tempDir();
    const configPath = join(tempDir(), "config.json");
    const prompts = testPrompts({
      text: vi.fn(async (input) => input.initialValue ?? ""),
      password: vi.fn(async () => {
        throw new Error("Unexpected manual credential prompt");
      })
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
        prompts,
        scanLarkPersonalAgent
      }
    );

    expect(scanLarkPersonalAgent).toHaveBeenCalledWith({ domain: "lark" });
    expect(readCliConfig(configPath).platforms.lark).toEqual({
      appId: "cli_scan",
      appSecret: "secret_scan",
      domain: "lark",
      botOpenId: "ou_bot",
      defaultProjectBinding: true
    });
    expect(readCliConfig(configPath).preferences?.lastSetup).toMatchObject({
      platforms: ["lark"],
      executor: "echo",
      larkSetupMethod: "scan",
      bindingMethod: "default_project"
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
      binding: "bind_later",
      force: true
    }, { prompts: testPrompts() });

    expect(readCliConfig(configPath).platforms.lark).toEqual({
      appId: "cli_manual",
      appSecret: "secret_manual",
      domain: "feishu",
      botOpenId: "ou_manual_bot",
      defaultProjectBinding: false
    });
  });

  it("does not prompt for optional Lark bot open id when manual credentials are provided", async () => {
    const configPath = join(tempDir(), "config.json");
    const prompts = testPrompts({
      text: vi.fn(async () => {
        throw new Error("Unexpected optional bot open id prompt");
      })
    });

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        executor: "echo",
        larkSetup: "manual",
        larkDomain: "lark",
        larkAppId: "cli_manual",
        larkAppSecret: "secret_manual",
        force: true,
        yes: true
      },
      { prompts }
    );

    expect(readCliConfig(configPath).platforms.lark).toEqual({
      appId: "cli_manual",
      appSecret: "secret_manual",
      domain: "lark",
      defaultProjectBinding: true
    });
  });

  it("uses saved Lark credentials from the legacy start-lark config", async () => {
    const projectPath = tempDir();
    const configPath = join(tempDir(), "config.json");
    const legacyDirectory = join(projectPath, ".opentag", "lark");
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(
      join(legacyDirectory, "lark.local.json"),
      `${JSON.stringify({
        appId: "legacy_app",
        appSecret: "legacy_secret",
        domain: "feishu",
        botOpenId: "ou_legacy_bot"
      })}\n`
    );
    const scanLarkPersonalAgent = vi.fn(async () => {
      throw new Error("Unexpected Lark scan");
    });

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        executor: "echo",
        force: true,
        yes: true
      },
      {
        prompts: testPrompts(),
        scanLarkPersonalAgent
      }
    );

    expect(scanLarkPersonalAgent).not.toHaveBeenCalled();
    expect(readCliConfig(configPath).platforms.lark).toEqual({
      appId: "legacy_app",
      appSecret: "legacy_secret",
      domain: "feishu",
      botOpenId: "ou_legacy_bot",
      defaultProjectBinding: true
    });
    expect(readCliConfig(configPath).preferences?.lastSetup?.larkSetupMethod).toBe("saved");
  });

  it("labels Echo as dev/test only in the coding agent prompt", async () => {
    const configPath = join(tempDir(), "config.json");
    let echoHint: string | undefined;

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "lark",
        larkSetup: "manual",
        larkDomain: "lark",
        larkAppId: "cli_manual",
        larkAppSecret: "secret_manual",
        binding: "default_project",
        force: true,
        yes: true
      },
      {
        env: { PATH: "" },
        prompts: testPrompts({
          async select(input) {
            if (input.message === "Which coding agent should OpenTag use?") {
              echoHint = input.options.find((option) => option.value === "echo")?.hint;
              return "echo";
            }
            return input.initialValue ?? input.options[0]!.value;
          }
        })
      }
    );

    expect(echoHint).toBe("dev/test only; no real coding agent");
  });

  it("restores prior setup choices as prompt defaults", async () => {
    const projectPath = tempDir();
    const configPath = join(tempDir(), "config.json");
    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        executor: "claude-code",
        language: "zh-CN",
        larkSetup: "manual",
        larkDomain: "feishu",
        larkAppId: "cli_manual",
        larkAppSecret: "secret_manual",
        binding: "bind_later",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const seenDefaults: Record<string, string | undefined> = {};
    await runSetupCommand(
      {
        config: configPath,
        force: true
      },
      {
        prompts: testPrompts({
          async select(input) {
            seenDefaults[input.message] = input.initialValue;
            return input.initialValue ?? input.options[0]!.value;
          },
          async text(input) {
            if (input.message === "Lark App ID") return "cli_manual";
            return input.initialValue ?? "";
          },
          async password() {
            return "secret_manual";
          }
        })
      }
    );

    expect(Object.values(seenDefaults)).toContain("zh-CN");
    expect(Object.values(seenDefaults)).toContain("lark");
    expect(Object.values(seenDefaults)).toContain("claude-code");
    expect(Object.values(seenDefaults)).toContain("saved");
    expect(Object.values(seenDefaults)).toContain("bind_later");
    expect(readCliConfig(configPath).platforms.lark?.domain).toBe("feishu");
  });
});
