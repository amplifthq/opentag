import { execFileSync } from "node:child_process";
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

function tempGitProjectWithOrigin(remoteUrl: string): string {
  const projectPath = tempDir();
  execFileSync("git", ["init"], { cwd: projectPath, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: projectPath, stdio: "ignore" });
  return projectPath;
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
    expect(notes.join("\n")).toContain("https://api.slack.com/apps");
    expect(notes.join("\n")).toContain("https://docs.slack.dev/apis/events-api/using-socket-mode/");
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
    expect(notes.join("\n")).toContain("https://github.com/settings/personal-access-tokens/new");
    expect(notes.join("\n")).toContain("OpenTag 会自动生成 webhook secret");
  });

  it("prints the GitLab setup guide before collecting GitLab credentials", async () => {
    const configPath = join(tempDir(), "config.json");
    const notes: string[] = [];

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "gitlab",
        executor: "echo",
        gitlabProject: "acme/team/demo",
        gitlabToken: "glpat_token",
        gitlabWebhookSecret: "gitlab_webhook_secret",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts(notes) }
    );

    expect(notes.join("\n")).toContain("https://github.com/amplifthq/opentag/blob/main/docs/platforms/gitlab.en.md");
    expect(notes.join("\n")).toContain("https://docs.gitlab.com/user/project/integrations/webhook_events/");
    expect(notes.join("\n")).toContain("GitLab access token for issue/MR note replies and MR creation after you reply `apply 1`");
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
      webhookPath: "/github/webhooks",
      port: 3050
    });
    expect(config.daemon.githubToken).toBe("ghp_token");
    expect(config.daemon.preparePullRequestBranch).toBe(true);
    expect(config.daemon.allowAutoCreatePullRequest).toBe(false);
    expect(config.daemon.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "github", owner: "acme", repo: "demo" })
      ])
    );
  });

  it("generates the GitHub webhook secret and records the pull request choice", async () => {
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
        githubAutoCreatePr: true,
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.github?.webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(config.daemon.preparePullRequestBranch).toBe(true);
    expect(config.daemon.allowAutoCreatePullRequest).toBe(true);
    expect(config.preferences?.lastSetup?.githubAutoCreatePullRequest).toBe(true);
  });

  it("writes a GitLab config with a GitLab repository binding", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "gitlab",
        executor: "echo",
        gitlabProject: "acme/team/demo",
        gitlabBaseUrl: "https://gitlab.example.com",
        gitlabToken: "glpat_token",
        gitlabWebhookSecret: "gitlab_webhook_secret",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.gitlab).toEqual({
      token: "glpat_token",
      webhookSecret: "gitlab_webhook_secret",
      projectPathWithNamespace: "acme/team/demo",
      baseUrl: "https://gitlab.example.com",
      webhookPath: "/gitlab/webhooks",
      port: 3060
    });
    expect(config.daemon.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "gitlab", owner: "acme/team", repo: "demo" })
      ])
    );
    expect(config.preferences?.lastSetup).toMatchObject({
      platforms: ["gitlab"],
      gitlabProjectPathWithNamespace: "acme/team/demo",
      gitlabBaseUrl: "https://gitlab.example.com",
      gitlabPort: 3060
    });
  });

  it("detects self-managed GitLab projects from custom-domain remotes", async () => {
    const configPath = join(tempDir(), "config.json");
    const projectPath = tempGitProjectWithOrigin("https://git.company.com/acme/team/demo.git");

    await runSetupCommand(
      {
        config: configPath,
        project: projectPath,
        language: "en",
        platform: "gitlab",
        executor: "echo",
        gitlabToken: "glpat_token",
        gitlabWebhookSecret: "gitlab_webhook_secret",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.gitlab).toMatchObject({
      token: "glpat_token",
      webhookSecret: "gitlab_webhook_secret",
      projectPathWithNamespace: "acme/team/demo",
      baseUrl: "https://git.company.com"
    });
    expect(config.daemon.repositories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "gitlab", owner: "acme/team", repo: "demo" })
      ])
    );
  });

  it("prints the Discord setup guide before collecting Discord credentials", async () => {
    const configPath = join(tempDir(), "config.json");
    const notes: string[] = [];

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "discord",
        executor: "echo",
        discordApplicationId: "1234567890",
        discordPublicKey: "a".repeat(64),
        discordBotToken: "discord_bot_token",
        discordChannelId: "9876543210",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts(notes) }
    );

    expect(notes.join("\n")).toContain("https://github.com/amplifthq/opentag/blob/main/docs/platforms/discord.en.md");
    expect(notes.join("\n")).toContain("https://discord.com/developers/applications");
    expect(notes.join("\n")).toContain("The /opentag slash command must be registered");
  });

  it("writes a Discord config and default channel binding", async () => {
    const configPath = join(tempDir(), "config.json");
    const publicKey = "b".repeat(64);

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "discord",
        executor: "echo",
        discordApplicationId: "1234567890",
        discordPublicKey: publicKey,
        discordBotToken: "discord_bot_token",
        discordChannelId: "9876543210",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.discord).toMatchObject({
      applicationId: "1234567890",
      publicKey,
      botToken: "discord_bot_token",
      channelId: "9876543210",
      defaultProjectBinding: true,
      webhookPath: "/discord/interactions"
    });
    expect(config.daemon.channelBindings).toEqual([
      {
        provider: "discord",
        accountId: "1234567890",
        conversationId: "9876543210",
        repoProvider: config.daemon.repositories[0]!.provider,
        owner: config.daemon.repositories[0]!.owner,
        repo: config.daemon.repositories[0]!.repo
      }
    ]);
    expect(config.preferences?.lastSetup?.discordApplicationId).toBe("1234567890");
    expect(config.preferences?.lastSetup?.discordChannelId).toBe("9876543210");
  });

  it("prompts for the Discord interactions path when it is not provided", async () => {
    const configPath = join(tempDir(), "config.json");
    const askedMessages: string[] = [];
    const prompts: PromptAdapter = {
      intro() {},
      outro() {},
      note() {},
      async select<Value extends string>(input: { options: Array<PromptOption<Value>>; initialValue?: Value }): Promise<Value> {
        return input.initialValue ?? input.options[0]!.value;
      },
      async text(input) {
        askedMessages.push(input.message);
        if (input.message.includes("interactions path")) return "/custom/interactions";
        return input.initialValue ?? "";
      },
      async password() {
        return "secret_prompt";
      },
      async confirm() {
        return true;
      }
    };

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "discord",
        executor: "echo",
        discordApplicationId: "1234567890",
        discordPublicKey: "d".repeat(64),
        discordBotToken: "discord_bot_token",
        discordChannelId: "9876543210",
        start: false,
        force: true
      },
      { prompts }
    );

    expect(askedMessages.some((message) => message.includes("interactions path"))).toBe(true);
    const config = readCliConfig(configPath);
    expect(config.platforms.discord?.webhookPath).toBe("/custom/interactions");
  });

  it("honors the --discord-webhook-path flag without prompting", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "discord",
        executor: "echo",
        discordApplicationId: "1234567890",
        discordPublicKey: "e".repeat(64),
        discordBotToken: "discord_bot_token",
        discordChannelId: "9876543210",
        discordWebhookPath: "/flag/interactions",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.discord?.webhookPath).toBe("/flag/interactions");
  });
});
