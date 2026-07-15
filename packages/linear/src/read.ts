import { linearGraphql, type FetchLike } from "./graphql.js";
import {
  LINEAR_BACKLOG_READ_CONTRACT_VERSION,
  type LinearBacklogReadScope,
  type LinearCycleReference,
  type LinearIssueGetRequest,
  type LinearIssueGetResult,
  type LinearIssueListRequest,
  type LinearIssueListResult,
  type LinearIssueReadFilter,
  type LinearIssueSearchRequest,
  type LinearIssueSearchResult,
  type LinearIssueSnapshot,
  type LinearLabelReference,
  type LinearProjectReference,
  type LinearReadPagination,
  type LinearResolvedBacklogScope,
  type LinearTeamReference,
  type LinearUserReference,
  type LinearWorkflowStateReference
} from "./read-types.js";

/** Conservative Phase 1 bounds for Linear issue connections. */
export const LINEAR_ISSUE_SEARCH_MAX_PAGE_SIZE = 50;
export const LINEAR_ISSUE_SEARCH_MAX_ITEMS = 100;
export const LINEAR_ISSUE_LIST_MAX_PAGE_SIZE = 50;
export const LINEAR_ISSUE_LIST_MAX_ITEMS = 100;

const LINEAR_ISSUE_LABEL_PAGE_SIZE = 100;
// Linear currently rate-limits searchIssues calls; leave headroom for callers.
const LINEAR_ISSUE_SEARCH_MAX_PAGES = 25;
const LINEAR_ISSUE_LIST_MAX_PAGES = 100;

const LINEAR_ISSUE_SELECTION = `
  id
  identifier
  title
  url
  description
  priority
  priorityLabel
  createdAt
  updatedAt
  completedAt
  canceledAt
  dueDate
  archivedAt
  state { id name type color }
  team { id key name }
  project { id name url }
  cycle { id number name startsAt endsAt }
  assignee { id name displayName }
  labels(first: ${LINEAR_ISSUE_LABEL_PAGE_SIZE}) { nodes { id name color } }
`;

export type LinearIssueReadOptions = {
  token: string;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Linear ${context} must be an object.`);
  return value;
}

function optionalRecord(value: unknown, context: string): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredRecord(value, context);
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Linear ${context} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, context: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Linear ${context} must be a string when present.`);
  return value;
}

function optionalNumber(value: unknown, context: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Linear ${context} must be a finite number when present.`);
  return value;
}

function requirePositiveInteger(value: number, context: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${context} must be a positive integer.`);
}

function validateReadPagination(pagination: LinearReadPagination, context: "issue search" | "issue list"): void {
  requirePositiveInteger(pagination.first, `Linear ${context} pagination.first`);
  requirePositiveInteger(pagination.maxItems, `Linear ${context} pagination.maxItems`);
}

function normalizeTeam(value: unknown, context: string): LinearTeamReference {
  const node = requiredRecord(value, context);
  return {
    id: requiredString(node.id, `${context}.id`),
    key: requiredString(node.key, `${context}.key`),
    name: requiredString(node.name, `${context}.name`)
  };
}

function normalizeProject(value: unknown, context: string): LinearProjectReference {
  const node = requiredRecord(value, context);
  const url = optionalString(node.url, `${context}.url`);
  return {
    id: requiredString(node.id, `${context}.id`),
    name: requiredString(node.name, `${context}.name`),
    ...(url !== undefined ? { url } : {})
  };
}

function normalizeCycle(value: unknown, context: string): LinearCycleReference {
  const node = requiredRecord(value, context);
  const number = optionalNumber(node.number, `${context}.number`);
  const name = optionalString(node.name, `${context}.name`);
  const startsAt = optionalString(node.startsAt, `${context}.startsAt`);
  const endsAt = optionalString(node.endsAt, `${context}.endsAt`);
  return {
    id: requiredString(node.id, `${context}.id`),
    ...(number !== undefined ? { number } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(startsAt !== undefined ? { startsAt } : {}),
    ...(endsAt !== undefined ? { endsAt } : {})
  };
}

function normalizeUser(value: unknown, context: string): LinearUserReference {
  const node = requiredRecord(value, context);
  const displayName = optionalString(node.displayName, `${context}.displayName`);
  return {
    id: requiredString(node.id, `${context}.id`),
    name: requiredString(node.name, `${context}.name`),
    ...(displayName !== undefined ? { displayName } : {})
  };
}

function normalizeState(value: unknown, context: string): LinearWorkflowStateReference {
  const node = requiredRecord(value, context);
  const color = optionalString(node.color, `${context}.color`);
  return {
    id: requiredString(node.id, `${context}.id`),
    name: requiredString(node.name, `${context}.name`),
    type: requiredString(node.type, `${context}.type`),
    ...(color !== undefined ? { color } : {})
  };
}

function normalizeLabels(value: unknown, context: string): LinearLabelReference[] {
  const connection = requiredRecord(value, context);
  if (!Array.isArray(connection.nodes)) throw new Error(`Linear ${context}.nodes must be an array.`);
  return connection.nodes.map((value, index) => {
    const node = requiredRecord(value, `${context}.nodes[${index}]`);
    const color = optionalString(node.color, `${context}.nodes[${index}].color`);
    return {
      id: requiredString(node.id, `${context}.nodes[${index}].id`),
      name: requiredString(node.name, `${context}.nodes[${index}].name`),
      ...(color !== undefined ? { color } : {})
    };
  });
}

/** Convert either an Issue or IssueSearchResult node into the same safe snapshot. */
export function normalizeLinearIssueSnapshot(value: unknown, context = "issue"): LinearIssueSnapshot {
  const node = requiredRecord(value, context);
  const description = optionalString(node.description, `${context}.description`);
  const projectNode = optionalRecord(node.project, `${context}.project`);
  const cycleNode = optionalRecord(node.cycle, `${context}.cycle`);
  const assigneeNode = optionalRecord(node.assignee, `${context}.assignee`);
  const completedAt = optionalString(node.completedAt, `${context}.completedAt`);
  const canceledAt = optionalString(node.canceledAt, `${context}.canceledAt`);
  const dueDate = optionalString(node.dueDate, `${context}.dueDate`);
  const archivedAt = optionalString(node.archivedAt, `${context}.archivedAt`);
  const priorityValue = optionalNumber(node.priority, `${context}.priority`);
  const priorityLabel = optionalString(node.priorityLabel, `${context}.priorityLabel`);

  return {
    id: requiredString(node.id, `${context}.id`),
    identifier: requiredString(node.identifier, `${context}.identifier`),
    title: requiredString(node.title, `${context}.title`),
    url: requiredString(node.url, `${context}.url`),
    ...(description !== undefined ? { description } : {}),
    status: normalizeState(node.state, `${context}.state`),
    ...(priorityValue !== undefined && priorityValue > 0
      ? { priority: { value: priorityValue, ...(priorityLabel !== undefined ? { label: priorityLabel } : {}) } }
      : {}),
    team: normalizeTeam(node.team, `${context}.team`),
    ...(projectNode ? { project: normalizeProject(projectNode, `${context}.project`) } : {}),
    ...(cycleNode ? { cycle: normalizeCycle(cycleNode, `${context}.cycle`) } : {}),
    ...(assigneeNode ? { assignee: normalizeUser(assigneeNode, `${context}.assignee`) } : {}),
    labels: normalizeLabels(node.labels, `${context}.labels`),
    // Relation loading is a separate follow-up. Keep the normalized array
    // stable without leaking raw or partial GraphQL relation nodes.
    relations: [],
    createdAt: requiredString(node.createdAt, `${context}.createdAt`),
    updatedAt: requiredString(node.updatedAt, `${context}.updatedAt`),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(canceledAt !== undefined ? { canceledAt } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(archivedAt !== undefined ? { archivedAt } : {})
  };
}

function graphqlOptions(input: LinearIssueReadOptions): Pick<Parameters<typeof linearGraphql>[0], "token" | "graphqlUrl" | "fetchImpl" | "timeoutMs"> {
  return {
    token: input.token,
    fetchImpl: input.fetchImpl ?? fetch,
    ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {})
  };
}

function issueLookupValue(request: LinearIssueGetRequest): string {
  const value = "id" in request.issue ? request.issue.id : request.issue.identifier;
  return requiredString(value, "issue lookup");
}

export async function getLinearIssue(input: LinearIssueReadOptions & { request: LinearIssueGetRequest }): Promise<LinearIssueGetResult> {
  const data = await linearGraphql<{ issue?: unknown }>({
    ...graphqlOptions(input),
    query: `query OpenTagLinearIssueGet($id: String!) {
  issue(id: $id) {${LINEAR_ISSUE_SELECTION}}
}`,
    variables: { id: issueLookupValue(input.request) }
  });

  return {
    contractVersion: LINEAR_BACKLOG_READ_CONTRACT_VERSION,
    capturedAt: new Date().toISOString(),
    issue: normalizeLinearIssueSnapshot(data.issue),
    provenance: {
      provider: "linear",
      operation: "issue.get"
    }
  };
}

async function resolveLinearIssueReadScope(
  input: LinearIssueReadOptions & {
    scope: LinearBacklogReadScope;
    operation: "issue.search" | "issue.list";
  }
): Promise<LinearResolvedBacklogScope> {
  if (input.scope.projectId !== undefined || input.scope.cycle !== undefined) {
    throw new Error(
      `Linear ${input.operation} currently supports team scope only; project and cycle scope are not implemented yet.`
    );
  }
  const teamId = requiredString(input.scope.teamId, "scope.teamId");
  const data = await linearGraphql<{ team?: unknown }>({
    ...graphqlOptions(input),
    query: `query OpenTagLinearResolveIssueReadTeam($teamId: String!) {
  team(id: $teamId) { id key name }
}`,
    variables: { teamId }
  });
  return {
    team: normalizeTeam(data.team, "resolved scope team")
  };
}

function nonEmptyValues<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function buildIssueFilter(filterInput: LinearIssueReadFilter | undefined, scope: LinearResolvedBacklogScope): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    team: { id: { eq: scope.team.id } }
  };
  const stateIds = nonEmptyValues(filterInput?.stateIds);
  const state: Record<string, unknown> = {};
  if (stateIds) state.id = { in: stateIds };
  if (filterInput?.completion === "unfinished") state.type = { nin: ["completed", "canceled"] };
  if (filterInput?.completion === "completed") state.type = { eq: "completed" };
  if (Object.keys(state).length > 0) filter.state = state;

  const assigneeIds = nonEmptyValues(filterInput?.assigneeIds);
  if (assigneeIds) filter.assignee = { id: { in: assigneeIds } };
  const labelIds = nonEmptyValues(filterInput?.labelIds);
  if (labelIds) filter.labels = { id: { in: labelIds } };
  const priorities = nonEmptyValues(filterInput?.priorities);
  if (priorities) filter.priority = { in: priorities };
  return filter;
}

type LinearIssuePageInfo = {
  hasNextPage: boolean;
  endCursor?: string;
};

type LinearBoundedIssueRead = {
  items: LinearIssueSnapshot[];
  pageInfo: LinearIssuePageInfo;
  limits: {
    requestedMaxItems: number;
    appliedMaxItems: number;
    returnedItems: number;
  };
  truncated: boolean;
};

function normalizePageInfo(value: unknown, context: string): LinearIssuePageInfo {
  const pageInfo = requiredRecord(value, `${context} pageInfo`);
  if (typeof pageInfo.hasNextPage !== "boolean") {
    throw new Error(`Linear ${context} pageInfo.hasNextPage must be a boolean.`);
  }
  const endCursor = optionalString(pageInfo.endCursor, `${context} pageInfo.endCursor`);
  if (pageInfo.hasNextPage && !endCursor) throw new Error(`Linear ${context} pageInfo did not include endCursor.`);
  return {
    hasNextPage: pageInfo.hasNextPage,
    ...(endCursor !== undefined ? { endCursor } : {})
  };
}

function normalizeIssuePage(value: unknown, context: string): { nodes: unknown[]; pageInfo: LinearIssuePageInfo } {
  const connection = requiredRecord(value, `${context} result`);
  if (!Array.isArray(connection.nodes)) throw new Error(`Linear ${context} result.nodes must be an array.`);
  return {
    nodes: connection.nodes,
    pageInfo: normalizePageInfo(connection.pageInfo, context)
  };
}

async function readBoundedLinearIssuePages(input: {
  pagination: LinearReadPagination;
  maxPageSize: number;
  maxItems: number;
  maxPages: number;
  context: "issue search" | "issue list";
  readPage: (first: number, after: string | undefined) => Promise<unknown>;
}): Promise<LinearBoundedIssueRead> {
  const appliedPageSize = Math.min(input.pagination.first, input.maxPageSize);
  const appliedMaxItems = Math.min(input.pagination.maxItems, input.maxItems, input.maxPages * appliedPageSize);
  const items: LinearIssueSnapshot[] = [];
  let after = input.pagination.after;
  let pageInfo: LinearIssuePageInfo = { hasNextPage: false };
  let droppedItems = false;

  for (let page = 0; page < input.maxPages; page += 1) {
    const remaining = appliedMaxItems - items.length;
    if (remaining <= 0) break;
    const first = Math.min(appliedPageSize, remaining);
    const issuePage = normalizeIssuePage(await input.readPage(first, after), input.context);
    droppedItems ||= issuePage.nodes.length > remaining;
    items.push(
      ...issuePage.nodes
        .slice(0, remaining)
        .map((node, index) => normalizeLinearIssueSnapshot(node, `${input.context} nodes[${items.length + index}]`))
    );
    pageInfo = issuePage.pageInfo;
    if (!pageInfo.hasNextPage || items.length >= appliedMaxItems) break;
    after = pageInfo.endCursor;
  }

  return {
    items,
    pageInfo,
    limits: {
      requestedMaxItems: input.pagination.maxItems,
      appliedMaxItems,
      returnedItems: items.length
    },
    truncated: pageInfo.hasNextPage || droppedItems
  };
}

export async function searchLinearIssues(
  input: LinearIssueReadOptions & { request: LinearIssueSearchRequest }
): Promise<LinearIssueSearchResult> {
  const queryTerm = requiredString(input.request.query.trim(), "issue search query");
  validateReadPagination(input.request.pagination, "issue search");
  const resolvedScope = await resolveLinearIssueReadScope({
    ...input,
    scope: input.request.scope,
    operation: "issue.search"
  });
  const filter = buildIssueFilter(input.request.filter, resolvedScope);
  const bounded = await readBoundedLinearIssuePages({
    pagination: input.request.pagination,
    maxPageSize: LINEAR_ISSUE_SEARCH_MAX_PAGE_SIZE,
    maxItems: LINEAR_ISSUE_SEARCH_MAX_ITEMS,
    maxPages: LINEAR_ISSUE_SEARCH_MAX_PAGES,
    context: "issue search",
    readPage: async (first, after) => {
      const data = await linearGraphql<{ searchIssues?: unknown }>({
        ...graphqlOptions(input),
        query: `query OpenTagLinearIssueSearch(
  $term: String!
  $teamId: String!
  $filter: IssueFilter!
  $first: Int!
  $after: String
  $includeArchived: Boolean!
) {
  searchIssues(
    term: $term
    teamId: $teamId
    filter: $filter
    first: $first
    after: $after
    includeArchived: $includeArchived
    includeComments: false
  ) {
    nodes {${LINEAR_ISSUE_SELECTION}}
    pageInfo { hasNextPage endCursor }
  }
}`,
        variables: {
          term: queryTerm,
          teamId: resolvedScope.team.id,
          filter,
          first,
          after: after ?? null,
          includeArchived: input.request.filter?.includeArchived ?? false
        }
      });
      return data.searchIssues;
    }
  });

  return {
    contractVersion: LINEAR_BACKLOG_READ_CONTRACT_VERSION,
    capturedAt: new Date().toISOString(),
    request: input.request,
    resolvedScope,
    ...bounded,
    provenance: {
      provider: "linear",
      operation: "issue.search"
    }
  };
}

export async function listLinearIssues(
  input: LinearIssueReadOptions & { request: LinearIssueListRequest }
): Promise<LinearIssueListResult> {
  validateReadPagination(input.request.pagination, "issue list");
  const resolvedScope = await resolveLinearIssueReadScope({
    ...input,
    scope: input.request.scope,
    operation: "issue.list"
  });
  const filter = buildIssueFilter(input.request.filter, resolvedScope);
  const bounded = await readBoundedLinearIssuePages({
    pagination: input.request.pagination,
    maxPageSize: LINEAR_ISSUE_LIST_MAX_PAGE_SIZE,
    maxItems: LINEAR_ISSUE_LIST_MAX_ITEMS,
    maxPages: LINEAR_ISSUE_LIST_MAX_PAGES,
    context: "issue list",
    readPage: async (first, after) => {
      const data = await linearGraphql<{ issues?: unknown }>({
        ...graphqlOptions(input),
        query: `query OpenTagLinearIssueList(
  $filter: IssueFilter!
  $first: Int!
  $after: String
  $includeArchived: Boolean!
) {
  issues(
    filter: $filter
    first: $first
    after: $after
    includeArchived: $includeArchived
  ) {
    nodes {${LINEAR_ISSUE_SELECTION}}
    pageInfo { hasNextPage endCursor }
  }
}`,
        variables: {
          filter,
          first,
          after: after ?? null,
          includeArchived: input.request.filter?.includeArchived ?? false
        }
      });
      return data.issues;
    }
  });

  return {
    contractVersion: LINEAR_BACKLOG_READ_CONTRACT_VERSION,
    capturedAt: new Date().toISOString(),
    request: input.request,
    resolvedScope,
    ...bounded,
    provenance: {
      provider: "linear",
      operation: "issue.list"
    }
  };
}
