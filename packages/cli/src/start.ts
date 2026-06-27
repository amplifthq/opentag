import { createServer } from "node:net";
import { createDispatcherAdminClient, type ChannelBindingInput, type RepositoryBindingConfig } from "@opentag/client";
import { startGitHubIngress, type GitHubIngressConfig, type GitHubIngressHandle } from "@opentag/github";
import { DEFAULT_AGENT_ID, startLarkIngress, type LarkIngressConfig, type LarkIngressHandle } from "@opentag/lark";
import {
  createDaemonRuntimeInput,
  normalizeChannelBindings,
  serveDaemon,
  startDispatcher,
  type LocalDispatcherRuntimeInput
} from "@opentag/local-runtime";
import {
  startSlackIngress,
  startSlackSocketModeIngress,
  type SlackEventsApiIngressConfig,
  type SlackIngressHandle,
  type SlackSocketModeIngressConfig,
  type SlackSocketModeIngressHandle
} from "@opentag/slack";
import { defaultConfigPath, ensurePrivateDirectory, readCliConfig, type OpenTagCliConfig } from "./config.js";
import { probeDispatcherHealth } from "./health.js";
import { githubLocalWebhookUrl, githubPublicWebhookUrlPlaceholder, githubWebhooksSettingsUrl } from "./platforms/github/display.js";
import { DEFAULT_GITHUB_WEBHOOK_PORT, DEFAULT_SLACK_EVENTS_PORT } from "./platforms/ports.js";

export type StartCommandOptions = {
  config?: string;
};

export type BootstrapClient = {
  registerRunner(name?: string): Promise<void>;
  bindRepository(binding: RepositoryBindingConfig): Promise<void>;
  bindChannel(binding: ChannelBindingInput): Promise<void>;
};

type PlatformIngressHandle =
  | { platform: "lark"; url?: string; handle: LarkIngressHandle }
  | { platform: "slack"; mode: "events_api"; url: string; handle: SlackIngressHandle }
  | { platform: "slack"; mode: "socket_mode"; handle: SlackSocketModeIngressHandle }
  | { platform: "github"; url: string; webhookPath: string; handle: GitHubIngressHandle };

function dispatcherPortFromUrl(dispatcherUrl: string): number {
  const url = new URL(dispatcherUrl);
  if (url.protocol !== "http:" || (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")) {
    throw new Error("opentag start currently supports only local http dispatcher URLs.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Dispatcher URL must not include a path, query, or hash.");
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Dispatcher URL has an invalid port: ${dispatcherUrl}`);
  }
  return port;
}

function requireLarkConfig(config: OpenTagCliConfig): NonNullable<OpenTagCliConfig["platforms"]["lark"]> {
  const lark = config.platforms.lark;
  if (!lark) {
    throw new Error("This config has no Lark platform config.");
  }
  return lark;
}

function requireSlackConfig(config: OpenTagCliConfig): NonNullable<OpenTagCliConfig["platforms"]["slack"]> {
  const slack = config.platforms.slack;
  if (!slack) {
    throw new Error("This config has no Slack platform config.");
  }
  return slack;
}

function requireGitHubConfig(config: OpenTagCliConfig): NonNullable<OpenTagCliConfig["platforms"]["github"]> {
  const github = config.platforms.github;
  if (!github) {
    throw new Error("This config has no GitHub platform config.");
  }
  return github;
}

function hasStartablePlatform(config: OpenTagCliConfig): boolean {
  return Boolean(config.platforms.lark || config.platforms.slack || config.platforms.github);
}

type LocalPortCheck = {
  label: string;
  port: number;
  fix: string;
};

function localStartPortChecks(config: OpenTagCliConfig): LocalPortCheck[] {
  const checks: LocalPortCheck[] = [
    {
      label: "dispatcher",
      port: dispatcherPortFromUrl(config.daemon.dispatcherUrl),
      fix: "Change daemon.dispatcherUrl in the OpenTag config."
    }
  ];
  const slack = config.platforms.slack;
  if (slack && slackModeFromCliConfig(config) === "events_api") {
    checks.push({
      label: "Slack Events API",
      port: slack.port ?? DEFAULT_SLACK_EVENTS_PORT,
      fix: "Run `opentag setup --platform slack --slack-mode events_api --slack-port <port> --force`, or edit platforms.slack.port in the OpenTag config."
    });
  }
  const github = config.platforms.github;
  if (github) {
    checks.push({
      label: "GitHub local webhook",
      port: github.port ?? DEFAULT_GITHUB_WEBHOOK_PORT,
      fix: "Run `opentag setup --platform github --github-port <port> --force`, or edit platforms.github.port in the OpenTag config."
    });
  }
  return checks;
}

async function assertPortAvailable(check: LocalPortCheck): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            [
              `OpenTag cannot start ${check.label} because port ${check.port} is already in use.`,
              check.fix,
              `To inspect the current process: lsof -nP -iTCP:${check.port} -sTCP:LISTEN`
            ].join("\n")
          )
        );
        return;
      }
      reject(
        new Error(
          [`OpenTag cannot start ${check.label} on port ${check.port}: ${error.message}`, check.fix].join("\n")
        )
      );
    });
    // Tunnels commonly forward to localhost/127.0.0.1; this catches the real
    // collision even when another address family would still let Node listen.
    server.listen(check.port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
}

export async function assertStartPortsAvailable(config: OpenTagCliConfig): Promise<void> {
  const checks = localStartPortChecks(config);
  const seen = new Map<number, LocalPortCheck>();
  for (const check of checks) {
    const existing = seen.get(check.port);
    if (existing) {
      throw new Error(
        [
          `OpenTag cannot start because ${existing.label} and ${check.label} both use port ${check.port}.`,
          `${existing.label}: ${existing.fix}`,
          `${check.label}: ${check.fix}`
        ].join("\n")
      );
    }
    seen.set(check.port, check);
  }
  for (const check of checks) {
    await assertPortAvailable(check);
  }
}

export function dispatcherRuntimeInputFromCliConfig(config: OpenTagCliConfig): LocalDispatcherRuntimeInput {
  if (!hasStartablePlatform(config)) {
    throw new Error("This config has no startable platform. Run `opentag setup` and choose Lark, Slack, or GitHub.");
  }
  const lark = config.platforms.lark;
  const slack = config.platforms.slack;
  const github = config.platforms.github;
  if (github && !config.daemon.githubToken) {
    throw new Error("GitHub platform requires daemon.githubToken for callbacks.");
  }
  if (github && !config.daemon.preparePullRequestBranch && !config.daemon.allowAutoCreatePullRequest) {
    throw new Error(
      "GitHub platform requires daemon.preparePullRequestBranch=true unless legacy daemon.allowAutoCreatePullRequest is enabled. Run `opentag setup` and choose GitHub to update this config."
    );
  }
  return {
    port: dispatcherPortFromUrl(config.daemon.dispatcherUrl),
    databasePath: config.state.databasePath,
    ...(config.daemon.pairingToken ? { pairingToken: config.daemon.pairingToken } : {}),
    ...(config.daemon.githubToken ? { githubToken: config.daemon.githubToken } : {}),
    ...(lark
      ? {
          lark: {
            appId: lark.appId,
            appSecret: lark.appSecret,
            domain: lark.domain
          }
        }
      : {}),
    ...(slack ? { slackBotToken: slack.botToken } : {})
  };
}

function defaultRepoBindingFromConfig(config: OpenTagCliConfig): LarkIngressConfig["defaultRepoBinding"] {
  if (config.platforms.lark?.defaultProjectBinding === false) return undefined;
  if (config.daemon.repositories.length !== 1) return undefined;
  const repository = config.daemon.repositories[0];
  if (!repository) return undefined;
  return {
    repoProvider: repository.provider,
    owner: repository.owner,
    repo: repository.repo
  };
}

export function larkIngressConfigFromCliConfig(config: OpenTagCliConfig): LarkIngressConfig {
  const lark = requireLarkConfig(config);
  const defaultRepoBinding = defaultRepoBindingFromConfig(config);
  return {
    appId: lark.appId,
    appSecret: lark.appSecret,
    dispatcherUrl: config.daemon.dispatcherUrl,
    domain: lark.domain,
    agentId: DEFAULT_AGENT_ID,
    ...(config.daemon.pairingToken ? { dispatcherToken: config.daemon.pairingToken } : {}),
    ...(lark.botOpenId ? { botOpenId: lark.botOpenId } : {}),
    ...(defaultRepoBinding ? { defaultRepoBinding } : {})
  };
}

function slackModeFromCliConfig(config: OpenTagCliConfig): "socket_mode" | "events_api" {
  const slack = requireSlackConfig(config);
  return slack.mode ?? "events_api";
}

export function slackIngressConfigFromCliConfig(config: OpenTagCliConfig): SlackEventsApiIngressConfig {
  const slack = requireSlackConfig(config);
  if (!slack.signingSecret) {
    throw new Error("Slack Events API mode requires platforms.slack.signingSecret.");
  }
  return {
    signingSecret: slack.signingSecret,
    dispatcherUrl: config.daemon.dispatcherUrl,
    ...(config.daemon.pairingToken ? { dispatcherToken: config.daemon.pairingToken } : {}),
    ...(slack.appId ? { appId: slack.appId } : {}),
    ...(slack.port ? { port: slack.port } : {})
  };
}

export function slackSocketModeIngressConfigFromCliConfig(config: OpenTagCliConfig): SlackSocketModeIngressConfig {
  const slack = requireSlackConfig(config);
  if (!slack.appToken) {
    throw new Error("Slack Socket Mode requires platforms.slack.appToken.");
  }
  return {
    appToken: slack.appToken,
    dispatcherUrl: config.daemon.dispatcherUrl,
    ...(config.daemon.pairingToken ? { dispatcherToken: config.daemon.pairingToken } : {}),
    ...(slack.appId ? { appId: slack.appId } : {})
  };
}

export function githubIngressConfigFromCliConfig(config: OpenTagCliConfig): GitHubIngressConfig {
  const github = requireGitHubConfig(config);
  return {
    webhookSecret: github.webhookSecret,
    dispatcherUrl: config.daemon.dispatcherUrl,
    ...(config.daemon.pairingToken ? { dispatcherToken: config.daemon.pairingToken } : {}),
    port: github.port ?? DEFAULT_GITHUB_WEBHOOK_PORT,
    ...(github.webhookPath ? { webhookPath: github.webhookPath } : {})
  };
}

export async function bootstrapLocalDispatcher(config: OpenTagCliConfig, client?: BootstrapClient): Promise<void> {
  const admin =
    client ??
    createDispatcherAdminClient({
      dispatcherUrl: config.daemon.dispatcherUrl,
      runnerId: config.daemon.runnerId,
      ...(config.daemon.pairingToken ? { pairingToken: config.daemon.pairingToken } : {})
    });

  await admin.registerRunner(config.daemon.runnerId);
  for (const repository of config.daemon.repositories) {
    await admin.bindRepository({
      provider: repository.provider,
      owner: repository.owner,
      repo: repository.repo,
      checkoutPath: repository.checkoutPath,
      ...(repository.defaultExecutor ? { defaultExecutor: repository.defaultExecutor } : {}),
      ...(repository.baseBranch ? { baseBranch: repository.baseBranch } : {}),
      ...(repository.pushRemote ? { pushRemote: repository.pushRemote } : {}),
      ...(repository.worktreeRoot ? { worktreeRoot: repository.worktreeRoot } : {}),
      ...(repository.keepWorktree ? { keepWorktree: repository.keepWorktree } : {})
    });
  }
  for (const binding of normalizeChannelBindings(config.daemon)) {
    await admin.bindChannel({
      provider: binding.provider,
      accountId: binding.accountId,
      conversationId: binding.conversationId,
      repoProvider: binding.repoProvider,
      owner: binding.owner,
      repo: binding.repo,
      ...(binding.metadata ? { metadata: binding.metadata } : {})
    });
  }
}

export async function waitForDispatcher(input: {
  dispatcherUrl: string;
  fetchImpl?: typeof fetch;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
}): Promise<void> {
  const attempts = input.attempts ?? 60;
  const delayMs = input.delayMs ?? 500;
  const timeoutMs = input.timeoutMs ?? 1_000;
  const healthUrl = `${input.dispatcherUrl.replace(/\/$/, "")}/healthz`;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const healthy = await probeDispatcherHealth({
      dispatcherUrl: input.dispatcherUrl,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      timeoutMs
    });
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Dispatcher did not become healthy at ${healthUrl}.`);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function shouldRethrowAbortReason(input: { shutdownRequested: boolean; reason: unknown }): boolean {
  return !input.shutdownRequested && input.reason instanceof Error;
}

export async function runStartCommand(options: StartCommandOptions): Promise<void> {
  const configPath = options.config ?? defaultConfigPath();
  const config = readCliConfig(configPath);

  ensurePrivateDirectory(config.state.directory);
  ensurePrivateDirectory(config.state.worktreeRoot);
  await assertStartPortsAvailable(config);

  const abortController = new AbortController();
  const dispatcher = startDispatcher(dispatcherRuntimeInputFromCliConfig(config));
  const ingresses: PlatformIngressHandle[] = [];
  let shutdownRequested = false;

  const onSignal = () => {
    shutdownRequested = true;
    abortController.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await waitForDispatcher({ dispatcherUrl: config.daemon.dispatcherUrl });
    await bootstrapLocalDispatcher(config);

    const daemonPromise = serveDaemon({
      ...createDaemonRuntimeInput(config.daemon),
      signal: abortController.signal
    });
    if (config.platforms.lark) {
      const handle = startLarkIngress(larkIngressConfigFromCliConfig(config));
      ingresses.push({ platform: "lark", handle });
      handle.startPromise.catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          abortController.abort(error);
        }
      });
    }
    if (config.platforms.slack) {
      if (slackModeFromCliConfig(config) === "socket_mode") {
        const handle = startSlackSocketModeIngress(slackSocketModeIngressConfigFromCliConfig(config));
        ingresses.push({ platform: "slack", mode: "socket_mode", handle });
        handle.startPromise.catch((error: unknown) => {
          if (!abortController.signal.aborted) {
            abortController.abort(error);
          }
        });
      } else {
        const handle = startSlackIngress(slackIngressConfigFromCliConfig(config));
        ingresses.push({ platform: "slack", mode: "events_api", url: handle.url, handle });
      }
    }
    if (config.platforms.github) {
      const handle = startGitHubIngress(githubIngressConfigFromCliConfig(config));
      ingresses.push({ platform: "github", url: handle.url, webhookPath: handle.webhookPath, handle });
    }
    daemonPromise.catch((error: unknown) => {
      if (!abortController.signal.aborted) {
        abortController.abort(error);
      }
    });

    console.log("OpenTag is running.");
    console.log(`Config: ${configPath}`);
    console.log(`Dispatcher: ${config.daemon.dispatcherUrl}`);
    for (const ingress of ingresses) {
      if (ingress.platform === "slack") {
        const slack = config.platforms.slack!;
        if (ingress.mode === "socket_mode") {
          console.log("Slack: using Socket Mode");
          console.log(`Slack channel binding: ${slack.teamId}/${slack.channelId}`);
          console.log("Before testing, invite the Slack app to that channel with /invite @your app name.");
        } else {
          console.log(`Slack Events: ${ingress.url}/slack/events`);
          console.log(`Slack channel binding: ${slack.teamId}/${slack.channelId}`);
          console.log("Before testing, invite the Slack app to that channel with /invite @your app name.");
        }
      } else if (ingress.platform === "github") {
        const github = config.platforms.github!;
        console.log(`GitHub local webhook: ${githubLocalWebhookUrl({ port: github.port, webhookPath: ingress.webhookPath })}`);
        console.log(`GitHub Payload URL: ${githubPublicWebhookUrlPlaceholder(ingress.webhookPath)}`);
        console.log(`GitHub settings: ${githubWebhooksSettingsUrl(github)}`);
        console.log(`Tunnel example: ngrok http ${github.port ?? DEFAULT_GITHUB_WEBHOOK_PORT}`);
      } else {
        console.log("Lark / Feishu: connected through Personal Agent long connection");
      }
    }
    console.log("Press Ctrl-C to stop.");

    await waitForAbort(abortController.signal);
    const reason = abortController.signal.reason;
    if (shouldRethrowAbortReason({ shutdownRequested, reason })) {
      throw reason;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    abortController.abort();
    await Promise.allSettled([...ingresses].reverse().map((ingress) => ingress.handle.close()));
    await dispatcher.close();
  }
}
