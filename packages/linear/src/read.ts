import { linearGraphql, type FetchLike } from "./graphql.js";
import {
  LINEAR_BACKLOG_READ_CONTRACT_VERSION,
  type LinearBacklogSnapshot,
  type LinearBacklogReadScope,
  type LinearCycleReference,
  type LinearIssueGetRequest,
  type LinearIssueGetResult,
  type LinearIssueListRequest,
  type LinearIssueListResult,
  type LinearIssueReadFilter,
  type LinearIssueReference,
  type LinearIssueRelationSnapshot,
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
export const LINEAR_ISSUE_RELATION_MAX_ITEMS = 100;

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
  relations(first: ${LINEAR_ISSUE_RELATION_MAX_ITEMS}) {
    nodes { type relatedIssue { id identifier title url } }
    pageInfo { hasNextPage }
  }
  inverseRelations(first: ${LINEAR_ISSUE_RELATION_MAX_ITEMS}) {
    nodes { type issue { id identifier title url } }
    pageInfo { hasNextPage }
  }
`;

export type LinearIssueReadOptions = {
  token: string;
  graphqlUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export type LinearBacklogSnapshotOptions = LinearIssueReadOptions & {
  request: LinearIssueListRequest;
  /** Optional safe workspace identifier for provenance; never pass a token or secret. */
  workspaceId?: string;
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

function normalizeIssueReference(value: unknown, context: string): LinearIssueReference {
  const node = requiredRecord(value, context);
  return {
    id: requiredString(node.id, `${context}.id`),
    identifier: requiredString(node.identifier, `${context}.identifier`),
    title: requiredString(node.title, `${context}.title`),
    url: requiredString(node.url, `${context}.url`)
  };
}

function normalizeIssueRelations(value: unknown, direction: "outgoing" | "incoming", context: string): LinearIssueRelationSnapshot[] {
  const connection = requiredRecord(value, context);
  if (!Array.isArray(connection.nodes)) throw new Error(`Linear ${context}.nodes must be an array.`);
  const pageInfo = requiredRecord(connection.pageInfo, `${context}.pageInfo`);
  if (typeof pageInfo.hasNextPage !== "boolean") {
    throw new Error(`Linear ${context}.pageInfo.hasNextPage must be a boolean.`);
  }
  if (pageInfo.hasNextPage) {
    throw new Error(`Linear ${context} exceeded the ${LINEAR_ISSUE_RELATION_MAX_ITEMS}-relation safety limit.`);
  }

  const relations: LinearIssueRelationSnapshot[] = [];
  for (const [index, value] of connection.nodes.entries()) {
    const node = requiredRecord(value, `${context}.nodes[${index}]`);
    const type = requiredString(node.type, `${context}.nodes[${index}].type`);
    if (type !== "blocks" && type !== "related") continue;
    relations.push({
      kind: type === "blocks" ? (direction === "outgoing" ? "blocks" : "blocked_by") : "related",
      issue: normalizeIssueReference(
        direction === "outgoing" ? node.relatedIssue : node.issue,
        `${context}.nodes[${index}].${direction === "outgoing" ? "relatedIssue" : "issue"}`
      )
    });
  }
  return relations;
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
  const relations = normalizeIssueRelations(node.relations, "outgoing", `${context}.relations`);
  const inverseRelations = normalizeIssueRelations(node.inverseRelations, "incoming", `${context}.inverseRelations`);
  if (relations.length + inverseRelations.length > LINEAR_ISSUE_RELATION_MAX_ITEMS) {
    throw new Error(`Linear ${context} exceeded the ${LINEAR_ISSUE_RELATION_MAX_ITEMS}-relation safety limit.`);
  }

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
    relations: [...relations, ...inverseRelations],
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
  const teamId = requiredString(input.scope.teamId, "scope.teamId");
  const projectId =
    input.scope.projectId !== undefined ? requiredString(input.scope.projectId, "scope.projectId") : undefined;
  const cycleSelector = input.scope.cycle;
  if (cycleSelector !== undefined && cycleSelector.kind !== "id" && cycleSelector.kind !== "current") {
    throw new Error("Linear scope.cycle.kind must be either id or current.");
  }
  const requestedCycleId =
    cycleSelector?.kind === "id" ? requiredString(cycleSelector.id, "scope.cycle.id") : undefined;
  const data = await linearGraphql<{ team?: unknown }>({
    ...graphqlOptions(input),
    query: `query OpenTagLinearResolveIssueReadTeam($teamId: String!) {
  team(id: $teamId) { id key name }
}`,
    variables: { teamId }
  });
  const team = normalizeTeam(data.team, "resolved scope team");
  let project: LinearProjectReference | undefined;
  let cycle: LinearCycleReference | undefined;

  if (projectId !== undefined) {
    const projectData = await linearGraphql<{ project?: unknown }>({
      ...graphqlOptions(input),
      query: `query OpenTagLinearResolveIssueReadProject($projectId: String!, $teamId: ID!) {
  project(id: $projectId) {
    id
    name
    url
    teams(first: 1, filter: { id: { eq: $teamId } }) { nodes { id } }
  }
}`,
      variables: { projectId, teamId: team.id }
    });
    const projectNode = requiredRecord(projectData.project, "resolved scope project");
    const projectTeams = requiredRecord(projectNode.teams, "resolved scope project.teams");
    if (!Array.isArray(projectTeams.nodes)) throw new Error("Linear resolved scope project.teams.nodes must be an array.");
    if (projectTeams.nodes.length !== 1) {
      throw new Error(`Linear ${input.operation} project ${projectId} is not associated with team ${team.id}.`);
    }
    project = normalizeProject(projectNode, "resolved scope project");
  }

  if (requestedCycleId !== undefined) {
    const cycleData = await linearGraphql<{ cycle?: unknown }>({
      ...graphqlOptions(input),
      query: `query OpenTagLinearResolveIssueReadCycle($cycleId: String!) {
  cycle(id: $cycleId) { id number name startsAt endsAt team { id } }
}`,
      variables: { cycleId: requestedCycleId }
    });
    const cycleNode = requiredRecord(cycleData.cycle, "resolved scope cycle");
    const cycleTeam = requiredRecord(cycleNode.team, "resolved scope cycle.team");
    if (requiredString(cycleTeam.id, "resolved scope cycle.team.id") !== team.id) {
      throw new Error(`Linear ${input.operation} cycle ${requestedCycleId} does not belong to team ${team.id}.`);
    }
    cycle = normalizeCycle(cycleNode, "resolved scope cycle");
  } else if (cycleSelector?.kind === "current") {
    const cycleData = await linearGraphql<{ cycles?: unknown }>({
      ...graphqlOptions(input),
      query: `query OpenTagLinearResolveIssueReadCurrentCycle($teamId: ID!) {
  cycles(first: 2, filter: { team: { id: { eq: $teamId } }, isActive: { eq: true } }) {
    nodes { id number name startsAt endsAt team { id } }
  }
}`,
      variables: { teamId: team.id }
    });
    const cycleConnection = requiredRecord(cycleData.cycles, "resolved current cycle");
    if (!Array.isArray(cycleConnection.nodes)) throw new Error("Linear resolved current cycle.nodes must be an array.");
    if (cycleConnection.nodes.length === 0) {
      throw new Error(`Linear ${input.operation} could not resolve an active cycle for team ${team.id}.`);
    }
    if (cycleConnection.nodes.length > 1) {
      throw new Error(`Linear ${input.operation} resolved more than one active cycle for team ${team.id}.`);
    }
    const cycleNode = requiredRecord(cycleConnection.nodes[0], "resolved current cycle.nodes[0]");
    const cycleTeam = requiredRecord(cycleNode.team, "resolved current cycle.nodes[0].team");
    if (requiredString(cycleTeam.id, "resolved current cycle.nodes[0].team.id") !== team.id) {
      throw new Error(`Linear ${input.operation} current cycle does not belong to team ${team.id}.`);
    }
    cycle = normalizeCycle(cycleNode, "resolved current cycle.nodes[0]");
  }

  return {
    team,
    ...(project !== undefined ? { project } : {}),
    ...(cycle !== undefined ? { cycle } : {})
  };
}

function nonEmptyValues<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined;
}

function buildIssueFilter(filterInput: LinearIssueReadFilter | undefined, scope: LinearResolvedBacklogScope): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    team: { id: { eq: scope.team.id } }
  };
  if (scope.project) filter.project = { id: { eq: scope.project.id } };
  if (scope.cycle) filter.cycle = { id: { eq: scope.cycle.id } };
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

/** Build the bounded, point-in-time Linear backlog view consumed by project planning. */
export async function buildLinearBacklogSnapshot(input: LinearBacklogSnapshotOptions): Promise<LinearBacklogSnapshot> {
  const workspaceId =
    input.workspaceId !== undefined ? requiredString(input.workspaceId, "backlog snapshot workspaceId") : undefined;
  const result = await listLinearIssues(input);

  return {
    contractVersion: result.contractVersion,
    capturedAt: result.capturedAt,
    request: result.request,
    resolvedScope: result.resolvedScope,
    issues: result.items,
    pageInfo: result.pageInfo,
    limits: result.limits,
    truncated: result.truncated,
    provenance: {
      provider: "linear",
      operation: "backlog.snapshot",
      ...(workspaceId !== undefined ? { workspaceId } : {})
    }
  };
}
