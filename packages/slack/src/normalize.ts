import { commandFromRawText, type ContextPointer, type OpenTagCommand, type OpenTagEvent, type PermissionGrant } from "@opentag/core";

export type SlackChannelBinding = {
  teamId: string;
  channelId: string;
  repoProvider?: string;
  owner: string;
  repo: string;
};

export type SlackAppMentionInput = {
  teamId: string;
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  eventId: string;
  eventTime: number;
  appId?: string;
  agentId?: string;
  botUserId?: string;
  callbackUri?: string;
  binding: SlackChannelBinding;
};

export function stripSlackAppMention(text: string, botUserId?: string): string | null {
  const patterns = botUserId
    ? [new RegExp(`^<@${botUserId}>\\s*`, "i"), /^<@[^>]+>\s*/]
    : [/^<@[^>]+>\s*/];

  for (const pattern of patterns) {
    const stripped = text.replace(pattern, "").trim();
    if (stripped !== text.trim()) {
      return stripped.length > 0 ? stripped : null;
    }
  }

  return null;
}

export function encodeSlackThreadKey(input: { teamId: string; channelId: string; threadTs: string }): string {
  return `${input.teamId}|${input.channelId}|${input.threadTs}`;
}

export function parseSlackThreadKey(threadKey: string): { teamId: string; channelId: string; threadTs: string } {
  const [teamId, channelId, threadTs] = threadKey.split("|");
  if (!teamId || !channelId || !threadTs) {
    throw new Error(`Invalid Slack thread key: ${threadKey}`);
  }
  return { teamId, channelId, threadTs };
}

function permissionsForIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    {
      scope: "chat:postMessage",
      reason: "reply in the originating Slack thread"
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

function referenceTitle(reference: NonNullable<OpenTagCommand["parsed"]>["references"][number]): string {
  return reference.title ?? "Command file reference";
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

export function normalizeSlackAppMention(input: SlackAppMentionInput): OpenTagEvent | null {
  const rawText = stripSlackAppMention(input.text, input.botUserId);
  if (!rawText) return null;

  const command = commandFromRawText(rawText);
  const replyThreadTs = input.threadTs ?? input.ts;
  const agentId = input.agentId ?? "opentag";

  return {
    id: `evt_slack_app_mention_${input.eventId}`,
    source: "slack",
    sourceEventId: input.eventId,
    receivedAt: new Date(input.eventTime * 1000).toISOString(),
    actor: {
      provider: "slack",
      providerUserId: input.userId,
      handle: input.userId,
      organizationId: input.teamId
    },
    target: {
      mention: input.botUserId ? `<@${input.botUserId}>` : "<@app>",
      agentId,
      ...(command.parsed?.executorHint ? { executorHint: command.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "slack",
        kind: "message",
        uri: `slack://team/${input.teamId}/channel/${input.channelId}/message/${input.ts}`,
        visibility: "organization",
        title: "Slack message"
      },
      {
        kind: "text",
        uri: input.text,
        visibility: "organization",
        title: "Slack message text"
      },
      ...contextPointersForCommand(command)
    ],
    permissions: permissionsForIntent(command.intent),
    callback: {
      provider: "slack",
      uri: input.callbackUri ?? "https://slack.com/api/chat.postMessage",
      threadKey: encodeSlackThreadKey({
        teamId: input.teamId,
        channelId: input.channelId,
        threadTs: replyThreadTs
      })
    },
    metadata: {
      teamId: input.teamId,
      channelId: input.channelId,
      messageTs: input.ts,
      ...(input.appId ? { slackAppId: input.appId } : {}),
      ...(input.botUserId ? { slackBotUserId: input.botUserId } : {}),
      ...commandMetadata(command),
      repoProvider: input.binding.repoProvider ?? "github",
      owner: input.binding.owner,
      repo: input.binding.repo
    }
  };
}
