import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCliConfig } from "../src/config.js";
import { runSetupCommand } from "../src/setup.js";
import type { PromptAdapter, PromptOption } from "../src/ui/prompts.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function testPrompts(notes: string[] = []): PromptAdapter {
  return {
    intro() {},
    outro() {},
    note(message) {
      notes.push(message);
    },
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
    }
  };
}

describe("OpenTag CLI setup platforms", () => {
  it("prints the Slack setup guide before collecting Slack credentials", async () => {
    const configPath = join(tempDir(), "config.json");
    const notes: string[] = [];

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "slack",
        executor: "echo",
        slackSigningSecret: "slack_signing_secret",
        slackBotToken: "xoxb-token",
        slackTeamId: "T123",
        slackChannelId: "C123",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts(notes) }
    );

    expect(notes.join("\n")).toContain("https://github.com/amplifthq/opentag/blob/main/docs/platforms/slack.en.md");
    expect(notes.join("\n")).toContain("Slack Signing Secret");
    expect(notes.join("\n")).toContain("Slack App-Level Token");
  });

  it("prints the localized GitHub setup guide", async () => {
    const configPath = join(tempDir(), "config.json");
    const notes: string[] = [];

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "zh-CN",
        platform: "github",
        executor: "echo",
        githubRepository: "acme/demo",
        githubToken: "ghp_token",
        githubWebhookSecret: "github_webhook_secret",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts(notes) }
    );

    expect(notes.join("\n")).toContain("https://github.com/amplifthq/opentag/blob/main/docs/platforms/github.zh-CN.md");
    expect(notes.join("\n")).toContain("GitHub webhook secret");
  });

  it("writes a Slack config and default channel binding without Lark", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "slack",
        executor: "echo",
        slackSigningSecret: "slack_signing_secret",
        slackBotToken: "xoxb-token",
        slackAppId: "A123",
        slackTeamId: "T123",
        slackChannelId: "C123",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.lark).toBeUndefined();
    expect(config.platforms.slack).toMatchObject({
      mode: "events_api",
      signingSecret: "slack_signing_secret",
      botToken: "xoxb-token",
      appId: "A123",
      teamId: "T123",
      channelId: "C123",
      defaultProjectBinding: true
    });
    expect(config.daemon.channelBindings).toEqual([
      {
        provider: "slack",
        accountId: "T123",
        conversationId: "C123",
        repoProvider: config.daemon.repositories[0]!.provider,
        owner: config.daemon.repositories[0]!.owner,
        repo: config.daemon.repositories[0]!.repo
      }
    ]);
  });

  it("writes Slack Socket Mode config by default for local setup", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "slack",
        executor: "echo",
        slackAppToken: "xapp-token",
        slackBotToken: "xoxb-token",
        slackAppId: "A123",
        slackTeamId: "T123",
        slackChannelId: "C123",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.slack).toMatchObject({
      mode: "socket_mode",
      appToken: "xapp-token",
      botToken: "xoxb-token",
      appId: "A123",
      teamId: "T123",
      channelId: "C123",
      defaultProjectBinding: true
    });
    expect(config.preferences?.lastSetup?.slackMode).toBe("socket_mode");
  });

  it("writes a GitHub config with a GitHub repository binding", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "github",
        executor: "echo",
        githubRepository: "acme/demo",
        githubToken: "ghp_token",
        githubWebhookSecret: "github_webhook_secret",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.lark).toBeUndefined();
    expect(config.platforms.github).toEqual({
      webhookSecret: "github_webhook_secret",
      owner: "acme",
      repo: "demo",
      webhookPath: "/github/webhooks"
    });
    expect(config.daemon.githubToken).toBe("ghp_token");
    expect(config.daemon.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "github", owner: "acme", repo: "demo" })
      ])
    );
  });
});
