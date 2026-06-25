import { parseOpenTagMention, type OpenTagEvent } from "@opentag/core";
import type { ContextPointer, OpenTagCommand, PermissionGrant } from "@opentag/core";

export type GitHubIssueCommentInput = {
  id: string;
  commentBody: string;
  commentUrl: string;
  apiCommentsUrl: string;
  issueUrl: string;
  issueNumber: number;
  owner: string;
  repo: string;
  actorId: number;
  actorLogin: string;
  private: boolean;
  receivedAt: string;
  installationId?: number;
};

export type GitHubPullRequestReviewCommentInput = {
  id: string;
  commentBody: string;
  commentUrl: string;
  pullRequestUrl: string;
  apiCommentsUrl: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  actorId: number;
  actorLogin: string;
  private: boolean;
  receivedAt: string;
  installationId?: number;
};

function permissionsForIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    {
      scope: "issue:comment",
      reason: "reply to the source GitHub thread"
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

function contextPointersForCommand(command: OpenTagCommand, privateRepo: boolean): ContextPointer[] {
  const visibility = privateRepo ? "private" : "public";
  const context: ContextPointer[] = [];

  for (const reference of command.parsed?.references ?? []) {
    if (reference.kind === "url") {
      context.push({
        kind: "url",
        uri: reference.uri,
        visibility,
        title: reference.title ?? "Command URL reference"
      });
      continue;
    }

    if (reference.kind === "file" || reference.kind === "path") {
      context.push({
        kind: "file",
        uri: uriWithLineFragment(reference.uri, reference.startLine, reference.endLine, reference.line),
        visibility,
        title: reference.title ?? "Command file reference"
      });
    }
  }

  return context;
}

function uriWithLineFragment(uri: string, startLine?: number, endLine?: number, line?: number): string {
  if (startLine && endLine) {
    return `${uri}#L${startLine}-L${endLine}`;
  }
  if (line) {
    return `${uri}#L${line}`;
  }
  return uri;
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

export function normalizeGitHubIssueComment(input: GitHubIssueCommentInput): OpenTagEvent | null {
  const mention = parseOpenTagMention(input.commentBody);
  if (!mention.matched) return null;

  const command = {
    rawText: mention.rawText,
    intent: mention.intent,
    args: mention.args,
    ...(mention.parsed ? { parsed: mention.parsed } : {})
  };

  return {
    id: `evt_github_comment_${input.id}`,
    source: "github",
    sourceEventId: input.id,
    receivedAt: input.receivedAt,
    actor: {
      provider: "github",
      providerUserId: String(input.actorId),
      handle: input.actorLogin
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      ...(mention.parsed?.executorHint ? { executorHint: mention.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        kind: "github.issue",
        uri: input.issueUrl,
        visibility: input.private ? "private" : "public"
      },
      {
        kind: "github.comment",
        uri: input.commentUrl,
        visibility: input.private ? "private" : "public"
      },
      ...contextPointersForCommand(command, input.private)
    ],
    permissions: permissionsForIntent(mention.intent),
    callback: {
      provider: "github",
      uri: input.apiCommentsUrl,
      threadKey: `${input.owner}/${input.repo}`
    },
    metadata: {
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.issueNumber,
      ...commandMetadata(command),
      ...(typeof input.installationId === "number" ? { installationId: input.installationId } : {})
    }
  };
}

export function normalizeGitHubPullRequestReviewComment(input: GitHubPullRequestReviewCommentInput): OpenTagEvent | null {
  const mention = parseOpenTagMention(input.commentBody);
  if (!mention.matched) return null;

  const command = {
    rawText: mention.rawText,
    intent: mention.intent,
    args: mention.args,
    ...(mention.parsed ? { parsed: mention.parsed } : {})
  };

  return {
    id: `evt_github_pr_review_comment_${input.id}`,
    source: "github",
    sourceEventId: input.id,
    receivedAt: input.receivedAt,
    actor: {
      provider: "github",
      providerUserId: String(input.actorId),
      handle: input.actorLogin
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      ...(mention.parsed?.executorHint ? { executorHint: mention.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        kind: "github.pull_request",
        uri: input.pullRequestUrl,
        visibility: input.private ? "private" : "public"
      },
      {
        kind: "github.comment",
        uri: input.commentUrl,
        visibility: input.private ? "private" : "public"
      },
      ...contextPointersForCommand(command, input.private)
    ],
    permissions: permissionsForIntent(mention.intent),
    callback: {
      provider: "github",
      uri: input.apiCommentsUrl,
      threadKey: `${input.owner}/${input.repo}#${input.pullRequestNumber}`
    },
    metadata: {
      owner: input.owner,
      repo: input.repo,
      pullRequestNumber: input.pullRequestNumber,
      ...commandMetadata(command),
      ...(typeof input.installationId === "number" ? { installationId: input.installationId } : {})
    }
  };
}
