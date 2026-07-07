import { parseOpenTagMention, type ContextPointer, type OpenTagCommand, type OpenTagEvent, type PermissionGrant, type WorkItemReference } from "@opentag/core";

export const DEFAULT_LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export type LinearProjectTarget = {
  repoProvider: string;
  owner: string;
  repo: string;
};

export type LinearIssueCommentInput = {
  id: string;
  commentBody: string;
  commentUrl?: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle?: string;
  issueUrl: string;
  teamId: string;
  teamKey?: string;
  teamName?: string;
  organizationId?: string;
  actorId: string;
  actorName?: string;
  actorDisplayName?: string;
  actorEmail?: string;
  receivedAt: string;
  projectTarget?: LinearProjectTarget;
  graphqlUrl?: string;
};

function permissionsForIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    {
      scope: "issue:comment",
      reason: "reply to the source Linear issue"
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
        reason: "open a pull request or merge request for completed code changes"
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
    if (reference.kind === "file" || reference.kind === "path" || reference.kind === "line" || reference.kind === "range") {
      context.push({
        kind: "file",
        uri: reference.uri,
        ...(reference.line ? { line: reference.line } : {}),
        ...(reference.startLine ? { startLine: reference.startLine } : {}),
        ...(reference.endLine ? { endLine: reference.endLine } : {}),
        visibility: "organization",
        title: reference.title ?? "Command file reference"
      });
    }
  }
  return context;
}

function linearWorkItem(input: LinearIssueCommentInput): WorkItemReference {
  return {
    provider: "linear",
    kind: "issue",
    externalId: input.issueIdentifier || input.issueId,
    uri: input.issueUrl,
    ...(input.issueTitle ? { title: input.issueTitle } : {}),
    ownerContainer: {
      provider: "linear",
      id: input.teamId,
      ...(input.teamKey ? { uri: `linear://team/${encodeURIComponent(input.teamKey)}` } : {})
    },
    metadata: {
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      teamId: input.teamId,
      ...(input.teamKey ? { teamKey: input.teamKey } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {})
    }
  };
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

function actorHandle(input: LinearIssueCommentInput): string | undefined {
  return input.actorDisplayName ?? input.actorName ?? input.actorEmail;
}

export function linearIssueCallbackUri(issueId: string): string {
  return `linear://issue/${encodeURIComponent(issueId)}/comments`;
}

export function linearIssueIdFromCallbackUri(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "linear:" || parsed.hostname !== "issue") return null;
    const issueId = parsed.pathname.split("/").filter(Boolean)[0];
    return issueId ? decodeURIComponent(issueId) : null;
  } catch {
    return null;
  }
}

export function normalizeLinearIssueComment(input: LinearIssueCommentInput): OpenTagEvent | null {
  const mention = parseOpenTagMention(input.commentBody);
  if (!mention.matched) return null;

  const command = {
    rawText: mention.rawText,
    intent: mention.intent,
    args: mention.args,
    ...(mention.parsed ? { parsed: mention.parsed } : {})
  };
  const threadKey = `${input.teamKey ?? input.teamId}|issue|${input.issueIdentifier || input.issueId}`;

  return {
    id: `evt_linear_comment_${input.id}`,
    source: "linear",
    sourceEventId: input.id,
    receivedAt: input.receivedAt,
    actor: {
      provider: "linear",
      providerUserId: input.actorId,
      ...(actorHandle(input) ? { handle: actorHandle(input) } : {}),
      ...(input.actorDisplayName ? { displayName: input.actorDisplayName } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {})
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      ...(mention.parsed?.executorHint ? { executorHint: mention.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "linear",
        kind: "issue",
        uri: input.issueUrl,
        ...(input.issueTitle ? { title: input.issueTitle } : {}),
        visibility: "organization"
      },
      ...(input.commentUrl
        ? [
            {
              provider: "linear",
              kind: "comment",
              uri: input.commentUrl,
              visibility: "organization" as const
            }
          ]
        : []),
      ...contextPointersForCommand(command)
    ],
    workItem: linearWorkItem(input),
    permissions: permissionsForIntent(mention.intent),
    callback: {
      provider: "linear",
      uri: linearIssueCallbackUri(input.issueId),
      threadKey
    },
    metadata: {
      repoProvider: input.projectTarget?.repoProvider,
      owner: input.projectTarget?.owner,
      repo: input.projectTarget?.repo,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      ...(input.issueTitle ? { issueTitle: input.issueTitle } : {}),
      teamId: input.teamId,
      ...(input.teamKey ? { teamKey: input.teamKey } : {}),
      ...(input.teamName ? { teamName: input.teamName } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      graphqlUrl: input.graphqlUrl ?? DEFAULT_LINEAR_GRAPHQL_URL,
      ...commandMetadata(command)
    }
  };
}
