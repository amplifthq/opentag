import { commandFromRawText, type ContextPointer, type OpenTagCommand, type OpenTagEvent, type PermissionGrant } from "@opentag/core";

export type TelegramChannelBinding = {
  botId: string;
  chatId: string;
  repoProvider?: string;
  owner: string;
  repo: string;
};

export type TelegramMessageInput = {
  botId: string;
  botUsername?: string;
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  userId: string;
  username?: string;
  text: string;
  messageId: number;
  updateId?: number;
  messageThreadId?: number;
  receivedAt?: string;
  agentId?: string;
  callbackUri?: string;
  binding: TelegramChannelBinding;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripTelegramInvocation(input: {
  text: string;
  chatType: TelegramMessageInput["chatType"];
  botUsername?: string;
}): string | null {
  const trimmed = input.text.trim();
  if (!trimmed) return null;
  if (input.chatType === "private") return trimmed;

  const username = input.botUsername?.replace(/^@/, "");
  const patterns = username
    ? [
        new RegExp(`^@${escapeRegExp(username)}\\s+`, "i"),
        new RegExp(`^/opentag@${escapeRegExp(username)}\\s+`, "i"),
        /^\/opentag\s+/i
      ]
    : [/^\/opentag\s+/i];

  for (const pattern of patterns) {
    const stripped = trimmed.replace(pattern, "").trim();
    if (stripped !== trimmed) {
      return stripped.length > 0 ? stripped : null;
    }
  }

  return null;
}

export function encodeTelegramThreadKey(input: {
  botId: string;
  chatId: string;
  replyToMessageId: number;
  messageThreadId?: number;
}): string {
  return [input.botId, input.chatId, String(input.replyToMessageId), input.messageThreadId ? String(input.messageThreadId) : ""].join("|");
}

export function parseTelegramThreadKey(threadKey: string): {
  botId: string;
  chatId: string;
  replyToMessageId: number;
  messageThreadId?: number;
} {
  const [botId, chatId, replyToMessageIdRaw, messageThreadIdRaw] = threadKey.split("|");
  const replyToMessageId = Number(replyToMessageIdRaw);
  if (!botId || !chatId || !Number.isInteger(replyToMessageId) || replyToMessageId <= 0) {
    throw new Error(`Invalid Telegram thread key: ${threadKey}`);
  }
  const messageThreadId = messageThreadIdRaw ? Number(messageThreadIdRaw) : undefined;
  return {
    botId,
    chatId,
    replyToMessageId,
    ...(messageThreadId && Number.isInteger(messageThreadId) && messageThreadId > 0 ? { messageThreadId } : {})
  };
}

function permissionsForIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    {
      scope: "chat:postMessage",
      reason: "reply in the originating Telegram thread"
    },
    {
      scope: "runner:local",
      reason: "execute the run on a paired local daemon"
    }
  ];

  if (intent === "fix" || intent === "run") {
    permissions.push(
      {
        scope: "repo:read",
        reason: "inspect the repository in the paired local checkout"
      },
      {
        scope: "repo:write",
        reason: "commit code changes on an isolated run branch"
      },
      {
        scope: "pr:create",
        reason: "open a pull request for completed code changes"
      }
    );
  }

  return permissions;
}

function referenceTitle(reference: NonNullable<OpenTagCommand["parsed"]>["references"][number]): string {
  return reference.title ?? "Command file reference";
}

function contextPointersForCommand(command: OpenTagCommand): ContextPointer[] {
  const context: ContextPointer[] = [];
  for (const reference of command.parsed?.references ?? []) {
    if (reference.kind === "url") {
      context.push({
        kind: "url",
        uri: reference.uri,
        visibility: "organization",
        title: reference.title ?? "Command URL reference"
      });
      continue;
    }
    if (reference.kind === "file" || reference.kind === "path") {
      context.push({
        kind: "file",
        uri: reference.uri,
        ...(reference.line ? { line: reference.line } : {}),
        ...(reference.startLine ? { startLine: reference.startLine } : {}),
        ...(reference.endLine ? { endLine: reference.endLine } : {}),
        visibility: "organization",
        title: referenceTitle(reference)
      });
    }
  }
  return context;
}

function commandMetadata(command: OpenTagCommand): Record<string, unknown> {
  if (!command.parsed) return {};
  return {
    commandParser: command.parsed.version,
    commandDiagnostics: command.parsed.diagnostics,
    ...(command.parsed.approval ? { approval: command.parsed.approval } : {}),
    ...(command.parsed.network ? { network: command.parsed.network } : {})
  };
}

export function normalizeTelegramMessage(input: TelegramMessageInput): OpenTagEvent | null {
  const rawText = stripTelegramInvocation({
    text: input.text,
    chatType: input.chatType,
    ...(input.botUsername ? { botUsername: input.botUsername } : {})
  });
  if (!rawText) return null;

  const command = commandFromRawText(rawText);
  const agentId = input.agentId ?? "opentag";

  return {
    id: `evt_telegram_${input.updateId ?? `${input.botId}_${input.chatId}_${input.messageId}`}`,
    source: "telegram",
    sourceEventId: String(input.updateId ?? input.messageId),
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    actor: {
      provider: "telegram",
      providerUserId: input.userId,
      ...(input.username ? { handle: input.username } : {})
    },
    target: {
      mention: input.botUsername ? `@${input.botUsername.replace(/^@/, "")}` : "/opentag",
      agentId,
      ...(command.parsed?.executorHint ? { executorHint: command.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "telegram",
        kind: "message",
        uri: `telegram://bot/${input.botId}/chat/${input.chatId}/message/${input.messageId}`,
        visibility: "organization",
        title: "Telegram message"
      },
      {
        kind: "text",
        uri: input.text,
        visibility: "organization",
        title: "Telegram message text"
      },
      ...contextPointersForCommand(command)
    ],
    permissions: permissionsForIntent(command.intent),
    callback: {
      provider: "telegram",
      uri: input.callbackUri ?? "https://api.telegram.org/sendMessage",
      threadKey: encodeTelegramThreadKey({
        botId: input.botId,
        chatId: input.chatId,
        replyToMessageId: input.messageId,
        ...(input.messageThreadId ? { messageThreadId: input.messageThreadId } : {})
      })
    },
    metadata: {
      botId: input.botId,
      chatId: input.chatId,
      messageId: input.messageId,
      chatType: input.chatType,
      ...(input.messageThreadId ? { messageThreadId: input.messageThreadId } : {}),
      ...(input.botUsername ? { telegramBotUsername: input.botUsername.replace(/^@/, "") } : {}),
      ...commandMetadata(command),
      repoProvider: input.binding.repoProvider ?? "github",
      owner: input.binding.owner,
      repo: input.binding.repo
    }
  };
}
