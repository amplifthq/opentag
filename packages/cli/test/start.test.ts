import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSetupConfig } from "../src/setup.js";
import {
  assertStartPortsAvailable,
  bootstrapLocalDispatcher,
  dispatcherRuntimeInputFromCliConfig,
  githubIngressConfigFromCliConfig,
  gitlabIngressConfigFromCliConfig,
  larkIngressConfigFromCliConfig,
  shouldRethrowAbortReason,
  slackIngressConfigFromCliConfig,
  slackSocketModeIngressConfigFromCliConfig,
  startFromConfig,
  type StartRuntimeDependencies,
  waitForDispatcher
} from "../src/start.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function config() {
  return createSetupConfig({
    language: "en",
    platform: "lark",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    lark: {
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "lark",
      botOpenId: "ou_bot",
      setupMethod: "scan",
      bindingMethod: "default_project"
    }
  });
}

function slackConfig() {
  return createSetupConfig({
    language: "en",
    platform: "slack",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    slack: {
      mode: "events_api",
      signingSecret: "slack_signing_secret",
      botToken: "xoxb-token",
      appId: "A123",
      teamId: "T123",
      channelId: "C123",
      bindingMethod: "default_project"
    }
  });
}

function slackSocketModeConfig() {
  return createSetupConfig({
    language: "en",
    platform: "slack",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    slack: {
      mode: "socket_mode",
      appToken: "xapp-token",
      botToken: "xoxb-token",
      appId: "A123",
      teamId: "T123",
      channelId: "C123",
      bindingMethod: "default_project"
    }
  });
}

function githubConfig(port?: number) {
  return createSetupConfig({
    language: "en",
    platform: "github",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    github: {
      token: "ghp_token",
      webhookSecret: "github_webhook_secret",
      owner: "acme",
      repo: "demo",
      webhookPath: "/github/webhooks",
      autoCreatePullRequest: false,
      port: port ?? 3050
    }
  });
}

function gitlabConfig(port?: number) {
  return createSetupConfig({
    language: "en",
    platform: "gitlab",
    projectPath: tempDir(),
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    gitlab: {
      token: "glpat_token",
      webhookSecret: "gitlab_webhook_secret",
      projectPathWithNamespace: "acme/team/demo",
      baseUrl: "https://gitlab.example.com",
      webhookPath: "/gitlab/webhooks",
      port: port ?? 3060
    }
  });
}

async function listenOnRandomPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate a test port.");
  }
  return { server, port: address.port };
}

function hangingFetch(): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as unknown as typeof fetch;
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe("OpenTag CLI start wiring", () => {
  it("derives dispatcher input with the Lark callback sink credentials", () => {
    const built = config();
    built.daemon.runnerToken = "runner_token";
    built.daemon.runnerTokens = ["runner_old"];
    built.daemon.revokedRunnerTokenFingerprints = ["abc123"];
    const dispatcher = dispatcherRuntimeInputFromCliConfig(built);

    expect(dispatcher).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      runnerToken: "runner_token",
      runnerTokens: ["runner_old"],
      revokedRunnerTokenFingerprints: ["abc123"],
      lark: {
        appId: "cli_test",
        appSecret: "secret_test",
        domain: "lark"
      }
    });
  });

  it("adds dispatcher hardening env to the local dispatcher without overriding config authority", () => {
    const built = config();
    built.daemon.pairingToken = "config_pairing_token";
    const dispatcher = dispatcherRuntimeInputFromCliConfig(built, {
      env: {
        OPENTAG_PAIRING_TOKEN: "env_pairing_token",
        OPENTAG_MAX_REQUEST_BODY_BYTES: "4096",
        OPENTAG_RATE_LIMIT_WINDOW_MS: "60000",
        OPENTAG_RATE_LIMIT_MAX_REQUESTS: "120"
      }
    });

    expect(dispatcher).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: "config_pairing_token",
      maxRequestBodyBytes: 4096,
      rateLimit: {
        windowMs: 60000,
        maxRequests: 120
      }
    });
  });

  it("derives dispatcher and ingress input for Slack without Lark", () => {
    const built = slackConfig();
    built.daemon.runTimeoutMs = 30_000;

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      slackBotToken: "xoxb-token"
    });
    expect(slackIngressConfigFromCliConfig(built)).toMatchObject({
      signingSecret: "slack_signing_secret",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      botToken: "xoxb-token",
      appId: "A123",
      runTimeoutMs: 30_000
    });
  });

  it("passes the service request body limit to Slack Events API ingress", () => {
    const built = slackConfig();

    expect(
      slackIngressConfigFromCliConfig(built, {
        env: { OPENTAG_MAX_REQUEST_BODY_BYTES: "8192" }
      })
    ).toMatchObject({
      maxRequestBodyBytes: 8192
    });
  });

  it("derives Slack Socket Mode input without requiring a public Events URL", () => {
    const built = slackSocketModeConfig();
    built.daemon.runTimeoutMs = 30_000;

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      slackBotToken: "xoxb-token"
    });
    expect(slackSocketModeIngressConfigFromCliConfig(built)).toMatchObject({
      appToken: "xapp-token",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      botToken: "xoxb-token",
      appId: "A123",
      runTimeoutMs: 30_000
    });
  });

  it("derives dispatcher and ingress input for GitHub without Lark", () => {
    const built = githubConfig();

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      githubToken: "ghp_token",
      githubCallbackToken: "ghp_token",
      githubApplyToken: "ghp_token"
    });
    expect(githubIngressConfigFromCliConfig(built)).toMatchObject({
      webhookSecret: "github_webhook_secret",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      webhookPath: "/github/webhooks"
    });
  });

  it("derives dispatcher and ingress input for GitLab without Lark", () => {
    const built = gitlabConfig();

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      port: 3030,
      databasePath: built.state.databasePath,
      pairingToken: built.daemon.pairingToken,
      gitlabToken: "glpat_token",
      gitlabBaseUrl: "https://gitlab.example.com"
    });
    expect(gitlabIngressConfigFromCliConfig(built)).toMatchObject({
      webhookSecret: "gitlab_webhook_secret",
      baseUrl: "https://gitlab.example.com",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      webhookPath: "/gitlab/webhooks",
      port: 3060
    });
  });

  it("passes the service request body limit to GitHub webhook ingress", () => {
    const built = githubConfig();

    expect(
      githubIngressConfigFromCliConfig(built, {
        env: { OPENTAG_MAX_REQUEST_BODY_BYTES: "8192" }
      })
    ).toMatchObject({
      maxRequestBodyBytes: 8192
    });
  });

  it("can keep GitHub callbacks enabled while disabling direct apply capability", () => {
    const built = githubConfig();
    built.daemon.githubApplyToken = null;

    expect(dispatcherRuntimeInputFromCliConfig(built)).toMatchObject({
      githubToken: "ghp_token",
      githubCallbackToken: "ghp_token",
      githubApplyToken: null
    });
  });

  it("uses the CLI GitHub webhook port default for legacy configs without a saved port", () => {
    const built = githubConfig();
    delete built.platforms.github!.port;

    expect(githubIngressConfigFromCliConfig(built)).toMatchObject({
      port: 3050
    });
  });

  it("fails before start when the GitHub webhook port is already in use", async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const built = githubConfig(port);

      await expect(assertStartPortsAvailable(built)).rejects.toThrow(
        `OpenTag cannot start GitHub local webhook because port ${port} is already in use.`
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails before start when the GitLab webhook port is already in use", async () => {
    const { server, port } = await listenOnRandomPort();
    try {
      const built = gitlabConfig(port);

      await expect(assertStartPortsAvailable(built)).rejects.toThrow(
        `OpenTag cannot start GitLab local webhook because port ${port} is already in use.`
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("fails fast for GitHub when run branches are not prepared for apply actions", () => {
    const built = githubConfig();
    built.daemon.preparePullRequestBranch = false;
    built.daemon.allowAutoCreatePullRequest = false;

    expect(() => dispatcherRuntimeInputFromCliConfig(built)).toThrow(
      "GitHub platform requires daemon.preparePullRequestBranch=true unless legacy daemon.allowAutoCreatePullRequest is enabled."
    );
  });

  it("fails fast when the Discord public key is set without a bot token", () => {
    const built = config();

    expect(() =>
      dispatcherRuntimeInputFromCliConfig(built, { env: { OPENTAG_DISCORD_PUBLIC_KEY: "pubkey" } })
    ).toThrow("Discord platform requires OPENTAG_DISCORD_BOT_TOKEN for callbacks.");
  });

  it("passes the documented Discord webhook path through to the runtime input", () => {
    const built = config();

    expect(
      dispatcherRuntimeInputFromCliConfig(built, {
        env: {
          OPENTAG_DISCORD_PUBLIC_KEY: "pubkey",
          OPENTAG_DISCORD_BOT_TOKEN: "bot",
          OPENTAG_DISCORD_WEBHOOK_PATH: "/custom/discord"
        }
      })
    ).toMatchObject({
      discordPublicKey: "pubkey",
      discordBotToken: "bot",
      discordWebhookPath: "/custom/discord"
    });
  });

  it("derives Lark ingress config with a default repo binding for one Project Target", () => {
    const built = config();
    built.daemon.runTimeoutMs = 30_000;
    const ingress = larkIngressConfigFromCliConfig(built);
    const repository = built.daemon.repositories[0]!;

    expect(ingress).toMatchObject({
      appId: "cli_test",
      appSecret: "secret_test",
      dispatcherUrl: "http://localhost:3030",
      dispatcherToken: built.daemon.pairingToken,
      agentId: "opentag",
      botOpenId: "ou_bot",
      runTimeoutMs: 30_000,
      defaultRepoBinding: {
        repoProvider: repository.provider,
        owner: repository.owner,
        repo: repository.repo
      }
    });
  });

  it("omits default Lark repo binding when setup chose bind later", () => {
    const built = config();
    built.platforms.lark!.defaultProjectBinding = false;

    expect(larkIngressConfigFromCliConfig(built).defaultRepoBinding).toBeUndefined();
  });

  it("bootstraps runner, Project Target, and channel bindings in dispatcher state", async () => {
    const built = config();
    built.daemon.channelBindings = [
      {
        provider: "lark",
        accountId: "tenant_1",
        conversationId: "chat_1",
        repoProvider: built.daemon.repositories[0]!.provider,
        owner: built.daemon.repositories[0]!.owner,
        repo: built.daemon.repositories[0]!.repo
      }
    ];
    const calls: string[] = [];

    await bootstrapLocalDispatcher(built, {
      async registerRunner(name) {
        calls.push(`runner:${name}`);
      },
      async bindRepository(binding) {
        calls.push(`repo:${binding.provider}:${binding.owner}/${binding.repo}`);
      },
      async bindChannel(binding) {
        calls.push(`channel:${binding.provider}:${binding.accountId}/${binding.conversationId}`);
      }
    });

    expect(calls).toEqual([
      "runner:runner_local",
      `repo:${built.daemon.repositories[0]!.provider}:${built.daemon.repositories[0]!.owner}/${built.daemon.repositories[0]!.repo}`,
      "channel:lark:tenant_1/chat_1"
    ]);
  });

  it("starts relay mode without local dispatcher, local port checks, or GitHub ingress", async () => {
    const built = githubConfig();
    built.runtime = {
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    };
    built.daemon.dispatcherUrl = "https://relay.example";
    const calls: string[] = [];
    const logs: string[] = [];
    const dispatcherHandle = {
      url: "http://localhost:3030",
      server: {},
      async close() {
        calls.push("dispatcher.close");
      }
    } as ReturnType<NonNullable<StartRuntimeDependencies["startDispatcher"]>>;

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {
          calls.push("ports");
        },
        startDispatcher() {
          calls.push("dispatcher");
          return dispatcherHandle;
        },
        startGitHubIngress() {
          calls.push("github-ingress");
          throw new Error("GitHub ingress should not start in relay mode");
        },
        async waitForDispatcher() {
          calls.push("wait");
        },
        async bootstrapDispatcher() {
          calls.push("bootstrap");
        },
        async serveDaemon() {
          calls.push("daemon");
        },
        logger: {
          log(message) {
            logs.push(message);
          }
        }
      }
    });

    expect(calls).toEqual(["wait", "bootstrap", "daemon"]);
    expect(logs.join("\n")).toContain("OpenTag is running in relay mode.");
    expect(logs.join("\n")).toContain("Local dispatcher: disabled");
    expect(logs.join("\n")).toContain("Security: only pair with a relay you operate or trust");
    expect(logs.join("\n")).toContain("GitHub webhook URL: https://relay.example/github/webhooks");
    expect(logs.join("\n")).toContain("GitHub webhook secret: the relay must verify the configured secret before creating runs.");
  });

  it("starts relay mode for GitLab without local dispatcher, local port checks, or local GitLab ingress", async () => {
    const built = gitlabConfig();
    built.runtime = {
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    };
    built.daemon.dispatcherUrl = "https://relay.example";
    const calls: string[] = [];
    const logs: string[] = [];

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {
          calls.push("ports");
        },
        startDispatcher() {
          calls.push("dispatcher");
          throw new Error("local dispatcher should not start in relay mode");
        },
        startGitLabIngress() {
          calls.push("gitlab-ingress");
          throw new Error("GitLab ingress should not start in relay mode");
        },
        async waitForDispatcher() {
          calls.push("wait");
        },
        async bootstrapDispatcher() {
          calls.push("bootstrap");
        },
        async serveDaemon() {
          calls.push("daemon");
        },
        logger: {
          log(message) {
            logs.push(message);
          }
        }
      }
    });

    expect(calls).toEqual(["wait", "bootstrap", "daemon"]);
    expect(logs.join("\n")).toContain("OpenTag is running in relay mode.");
    expect(logs.join("\n")).toContain("GitLab webhook URL: https://relay.example/gitlab/webhooks");
    expect(logs.join("\n")).toContain("GitLab webhook secret: the relay must verify X-Gitlab-Token before creating runs.");
  });

  it("refuses public HTTP relay configs before connecting", async () => {
    const built = githubConfig();
    built.runtime = {
      mode: "relay",
      relayUrl: "http://relay.example",
      relayProvider: "custom"
    };
    built.daemon.dispatcherUrl = "http://relay.example";
    const calls: string[] = [];

    await expect(
      startFromConfig({
        config: built,
        configPath: "/tmp/opentag/config.json",
        signal: abortedSignal(),
        listenForProcessSignals: false,
        dependencies: {
          async waitForDispatcher() {
            calls.push("wait");
          },
          logger: {
            log() {}
          }
        }
      })
    ).rejects.toThrow("Relay URL must use HTTPS unless it points to localhost for local testing.");
    expect(calls).toEqual([]);
  });

  it("keeps local mode on the local dispatcher and platform ingress path", async () => {
    const built = config();
    const calls: string[] = [];
    const dispatcherHandle = {
      url: "http://localhost:3030",
      server: {},
      async close() {
        calls.push("dispatcher.close");
      }
    } as ReturnType<NonNullable<StartRuntimeDependencies["startDispatcher"]>>;

    await startFromConfig({
      config: built,
      configPath: "/tmp/opentag/config.json",
      signal: abortedSignal(),
      listenForProcessSignals: false,
      dependencies: {
        async assertStartPortsAvailable() {
          calls.push("ports");
        },
        startDispatcher() {
          calls.push("dispatcher");
          return dispatcherHandle;
        },
        async waitForDispatcher() {
          calls.push("wait");
        },
        async bootstrapDispatcher() {
          calls.push("bootstrap");
        },
        async serveDaemon() {
          calls.push("daemon");
        },
        startLarkIngress() {
          calls.push("lark-ingress");
          return {
            startPromise: new Promise<void>(() => {}),
            async close() {
              calls.push("lark.close");
            }
          };
        },
        logger: {
          log() {}
        }
      }
    });

    expect(calls.slice(0, 2)).toEqual(["ports", "dispatcher"]);
    expect(calls).toEqual(expect.arrayContaining(["wait", "bootstrap", "daemon", "lark-ingress", "lark.close", "dispatcher.close"]));
  });

  it("fails clearly for relay mode platform ingress that is not supported in the MVP", async () => {
    const built = config();
    built.runtime = {
      mode: "relay",
      relayUrl: "https://relay.example",
      relayProvider: "custom"
    };
    built.daemon.dispatcherUrl = "https://relay.example";

    await expect(
      startFromConfig({
        config: built,
        configPath: "/tmp/opentag/config.json",
        signal: abortedSignal(),
        listenForProcessSignals: false,
        dependencies: {
          async waitForDispatcher() {
            throw new Error("health should not run before platform validation");
          },
          logger: {
            log() {}
          }
        }
      })
    ).rejects.toThrow("Relay mode currently supports GitHub/GitLab-backed ingress only.");
  });

  it("waits for dispatcher health instead of assuming the port is ready", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(
      waitForDispatcher({
        dispatcherUrl: "http://localhost:3030",
        fetchImpl,
        attempts: 2,
        delayMs: 1
      })
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("times out each dispatcher health attempt", async () => {
    const fetchImpl = hangingFetch();

    await expect(
      waitForDispatcher({
        dispatcherUrl: "http://localhost:3030",
        fetchImpl,
        attempts: 1,
        delayMs: 1,
        timeoutMs: 5
      })
    ).rejects.toThrow("Dispatcher did not become healthy at http://localhost:3030/healthz.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats Ctrl-C shutdown as normal but still rethrows subsystem failures", () => {
    expect(shouldRethrowAbortReason({ shutdownRequested: true, reason: new Error("AbortError") })).toBe(false);
    expect(shouldRethrowAbortReason({ shutdownRequested: false, reason: new Error("daemon crashed") })).toBe(true);
    expect(shouldRethrowAbortReason({ shutdownRequested: false, reason: "stopped" })).toBe(false);
  });
});
