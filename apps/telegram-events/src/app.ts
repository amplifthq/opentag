import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  createDoctorSummaryPresentation,
  createSourceThreadStatusPresentation,
  parseProjectTargetRef,
  readRequestTextWithLimit,
  renderOpenTagPresentationPlainText,
  type OpenTagDoctorSummaryPresentation,
  type OpenTagEvent,
  type OpenTagSourceThreadStatusPresentation
} from "@opentag/core";
import { type TelegramChannelBinding, normalizeTelegramMessage, stripTelegramInvocation } from "@opentag/telegram";
import { Hono } from "hono";

type TelegramBotConfig = {
  botId: string;
  agentId: string;
  botUsername?: string;
  secretToken?: string;
  callbackUri?: string;
};

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    message_thread_id?: number;
    text?: string;
    from?: {
      id?: number;
      username?: string;
    };
    chat?: {
      id?: number;
      type?: "private" | "group" | "supergroup" | "channel";
    };
  };
};

type TelegramChatType = NonNullable<NonNullable<NonNullable<TelegramUpdate["message"]>["chat"]>["type"]>;

export type TelegramSelfServiceReply = {
  text: string;
};

export type TelegramSelfServiceContext = {
  botId: string;
  chatId: string;
  messageId: number;
  messageThreadId?: number;
  binding: TelegramChannelBinding | null;
};

export type TelegramStopRunResult =
  | { outcome: "cancelled"; runId: string }
  | { outcome: "not_found"; runId?: string }
  | { outcome: "already_terminal"; runId: string };

export type TelegramBindingManagementContext = {
  action: "bind" | "unbind";
  botId: string;
  chatId: string;
  chatType: TelegramChatType;
  userId: string;
  username?: string;
  messageId: number;
  messageThreadId?: number;
};

const HELP_TEXT = [
  "OpenTag commands:",
  "- /help shows these commands.",
  "- /bind <owner>/<repo> or /bind <provider>:<owner>/<repo> connects this Telegram chat to a Project Target.",
  "- /unbind confirm disconnects this Telegram chat from its current Project Target; it never deletes local checkout config.",
  "- /status shows the current Project Target, active-run guidance, queued follow-ups, and the next safe action.",
  "- /doctor shows a redacted readiness summary for this Telegram chat.",
  "- /stop [run_id] requests cancellation for the active chat run or the specified run; OpenTag will not treat stop as successful completion.",
  "- Send a task in private chat, or address the bot in a group with @botname or /opentag.",
  "Project Targets never use absolute local paths. Keep local checkout paths in runner config and allowlists."
].join("\n");

const UNBOUND_HINT =
  "This Telegram chat is not connected to a Project Target yet. Send `/bind <owner>/<repo>` or configure dispatcher channel bindings before starting runs.";
const BIND_USAGE =
  "Usage: /bind <owner>/<repo> — e.g. /bind amplifthq/opentag (or /bind github:amplifthq/opentag). Project Targets never use absolute local paths.";
const UNBIND_USAGE =
  "Usage: /unbind confirm — disconnects this Telegram chat from its current Project Target. This does not remove local checkout config, repository bindings, or allowlists.";
const BINDING_AUTH_DENIED_TEXT =
  "Only an authorized Telegram binding manager can change this chat's Project Target. Ask an admin to run the command or update local OpenTag channel bindings.";
const STOP_UNAVAILABLE_TEXT = [
  "Run cancellation from this Telegram ingress is not configured.",
  "OpenTag will not treat a stop request as a successful completion. Use `opentag status --run <run_id>` for audit detail, or `opentag service stop` if you need to stop the local background service."
].join("\n");

function normalizeSelfServiceReply(reply: TelegramSelfServiceReply | string): TelegramSelfServiceReply {
  return typeof reply === "string" ? { text: reply } : reply;
}

function parseSelfServiceCommand(command: string): "help" | "status" | "doctor" | null {
  const trimmed = command.trim();
  if (/^\/help(\s|$)/.test(trimmed)) return "help";
  if (/^\/status(\s|$)/.test(trimmed)) return "status";
  if (/^\/doctor(\s|$)/.test(trimmed)) return "doctor";
  return null;
}

function parseStopCommand(command: string): { runId?: string } | null {
  const match = command.trim().match(/^\/stop(?:\s+(\S+))?\s*$/);
  if (!match) return null;
  return match[1] ? { runId: match[1] } : {};
}

function parseBindCommand(
  command: string
): { ok: true; repoProvider: string; owner: string; repo: string } | { ok: false } | null {
  const trimmed = command.trim();
  if (!/^\/bind(\s|$)/.test(trimmed)) return null;
  const match = trimmed.match(/^\/bind\s+(\S+)\s*$/);
  if (!match) return { ok: false };
  try {
    const ref = parseProjectTargetRef(match[1] as string);
    return { ok: true, repoProvider: ref.provider, owner: ref.owner, repo: ref.repo };
  } catch {
    return { ok: false };
  }
}

function parseUnbindCommand(command: string): { ok: true } | { ok: false } | null {
  const trimmed = command.trim();
  if (!/^\/unbind(\s|$)/.test(trimmed)) return null;
  return /^\/unbind\s+confirm\s*$/.test(trimmed) ? { ok: true } : { ok: false };
}

function formatStopResultText(result: TelegramStopRunResult): string {
  if (result.outcome === "cancelled") {
    return [
      `Cancellation requested for run ${result.runId}.`,
      "- OpenTag will not treat this stop request as a successful completion.",
      "- The local executor may need a moment to observe the cancellation; further nonessential completion writes are suppressed."
    ].join("\n");
  }
  if (result.outcome === "already_terminal") {
    return `Run ${result.runId} is already finished. OpenTag will not change its final result.`;
  }
  return result.runId
    ? `Run ${result.runId} was not found or is no longer cancelable.`
    : "No active run was found for this Telegram chat and Project Target.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTelegramChatType(value: unknown): value is TelegramChatType {
  return value === "private" || value === "group" || value === "supergroup" || value === "channel";
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (!isRecord(value)) return false;
  if (value.update_id !== undefined && typeof value.update_id !== "number") return false;
  if (value.message === undefined) return true;
  if (!isRecord(value.message)) return false;
  if (value.message.message_id !== undefined && typeof value.message.message_id !== "number") return false;
  if (value.message.message_thread_id !== undefined && typeof value.message.message_thread_id !== "number") return false;
  if (value.message.text !== undefined && typeof value.message.text !== "string") return false;
  if (value.message.from !== undefined) {
    if (!isRecord(value.message.from)) return false;
    if (value.message.from.id !== undefined && typeof value.message.from.id !== "number") return false;
    if (value.message.from.username !== undefined && typeof value.message.from.username !== "string") return false;
  }
  if (value.message.chat !== undefined) {
    if (!isRecord(value.message.chat)) return false;
    if (value.message.chat.id !== undefined && typeof value.message.chat.id !== "number") return false;
    if (value.message.chat.type !== undefined && !isTelegramChatType(value.message.chat.type)) return false;
  }
  return true;
}

function formatProjectTarget(binding: TelegramChannelBinding): string {
  return `${binding.repoProvider ?? "github"}:${binding.owner}/${binding.repo}`;
}

async function canManageBinding(
  input: { canManageBinding?: (input: TelegramBindingManagementContext) => Promise<boolean> | boolean },
  context: TelegramBindingManagementContext
): Promise<boolean> {
  if (input.canManageBinding) return input.canManageBinding(context);
  return context.chatType === "private";
}

function statusPresentation(input: {
  botId: string;
  chatId: string;
  binding: TelegramChannelBinding | null;
}): OpenTagSourceThreadStatusPresentation {
  if (!input.binding) {
    return createSourceThreadStatusPresentation({
      title: "OpenTag status:",
      sourceContainer: `telegram:${input.botId}/${input.chatId}`,
      bindingState: "unbound",
      nextAction: UNBOUND_HINT,
      detailHint: "active run and queued follow-up status are unavailable until this chat is bound."
    });
  }
  return createSourceThreadStatusPresentation({
    title: "OpenTag status:",
    sourceContainer: `telegram:${input.botId}/${input.chatId}`,
    projectTarget: formatProjectTarget(input.binding),
    bindingState: "bound",
    nextAction: "send a follow-up in this chat, or check `opentag status --run <run_id>` locally for audit detail.",
    stopHint: "cancellation is explicit and is not reported as successful completion; timeout policy is surfaced in status/audit.",
    detailHint: "at most one run is active per Project Target + source thread; new same-thread requests queue behind it."
  });
}

function statusReply(input: { botId: string; chatId: string; binding: TelegramChannelBinding | null }): TelegramSelfServiceReply {
  return { text: renderOpenTagPresentationPlainText(statusPresentation(input)) };
}

function doctorPresentation(input: {
  botId: string;
  chatId: string;
  binding: TelegramChannelBinding | null;
}): OpenTagDoctorSummaryPresentation {
  return createDoctorSummaryPresentation({
    title: "OpenTag doctor (redacted):",
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
  });
}

function doctorReply(input: { botId: string; chatId: string; binding: TelegramChannelBinding | null }): TelegramSelfServiceReply {
  return { text: renderOpenTagPresentationPlainText(doctorPresentation(input)) };
}

export function createTelegramEventsApp(input: {
  telegramBots: TelegramBotConfig[];
  resolveChannelBinding(input: { botId: string; chatId: string }): Promise<TelegramChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  bindChannel?(input: { botId: string; chatId: string; repoProvider: string; owner: string; repo: string }): Promise<void>;
  unbindChannel?(input: { botId: string; chatId: string }): Promise<void>;
  canManageBinding?(input: TelegramBindingManagementContext): Promise<boolean> | boolean;
  status?(input: TelegramSelfServiceContext): Promise<TelegramSelfServiceReply | string>;
  doctor?(input: TelegramSelfServiceContext): Promise<TelegramSelfServiceReply | string>;
  stopRun?(input: { botId: string; chatId: string; runId?: string; requestedBy: string }): Promise<TelegramStopRunResult>;
  recordControlPlaneEvent?(event: {
    type: string;
    severity?: "info" | "warn" | "error";
    subject?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  reply?(input: { botId: string; chatId: string; messageId: number; text: string; messageThreadId?: number }): Promise<void>;
  maxRequestBodyBytes?: number;
  now(): string;
}) {
  const app = new Hono();
  const maxRequestBodyBytes = input.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;

  async function recordRequestBodyRejected(rejection: {
    botId: string;
    reason: "request_body_too_large" | "invalid_json_body" | "invalid_request_body";
    maxBytes: number;
    contentLength: string | null;
  }): Promise<void> {
    try {
      await input.recordControlPlaneEvent?.({
        type: "security.request_body_rejected",
        severity: "warn",
        subject: "telegram:POST /telegram/events/:botId",
        payload: {
          provider: "telegram",
          endpoint: "POST /telegram/events/:botId",
          reason: rejection.reason,
          botId: rejection.botId,
          ...(rejection.maxBytes ? { maxBytes: rejection.maxBytes } : {}),
          contentLength: rejection.contentLength
        }
      });
    } catch {
      // Oversized-payload rejection should still fail closed if audit reporting is unavailable.
    }
  }

  async function recordSignatureFailed(inputEvent: { botId: string; hasSecretToken: boolean }): Promise<void> {
    try {
      await input.recordControlPlaneEvent?.({
        type: "security.signature_failed",
        severity: "warn",
        subject: "telegram:POST /telegram/events/:botId",
        payload: {
          provider: "telegram",
          endpoint: "POST /telegram/events/:botId",
          reason: "invalid_secret_token",
          botId: inputEvent.botId,
          hasSecretToken: inputEvent.hasSecretToken
        }
      });
    } catch {
      // Secret-token rejection should still fail closed if audit reporting is unavailable.
    }
  }

  app.post("/telegram/events/:botId", async (c) => {
    const botId = c.req.param("botId");
    const bot = input.telegramBots.find((candidate) => candidate.botId === botId);
    if (!bot) {
      return c.json({ error: "unknown_telegram_bot" }, 404);
    }
    if (bot.secretToken) {
      const actual = c.req.header("x-telegram-bot-api-secret-token");
      if (actual !== bot.secretToken) {
        await recordSignatureFailed({ botId, hasSecretToken: Boolean(actual) });
        return c.json({ error: "invalid_secret_token" }, 401);
      }
    }

    let payload: unknown;
    try {
      const rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes: maxRequestBodyBytes });
      payload = JSON.parse(rawBody);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        await recordRequestBodyRejected({
          botId,
          reason: "request_body_too_large",
          maxBytes: error.maxBytes,
          contentLength: c.req.raw.headers.get("content-length")
        });
        return c.json({ error: "request_body_too_large", maxBytes: error.maxBytes }, 413);
      }
      if (error instanceof SyntaxError) {
        await recordRequestBodyRejected({
          botId,
          reason: "invalid_json_body",
          maxBytes: maxRequestBodyBytes,
          contentLength: c.req.raw.headers.get("content-length")
        });
        return c.json({ error: "invalid_json" }, 400);
      }
      throw error;
    }
    if (!isTelegramUpdate(payload)) {
      await recordRequestBodyRejected({
        botId,
        reason: "invalid_request_body",
        maxBytes: maxRequestBodyBytes,
        contentLength: c.req.raw.headers.get("content-length")
      });
      return c.json({ error: "invalid_request_body" }, 400);
    }

    const message = payload.message;
    if (!message?.message_id || !message.chat?.id || !message.chat.type || !message.from?.id || !message.text) {
      return c.json({ ok: true, ignored: "unsupported_update" });
    }

    const chatId = String(message.chat.id);
    const commandText = stripTelegramInvocation({
      text: message.text,
      chatType: message.chat.type,
      ...(bot.botUsername ? { botUsername: bot.botUsername } : {})
    });
    if (!commandText) {
      return c.json({ ok: true, ignored: "empty_command" });
    }

    const selfServiceCommand = parseSelfServiceCommand(commandText);
    if (selfServiceCommand === "help") {
      await input.reply?.({
        botId,
        chatId,
        messageId: message.message_id,
        text: HELP_TEXT,
        ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
      });
      return c.json({ ok: true, command: "help" });
    }

    const bindRequest = parseBindCommand(commandText);
    if (bindRequest) {
      if (!input.bindChannel) {
        await input.reply?.({
          botId,
          chatId,
          messageId: message.message_id,
          text: "Telegram chat binding from source threads is not configured. Re-run `opentag setup` or update local OpenTag channel bindings.",
          ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
        });
        return c.json({ ok: true, command: "bind", unavailable: true });
      }
      if (!bindRequest.ok) {
        await input.reply?.({
          botId,
          chatId,
          messageId: message.message_id,
          text: BIND_USAGE,
          ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
        });
        return c.json({ ok: true, command: "bind", usage: true });
      }
      const allowed = await canManageBinding(input, {
        action: "bind",
        botId,
        chatId,
        chatType: message.chat.type,
        userId: String(message.from.id),
        ...(message.from.username ? { username: message.from.username } : {}),
        messageId: message.message_id,
        ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
      });
      if (!allowed) {
        await input.reply?.({
          botId,
          chatId,
          messageId: message.message_id,
          text: BINDING_AUTH_DENIED_TEXT,
          ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
        });
        return c.json({ ok: true, command: "bind", unauthorized: true });
      }
      await input.bindChannel({
        botId,
        chatId,
        repoProvider: bindRequest.repoProvider,
        owner: bindRequest.owner,
        repo: bindRequest.repo
      });
      await input.reply?.({
        botId,
        chatId,
        messageId: message.message_id,
        text: `Connected this Telegram chat to Project Target ${bindRequest.repoProvider}:${bindRequest.owner}/${bindRequest.repo}. Send a task to start a run.`,
        ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
      });
      return c.json({ ok: true, command: "bind" });
    }

    const unbindRequest = parseUnbindCommand(commandText);
    if (unbindRequest) {
      if (!input.unbindChannel) {
        await input.reply?.({
          botId,
          chatId,
          messageId: message.message_id,
          text: "Telegram chat unbinding from source threads is not configured. Update local OpenTag channel bindings instead.",
          ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
        });
        return c.json({ ok: true, command: "unbind", unavailable: true });
      }
      if (!unbindRequest.ok) {
        await input.reply?.({
          botId,
          chatId,
          messageId: message.message_id,
          text: UNBIND_USAGE,
          ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
        });
        return c.json({ ok: true, command: "unbind", usage: true });
      }
      const allowed = await canManageBinding(input, {
        action: "unbind",
        botId,
        chatId,
        chatType: message.chat.type,
        userId: String(message.from.id),
        ...(message.from.username ? { username: message.from.username } : {}),
        messageId: message.message_id,
        ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
      });
      if (!allowed) {
        await input.reply?.({
          botId,
          chatId,
          messageId: message.message_id,
          text: BINDING_AUTH_DENIED_TEXT,
          ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
        });
        return c.json({ ok: true, command: "unbind", unauthorized: true });
      }
      const existingBinding = await input.resolveChannelBinding({ botId, chatId });
      if (!existingBinding) {
        await input.reply?.({
          botId,
          chatId,
          messageId: message.message_id,
          text: UNBOUND_HINT,
          ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
        });
        return c.json({ ok: true, command: "unbind", ignored: "unbound_chat" });
      }
      await input.unbindChannel({ botId, chatId });
      await input.reply?.({
        botId,
        chatId,
        messageId: message.message_id,
        text: `Disconnected this Telegram chat from Project Target ${formatProjectTarget(existingBinding)}. Send \`/bind <owner>/<repo>\` to connect a new target.`,
        ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
      });
      return c.json({ ok: true, command: "unbind" });
    }

    const stopRequest = parseStopCommand(commandText);
    if (stopRequest) {
      if (!input.stopRun) {
        await input.reply?.({
          botId,
          chatId,
          messageId: message.message_id,
          text: STOP_UNAVAILABLE_TEXT,
          ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
        });
        return c.json({ ok: true, command: "stop", unavailable: true });
      }
      const result = await input.stopRun({
        botId,
        chatId,
        ...(stopRequest.runId ? { runId: stopRequest.runId } : {}),
        requestedBy: `telegram:${message.from.id}`
      });
      await input.reply?.({
        botId,
        chatId,
        messageId: message.message_id,
        text: formatStopResultText(result),
        ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
      });
      return c.json({ ok: true, command: "stop", ...(result.runId ? { runId: result.runId } : {}) });
    }

    const binding = await input.resolveChannelBinding({ botId, chatId });
    if (selfServiceCommand === "status" || selfServiceCommand === "doctor") {
      const context: TelegramSelfServiceContext = {
        botId,
        chatId,
        messageId: message.message_id,
        ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {}),
        binding
      };
      const reply =
        selfServiceCommand === "status"
          ? normalizeSelfServiceReply(input.status ? await input.status(context) : statusReply({ botId, chatId, binding }))
          : normalizeSelfServiceReply(input.doctor ? await input.doctor(context) : doctorReply({ botId, chatId, binding }));
      await input.reply?.({
        botId,
        chatId,
        messageId: message.message_id,
        text: reply.text,
        ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {})
      });
      return c.json({ ok: true, command: selfServiceCommand });
    }

    if (!binding) {
      return c.json({ ok: true, ignored: "unbound_chat" });
    }

    const event = normalizeTelegramMessage({
      botId,
      chatId,
      chatType: message.chat.type,
      userId: String(message.from.id),
      ...(message.from.username ? { username: message.from.username } : {}),
      ...(bot.botUsername ? { botUsername: bot.botUsername } : {}),
      text: message.text,
      messageId: message.message_id,
      ...(payload.update_id ? { updateId: payload.update_id } : {}),
      ...(message.message_thread_id ? { messageThreadId: message.message_thread_id } : {}),
      receivedAt: input.now(),
      agentId: bot.agentId,
      ...(bot.callbackUri ? { callbackUri: bot.callbackUri } : {}),
      binding
    });
    if (!event) {
      return c.json({ ok: true, ignored: "empty_command" });
    }

    await input.createRun(event);
    return c.json({ ok: true });
  });

  return app;
}
