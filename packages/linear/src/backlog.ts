import { linearGraphql, type FetchLike } from "./graphql.js";

export const LINEAR_BACKLOG_PAGE_SIZE = 100;
export const DEFAULT_LINEAR_BACKLOG_TIMEOUT_MS = 10_000;

export type LinearBacklogIssue = {
  identifier: string;
  title: string;
  url: string;
  stateName: string;
  stateType: string;
  priority: number;
};

export type LinearProjectBacklog = {
  issues: LinearBacklogIssue[];
  fetched: number;
  hasMore: boolean;
  projectName: string | null;
};

const BACKLOG_QUERY = `query OpenTagProjectBacklog($projectId: ID!, $first: Int!) {
  project(id: $projectId) { name }
  issues(
    filter: {
      project: { id: { eq: $projectId } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
    first: $first
  ) {
    nodes { identifier title url priority state { name type } }
    pageInfo { hasNextPage }
  }
}`;

const STATE_TYPE_ORDER: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, triage: 3 };

function issueNumber(identifier: string): number {
  const value = Number(identifier.split("-")[1]);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

// Linear priority semantics: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
// Rank "none" after every set priority so unprioritized issues sort last
// within their state type.
function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

export async function fetchLinearProjectBacklog(input: {
  token: string;
  projectId: string;
  graphqlUrl?: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}): Promise<LinearProjectBacklog> {
  const data = await linearGraphql<{
    project: { name: string } | null;
    issues: {
      nodes: Array<{
        identifier: string;
        title: string;
        url: string;
        priority: number | null;
        state: { name: string; type: string };
      }>;
      pageInfo: { hasNextPage: boolean };
    };
  }>({
    token: input.token,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    query: BACKLOG_QUERY,
    variables: { projectId: input.projectId, first: LINEAR_BACKLOG_PAGE_SIZE },
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs ?? DEFAULT_LINEAR_BACKLOG_TIMEOUT_MS
  });
  const issues = data.issues.nodes
    .map((node) => ({
      identifier: node.identifier,
      title: node.title,
      url: node.url,
      stateName: node.state.name,
      stateType: node.state.type,
      priority: node.priority ?? 0
    }))
    .sort(
      (a, b) =>
        (STATE_TYPE_ORDER[a.stateType] ?? 9) - (STATE_TYPE_ORDER[b.stateType] ?? 9) ||
        priorityRank(a.priority) - priorityRank(b.priority) ||
        issueNumber(a.identifier) - issueNumber(b.identifier)
    );
  return {
    issues,
    fetched: issues.length,
    hasMore: data.issues.pageInfo.hasNextPage,
    projectName: data.project?.name ?? null
  };
}
