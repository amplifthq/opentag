import { commandFromRawText, type ContextPointer, type OpenTagCommand, type OpenTagEvent, type PermissionGrant } from "@opentag/core";

/** Channel → repository binding, keyed on the dispatcher by
 * `("discord", applicationId, channelId)`. */
export type DiscordChannelBinding = {
  applicationId: string;
  guildId?: string;
  channelId: string;
} & ({ repoProvider?: string; owner: string; repo: string } | { repoProvider?: never; owner?: never; repo?: never });

export type DiscordInteractionInput = {
  interactionId: string;
  applicationId: string;
  channelId: string;
  guildId?: string;
  userId: string;
  username?: string;
  prompt: string;
  /** Optional `executor` option; appended as `--executor <value>` so the shared
   * parser resolves it into `target.executorHint` (parser only accepts `--executor`). */
  executor?: string;
  binding: DiscordChannelBinding;
  callbackBaseUrl?: string;
  receivedAt?: string;
};

/** threadKey = `guildId|channelId|anchorId` (guild segment empty for DMs).
 * Segments must not contain `|`. */
export function encodeDiscordThreadKey(input: { guildId?: string; channelId: string; anchorId: string }): string {
  return [input.guildId ?? "", input.channelId, input.anchorId].join("|");
}

export function parseDiscordThreadKey(threadKey: string): { guildId?: string; channelId: string; anchorId: string } {
  const [guildId, channelId, anchorId] = threadKey.split("|");
  if (!channelId || !anchorId) {
    throw new Error(`Invalid Discord thread key: ${threadKey}`);
  }
  return {
    ...(guildId ? { guildId } : {}),
    channelId,
    anchorId
  };
}

function permissionsForIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    {
      scope: "chat:postMessage",
      reason: "reply in the originating Discord channel"
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

function commandTextFromInteraction(input: DiscordInteractionInput): string {
  const prompt = input.prompt.trim();
  const executor = input.executor?.trim();
  return executor ? `${prompt} --executor ${executor}` : prompt;
}

/**
 * Normalize a Discord `APPLICATION_COMMAND` interaction (`/opentag`) into an
 * `OpenTagEvent`. Returns `null` when the command body is empty after trimming
 * (nothing to run). The `workItem` field is intentionally omitted — a slash
 * command in a channel is a pure chat mention, not attached to a canonical
 * external work item (same as the Telegram adapter).
 */
export function normalizeDiscordInteraction(input: DiscordInteractionInput): OpenTagEvent | null {
  // Guard on the prompt itself: a whitespace-only prompt with an executor option set
  // would otherwise yield a truthy rawText like "--executor codex" and start a run with
  // no real instruction.
  if (!input.prompt.trim()) return null;
  const rawText = commandTextFromInteraction(input);

  const command = commandFromRawText(rawText);
  const baseUrl = input.callbackBaseUrl ?? "https://discord.com/api/v10";
  const channelMessagesUri = `${baseUrl}/channels/${input.channelId}/messages`;

  return {
    id: `evt_discord_${input.interactionId}`,
    source: "discord",
    sourceEventId: input.interactionId,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    actor: {
      provider: "discord",
      providerUserId: input.userId,
      ...(input.username ? { handle: input.username } : {})
    },
    target: {
      mention: "/opentag",
      agentId: "opentag",
      ...(command.parsed?.executorHint ? { executorHint: command.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "discord",
        kind: "message",
        uri: `discord://channel/${input.channelId}/message/${input.interactionId}`,
        visibility: "organization",
        title: "Discord interaction"
      },
      {
        kind: "text",
        uri: rawText,
        visibility: "organization",
        title: "Discord command text"
      },
      ...contextPointersForCommand(command)
    ],
    permissions: permissionsForIntent(command.intent),
    callback: {
      provider: "discord",
      uri: channelMessagesUri,
      threadKey: encodeDiscordThreadKey({
        ...(input.guildId ? { guildId: input.guildId } : {}),
        channelId: input.channelId,
        anchorId: input.interactionId
      })
    },
    metadata: {
      applicationId: input.applicationId,
      channelId: input.channelId,
      ...(input.guildId ? { guildId: input.guildId } : {}),
      ...commandMetadata(command),
      ...(input.binding.owner && input.binding.repo
        ? { repoProvider: input.binding.repoProvider ?? "github", owner: input.binding.owner, repo: input.binding.repo }
        : {})
    }
  };
}
