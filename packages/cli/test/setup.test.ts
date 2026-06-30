import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
        start: false,
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

  it("normalizes a saved built-in executor before reusing setup defaults", async () => {
    const configPath = join(tempDir(), "config.json");
    const projectPath = tempDir();

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        platform: "lark",
        larkSetup: "manual",
        larkDomain: "lark",
        larkAppId: "cli_manual",
        larkAppSecret: "secret_manual",
        force: true,
        yes: true
      },
      {
        prompts: testPrompts(),
        defaults: { executor: " codex " }
      }
    );

    expect(readCliConfig(configPath).daemon.repositories[0].defaultExecutor).toBe("codex");
  });

  it("rejects whitespace-only saved executor defaults", async () => {
    await expect(
      runSetupCommand(
        {
          config: join(tempDir(), "config.json"),
          platform: "lark",
          force: true,
          yes: true
        },
        {
          prompts: testPrompts(),
          defaults: { executor: "   " }
        }
      )
    ).rejects.toThrow("Executor id must not be empty.");
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
      start: false,
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

  it("shows official Lark console links before manual credential prompts", async () => {
    const configPath = join(tempDir(), "config.json");
    const notes: string[] = [];
    const prompts = testPrompts({
      note(message) {
        notes.push(message);
      },
      text: vi.fn(async (input) => {
        return input.message.includes("App ID") ? "cli_manual" : "";
      }),
      password: vi.fn(async () => "secret_manual")
    });

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        executor: "echo",
        larkSetup: "manual",
        larkDomain: "feishu",
        start: false,
        force: true
      },
      { prompts }
    );

    expect(notes.join("\n")).toContain("https://open.feishu.cn/app");
    expect(notes.join("\n")).toContain("https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/use-websocket?lang=zh-CN");
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
    const legacyConfigPath = join(legacyDirectory, "lark.local.json");
    writeFileSync(
      legacyConfigPath,
      `${JSON.stringify({
        appId: "legacy_app",
        appSecret: "legacy_secret",
        domain: "feishu",
        botOpenId: "ou_legacy_bot"
      })}\n`
    );
    chmodSync(legacyConfigPath, 0o600);
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

  it("summarizes the saved project path instead of the internal Project Target id", async () => {
    const configPath = join(tempDir(), "config.json");
    const projectPath = tempDir();
    const notes: string[] = [];

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        executor: "echo",
        larkSetup: "manual",
        larkDomain: "lark",
        larkAppId: "cli_manual",
        larkAppSecret: "secret_manual",
        start: false,
        force: true
      },
      {
        prompts: testPrompts({
          note(message) {
            notes.push(message);
          }
        })
      }
    );

    const completeNote = notes.at(-1) ?? "";
    expect(completeNote).toContain("OpenTag config saved.");
    expect(completeNote).toContain(`Project path: ${realpathSync.native(projectPath)}`);
    expect(completeNote).not.toContain("Project Target");
    expect(completeNote).not.toContain("path_");
  });

  it("starts OpenTag directly after interactive setup when confirmed", async () => {
    const configPath = join(tempDir(), "config.json");
    const startOpenTag = vi.fn(async () => undefined);

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        executor: "echo",
        larkSetup: "manual",
        larkDomain: "lark",
        larkAppId: "cli_manual",
        larkAppSecret: "secret_manual",
        force: true
      },
      {
        prompts: testPrompts(),
        startOpenTag
      }
    );

    expect(startOpenTag).toHaveBeenCalledWith({ config: configPath });
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
        force: true,
        start: false
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

  it("writes the GitHub local webhook port from setup options", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        platform: "github",
        executor: "echo",
        language: "en",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        githubPort: "3050",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.github?.port).toBe(3050);
    expect(config.preferences?.lastSetup?.githubPort).toBe(3050);
  });

  it("uses the CLI GitHub webhook port default for new setup configs", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        platform: "github",
        executor: "echo",
        language: "en",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    expect(readCliConfig(configPath).platforms.github?.port).toBe(3050);
  });

  it("uses injected config and state env paths during setup", async () => {
    const configHome = tempDir();
    const stateDirectory = tempDir();
    const configPath = join(configHome, "config.json");

    await runSetupCommand(
      {
        project: tempDir(),
        executor: "echo",
        larkSetup: "manual",
        larkDomain: "lark",
        larkAppId: "cli_manual",
        larkAppSecret: "secret_manual",
        force: true,
        yes: true
      },
      {
        env: {
          OPENTAG_CONFIG_HOME: configHome,
          OPENTAG_STATE_DIR: stateDirectory
        },
        prompts: testPrompts()
      }
    );

    expect(readCliConfig(configPath).state.directory).toBe(stateDirectory);
  });

  it("allows --force to replace an invalid existing config", async () => {
    const configPath = join(tempDir(), "config.json");
    writeFileSync(configPath, "{not valid json");
    chmodSync(configPath, 0o600);

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
      { prompts: testPrompts() }
    );

    expect(readCliConfig(configPath).platforms.lark?.appId).toBe("cli_manual");
  });

  it("does not read stale saved Lark credentials when scan is explicitly selected", async () => {
    const projectPath = tempDir();
    const configPath = join(tempDir(), "config.json");
    const legacyDirectory = join(projectPath, ".opentag", "lark");
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyConfigPath = join(legacyDirectory, "lark.local.json");
    writeFileSync(legacyConfigPath, "{not valid json");
    chmodSync(legacyConfigPath, 0o600);

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        executor: "echo",
        larkSetup: "scan",
        start: false,
        force: true,
        yes: true
      },
      {
        prompts: testPrompts(),
        scanLarkPersonalAgent: vi.fn(async () => ({
          appId: "cli_scan",
          appSecret: "secret_scan",
          domain: "lark" as const
        }))
      }
    );

    expect(readCliConfig(configPath).platforms.lark?.appId).toBe("cli_scan");
  });

  it("fails fast when --project points at a missing path", async () => {
    await expect(
      runSetupCommand(
        {
          config: join(tempDir(), "config.json"),
          project: join(tempDir(), "missing"),
          executor: "echo",
          larkSetup: "manual",
          larkDomain: "lark",
          larkAppId: "cli_manual",
          larkAppSecret: "secret_manual",
          force: true,
          yes: true
        },
        { prompts: testPrompts() }
      )
    ).rejects.toThrow("Path does not exist:");
  });

  it("keeps the existing GitHub webhook secret on setup reruns", async () => {
    const configPath = join(tempDir(), "config.json");
    const projectPath = tempDir();

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        platform: "github",
        executor: "echo",
        language: "en",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        githubWebhookSecret: "github_webhook_secret",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );
    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        platform: "github",
        executor: "echo",
        language: "en",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    expect(readCliConfig(configPath).platforms.github?.webhookSecret).toBe("github_webhook_secret");
  });

  it("keeps the existing GitHub webhook path on setup reruns", async () => {
    const configPath = join(tempDir(), "config.json");
    const projectPath = tempDir();

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        platform: "github",
        executor: "echo",
        language: "en",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        githubWebhookPath: "/opentag",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );
    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        platform: "github",
        executor: "echo",
        language: "en",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    expect(readCliConfig(configPath).platforms.github?.webhookPath).toBe("/opentag");
  });

  it("keeps the existing GitHub auto-PR choice on --yes setup reruns", async () => {
    const configPath = join(tempDir(), "config.json");
    const projectPath = tempDir();

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        platform: "github",
        executor: "echo",
        language: "en",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        githubAutoCreatePr: true,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );
    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        platform: "github",
        executor: "echo",
        language: "en",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.daemon.allowAutoCreatePullRequest).toBe(true);
    expect(config.preferences?.lastSetup?.githubAutoCreatePullRequest).toBe(true);
  });

  it("rejects a GitHub webhook path that is not rooted", async () => {
    await expect(
      runSetupCommand(
        {
          config: join(tempDir(), "config.json"),
          project: tempDir(),
          platform: "github",
          executor: "echo",
          githubRepository: "acme/demo",
          githubToken: "ghp_test",
          githubWebhookPath: "github/webhooks",
          force: true,
          yes: true
        },
        { prompts: testPrompts() }
      )
    ).rejects.toThrow("GitHub webhook path must start with /.");
  });

  it("writes Hermes setup options into daemon config", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        platform: "github",
        executor: "hermes",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        hermesCommand: "custom-hermes",
        hermesProfile: "opentag-fixed",
        hermesProfileTemplate: "opentag-{provider}-{owner}-{repo}",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.daemon.repositories[0]?.defaultExecutor).toBe("hermes");
    expect(config.daemon.hermes).toEqual({
      command: "custom-hermes",
      profile: "opentag-fixed",
      profileTemplate: "opentag-{provider}-{owner}-{repo}"
    });
  });

  it("defaults Hermes profileTemplate when no fixed profile is provided", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        platform: "github",
        executor: "hermes",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    expect(readCliConfig(configPath).daemon.hermes).toEqual({
      profileTemplate:
        "opentag-{provider}-{accountId}-{conversationId}-{owner}-{repo}-i{issueNumber}-pr{pullRequestNumber}"
    });
  });

  it("does not keep an inherited Hermes fixed profile when a profileTemplate is explicitly provided", async () => {
    const configPath = join(tempDir(), "config.json");
    const projectPath = tempDir();

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        platform: "github",
        executor: "hermes",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        hermesProfile: "opentag-fixed",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );
    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        platform: "github",
        executor: "hermes",
        githubRepository: "acme/demo",
        githubToken: "ghp_test",
        hermesProfileTemplate: "opentag-{provider}-{owner}-{repo}",
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    expect(readCliConfig(configPath).daemon.hermes).toEqual({
      profileTemplate: "opentag-{provider}-{owner}-{repo}"
    });
  });

  it("rejects Slack setup without an initial channel binding", async () => {
    await expect(
      runSetupCommand(
        {
          config: join(tempDir(), "config.json"),
          project: tempDir(),
          platform: "slack",
          executor: "echo",
          slackAppToken: "xapp-token",
          slackBotToken: "xoxb-token",
          slackTeamId: "T123",
          slackChannelId: "C123",
          binding: "bind_later",
          force: true,
          yes: true
        },
        { prompts: testPrompts() }
      )
    ).rejects.toThrow("Slack setup requires a channel binding.");
  });
});
