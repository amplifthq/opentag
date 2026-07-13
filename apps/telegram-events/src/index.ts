import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient, type ChannelRuntimeStatus } from "@opentag/client";
import {
  createDoctorSummaryPresentation,
  createSourceThreadStatusPresentation,
  renderOpenTagPresentationPlainText,
  type OpenTagSourceThreadQueuedFollowUp
} from "@opentag/core";
import {
  TELEGRAM_DOCTOR_TITLE,
  TELEGRAM_STATUS_TITLE,
  createTelegramSendMessagePayload,
  type TelegramChannelBinding
} from "@opentag/telegram";
import { createTelegramEventsApp, type TelegramStopRunResult } from "./app.js";

const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
if (!dispatcherUrl) {
  throw new Error("OPENTAG_DISPATCHER_URL is required");
}

const dispatcherToken = process.env.OPENTAG_DISPATCHER_TOKEN;
const port = Number(process.env.PORT ?? "3050");
const maxRequestBodyBytes = positiveIntegerFromEnv(
  "OPENTAG_MAX_REQUEST_BODY_BYTES",
  process.env.OPENTAG_MAX_REQUEST_BODY_BYTES
);
const dispatcherClient = createOpenTagClient({
  dispatcherUrl,
  ...(dispatcherToken ? { pairingToken: dispatcherToken } : {})
});

type TelegramBotConfig = {
  botId: string;
  agentId: string;
  botUsername?: string;
  botToken?: string;
  bindingAdminUserIds?: string[];
  secretToken?: string;
  callbackUri?: string;
};

function csvList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function positiveIntegerFromEnv(name: string, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

function telegramBotsFromEnv(): TelegramBotConfig[] {
  const botsJson = process.env.OPENTAG_TELEGRAM_BOTS_JSON;
  if (botsJson) {
    try {
      const parsed = JSON.parse(botsJson);
      if (!Array.isArray(parsed)) {
        throw new Error("Value is not a JSON array");
      }
      return parsed.filter(
        (candidate): candidate is TelegramBotConfig =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          typeof candidate.botId === "string" &&
          typeof candidate.agentId === "string" &&
          (!("botUsername" in candidate) || typeof candidate.botUsername === "string") &&
          (!("botToken" in candidate) || typeof candidate.botToken === "string") &&
          (!("bindingAdminUserIds" in candidate) || isStringArray(candidate.bindingAdminUserIds)) &&
          (!("secretToken" in candidate) || typeof candidate.secretToken === "string") &&
          (!("callbackUri" in candidate) || typeof candidate.callbackUri === "string")
      );
    } catch (error) {
      throw new Error(
        `Failed to parse OPENTAG_TELEGRAM_BOTS_JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!process.env.OPENTAG_TELEGRAM_BOT_ID) {
    return [];
  }

  const bindingAdminUserIds = csvList(process.env.OPENTAG_TELEGRAM_BINDING_ADMIN_USER_IDS);
  return [
    {
      botId: process.env.OPENTAG_TELEGRAM_BOT_ID,
      agentId: process.env.OPENTAG_TELEGRAM_AGENT_ID ?? "opentag",
      ...(process.env.OPENTAG_TELEGRAM_BOT_USERNAME ? { botUsername: process.env.OPENTAG_TELEGRAM_BOT_USERNAME } : {}),
      ...(process.env.OPENTAG_TELEGRAM_BOT_TOKEN ? { botToken: process.env.OPENTAG_TELEGRAM_BOT_TOKEN } : {}),
      ...(bindingAdminUserIds ? { bindingAdminUserIds } : {}),
      ...(process.env.OPENTAG_TELEGRAM_SECRET_TOKEN ? { secretToken: process.env.OPENTAG_TELEGRAM_SECRET_TOKEN } : {}),
      ...(process.env.OPENTAG_TELEGRAM_CALLBACK_URI ? { callbackUri: process.env.OPENTAG_TELEGRAM_CALLBACK_URI } : {})
    }
  ];
}

const telegramBots = telegramBotsFromEnv();
if (telegramBots.length === 0) {
  throw new Error("Configure OPENTAG_TELEGRAM_BOT_ID or OPENTAG_TELEGRAM_BOTS_JSON");
}

const duplicateTelegramBotIds = telegramBots
  .map((bot) => bot.botId)
  .filter((botId, index, botIds) => botIds.indexOf(botId) !== index);
if (duplicateTelegramBotIds.length > 0) {
  throw new Error(`Duplicate Telegram botId entries are not allowed: ${[...new Set(duplicateTelegramBotIds)].join(", ")}`);
}

const telegramBotTokenById = new Map(telegramBots.flatMap((bot) => (bot.botToken ? [[bot.botId, bot.botToken] as const] : [])));
const telegramSendTimeoutMs = positiveIntegerFromEnv(
  "OPENTAG_TELEGRAM_SEND_TIMEOUT_MS",
  process.env.OPENTAG_TELEGRAM_SEND_TIMEOUT_MS
) ?? 10_000;

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

function formatRuntimeStatusText(input: {
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

function formatDoctorText(input: { botId: string; chatId: string; binding: TelegramChannelBinding | null }): string {
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

function mapStopError(input: { error: unknown; runId?: string }): TelegramStopRunResult | null {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  if (message.includes("run_already_terminal")) {
    return { outcome: "already_terminal", runId: input.runId ?? "active run" };
  }
  if (message.includes("run_not_found") || message.includes("active_run_not_found") || message.includes("channel_binding_not_found")) {
    return input.runId ? { outcome: "not_found", runId: input.runId } : { outcome: "not_found" };
  }
  return null;
}

serve({
  fetch: createTelegramEventsApp({
    telegramBots,
    ...(maxRequestBodyBytes ? { maxRequestBodyBytes } : {}),
    async resolveChannelBinding(input) {
      try {
        const { binding } = await dispatcherClient.getChannelBinding({
          provider: "telegram",
          accountId: input.botId,
          conversationId: input.chatId
        });
        return {
          botId: binding.accountId,
          chatId: binding.conversationId,
          ...(binding.repoProvider && binding.owner && binding.repo
            ? { repoProvider: binding.repoProvider, owner: binding.owner, repo: binding.repo }
            : {})
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
    async bindChannel(input) {
      await dispatcherClient.bindChannel({
        provider: "telegram",
        accountId: input.botId,
        conversationId: input.chatId,
        repoProvider: input.repoProvider,
        owner: input.owner,
        repo: input.repo
      });
    },
    async unbindChannel(input) {
      await dispatcherClient.unbindChannel({
        provider: "telegram",
        accountId: input.botId,
        conversationId: input.chatId
      });
    },
    canManageBinding(input) {
      if (input.chatType === "private") return true;
      const bot = telegramBots.find((candidate) => candidate.botId === input.botId);
      return Boolean(bot?.bindingAdminUserIds?.includes(input.userId));
    },
    async status(input) {
      if (!input.binding) {
        return formatRuntimeStatusText(input);
      }
      const status = await dispatcherClient.getChannelRuntimeStatus({
        provider: "telegram",
        accountId: input.botId,
        conversationId: input.chatId
      });
      return formatRuntimeStatusText({ ...input, status });
    },
    async doctor(input) {
      return formatDoctorText(input);
    },
    async stopRun(input) {
      try {
        const result = input.runId
          ? await dispatcherClient.cancelRun({
              runId: input.runId,
              reason: "Stop requested from Telegram.",
              requestedBy: input.requestedBy
            })
          : await dispatcherClient.cancelActiveChannelRun({
              provider: "telegram",
              accountId: input.botId,
              conversationId: input.chatId,
              reason: "Stop requested from Telegram.",
              requestedBy: input.requestedBy
            });
        return { outcome: "cancelled", runId: result.run.id };
      } catch (error) {
        const mapped = mapStopError({ error, ...(input.runId ? { runId: input.runId } : {}) });
        if (mapped) return mapped;
        throw error;
      }
    },
    async recordControlPlaneEvent(event) {
      await dispatcherClient.recordControlPlaneEvent(event);
    },
    async reply(input) {
      const botToken = telegramBotTokenById.get(input.botId);
      if (!botToken) return;
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), telegramSendTimeoutMs);
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: abortController.signal,
          body: JSON.stringify(
            createTelegramSendMessagePayload({
              chatId: input.chatId,
              text: input.text,
              replyToMessageId: input.messageId,
              ...(input.messageThreadId ? { messageThreadId: input.messageThreadId } : {})
            })
          )
        });
        if (!response.ok) {
          throw new Error(`Telegram self-service reply failed with HTTP ${response.status}`);
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new Error(`Telegram self-service reply timed out after ${telegramSendTimeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    now: () => new Date().toISOString()
  }).fetch,
  port
});

console.log(`OpenTag Telegram events ingress listening on http://localhost:${port}`);
