import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

function relayCapabilityFetch(platforms: unknown[]): typeof fetch {
  return vi.fn(async (url) => {
    const href = String(url);
    if (href.endsWith("/healthz")) return Response.json({ ok: true });
    if (href.endsWith("/v1/relay/capabilities")) {
      return Response.json({
        schemaVersion: 1,
        relay: true,
        platforms
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
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

  it("prints the Linear setup guide before collecting Linear credentials", async () => {
    const configPath = join(tempDir(), "config.json");
    const notes: string[] = [];

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "linear",
        executor: "echo",
        linearToken: "lin_api_token",
        linearWebhookSecret: "linear_webhook_secret",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts(notes) }
    );

    expect(notes.join("\n")).toContain("https://github.com/amplifthq/opentag/blob/main/docs/platforms/linear.en.md");
    expect(notes.join("\n")).toContain("https://linear.app/settings/api");
    expect(notes.join("\n")).toContain("https://linear.app/developers/oauth-2-0-authentication");
    expect(notes.join("\n")).toContain("Linear GraphQL API docs");
    expect(notes.join("\n")).toContain("Linear OAuth App / actor=app install is recommended");
    expect(notes.join("\n")).toContain("Manual API keys remain supported for quick local validation");
  });

  it("prints the Telegram setup guide before collecting Telegram credentials", async () => {
    const configPath = join(tempDir(), "config.json");
    const notes: string[] = [];

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "telegram",
        executor: "echo",
        telegramBotToken: "123456789:telegram_secret",
        telegramBotUsername: "opentag_bot",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts(notes) }
    );

    expect(notes.join("\n")).toContain("https://github.com/amplifthq/opentag/blob/main/docs/platforms/telegram.en.md");
    expect(notes.join("\n")).toContain("https://t.me/BotFather");
    expect(notes.join("\n")).toContain("Telegram Bot API / getUpdates");
    expect(notes.join("\n")).toContain("Telegram bot token from BotFather");
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
        discordBotToken: "discord_bot_token",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts(notes) }
    );

    expect(notes.join("\n")).toContain("https://github.com/amplifthq/opentag/blob/main/docs/platforms/discord.en.md");
    expect(notes.join("\n")).toContain("https://discord.com/developers/applications");
    expect(notes.join("\n")).toContain("Discord Gateway docs");
    expect(notes.join("\n")).toContain("A registered /opentag slash command");
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

  it("writes a Linear config with a local project target", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "linear",
        executor: "echo",
        linearToken: "lin_api_token",
        linearWebhookSecret: "linear_webhook_secret",
        linearTeamId: "team_eng",
        linearTeamKey: "ENG",
        linearGraphqlUrl: "https://linear.example/graphql",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.linear).toMatchObject({
      token: "lin_api_token",
      webhookSecret: "linear_webhook_secret",
      teamId: "team_eng",
      teamKey: "ENG",
      graphqlUrl: "https://linear.example/graphql",
      webhookPath: "/linear/webhooks",
      port: 3070,
      projectTarget: {
        repoProvider: "local",
        repo: expect.any(String)
      }
    });
    expect(config.preferences?.lastSetup).toMatchObject({
      platforms: ["linear"],
      linearTeamId: "team_eng",
      linearTeamKey: "ENG",
      linearPort: 3070
    });
  });

  it("writes a Linear OAuth app config with discovered metadata mappings", async () => {
    const configPath = join(tempDir(), "config.json");
    const notes: string[] = [];

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "linear",
        executor: "echo",
        linearAuth: "oauth_app",
        linearOauthClientId: "linear_client_id",
        linearOauthClientSecret: "linear_client_secret",
        linearOauthRedirectUri: "https://opentag.example/oauth/linear/callback",
        linearOauthCode: "linear_auth_code",
        linearWebhookSecret: "linear_webhook_secret",
        linearGraphqlUrl: "https://linear.example/graphql",
        start: false,
        force: true,
        yes: true
      },
      {
        prompts: testPrompts(notes),
        now: () => new Date("2026-07-07T00:00:00.000Z"),
        async exchangeLinearOAuthCode(input) {
          expect(input).toMatchObject({
            clientId: "linear_client_id",
            clientSecret: "linear_client_secret",
            code: "linear_auth_code",
            redirectUri: "https://opentag.example/oauth/linear/callback"
          });
          return {
            accessToken: "Bearer linear_oauth_access",
            refreshToken: "linear_refresh_token",
            expiresIn: 3600,
            scope: ["read", "write", "comments:create", "app:assignable", "app:mentionable"]
          };
        },
        async discoverLinearMetadata(input) {
          expect(input).toMatchObject({
            token: "Bearer linear_oauth_access",
            graphqlUrl: "https://linear.example/graphql",
            first: 100
          });
          return {
            teams: [{ id: "team_eng", key: "ENG", name: "Engineering" }],
            users: [
              { id: "user_ada", name: "Ada Lovelace", displayName: "Ada", email: "ada@example.com", active: true, app: false },
              { id: "user_bot", name: "OpenTag", active: true, app: true }
            ],
            workflowStates: [{ id: "state_progress", name: "In Progress", type: "started", team: { id: "team_eng", key: "ENG" } }],
            issueLabels: [{ id: "label_bug", name: "Bug", color: "#ff0000", isGroup: false, team: { id: "team_eng", key: "ENG" } }]
          };
        }
      }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.linear).toMatchObject({
      token: "Bearer linear_oauth_access",
      auth: {
        method: "oauth_app",
        actor: "app",
        clientId: "linear_client_id",
        clientSecret: "linear_client_secret",
        redirectUri: "https://opentag.example/oauth/linear/callback",
        refreshToken: "linear_refresh_token",
        accessTokenExpiresAt: "2026-07-07T01:00:00.000Z",
        scopes: ["read", "write", "comments:create", "app:assignable", "app:mentionable"]
      },
      teamId: "team_eng",
      teamKey: "ENG"
    });
    expect(config.platforms.linear?.mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "linear_status_state_id",
          adapter: "linear",
          domain: "status",
          strategy: "state_id",
          values: expect.objectContaining({
            in_progress: "state_progress",
            eng_in_progress: "state_progress",
            started: "state_progress"
          })
        }),
        expect.objectContaining({
          id: "linear_assignee_user_id",
          domain: "assignee",
          strategy: "user_id",
          values: expect.objectContaining({
            ada_lovelace: "user_ada",
            ada: "user_ada",
            "ada@example.com": "user_ada"
          })
        }),
        expect.objectContaining({
          id: "linear_label_label_id",
          domain: "label",
          strategy: "label_id",
          values: expect.objectContaining({
            bug: "label_bug",
            eng_bug: "label_bug"
          })
        })
      ])
    );
    expect(config.preferences?.lastSetup).toMatchObject({
      platforms: ["linear"],
      linearAuth: "oauth_app",
      linearTeamId: "team_eng",
      linearTeamKey: "ENG"
    });
    expect(notes.join("\n")).toContain("actor=app");
    expect(notes.join("\n")).toContain("Linear metadata discovery completed");
  });

  it("can configure Linear setup directly for relay mode", async () => {
    const configPath = join(tempDir(), "config.json");
    const notes: string[] = [];
    const calls: string[] = [];
    const fetchImpl = relayCapabilityFetch([
      {
        provider: "linear",
        ingress: {
          enabled: true,
          path: "/linear/webhooks",
          signatureVerification: "configured"
        },
        callback: { enabled: true },
        apply: { enabled: true }
      }
    ]);

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "linear",
        executor: "echo",
        linearToken: "lin_api_token",
        linearWebhookSecret: "linear_webhook_secret",
        relay: "https://relay.example",
        start: false,
        force: true,
        yes: true
      },
      {
        prompts: testPrompts(notes),
        fetchImpl,
        bootstrapClient: {
          async registerRunner(name) {
            calls.push(`runner:${name}`);
          },
          async bindRepository(binding) {
            calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
          },
          async upsertLinearRelayInstallation(input) {
            calls.push(`linear:${input.id}:${input.webhookPath}`);
          },
          async bindChannel(binding) {
            calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
          }
        }
      }
    );

    const config = readCliConfig(configPath);
    expect(config.runtime).toEqual({
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    });
    expect(config.daemon.dispatcherUrl).toBe("https://relay.example");
    expect(fetchImpl).toHaveBeenCalledWith("https://relay.example/healthz", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(calls).toEqual([
      "runner:runner_local",
      ...config.daemon.repositories.map((repository) => `repo:${repository.provider}:${repository.owner}/${repository.repo}`),
      `linear:${config.platforms.linear!.webhookPath!.slice("/linear/webhooks/".length)}:${config.platforms.linear!.webhookPath}`
    ]);
    expect(config.platforms.linear?.webhookPath).toMatch(/^\/linear\/webhooks\/[a-f0-9]{24}$/);
    expect(notes.join("\n")).toContain("OpenTag relay pairing updated.");
    expect(notes.join("\n")).toContain("Linear webhook URL: https://relay.example/linear/webhooks");
    expect(notes.join("\n")).toContain("Security: only pair with a relay you operate or trust");
  });

  it("starts a hosted Linear OAuth install for relay mode without a manual API key", async () => {
    const configPath = join(tempDir(), "config.json");
    const notes: string[] = [];
    const calls: string[] = [];
    const fetchImpl = relayCapabilityFetch([
      {
        provider: "linear",
        ingress: {
          enabled: true,
          path: "/linear/oauth/webhooks",
          signatureVerification: "configured"
        },
        oauthInstall: {
          enabled: true,
          path: "/v1/linear-oauth-installations"
        }
      }
    ]);

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "linear",
        executor: "echo",
        relay: "https://relay.example",
        start: false,
        force: true,
        yes: true
      },
      {
        prompts: testPrompts(notes),
        fetchImpl,
        bootstrapClient: {
          async registerRunner(name) {
            calls.push(`runner:${name}`);
          },
          async bindRepository(binding) {
            calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
          },
          async createLinearOAuthInstallation(input) {
            calls.push(`oauth:${input.repoProvider}:${input.owner}/${input.repo}`);
            return {
              authorizationUrl: "https://linear.example/oauth/authorize?state=linear_state",
              stateExpiresAt: "2026-07-07T01:00:00.000Z",
              oauthWebhookPath: "/linear/oauth/webhooks",
              installation: {
                id: "install_hosted",
                webhookPath: "/linear/webhooks/install_hosted",
                projectTarget: {
                  repoProvider: input.repoProvider ?? "github",
                  owner: input.owner,
                  repo: input.repo
                }
              }
            };
          },
          async bindChannel(binding) {
            calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
          }
        }
      }
    );

    const config = readCliConfig(configPath);
    expect(config.runtime).toEqual({
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    });
    expect(config.platforms.linear).toMatchObject({
      auth: {
        method: "hosted_oauth_app",
        actor: "app",
        installationId: "install_hosted",
        authorizationUrl: "https://linear.example/oauth/authorize?state=linear_state",
        stateExpiresAt: "2026-07-07T01:00:00.000Z"
      },
      webhookPath: "/linear/oauth/webhooks"
    });
    expect(config.platforms.linear).not.toHaveProperty("token");
    expect(config.platforms.linear).not.toHaveProperty("webhookSecret");
    expect(calls).toEqual([
      "runner:runner_local",
      ...config.daemon.repositories.map((repository) => `repo:${repository.provider}:${repository.owner}/${repository.repo}`),
      `oauth:${config.platforms.linear!.projectTarget.repoProvider}:${config.platforms.linear!.projectTarget.owner}/${config.platforms.linear!.projectTarget.repo}`
    ]);
    expect(notes.join("\n")).toContain("Linear OAuth install URL: https://linear.example/oauth/authorize?state=linear_state");
    expect(notes.join("\n")).toContain("Linear webhook URL: https://relay.example/linear/oauth/webhooks");
    expect(notes.join("\n")).toContain("Relay mode: Linear should call the relay URL above; no ngrok/cloudflared tunnel is needed.");
  });

  it("rejects hosted Linear OAuth relay setup when the relay does not advertise OAuth install support", async () => {
    const configPath = join(tempDir(), "config.json");
    const calls: string[] = [];

    let message = "";
    try {
      await runSetupCommand(
        {
          config: configPath,
          project: tempDir(),
          language: "en",
          platform: "linear",
          executor: "echo",
          relay: "https://relay.example",
          start: false,
          force: true,
          yes: true
        },
        {
          prompts: testPrompts(),
          fetchImpl: relayCapabilityFetch([
            {
              provider: "linear",
              ingress: {
                enabled: true,
                path: "/linear/oauth/webhooks",
                signatureVerification: "configured"
              },
              oauthInstall: {
                enabled: false,
                reason: "OPENTAG_LINEAR_OAUTH_CLIENT_ID and OPENTAG_LINEAR_OAUTH_REDIRECT_URI are not configured."
              }
            }
          ]),
          bootstrapClient: {
            async registerRunner(name) {
              calls.push(`runner:${name}`);
            },
            async bindRepository(binding) {
              calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
            },
            async createLinearOAuthInstallation(input) {
              calls.push(`oauth:${input.owner}/${input.repo}`);
              throw new Error("should not create OAuth install");
            },
            async bindChannel(binding) {
              calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
            }
          }
        }
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Relay https://relay.example is not ready for Linear hosted OAuth install");
    expect(message).toContain("OPENTAG_LINEAR_OAUTH_CLIENT_ID");
    expect(message).toContain("OPENTAG_LINEAR_OAUTH_REDIRECT_URI");
    expect(calls).toEqual([]);
    expect(existsSync(configPath)).toBe(false);
  });

  it("rejects hosted Linear OAuth relay setup when OAuth ingress is not advertised", async () => {
    const configPath = join(tempDir(), "config.json");
    const calls: string[] = [];

    let message = "";
    try {
      await runSetupCommand(
        {
          config: configPath,
          project: tempDir(),
          language: "en",
          platform: "linear",
          executor: "echo",
          relay: "https://relay.example",
          start: false,
          force: true,
          yes: true
        },
        {
          prompts: testPrompts(),
          fetchImpl: relayCapabilityFetch([
            {
              provider: "linear",
              oauthInstall: {
                enabled: true,
                path: "/v1/linear-oauth-installations"
              }
            }
          ]),
          bootstrapClient: {
            async registerRunner(name) {
              calls.push(`runner:${name}`);
            },
            async bindRepository(binding) {
              calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
            },
            async createLinearOAuthInstallation(input) {
              calls.push(`oauth:${input.owner}/${input.repo}`);
              throw new Error("should not create OAuth install");
            },
            async bindChannel(binding) {
              calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
            }
          }
        }
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Relay https://relay.example is not ready for Linear hosted OAuth webhooks");
    expect(message).toContain("OPENTAG_LINEAR_OAUTH_WEBHOOK_SECRET");
    expect(calls).toEqual([]);
    expect(existsSync(configPath)).toBe(false);
  });

  it("rejects Linear relay setup when the relay advertises no Linear ingress", async () => {
    const configPath = join(tempDir(), "config.json");
    const calls: string[] = [];

    let message = "";
    try {
      await runSetupCommand(
        {
          config: configPath,
          project: tempDir(),
          language: "en",
          platform: "linear",
          executor: "echo",
          linearToken: "lin_api_token",
          linearWebhookSecret: "linear_webhook_secret",
          linearWebhookPath: "/linear/webhooks",
          relay: "https://relay.example",
          start: false,
          force: true,
          yes: true
        },
        {
          prompts: testPrompts(),
          fetchImpl: relayCapabilityFetch([]),
          bootstrapClient: {
            async registerRunner(name) {
              calls.push(`runner:${name}`);
            },
            async bindRepository(binding) {
              calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
            },
            async bindChannel(binding) {
              calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
            }
          }
        }
      )
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Relay https://relay.example is not ready for Linear at /linear/webhooks");
    expect(message).toContain("OPENTAG_LINEAR_API_KEY=<Linear OAuth access token or raw lin_api_... key>");
    expect(message).toContain("OPENTAG_LINEAR_WEBHOOK_SECRET=<copy platforms.linear.webhookSecret from the local OpenTag config>");
    expect(message).toContain("OPENTAG_LINEAR_REPO_PROVIDER=");
    expect(message).toContain("OPENTAG_LINEAR_REPO_OWNER=");
    expect(message).toContain("OPENTAG_LINEAR_REPO_NAME=");
    expect(message).not.toContain("lin_api_token");
    expect(message).not.toContain("linear_webhook_secret");
    expect(calls).toEqual([]);
    expect(existsSync(configPath)).toBe(false);
  });

  it("writes a Telegram polling config by default", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "telegram",
        executor: "echo",
        telegramBotToken: "123456789:telegram_secret",
        telegramBotUsername: "opentag_bot",
        telegramBindingAdminUserIds: "111,222",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.telegram).toMatchObject({
      mode: "polling",
      botId: "123456789",
      agentId: "opentag",
      botUsername: "opentag_bot",
      botToken: "123456789:telegram_secret",
      bindingAdminUserIds: ["111", "222"]
    });
    expect(config.platforms.telegram?.secretToken).toBeUndefined();
    expect(config.preferences?.lastSetup).toMatchObject({
      platforms: ["telegram"],
      telegramMode: "polling",
      telegramBotId: "123456789",
      telegramBotUsername: "opentag_bot"
    });
  });

  it("writes a Discord Gateway config by default", async () => {
    const configPath = join(tempDir(), "config.json");

    await runSetupCommand(
      {
        config: configPath,
        project: tempDir(),
        language: "en",
        platform: "discord",
        executor: "echo",
        discordBotToken: "discord_bot_token",
        start: false,
        force: true,
        yes: true
      },
      { prompts: testPrompts() }
    );

    const config = readCliConfig(configPath);
    expect(config.platforms.discord).toEqual({
      mode: "gateway",
      botToken: "discord_bot_token"
    });
    expect(config.preferences?.lastSetup).toMatchObject({
      platforms: ["discord"],
      discordMode: "gateway"
    });
  });
});
