import { commandFromRawText, type ContextPointer, type OpenTagCommand, type OpenTagEvent, type PermissionGrant } from "@opentag/core";

export type LineSourceType = "user" | "group" | "room";

export type LineMentionee = {
  isSelf?: boolean;
  index?: number;
  length?: number;
};

export type LineMention = {
  mentionees?: LineMentionee[];
};

export type LineSource = {
  type?: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
};

export type LineChannelBinding = {
  accountId: string;
  conversationId: string;
  repoProvider?: string;
  owner: string;
  repo: string;
};

export type LineMessageInput = {
  accountId: string;
  conversationId: string;
  sourceType: LineSourceType;
  userId: string;
  displayName?: string;
  text: string;
  messageId: string;
  webhookEventId?: string;
  replyToken?: string;
  mention?: LineMention;
  receivedAt?: string;
  agentId?: string;
  callbackUri?: string;
  binding: LineChannelBinding;
};

export function lineConversationIdFromSource(source: LineSource): string | null {
  if (source.type === "group") return source.groupId ?? null;
  if (source.type === "room") return source.roomId ?? null;
  return source.userId ?? null;
}

export function lineSourceType(source: LineSource): LineSourceType | null {
  if (source.type === "user" || source.type === "group" || source.type === "room") return source.type;
  return null;
}

export function stripLineInvocation(input: {
  text: string;
  sourceType: LineSourceType;
  mention?: LineMention;
}): string | null {
  const trimmed = input.text.trim();
  if (!trimmed) return null;
  if (input.sourceType === "user") return trimmed;

  const commandMatch = trimmed.match(/^\/opentag(?:\s+|$)/i);
  if (commandMatch) {
    const stripped = trimmed.slice(commandMatch[0].length).trim();
    return stripped.length > 0 ? stripped : null;
  }

  const selfMention = input.mention?.mentionees?.find((mentionee) => mentionee.isSelf === true);
  if (!selfMention) return null;
  if (
    Number.isInteger(selfMention.index) &&
    Number.isInteger(selfMention.length) &&
    selfMention.index === 0 &&
    selfMention.length &&
    selfMention.length > 0
  ) {
    const stripped = input.text.slice(selfMention.length).trim();
    return stripped.length > 0 ? stripped : null;
  }

  const stripped = trimmed.replace(/^@\S+\s+/, "").trim();
  return stripped !== trimmed && stripped.length > 0 ? stripped : null;
}

export function encodeLineThreadKey(input: { accountId: string; conversationId: string }): string {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

export function parseLineThreadKey(threadKey: string): { accountId: string; conversationId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(threadKey, "base64url").toString("utf8"));
  } catch {
    throw new Error(`Invalid LINE thread key: ${threadKey}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { accountId?: unknown }).accountId !== "string" ||
    typeof (parsed as { conversationId?: unknown }).conversationId !== "string"
  ) {
    throw new Error(`Invalid LINE thread key: ${threadKey}`);
  }
  const { accountId, conversationId } = parsed as { accountId: string; conversationId: string };
  if (!accountId || !conversationId) {
    throw new Error(`Invalid LINE thread key: ${threadKey}`);
  }
  return { accountId, conversationId };
}

function permissionsForIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    { scope: "chat:postMessage", reason: "reply in the originating LINE conversation" },
    { scope: "runner:local", reason: "execute the run on a paired local daemon" }
  ];
  if (intent === "fix" || intent === "run") {
    permissions.push(
      { scope: "repo:read", reason: "inspect the repository in the paired local checkout" },
      { scope: "repo:write", reason: "commit code changes on an isolated run branch" },
      { scope: "pr:create", reason: "open a pull request for completed code changes" }
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
      context.push({ kind: "url", uri: reference.uri, visibility: "organization", title: reference.title ?? "Command URL reference" });
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

export function normalizeLineMessage(input: LineMessageInput): OpenTagEvent | null {
  const rawText = stripLineInvocation({
    text: input.text,
    sourceType: input.sourceType,
    ...(input.mention ? { mention: input.mention } : {})
  });
  if (!rawText) return null;

  const command = commandFromRawText(rawText);
  const sourceEventId = input.webhookEventId ?? input.messageId;
  const agentId = input.agentId ?? "opentag";

  return {
    id: `evt_line_${sourceEventId}`,
    source: "line",
    sourceEventId,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    actor: {
      provider: "line",
      providerUserId: input.userId,
      organizationId: input.accountId,
      ...(input.displayName ? { displayName: input.displayName } : {})
    },
    target: {
      mention: input.sourceType === "user" ? "LINE direct message" : "/opentag",
      agentId,
      ...(command.parsed?.executorHint ? { executorHint: command.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "line",
        kind: "message",
        uri: `line://account/${input.accountId}/${input.sourceType}/${input.conversationId}/message/${input.messageId}`,
        visibility: "organization",
        title: "LINE message"
      },
      { kind: "text", uri: input.text, visibility: "organization", title: "LINE message text" },
      ...contextPointersForCommand(command)
    ],
    permissions: permissionsForIntent(command.intent),
    callback: {
      provider: "line",
      uri: input.callbackUri ?? "https://api.line.me/v2/bot/message/push",
      threadKey: encodeLineThreadKey({ accountId: input.accountId, conversationId: input.conversationId })
    },
    metadata: {
      accountId: input.accountId,
      conversationId: input.conversationId,
      sourceType: input.sourceType,
      messageId: input.messageId,
      ...(input.webhookEventId ? { webhookEventId: input.webhookEventId } : {}),
      ...(input.replyToken ? { replyToken: input.replyToken } : {}),
      ...commandMetadata(command),
      repoProvider: input.binding.repoProvider ?? "github",
      owner: input.binding.owner,
      repo: input.binding.repo
    }
  };
}