import { afterEach, describe, expect, it } from "vitest";
import {
  createInitialConfig,
  formatConfigError,
  loadConfigFromEnv,
  normalizeChannelBindings,
  parseDaemonConfig,
  type OpenTagDaemonConfig
} from "../src/config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("opentagd config", () => {
  it("rejects invalid Claude Code permission modes", () => {
    delete process.env.OPENTAG_CONFIG_PATH;
    process.env.OPENTAG_REPO_OWNER = "acme";
    process.env.OPENTAG_REPO_NAME = "demo";
    process.env.OPENTAG_WORKSPACE_PATH = "/tmp/demo";
    process.env.OPENTAG_CLAUDE_PERMISSION_MODE = "typo";

    expect(() => loadConfigFromEnv()).toThrow("Invalid OPENTAG_CLAUDE_PERMISSION_MODE: typo");
  });

  it("builds an initial daemon config with worktree defaults", () => {
    const config = createInitialConfig({
      owner: "acme",
      repo: "demo",
      checkoutPath: "/tmp/demo"
    });

    expect(config).toMatchObject({
      runnerId: "runner_local",
      dispatcherUrl: "http://localhost:3030",
      repositories: [
        {
          provider: "github",
          owner: "acme",
          repo: "demo",
          checkoutPath: "/tmp/demo",
          defaultExecutor: "echo",
          baseBranch: "main",
          pushRemote: "origin",
          keepWorktree: "on_failure"
        }
      ]
    });
  });

  it("parses JSON config files through the validated schema", () => {
    const parsed = parseDaemonConfig({
      runnerId: "runner_test",
      dispatcherUrl: "http://localhost:3030",
      repositories: [
        {
          owner: "acme",
          repo: "demo",
          checkoutPath: "/tmp/demo",
          defaultExecutor: "codex",
          worktreeRoot: "/tmp/worktrees",
          keepWorktree: "always"
        }
      ]
    } satisfies Partial<OpenTagDaemonConfig>);

    expect(parsed.repositories[0]).toMatchObject({
      provider: "github",
      defaultExecutor: "codex",
      worktreeRoot: "/tmp/worktrees",
      keepWorktree: "always"
    });
  });

  it("defaults Slack channel bindings to github repoProvider", () => {
    const parsed = parseDaemonConfig({
      dispatcherUrl: "http://localhost:3030",
      repositories: [],
      slackChannels: [{ teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" }]
    });

    expect(parsed.slackChannels?.[0]).toMatchObject({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    });
  });

  it("propagates OPENTAG_SLACK_REPO_PROVIDER into env-derived repository and Slack bindings", () => {
    delete process.env.OPENTAG_CONFIG_PATH;
    process.env.OPENTAG_REPO_OWNER = "acme";
    process.env.OPENTAG_REPO_NAME = "demo";
    process.env.OPENTAG_WORKSPACE_PATH = "/tmp/demo";
    process.env.OPENTAG_SLACK_TEAM_ID = "T123";
    process.env.OPENTAG_SLACK_CHANNEL_ID = "C123";
    process.env.OPENTAG_SLACK_REPO_PROVIDER = "gitlab";

    const config = loadConfigFromEnv();

    expect(config.repositories[0]).toMatchObject({
      provider: "gitlab",
      owner: "acme",
      repo: "demo",
      checkoutPath: "/tmp/demo"
    });
    expect(config.slackChannels?.[0]).toMatchObject({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "gitlab",
      owner: "acme",
      repo: "demo"
    });
  });

  it("parses generic channel bindings through the validated schema", () => {
    const parsed = parseDaemonConfig({
      dispatcherUrl: "http://localhost:3030",
      repositories: [],
      channelBindings: [
        {
          provider: "telegram",
          accountId: "bot_123",
          conversationId: "456",
          repoProvider: "github",
          owner: "acme",
          repo: "demo",
          metadata: { topic: "ops" }
        }
      ]
    });

    expect(parsed.channelBindings?.[0]).toMatchObject({
      provider: "telegram",
      accountId: "bot_123",
      conversationId: "456",
      repoProvider: "github",
      owner: "acme",
      repo: "demo",
      metadata: { topic: "ops" }
    });
  });

  it("normalizes generic, Slack, and Lark channel binding aliases into the canonical shape", () => {
    const parsed = parseDaemonConfig({
      dispatcherUrl: "http://localhost:3030",
      repositories: [],
      channelBindings: [
        {
          provider: "telegram",
          accountId: "bot_123",
          conversationId: "456",
          repoProvider: "github",
          owner: "acme",
          repo: "demo",
          metadata: { topic: "ops" }
        }
      ],
      slackChannels: [{ teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" }],
      larkChannels: [{ tenantKey: "tenant_123", chatId: "chat_123", repoProvider: "local", owner: "path_abc", repo: "app" }]
    });

    expect(normalizeChannelBindings(parsed)).toEqual([
      {
        provider: "telegram",
        accountId: "bot_123",
        conversationId: "456",
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        metadata: { topic: "ops" }
      },
      {
        provider: "slack",
        accountId: "T123",
        conversationId: "C123",
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      },
      {
        provider: "lark",
        accountId: "tenant_123",
        conversationId: "chat_123",
        repoProvider: "local",
        owner: "path_abc",
        repo: "app"
      }
    ]);
  });

  it("rejects conflicting channel binding aliases for the same conversation", () => {
    expect(() =>
      parseDaemonConfig({
        dispatcherUrl: "http://localhost:3030",
        repositories: [],
        channelBindings: [
          {
            provider: "slack",
            accountId: "T123",
            conversationId: "C123",
            repoProvider: "github",
            owner: "acme",
            repo: "demo"
          }
        ],
        slackChannels: [{ teamId: "T123", channelId: "C123", repoProvider: "github", owner: "other", repo: "demo" }]
      })
    ).toThrow(
      "Conflicting channel binding for slack:T123/C123: github:acme/demo and github:other/demo"
    );
  });

  it("does not collide channel binding identities when values contain delimiters", () => {
    const parsed = parseDaemonConfig({
      dispatcherUrl: "http://localhost:3030",
      repositories: [],
      channelBindings: [
        {
          provider: "a",
          accountId: "b:c",
          conversationId: "d",
          repoProvider: "github",
          owner: "acme",
          repo: "first"
        },
        {
          provider: "a:b",
          accountId: "c",
          conversationId: "d",
          repoProvider: "github",
          owner: "acme",
          repo: "second"
        }
      ]
    });

    expect(normalizeChannelBindings(parsed)).toHaveLength(2);
  });

  it("formats zod config errors into a readable message", () => {
    const error = (() => {
      try {
        parseDaemonConfig({
          dispatcherUrl: "not-a-url",
          repositories: [{ owner: "acme", repo: "demo", checkoutPath: "" }]
        });
      } catch (caught) {
        return caught;
      }
      return new Error("expected parse to fail");
    })();

    expect(formatConfigError(error)).toContain("dispatcherUrl");
    expect(formatConfigError(error)).toContain("repositories.0.checkoutPath");
  });
});
