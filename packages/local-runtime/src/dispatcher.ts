import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import {
  createCompositeCallbackSink,
  createCompositeSourceReceiptSink,
  createDiscordCallbackSink,
  createDispatcherApp,
  createGitHubCallbackSink,
  createGitLabCallbackSink,
  createLarkCallbackSink,
  createLarkSourceReceiptSink,
  createSlackCallbackSink,
  createSlackSourceReceiptSink,
  createTelegramCallbackSink
} from "@opentag/dispatcher";
import type { DispatcherRateLimitOptions } from "@opentag/dispatcher";
import { createDiscordInteractionsApp } from "@opentag/discord";
import { createGitLabWebhookApp } from "@opentag/gitlab";

export type LocalDispatcherRuntimeInput = {
  port: number;
  databasePath: string;
  pairingToken?: string;
  runnerToken?: string;
  runnerTokens?: string[];
  revokedRunnerTokenFingerprints?: string[];
  /**
   * Backward-compatible GitHub token. When specific callback/apply tokens are
   * omitted, this token is used for both callback delivery and direct apply.
   */
  githubToken?: string;
  githubCallbackToken?: string;
  githubApplyToken?: string | null;
  gitlabToken?: string;
  gitlabBaseUrl?: string;
  gitlabWebhookSecret?: string;
  gitlabWebhookPath?: string;
  lark?: {
    appId: string;
    appSecret: string;
    domain: "lark" | "feishu";
  };
  slackBotToken?: string;
  slackBotTokensByAgentId?: Record<string, string>;
  telegramBotToken?: string;
  telegramBotTokensByAgentId?: Record<string, string>;
  discordPublicKey?: string;
  discordBotToken?: string;
  discordWebhookPath?: string;
  maxRequestBodyBytes?: number;
  rateLimit?: DispatcherRateLimitOptions | false;
};

export type DispatcherRuntimeHardeningInput = Pick<LocalDispatcherRuntimeInput, "maxRequestBodyBytes" | "rateLimit">;

export type LocalDispatcherHandle = {
  url: string;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
};

type ClosableServer = ReturnType<typeof serve> & {
  closeAllConnections?: () => void;
  closeIdleConnections?: () => void;
};

function parseAgentTokenMap(name: string, raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Value is not a JSON object");
    }
    const entries = Object.entries(parsed);
    if (entries.length === 0) return undefined;
    for (const [agentId, token] of entries) {
      if (!agentId.trim()) {
        throw new Error("Agent id must be a non-empty string");
      }
      if (typeof token !== "string" || !token.trim()) {
        throw new Error(`Token for agent ${agentId} must be a non-empty string`);
      }
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch (error) {
    throw new Error(`Failed to parse ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseStringList(name: string, raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Value is not a JSON array");
    }
    const values = parsed.map((value, index) => {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Entry ${index} must be a non-empty string`);
      }
      return value.trim();
    });
    return values.length ? values : undefined;
  } catch (error) {
    throw new Error(`Failed to parse ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function larkDomainFromEnv(value: string | undefined): "lark" | "feishu" | undefined {
  if (value === undefined) return undefined;
  if (value === "lark" || value === "feishu") return value;
  throw new Error("LARK_DOMAIN must be either lark or feishu");
}

function parsePositiveIntegerEnv(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${raw}`);
  }
  return value;
}

function parseBooleanEnv(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be either true or false, received ${raw}`);
}

function rateLimitFromEnv(env: NodeJS.ProcessEnv): DispatcherRateLimitOptions | false | undefined {
  const disabled = parseBooleanEnv("OPENTAG_RATE_LIMIT_DISABLED", env.OPENTAG_RATE_LIMIT_DISABLED);
  const windowMs = parsePositiveIntegerEnv("OPENTAG_RATE_LIMIT_WINDOW_MS", env.OPENTAG_RATE_LIMIT_WINDOW_MS);
  const maxRequests = parsePositiveIntegerEnv("OPENTAG_RATE_LIMIT_MAX_REQUESTS", env.OPENTAG_RATE_LIMIT_MAX_REQUESTS);
  if (disabled === true) {
    if (windowMs !== undefined || maxRequests !== undefined) {
      throw new Error("OPENTAG_RATE_LIMIT_DISABLED cannot be true when OPENTAG_RATE_LIMIT_WINDOW_MS or OPENTAG_RATE_LIMIT_MAX_REQUESTS is set.");
    }
    return false;
  }
  if (windowMs === undefined && maxRequests === undefined) return undefined;
  if (windowMs === undefined || maxRequests === undefined) {
    throw new Error("OPENTAG_RATE_LIMIT_WINDOW_MS and OPENTAG_RATE_LIMIT_MAX_REQUESTS must be configured together.");
  }
  return { windowMs, maxRequests };
}

export function dispatcherRuntimeHardeningInputFromEnv(env: NodeJS.ProcessEnv): DispatcherRuntimeHardeningInput {
  const maxRequestBodyBytes = parsePositiveIntegerEnv("OPENTAG_MAX_REQUEST_BODY_BYTES", env.OPENTAG_MAX_REQUEST_BODY_BYTES);
  const rateLimit = rateLimitFromEnv(env);
  return {
    ...(maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes } : {}),
    ...(rateLimit !== undefined ? { rateLimit } : {})
  };
}

export function dispatcherRuntimeInputFromEnv(env: NodeJS.ProcessEnv): LocalDispatcherRuntimeInput {
  const port = Number(env.PORT ?? "3030");
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, received ${env.PORT ?? "3030"}`);
  }

  const larkDomain = larkDomainFromEnv(env.LARK_DOMAIN);
  if (Boolean(env.LARK_APP_ID) !== Boolean(env.LARK_APP_SECRET)) {
    throw new Error("LARK_APP_ID and LARK_APP_SECRET must be configured together.");
  }
  const slackBotTokensByAgentId = parseAgentTokenMap("OPENTAG_SLACK_BOT_TOKENS_JSON", env.OPENTAG_SLACK_BOT_TOKENS_JSON);
  const runnerTokens = parseStringList("OPENTAG_RUNNER_TOKENS_JSON", env.OPENTAG_RUNNER_TOKENS_JSON);
  const revokedRunnerTokenFingerprints = parseStringList(
    "OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON",
    env.OPENTAG_REVOKED_RUNNER_TOKEN_FINGERPRINTS_JSON
  );
  const telegramBotTokensByAgentId = parseAgentTokenMap(
    "OPENTAG_TELEGRAM_BOT_TOKENS_JSON",
    env.OPENTAG_TELEGRAM_BOT_TOKENS_JSON
  );
  const hardening = dispatcherRuntimeHardeningInputFromEnv(env);

  const githubApplyToken =
    env.OPENTAG_GITHUB_APPLY_DISABLED === "true"
      ? null
      : env.OPENTAG_GITHUB_APPLY_TOKEN
        ? env.OPENTAG_GITHUB_APPLY_TOKEN
        : undefined;

  return {
    port,
    databasePath: env.OPENTAG_DATABASE_PATH ?? "opentag.db",
    ...(env.OPENTAG_PAIRING_TOKEN ? { pairingToken: env.OPENTAG_PAIRING_TOKEN } : {}),
    ...(env.OPENTAG_RUNNER_TOKEN ? { runnerToken: env.OPENTAG_RUNNER_TOKEN } : {}),
    ...(runnerTokens ? { runnerTokens } : {}),
    ...(revokedRunnerTokenFingerprints ? { revokedRunnerTokenFingerprints } : {}),
    ...(env.OPENTAG_GITHUB_TOKEN ? { githubToken: env.OPENTAG_GITHUB_TOKEN } : {}),
    ...(env.OPENTAG_GITHUB_CALLBACK_TOKEN ? { githubCallbackToken: env.OPENTAG_GITHUB_CALLBACK_TOKEN } : {}),
    ...(githubApplyToken !== undefined ? { githubApplyToken } : {}),
    ...(env.OPENTAG_GITLAB_TOKEN ? { gitlabToken: env.OPENTAG_GITLAB_TOKEN } : {}),
    ...(env.OPENTAG_GITLAB_BASE_URL ? { gitlabBaseUrl: env.OPENTAG_GITLAB_BASE_URL } : {}),
    ...(env.OPENTAG_GITLAB_WEBHOOK_SECRET ? { gitlabWebhookSecret: env.OPENTAG_GITLAB_WEBHOOK_SECRET } : {}),
    ...(env.OPENTAG_GITLAB_WEBHOOK_PATH ? { gitlabWebhookPath: env.OPENTAG_GITLAB_WEBHOOK_PATH } : {}),
    ...(env.LARK_APP_ID && env.LARK_APP_SECRET
      ? {
          lark: {
            appId: env.LARK_APP_ID,
            appSecret: env.LARK_APP_SECRET,
            domain: larkDomain ?? "lark"
          }
        }
      : {}),
    ...(env.OPENTAG_SLACK_BOT_TOKEN ? { slackBotToken: env.OPENTAG_SLACK_BOT_TOKEN } : {}),
    ...(slackBotTokensByAgentId ? { slackBotTokensByAgentId } : {}),
    ...(env.OPENTAG_TELEGRAM_BOT_TOKEN ? { telegramBotToken: env.OPENTAG_TELEGRAM_BOT_TOKEN } : {}),
    ...(telegramBotTokensByAgentId ? { telegramBotTokensByAgentId } : {}),
    ...(env.OPENTAG_DISCORD_PUBLIC_KEY ? { discordPublicKey: env.OPENTAG_DISCORD_PUBLIC_KEY } : {}),
    ...(env.OPENTAG_DISCORD_BOT_TOKEN ? { discordBotToken: env.OPENTAG_DISCORD_BOT_TOKEN } : {}),
    ...(env.OPENTAG_DISCORD_WEBHOOK_PATH ? { discordWebhookPath: env.OPENTAG_DISCORD_WEBHOOK_PATH } : {}),
    ...hardening
  };
}

export function startDispatcher(input: LocalDispatcherRuntimeInput): LocalDispatcherHandle {
  const githubCallbackToken = input.githubCallbackToken ?? input.githubToken;
  const githubApplyToken = input.githubApplyToken === null ? undefined : (input.githubApplyToken ?? input.githubToken);

  const app = createDispatcherApp({
    databasePath: input.databasePath,
    ...(input.pairingToken ? { pairingToken: input.pairingToken } : {}),
    ...(input.runnerToken ? { runnerToken: input.runnerToken } : {}),
    ...(input.runnerTokens ? { runnerTokens: input.runnerTokens } : {}),
    ...(input.revokedRunnerTokenFingerprints ? { revokedRunnerTokenFingerprints: input.revokedRunnerTokenFingerprints } : {}),
    ...(input.maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes: input.maxRequestBodyBytes } : {}),
    ...(input.rateLimit !== undefined ? { rateLimit: input.rateLimit } : {}),
    ...(githubApplyToken ? { githubApply: { token: githubApplyToken } } : {}),
    ...(input.gitlabToken
      ? {
          gitlabApply: {
            token: input.gitlabToken,
            ...(input.gitlabBaseUrl ? { baseUrl: input.gitlabBaseUrl } : {})
          }
        }
      : {}),
    sourceReceiptSink: createCompositeSourceReceiptSink([
      createSlackSourceReceiptSink({
        ...(input.slackBotToken ? { botToken: input.slackBotToken } : {}),
        ...(input.slackBotTokensByAgentId ? { botTokensByAgentId: input.slackBotTokensByAgentId } : {})
      }),
      createLarkSourceReceiptSink({
        ...(input.lark
          ? {
              appId: input.lark.appId,
              appSecret: input.lark.appSecret,
              domain: input.lark.domain
            }
          : {})
      })
    ]),
    callbackSink: createCompositeCallbackSink([
      createGitHubCallbackSink({
        ...(githubCallbackToken ? { token: githubCallbackToken } : {})
      }),
      createGitLabCallbackSink({
        ...(input.gitlabToken ? { token: input.gitlabToken } : {})
      }),
      createSlackCallbackSink({
        ...(input.slackBotToken ? { botToken: input.slackBotToken } : {}),
        ...(input.slackBotTokensByAgentId ? { botTokensByAgentId: input.slackBotTokensByAgentId } : {})
      }),
      createLarkCallbackSink({
        ...(input.lark
          ? {
              appId: input.lark.appId,
              appSecret: input.lark.appSecret,
              domain: input.lark.domain
            }
          : {})
      }),
      createTelegramCallbackSink({
        ...(input.telegramBotToken ? { botToken: input.telegramBotToken } : {}),
        ...(input.telegramBotTokensByAgentId ? { botTokensByAgentId: input.telegramBotTokensByAgentId } : {})
      }),
      createDiscordCallbackSink({
        ...(input.discordBotToken ? { token: input.discordBotToken } : {})
      })
    ])
  });

  if (input.gitlabWebhookSecret) {
    if (input.port === 0) {
      throw new Error("GitLab relay webhook mount requires a fixed dispatcher port.");
    }
    const dispatcherClient = createOpenTagClient({
      dispatcherUrl: `http://127.0.0.1:${input.port}`,
      ...(input.pairingToken ? { pairingToken: input.pairingToken } : {})
    });
    app.route(
      "/",
      createGitLabWebhookApp({
        webhookSecret: input.gitlabWebhookSecret,
        ...(input.gitlabBaseUrl ? { baseUrl: input.gitlabBaseUrl } : {}),
        ...(input.gitlabWebhookPath ? { webhookPath: input.gitlabWebhookPath } : {}),
        async createRun(event) {
          const runId = `run_${randomUUID()}`;
          const created = await dispatcherClient.createRun({ runId, event });
          return created.outcome === "run_created" ? { runId: created.run.id } : {};
        },
        async submitThreadAction(action) {
          await dispatcherClient.submitThreadAction(action);
        },
        now: () => new Date().toISOString()
      })
    );
  }

  if (input.discordPublicKey) {
    if (input.port === 0) {
      throw new Error("Discord interactions mount requires a fixed dispatcher port.");
    }
    const dispatcherClient = createOpenTagClient({
      dispatcherUrl: `http://127.0.0.1:${input.port}`,
      ...(input.pairingToken ? { pairingToken: input.pairingToken } : {})
    });
    app.route(
      "/",
      createDiscordInteractionsApp({
        publicKey: input.discordPublicKey,
        ...(input.discordWebhookPath ? { webhookPath: input.discordWebhookPath } : {}),
        async resolveChannelBinding({ applicationId, channelId }) {
          try {
            const { binding } = await dispatcherClient.getChannelBinding({
              provider: "discord",
              accountId: applicationId,
              conversationId: channelId
            });
            return {
              applicationId,
              channelId,
              owner: binding.owner,
              repo: binding.repo,
              ...(binding.repoProvider ? { repoProvider: binding.repoProvider } : {})
            };
          } catch {
            return null;
          }
        },
        async createRun(event) {
          const runId = `run_${randomUUID()}`;
          const created = await dispatcherClient.createRun({ runId, event });
          return created.outcome === "run_created" ? { runId: created.run.id } : {};
        },
        async submitThreadAction(action) {
          await dispatcherClient.submitThreadAction(action);
        },
        now: () => new Date().toISOString()
      })
    );
  }

  const server: ClosableServer = serve({
    fetch: app.fetch,
    port: input.port
  });

  return {
    url: `http://localhost:${input.port}`,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.closeIdleConnections?.();
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeAllConnections?.();
      });
    }
  };
}
