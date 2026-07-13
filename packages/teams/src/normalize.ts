import {
  commandFromRawText,
  type ContextPointer,
  type OpenTagCommand,
  type OpenTagEvent,
  type PermissionGrant
} from "@opentag/core";
import { encodeTeamsThreadKey } from "./thread-key.js";

/** Channel → repository binding, keyed on the dispatcher by
 * `("teams", tenantId, conversationId)`. `channelId` may be absent for the
 * team's General channel, so `conversationId` is the reliable key. */
export type TeamsChannelBinding = {
  tenantId: string;
  teamId?: string;
  channelId?: string;
  conversationId: string;
  repoProvider?: string;
  owner: string;
  repo: string;
};

export type TeamsExtractedMessage = {
  activityId: string;
  serviceUrl: string;
  conversationId: string;
  tenantId: string;
  teamId?: string;
  channelId?: string;
  userId: string;
  userName?: string;
  /** Text with the bot mention removed and trimmed. May be empty. */
  text: string;
  /** The bot's channel id (recipient.id) — used later to route replies/actions. */
  botId: string;
};

export type TeamsActivityInput = {
  activityId: string;
  serviceUrl: string;
  conversationId: string;
  tenantId: string;
  teamId?: string;
  channelId?: string;
  userId: string;
  userName?: string;
  /** Mention already stripped; caller guards emptiness (normalize also guards). */
  text: string;
  binding: TeamsChannelBinding;
  receivedAt?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stripMention(text: string, mentionText: string): string {
  if (!mentionText) return text.trim();
  // Remove every occurrence of the exact mention markup, then collapse whitespace.
  return text.split(mentionText).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Extract typed fields from a raw Bot Framework activity, returning `null` when
 * the activity is not an addressed team-channel message we should act on:
 * - not a `message`;
 * - not a `channel` conversation (personal/groupChat are out of scope for v1);
 * - `text` missing;
 * - no `mention` entity targeting the bot (`recipient.id`);
 * - authored by the bot itself.
 * The returned `text` has the bot mention removed (may be empty — the caller
 * decides whether an empty command means "ignore").
 */
export function extractTeamsMessage(activity: Record<string, unknown>): TeamsExtractedMessage | null {
  if (activity.type !== "message") return null;

  const conversation = activity.conversation as { id?: unknown; conversationType?: unknown; tenantId?: unknown } | undefined;
  if (conversation?.conversationType !== "channel") return null;
  const conversationId = asString(conversation?.id);

  const recipient = activity.recipient as { id?: unknown } | undefined;
  const botId = asString(recipient?.id);

  const from = activity.from as { id?: unknown; name?: unknown; aadObjectId?: unknown } | undefined;
  const fromId = asString(from?.id);

  const rawText = asString(activity.text);
  const activityId = asString(activity.id);
  const serviceUrl = asString(activity.serviceUrl);

  const channelData = activity.channelData as
    | { tenant?: { id?: unknown }; team?: { id?: unknown }; channel?: { id?: unknown } }
    | undefined;
  const tenantId = asString(channelData?.tenant?.id) ?? asString(conversation?.tenantId);
  const teamId = asString(channelData?.team?.id);
  const channelId = asString(channelData?.channel?.id);

  if (!botId || !fromId || !rawText || !activityId || !serviceUrl || !conversationId || !tenantId) {
    return null;
  }
  if (fromId === botId) return null; // defence-in-depth: never act on our own messages.

  const entities = Array.isArray(activity.entities) ? activity.entities : [];
  const botMention = entities.find((entity): entity is Record<string, unknown> => {
    if (!entity || typeof entity !== "object") return false;
    const mention = entity as Record<string, unknown>;
    return mention.type === "mention" && (mention.mentioned as { id?: unknown } | undefined)?.id === botId;
  });
  if (!botMention) return null; // bot was not addressed.

  const text = stripMention(rawText, asString(botMention.text) ?? "");
  const userId = asString(from?.aadObjectId) ?? fromId;
  const userName = asString(from?.name);

  return {
    activityId,
    serviceUrl,
    conversationId,
    tenantId,
    ...(teamId ? { teamId } : {}),
    ...(channelId ? { channelId } : {}),
    userId,
    ...(userName ? { userName } : {}),
    text,
    botId
  };
}

function permissionsForIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    { scope: "chat:postMessage", reason: "reply in the originating Teams channel thread" },
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

/**
 * Normalize an addressed Teams channel message into an `OpenTagEvent`. Returns
 * `null` when the command body is empty after trimming. `workItem` is omitted —
 * a channel mention is a pure chat mention, not a canonical external work item
 * (same as the Discord/Telegram adapters).
 */
export function normalizeTeamsActivity(input: TeamsActivityInput): OpenTagEvent | null {
  const rawText = input.text.trim();
  if (!rawText) return null;

  const command = commandFromRawText(rawText);

  return {
    id: `evt_teams_${input.activityId}`,
    source: "teams",
    sourceEventId: input.activityId,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    actor: {
      provider: "teams",
      providerUserId: input.userId,
      ...(input.userName ? { handle: input.userName } : {}),
      ...(input.teamId ? { organizationId: input.teamId } : {})
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      ...(command.parsed?.executorHint ? { executorHint: command.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "teams",
        kind: "url",
        uri: `teams://team/${input.teamId ?? "unknown"}/channel/${input.channelId ?? input.conversationId}/message/${input.activityId}`,
        visibility: "organization",
        title: "Teams message"
      },
      ...contextPointersForCommand(command)
    ],
    permissions: permissionsForIntent(command.intent),
    callback: {
      provider: "teams",
      uri: input.serviceUrl,
      threadKey: encodeTeamsThreadKey({
        serviceUrl: input.serviceUrl,
        conversationId: input.conversationId,
        activityId: input.activityId
      })
    },
    metadata: {
      tenantId: input.tenantId,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      conversationId: input.conversationId,
      serviceUrl: input.serviceUrl,
      ...commandMetadata(command),
      repoProvider: input.binding.repoProvider ?? "github",
      owner: input.binding.owner,
      repo: input.binding.repo
    }
  };
}
