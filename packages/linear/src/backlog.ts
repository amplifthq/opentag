import { linearGraphql, type FetchLike } from "./graphql.js";

export const LINEAR_BACKLOG_PAGE_SIZE = 100;
export const DEFAULT_LINEAR_BACKLOG_TIMEOUT_MS = 10_000;

export type LinearBacklogIssue = {
  identifier: string;
  title: string;
  url: string;
  stateName: string;
  stateType: string;
};

export type LinearProjectBacklog = {
  issues: LinearBacklogIssue[];
  fetched: number;
  hasMore: boolean;
};

const BACKLOG_QUERY = `query OpenTagProjectBacklog($projectId: ID!, $first: Int!) {
  issues(
    filter: {
      project: { id: { eq: $projectId } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
    first: $first
  ) {
    nodes { identifier title url state { name type } }
    pageInfo { hasNextPage }
  }
}`;

const STATE_TYPE_ORDER: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, triage: 3 };

function issueNumber(identifier: string): number {
  const value = Number(identifier.split("-")[1]);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export async function fetchLinearProjectBacklog(input: {
  token: string;
  projectId: string;
  graphqlUrl?: string;
  fetchImpl: FetchLike;
  timeoutMs?: number;
}): Promise<LinearProjectBacklog> {
  const data = await linearGraphql<{
    issues: {
      nodes: Array<{ identifier: string; title: string; url: string; state: { name: string; type: string } }>;
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
      stateType: node.state.type
    }))
    .sort(
      (a, b) =>
        (STATE_TYPE_ORDER[a.stateType] ?? 9) - (STATE_TYPE_ORDER[b.stateType] ?? 9) ||
        issueNumber(a.identifier) - issueNumber(b.identifier)
    );
  return { issues, fetched: issues.length, hasMore: data.issues.pageInfo.hasNextPage };
}
