import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient, type ChannelRuntimeStatus } from "@opentag/client";
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
import { createDiscordInteractionsApp, startDiscordGateway } from "@opentag/discord";
import { createGitLabWebhookApp } from "@opentag/gitlab";
import {
  TELEGRAM_DOCTOR_TITLE,
  TELEGRAM_STATUS_TITLE,
  createTelegramEventsApp,
  createTelegramSendMessagePayload,
  type TelegramChannelBinding,
  type TelegramStopRunResult
} from "@opentag/telegram";
import {
  createDoctorSummaryPresentation,
  createSourceThreadStatusPresentation,
  renderOpenTagPresentationPlainText,
  type OpenTagSourceThreadQueuedFollowUp
} from "@opentag/core";

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
  telegramBots?: LocalTelegramBotConfig[];
  telegramSendTimeoutMs?: number;
  discordMode?: "gateway" | "webhook";
  discordPublicKey?: string;
  discordBotToken?: string;
  discordWebhookPath?: string;
  maxRequestBodyBytes?: number;
  rateLimit?: DispatcherRateLimitOptions | false;
};

export type LocalTelegramBotConfig = {
  mode?: "polling" | "webhook";
  botId: string;
  agentId: string;
  botUsername?: string;
  botToken?: string;
  bindingAdminUserIds?: string[];
  secretToken?: string;
  callbackUri?: string;
};

export type DispatcherRuntimeHardeningInput = Pick<LocalDispatcherRuntimeInput, "maxRequestBodyBytes" | "rateLimit">;

export type LocalDispatcherHandle = {
  url: string;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
};

type BackgroundHandle = {
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

function parseCsvList(raw: string | undefined): string[] | undefined {
  const items = raw
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function parseTelegramMode(name: string, raw: unknown): "polling" | "webhook" | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "polling" || raw === "webhook") return raw;
  throw new Error(`${name} must be polling or webhook`);
}

function parseDiscordMode(name: string, raw: unknown): "gateway" | "webhook" | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "gateway" || raw === "webhook") return raw;
  throw new Error(`${name} must be gateway or webhook`);
}

function telegramBotsFromEnv(env: NodeJS.ProcessEnv): LocalTelegramBotConfig[] | undefined {
  if (env.OPENTAG_TELEGRAM_BOTS_JSON) {
    try {
      const parsed = JSON.parse(env.OPENTAG_TELEGRAM_BOTS_JSON);
      if (!Array.isArray(parsed)) {
        throw new Error("Value is not a JSON array");
      }
      const bots = parsed.filter(
        (candidate): candidate is LocalTelegramBotConfig =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          (!("mode" in candidate) || candidate.mode === "polling" || candidate.mode === "webhook") &&
          typeof candidate.botId === "string" &&
          typeof candidate.agentId === "string" &&
          (!("botUsername" in candidate) || typeof candidate.botUsername === "string") &&
          (!("botToken" in candidate) || typeof candidate.botToken === "string") &&
          (!("bindingAdminUserIds" in candidate) || isStringArray(candidate.bindingAdminUserIds)) &&
          (!("secretToken" in candidate) || typeof candidate.secretToken === "string") &&
          (!("callbackUri" in candidate) || typeof candidate.callbackUri === "string")
      );
      return bots.length ? bots : undefined;
    } catch (error) {
      throw new Error(`Failed to parse OPENTAG_TELEGRAM_BOTS_JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!env.OPENTAG_TELEGRAM_BOT_ID) return undefined;
  const bindingAdminUserIds = parseCsvList(env.OPENTAG_TELEGRAM_BINDING_ADMIN_USER_IDS);
  const mode = parseTelegramMode("OPENTAG_TELEGRAM_MODE", env.OPENTAG_TELEGRAM_MODE);
  return [
    {
      ...(mode ? { mode } : {}),
      botId: env.OPENTAG_TELEGRAM_BOT_ID,
      agentId: env.OPENTAG_TELEGRAM_AGENT_ID ?? "opentag",
      ...(env.OPENTAG_TELEGRAM_BOT_USERNAME ? { botUsername: env.OPENTAG_TELEGRAM_BOT_USERNAME } : {}),
      ...(env.OPENTAG_TELEGRAM_BOT_TOKEN ? { botToken: env.OPENTAG_TELEGRAM_BOT_TOKEN } : {}),
      ...(bindingAdminUserIds ? { bindingAdminUserIds } : {}),
      ...(env.OPENTAG_TELEGRAM_SECRET_TOKEN ? { secretToken: env.OPENTAG_TELEGRAM_SECRET_TOKEN } : {}),
      ...(env.OPENTAG_TELEGRAM_CALLBACK_URI ? { callbackUri: env.OPENTAG_TELEGRAM_CALLBACK_URI } : {})
    }
  ];
}

function assertUniqueTelegramBotIds(bots: LocalTelegramBotConfig[] | undefined): void {
  if (!bots) return;
  const duplicates = bots.map((bot) => bot.botId).filter((botId, index, botIds) => botIds.indexOf(botId) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate Telegram botId entries are not allowed: ${[...new Set(duplicates)].join(", ")}`);
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

function formatProjectTarget(binding: TelegramChannelBinding): string {
  return `${binding.repoProvider ?? "github"}:${binding.owner}/${binding.repo}`;
}

function queuedFollowUpSummary(status: ChannelRuntimeStatus): OpenTagSourceThreadQueuedFollowUp[] {
  return status.queuedFollowUps.slice(0, 5).map((followUp) => ({
    id: followUp.id,
    status: followUp.status,
    ...(followUp.event.command.rawText ? { command: followUp.event.command.rawText } : {})
  }));
}

function formatTelegramRuntimeStatusText(input: {
  botId: string;
  chatId: string;
  binding: TelegramChannelBinding | null;
  status?: ChannelRuntimeStatus;
}): string {
  if (!input.binding) {
    return renderOpenTagPresentationPlainText(
      createSourceThreadStatusPresentation({
        title: TELEGRAM_STATUS_TITLE,
        sourceContainer: `telegram:${input.botId}/${input.chatId}`,
        bindingState: "unbound",
        nextAction: "Bind this Telegram chat to a Project Target before starting runs.",
        detailHint: "active run and queued follow-up status are unavailable until this chat is bound."
      })
    );
  }

  const status = input.status;
  return renderOpenTagPresentationPlainText(
    createSourceThreadStatusPresentation({
      title: TELEGRAM_STATUS_TITLE,
      sourceContainer: `telegram:${input.botId}/${input.chatId}`,
      projectTarget: formatProjectTarget(input.binding),
      bindingState: "bound",
      ...(status?.activeRun
        ? { activeRun: { id: status.activeRun.id, status: status.activeRun.status, updatedAt: status.activeRun.updatedAt } }
        : {}),
      ...(status?.activeEvent?.command.rawText ? { currentCommand: status.activeEvent.command.rawText } : {}),
      queuedFollowUps: status ? queuedFollowUpSummary(status) : [],
      queuedFollowUpsTotal: status?.queuedFollowUps.length ?? 0,
      nextAction: "send a follow-up in this chat, or check `opentag status --run <run_id>` locally for audit detail.",
      stopHint: status?.runTimeoutPolicy?.hardTimeoutMs
        ? `cancellation is explicit; hard timeout is ${status.runTimeoutPolicy.hardTimeoutMs}ms.`
        : "cancellation is explicit and is not reported as successful completion.",
      detailHint: "at most one run is active per Project Target + source thread; new same-thread requests queue behind it."
    })
  );
}

function formatTelegramDoctorText(input: { botId: string; chatId: string; binding: TelegramChannelBinding | null }): string {
  return renderOpenTagPresentationPlainText(
    createDoctorSummaryPresentation({
      title: TELEGRAM_DOCTOR_TITLE,
      checks: [
        { status: "ok", name: "Source container", message: `telegram:${input.botId}/${input.chatId}` },
        {
          status: input.binding ? "ok" : "warn",
          name: "Project Target",
          message: input.binding ? formatProjectTarget(input.binding) : "not bound"
        },
        { status: "ok", name: "Secrets", message: "redacted. Use env/file/keychain SecretRef config and never paste tokens into Telegram." },
        {
          status: "warn",
          name: "Runtime readiness",
          message: "check `opentag service status` locally; launchd running is not the same as connector ready."
        },
        { status: "ok", name: "Source-thread output", message: "concise final replies by default; detailed process stays in audit/status." }
      ]
    })
  );
}

function mapTelegramStopError(input: { error: unknown; runId?: string }): TelegramStopRunResult | null {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  if (message.includes("run_already_terminal")) {
    return { outcome: "already_terminal", runId: input.runId ?? "active run" };
  }
  if (message.includes("run_not_found") || message.includes("active_run_not_found") || message.includes("channel_binding_not_found")) {
    return input.runId ? { outcome: "not_found", runId: input.runId } : { outcome: "not_found" };
  }
  return null;
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
  const telegramBots = telegramBotsFromEnv(env);
  assertUniqueTelegramBotIds(telegramBots);
  const telegramSendTimeoutMs = parsePositiveIntegerEnv("OPENTAG_TELEGRAM_SEND_TIMEOUT_MS", env.OPENTAG_TELEGRAM_SEND_TIMEOUT_MS);
  const discordMode = parseDiscordMode("OPENTAG_DISCORD_MODE", env.OPENTAG_DISCORD_MODE);
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
    ...(telegramBots ? { telegramBots } : {}),
    ...(telegramSendTimeoutMs ? { telegramSendTimeoutMs } : {}),
    ...(discordMode ? { discordMode } : {}),
    ...(env.OPENTAG_DISCORD_PUBLIC_KEY ? { discordPublicKey: env.OPENTAG_DISCORD_PUBLIC_KEY } : {}),
    ...(env.OPENTAG_DISCORD_BOT_TOKEN ? { discordBotToken: env.OPENTAG_DISCORD_BOT_TOKEN } : {}),
    ...(env.OPENTAG_DISCORD_WEBHOOK_PATH ? { discordWebhookPath: env.OPENTAG_DISCORD_WEBHOOK_PATH } : {}),
    ...hardening
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function telegramBotApiRequest(input: {
  botToken: string;
  method: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${input.botToken}/${input.method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.body),
    signal: input.signal
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram ${input.method} failed: ${response.status} ${payload.description ?? "unknown_error"}`);
  }
  return payload.result;
}

function startTelegramPolling(input: {
  bot: LocalTelegramBotConfig;
  app: ReturnType<typeof createTelegramEventsApp>;
  logError(message: string, error?: unknown): void;
  reconnectDelayMs?: number;
}): BackgroundHandle & { startPromise: Promise<void> } {
  const botToken = input.bot.botToken;
  if (!botToken) {
    throw new Error(`Telegram polling mode requires botToken for bot ${input.bot.botId}.`);
  }
  const reconnectDelayMs = input.reconnectDelayMs ?? 1_000;
  let closed = false;
  let activeAbortController: AbortController | undefined;

  async function withTelegramSignal<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    activeAbortController = controller;
    try {
      return await work(controller.signal);
    } finally {
      if (activeAbortController === controller) {
        activeAbortController = undefined;
      }
    }
  }

  const startPromise = (async () => {
    let offset: number | undefined;
    let webhookCleared = false;
    while (!closed) {
      try {
        if (!webhookCleared) {
          await withTelegramSignal((signal) =>
            telegramBotApiRequest({
              botToken,
              method: "deleteWebhook",
              body: { drop_pending_updates: false },
              signal
            })
          );
          webhookCleared = true;
        }

        const result = await withTelegramSignal((signal) =>
          telegramBotApiRequest({
            botToken,
            method: "getUpdates",
            body: {
              timeout: 25,
              ...(offset !== undefined ? { offset } : {}),
              allowed_updates: ["message"]
            },
            signal
          })
        );
        const updates = Array.isArray(result) ? result : [];
        for (const update of updates) {
          if (closed) break;
          if (update && typeof update === "object" && typeof (update as { update_id?: unknown }).update_id === "number") {
            offset = (update as { update_id: number }).update_id + 1;
          }
          const response = await input.app.request(`/telegram/events/${encodeURIComponent(input.bot.botId)}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(input.bot.secretToken ? { "x-telegram-bot-api-secret-token": input.bot.secretToken } : {})
            },
            body: JSON.stringify(update)
          });
          if (!response.ok) {
            input.logError(`[telegram] polling update handler failed for bot ${input.bot.botId}: ${response.status} ${await response.text()}`);
          }
        }
      } catch (error) {
        if (!closed) {
          input.logError(`[telegram] polling failed for bot ${input.bot.botId}, retrying:`, error);
          await wait(reconnectDelayMs);
        }
      }
    }
  })();

  return {
    startPromise,
    async close() {
      closed = true;
      activeAbortController?.abort();
      await startPromise.catch(() => undefined);
    }
  };
}

export function startDispatcher(input: LocalDispatcherRuntimeInput): LocalDispatcherHandle {
  const githubCallbackToken = input.githubCallbackToken ?? input.githubToken;
  const githubApplyToken = input.githubApplyToken === null ? undefined : (input.githubApplyToken ?? input.githubToken);
  const backgroundHandles: BackgroundHandle[] = [];

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

  if (input.telegramBots?.length) {
    if (input.port === 0) {
      throw new Error("Telegram ingress requires a fixed dispatcher port.");
    }
    assertUniqueTelegramBotIds(input.telegramBots);
    const telegramWebhookBots = input.telegramBots.filter((bot) => bot.mode === "webhook");
    const telegramPollingBots = input.telegramBots.filter((bot) => (bot.mode ?? "polling") === "polling");
    const dispatcherClient = createOpenTagClient({
      dispatcherUrl: `http://127.0.0.1:${input.port}`,
      ...(input.pairingToken ? { pairingToken: input.pairingToken } : {})
    });
    const telegramSendTimeoutMs = input.telegramSendTimeoutMs ?? 10_000;

    const telegramEventsAppInput = (telegramBots: LocalTelegramBotConfig[]): Parameters<typeof createTelegramEventsApp>[0] => {
      const telegramBotTokenById = new Map(telegramBots.flatMap((bot) => (bot.botToken ? [[bot.botId, bot.botToken] as const] : [])));
      return {
        telegramBots,
        ...(input.maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes: input.maxRequestBodyBytes } : {}),
        async resolveChannelBinding(lookup) {
          try {
            const { binding } = await dispatcherClient.getChannelBinding({
              provider: "telegram",
              accountId: lookup.botId,
              conversationId: lookup.chatId
            });
            return {
              botId: binding.accountId,
              chatId: binding.conversationId,
              owner: binding.owner,
              repo: binding.repo,
              ...(binding.repoProvider ? { repoProvider: binding.repoProvider } : {})
            };
          } catch (error) {
            if (error instanceof Error && error.message.includes("channel_binding_not_found")) {
              return null;
            }
            throw error;
          }
        },
        async createRun(event) {
          const runId = `run_${randomUUID()}`;
          await dispatcherClient.createRun({ runId, event });
          return { runId };
        },
        async bindChannel(binding) {
          await dispatcherClient.bindChannel({
            provider: "telegram",
            accountId: binding.botId,
            conversationId: binding.chatId,
            repoProvider: binding.repoProvider,
            owner: binding.owner,
            repo: binding.repo
          });
        },
        async unbindChannel(binding) {
          await dispatcherClient.unbindChannel({
            provider: "telegram",
            accountId: binding.botId,
            conversationId: binding.chatId
          });
        },
        canManageBinding(binding) {
          if (binding.chatType === "private") return true;
          const bot = telegramBots.find((candidate) => candidate.botId === binding.botId);
          return Boolean(bot?.bindingAdminUserIds?.includes(binding.userId));
        },
        async status(statusInput) {
          if (!statusInput.binding) {
            return formatTelegramRuntimeStatusText(statusInput);
          }
          const status = await dispatcherClient.getChannelRuntimeStatus({
            provider: "telegram",
            accountId: statusInput.botId,
            conversationId: statusInput.chatId
          });
          return formatTelegramRuntimeStatusText({ ...statusInput, status });
        },
        async doctor(doctorInput) {
          return formatTelegramDoctorText(doctorInput);
        },
        async stopRun(stopInput) {
          try {
            const result = stopInput.runId
              ? await dispatcherClient.cancelRun({
                  runId: stopInput.runId,
                  reason: "Stop requested from Telegram.",
                  requestedBy: stopInput.requestedBy
                })
              : await dispatcherClient.cancelActiveChannelRun({
                  provider: "telegram",
                  accountId: stopInput.botId,
                  conversationId: stopInput.chatId,
                  reason: "Stop requested from Telegram.",
                  requestedBy: stopInput.requestedBy
                });
            return { outcome: "cancelled", runId: result.run.id };
          } catch (error) {
            const mapped = mapTelegramStopError({ error, ...(stopInput.runId ? { runId: stopInput.runId } : {}) });
            if (mapped) return mapped;
            throw error;
          }
        },
        async recordControlPlaneEvent(event) {
          await dispatcherClient.recordControlPlaneEvent(event);
        },
        async reply(replyInput) {
          const botToken = telegramBotTokenById.get(replyInput.botId);
          if (!botToken) return;
          const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              createTelegramSendMessagePayload({
                chatId: replyInput.chatId,
                text: replyInput.text,
                replyToMessageId: replyInput.messageId,
                ...(replyInput.messageThreadId ? { messageThreadId: replyInput.messageThreadId } : {})
              })
            ),
            signal: AbortSignal.timeout(telegramSendTimeoutMs)
          });
          if (!response.ok) {
            throw new Error(`Telegram self-service reply failed with HTTP ${response.status}`);
          }
        },
        now: () => new Date().toISOString()
      };
    };

    if (telegramWebhookBots.length > 0) {
      app.route("/", createTelegramEventsApp(telegramEventsAppInput(telegramWebhookBots)));
    }

    if (telegramPollingBots.length > 0) {
      const pollingApp = createTelegramEventsApp(telegramEventsAppInput(telegramPollingBots));
      for (const bot of telegramPollingBots) {
        const handle = startTelegramPolling({
          bot,
          app: pollingApp,
          logError(message, error) {
            if (error) {
              console.error(message, error);
              return;
            }
            console.error(message);
          }
        });
        backgroundHandles.push(handle);
      }
    }
  }

  const discordMode = input.discordMode ?? (input.discordPublicKey ? "webhook" : "gateway");
  if (discordMode === "webhook" && input.discordPublicKey) {
    if (input.port === 0) {
      throw new Error("Discord interactions mount requires a fixed dispatcher port.");
    }
    const dispatcherClient = createOpenTagClient({
      dispatcherUrl: `http://127.0.0.1:${input.port}`,
      ...(input.pairingToken ? { pairingToken: input.pairingToken } : {})
    });
    const discordBotToken = input.discordBotToken;
    app.route(
      "/",
      createDiscordInteractionsApp({
        publicKey: input.discordPublicKey,
        ...(input.discordWebhookPath ? { webhookPath: input.discordWebhookPath } : {}),
        ...(discordBotToken
          ? {
              async notifyChannel(target: { channelId: string; content: string }) {
                const response = await fetch(`https://discord.com/api/v10/channels/${target.channelId}/messages`, {
                  method: "POST",
                  headers: { authorization: `Bot ${discordBotToken}`, "content-type": "application/json" },
                  body: JSON.stringify({ content: target.content, allowed_mentions: { parse: [] } }),
                  signal: AbortSignal.timeout(10_000)
                });
                if (!response.ok) {
                  throw new Error(`Discord channel notice failed: ${response.status} ${await response.text()}`);
                }
              }
            }
          : {}),
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
          } catch (error) {
            // A real backend failure (network/5xx/timeout) is otherwise indistinguishable
            // from a genuinely unbound channel — log it so operators can tell them apart.
            console.error("discord.resolveChannelBinding failed", error);
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

  if (discordMode === "gateway" && input.discordBotToken) {
    if (input.port === 0) {
      throw new Error("Discord Gateway mode requires a fixed dispatcher port.");
    }
    const dispatcherClient = createOpenTagClient({
      dispatcherUrl: `http://127.0.0.1:${input.port}`,
      ...(input.pairingToken ? { pairingToken: input.pairingToken } : {})
    });
    const discordBotToken = input.discordBotToken;
    const gatewayHandle = startDiscordGateway({
      botToken: discordBotToken,
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
        } catch (error) {
          console.error("discord.resolveChannelBinding failed", error);
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
    });
    backgroundHandles.push(gatewayHandle);
  }

  const server: ClosableServer = serve({
    fetch: app.fetch,
    port: input.port
  });

  return {
    url: `http://localhost:${input.port}`,
    server,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeIdleConnections?.();
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeAllConnections?.();
      }).then(async () => {
        await Promise.allSettled([...backgroundHandles].reverse().map((handle) => handle.close()));
      });
    }
  };
}
