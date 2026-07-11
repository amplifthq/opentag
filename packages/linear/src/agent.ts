import { parseOpenTagMention, type ContextPointer, type OpenTagEvent, type PermissionGrant, type WorkItemReference } from "@opentag/core";
import { linearGraphql, type FetchLike } from "./graphql.js";
import { DEFAULT_LINEAR_GRAPHQL_URL, type LinearProjectTarget } from "./normalize.js";

export type LinearAgentActivityType = "thought" | "action" | "response" | "prompt" | "error" | "elicitation";

export type LinearAgentActivityInput = {
  agentSessionId: string;
  type: Exclude<LinearAgentActivityType, "prompt">;
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
  ephemeral?: boolean;
  signal?: "auth" | "continue" | "select" | "stop";
  signalMetadata?: Record<string, unknown>;
};

export type LinearAgentSessionPlanStep = {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
};

export type LinearAgentSessionEventPayload = {
  type?: unknown;
  action?: unknown;
  webhookId?: unknown;
  webhookTimestamp?: unknown;
  createdAt?: unknown;
  organizationId?: unknown;
  oauthClientId?: unknown;
  appUserId?: unknown;
  promptContext?: unknown;
  previousComments?: unknown;
  guidance?: unknown;
  agentActivity?: unknown;
  agentSession?: unknown;
};

export function linearAgentSessionCallbackUri(agentSessionId: string): string {
  return `linear://agent-session/${encodeURIComponent(agentSessionId)}/activities`;
}

export function linearAgentSessionIdFromCallbackUri(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "linear:" || parsed.hostname !== "agent-session") return null;
    const agentSessionId = parsed.pathname.split("/").filter(Boolean)[0];
    return agentSessionId ? decodeURIComponent(agentSessionId) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function issueFromAgentSession(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.issue)) return undefined;
  return value.issue;
}

function userFromAgentSession(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.creator)) return undefined;
  return value.creator;
}

export function linearAgentActivityBody(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const directBody = stringValue(value.body);
  if (directBody) return directBody;
  if (!isRecord(value.content)) return undefined;
  return stringValue(value.content.body);
}

function activityBody(value: unknown): string | undefined {
  return linearAgentActivityBody(value);
}

function issueWorkItem(input: { issue: Record<string, unknown>; organizationId?: string }): WorkItemReference | undefined {
  const issueId = stringValue(input.issue.id);
  const identifier = stringValue(input.issue.identifier) ?? issueId;
  const url = stringValue(input.issue.url);
  if (!issueId || !identifier || !url) return undefined;
  const team = isRecord(input.issue.team) ? input.issue.team : undefined;
  const teamId = stringValue(team?.id) ?? stringValue(input.issue.teamId) ?? "unknown";
  const teamKey = stringValue(team?.key);
  return {
    provider: "linear",
    kind: "issue",
    externalId: identifier,
    uri: url,
    ...(stringValue(input.issue.title) ? { title: stringValue(input.issue.title) } : {}),
    ownerContainer: {
      provider: "linear",
      id: teamId,
      ...(teamKey ? { uri: `linear://team/${encodeURIComponent(teamKey)}` } : {})
    },
    metadata: {
      issueId,
      issueIdentifier: identifier,
      teamId,
      ...(teamKey ? { teamKey } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {})
    }
  };
}

function agentPermissions(): PermissionGrant[] {
  return [
    { scope: "agent:activity", reason: "send native Linear agent activities" },
    { scope: "runner:local", reason: "execute the run on a paired local daemon" },
    { scope: "repo:read", reason: "inspect the repository in the paired local checkout" },
    { scope: "repo:write", reason: "commit code changes on an isolated run branch" },
    { scope: "pr:create", reason: "open a pull request or merge request for completed code changes" }
  ];
}

function issueContext(issue: Record<string, unknown> | undefined): ContextPointer[] {
  const url = stringValue(issue?.url);
  return url
    ? [
        {
          provider: "linear",
          kind: "issue",
          uri: url,
          ...(stringValue(issue?.title) ? { title: stringValue(issue?.title) } : {}),
          visibility: "organization"
        }
      ]
    : [];
}

export function normalizeLinearAgentSessionEvent(input: {
  payload: LinearAgentSessionEventPayload;
  projectTarget?: LinearProjectTarget;
  graphqlUrl?: string;
}): OpenTagEvent | null {
  const agentSession = isRecord(input.payload.agentSession) ? input.payload.agentSession : undefined;
  const agentSessionId = stringValue(agentSession?.id);
  if (!agentSession || !agentSessionId) return null;

  const organizationId = stringValue(input.payload.organizationId);
  const issue = issueFromAgentSession(agentSession);
  const issueId = stringValue(issue?.id) ?? stringValue(agentSession.issueId);
  const issueIdentifier = stringValue(issue?.identifier) ?? issueId;
  const team = isRecord(issue?.team) ? issue.team : undefined;
  const teamId = stringValue(team?.id) ?? stringValue(issue?.teamId);
  const teamKey = stringValue(team?.key);
  const actor = userFromAgentSession(agentSession);
  const actorId = stringValue(actor?.id) ?? stringValue(agentSession.creatorId) ?? "unknown";
  const action = stringValue(input.payload.action);
  const promptContext = stringValue(input.payload.promptContext);
  const promptedActivityBody = activityBody(input.payload.agentActivity);
  const fallbackPrompt = stringValue(issue?.title) ?? `Linear agent session ${agentSessionId}`;
  // For mention-created sessions, the root comment holds the user's actual request;
  // promptContext is the surrounding issue XML and belongs in context, not in the command.
  const rootComment = isRecord(agentSession.comment) ? agentSession.comment : undefined;
  const rootCommentMention = stringValue(rootComment?.body) ? parseOpenTagMention(stringValue(rootComment?.body)!) : undefined;
  const rootCommentPrompt = rootCommentMention?.matched ? rootCommentMention.rawText : undefined;
  const prompt =
    action === "prompted"
      ? (promptedActivityBody ?? promptContext ?? fallbackPrompt)
      : (rootCommentPrompt ?? promptContext ?? promptedActivityBody ?? fallbackPrompt);
  // Agent sessions live on an issue; keying the conversation by that issue (matching the
  // comment channel's thread key) keeps proposals, follow-up queueing, and thread actions
  // shared across both channels instead of splitting per session.
  const issueThreadRef = issueIdentifier ?? issueId;
  const threadKey = issueThreadRef
    ? `${teamKey ?? teamId ?? organizationId ?? "linear"}|issue|${issueThreadRef}`
    : `${teamKey ?? teamId ?? organizationId ?? "linear"}|agent-session|${agentSessionId}`;
  const agentActivityId = isRecord(input.payload.agentActivity) ? stringValue(input.payload.agentActivity.id) : undefined;
  const eventId = agentActivityId ?? agentSessionId;

  return {
    id: `evt_linear_agent_session_${eventId}`,
    source: "linear",
    sourceEventId: eventId,
    receivedAt: stringValue(input.payload.createdAt) ?? new Date().toISOString(),
    actor: {
      provider: "linear",
      providerUserId: actorId,
      ...(stringValue(actor?.name) ? { handle: stringValue(actor?.name) } : {}),
      ...(organizationId ? { organizationId } : {})
    },
    target: {
      mention: "@linear-agent",
      agentId: "opentag"
    },
    command: {
      rawText: prompt,
      intent: "run",
      args: {}
    },
    context: issueContext(issue),
    ...(issue ? { workItem: issueWorkItem({ issue, ...(organizationId ? { organizationId } : {}) }) } : {}),
    permissions: agentPermissions(),
    callback: {
      provider: "linear",
      uri: linearAgentSessionCallbackUri(agentSessionId),
      threadKey
    },
    metadata: {
      repoProvider: input.projectTarget?.repoProvider,
      owner: input.projectTarget?.owner,
      repo: input.projectTarget?.repo,
      agentSessionId,
      action,
      appUserId: stringValue(input.payload.appUserId),
      oauthClientId: stringValue(input.payload.oauthClientId),
      ...(issueId ? { issueId } : {}),
      ...(issueIdentifier ? { issueIdentifier } : {}),
      ...(stringValue(issue?.title) ? { issueTitle: stringValue(issue?.title) } : {}),
      ...(teamId ? { teamId } : {}),
      ...(teamKey ? { teamKey } : {}),
      ...(organizationId ? { organizationId } : {}),
      graphqlUrl: input.graphqlUrl ?? DEFAULT_LINEAR_GRAPHQL_URL
    }
  };
}

function activityContent(input: LinearAgentActivityInput): Record<string, unknown> {
  if (input.type === "action") {
    return {
      type: "action",
      action: input.action ?? "OpenTag",
      parameter: input.parameter ?? input.body ?? "",
      ...(input.result ? { result: input.result } : {})
    };
  }
  return {
    type: input.type,
    body: input.body ?? ""
  };
}

export async function createLinearAgentActivity(input: {
  token: string;
  graphqlUrl?: string;
  activity: LinearAgentActivityInput;
  fetchImpl?: FetchLike;
}): Promise<string | undefined> {
  const data = await linearGraphql<{
    agentActivityCreate?: {
      success?: boolean;
      agentActivity?: { id?: string };
    };
  }>({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    fetchImpl: input.fetchImpl ?? fetch,
    query: `mutation OpenTagCreateLinearAgentActivity($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) {
    success
    agentActivity { id }
  }
}`,
    variables: {
      input: {
        agentSessionId: input.activity.agentSessionId,
        content: activityContent(input.activity),
        ...(input.activity.ephemeral !== undefined ? { ephemeral: input.activity.ephemeral } : {}),
        ...(input.activity.signal ? { signal: input.activity.signal } : {}),
        ...(input.activity.signalMetadata ? { signalMetadata: input.activity.signalMetadata } : {})
      }
    }
  });
  if (data.agentActivityCreate?.success === false) {
    throw new Error("Linear agentActivityCreate returned success=false.");
  }
  return data.agentActivityCreate?.agentActivity?.id;
}

export async function updateLinearAgentSession(input: {
  token: string;
  agentSessionId: string;
  plan?: LinearAgentSessionPlanStep[];
  externalLinks?: Array<{ label: string; url: string }>;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const data = await linearGraphql<{
    agentSessionUpdate?: { success?: boolean };
  }>({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    fetchImpl: input.fetchImpl ?? fetch,
    query: `mutation OpenTagUpdateLinearAgentSession($agentSessionId: String!, $input: AgentSessionUpdateInput!) {
  agentSessionUpdate(id: $agentSessionId, input: $input) {
    success
  }
}`,
    variables: {
      agentSessionId: input.agentSessionId,
      input: {
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.externalLinks ? { externalUrls: input.externalLinks } : {})
      }
    }
  });
  if (data.agentSessionUpdate?.success === false) {
    throw new Error("Linear agentSessionUpdate returned success=false.");
  }
}

export function acceptedLinearAgentSessionPlan(): LinearAgentSessionPlanStep[] {
  return [
    {
      content: "Accept the Linear agent session",
      status: "completed"
    },
    {
      content: "Run OpenTag on the paired local checkout",
      status: "inProgress"
    },
    {
      content: "Report the result back to Linear",
      status: "pending"
    }
  ];
}

export async function acknowledgeLinearAgentSession(input: {
  token: string;
  agentSessionId: string;
  runId?: string;
  body?: string;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<string | undefined> {
  await updateLinearAgentSession({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    agentSessionId: input.agentSessionId,
    plan: acceptedLinearAgentSessionPlan(),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
  return createLinearAgentActivity({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    activity: {
      agentSessionId: input.agentSessionId,
      type: "thought",
      body: input.body ?? `OpenTag accepted this Linear agent session${input.runId ? ` and queued run ${input.runId}` : ""}.`
    },
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {})
  });
}
