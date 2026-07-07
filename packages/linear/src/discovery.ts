import { linearGraphql, type FetchLike } from "./graphql.js";

export type LinearTeamMetadata = {
  id: string;
  key: string;
  name: string;
  displayName?: string;
  color?: string | null;
};

export type LinearUserMetadata = {
  id: string;
  name: string;
  displayName?: string;
  email?: string;
  active: boolean;
  app: boolean;
};

export type LinearWorkflowStateMetadata = {
  id: string;
  name: string;
  type: string;
  color?: string | null;
  team: LinearTeamRef;
};

export type LinearIssueLabelMetadata = {
  id: string;
  name: string;
  color: string;
  isGroup: boolean;
  team?: LinearTeamRef | null;
};

export type LinearTeamRef = {
  id: string;
  key?: string;
  name?: string;
};

export type LinearMetadataSnapshot = {
  teams: LinearTeamMetadata[];
  users: LinearUserMetadata[];
  workflowStates: LinearWorkflowStateMetadata[];
  issueLabels: LinearIssueLabelMetadata[];
};

export type LinearAdapterMappingDraft = {
  adapter: "linear";
  domain: "team" | "status" | "priority" | "assignee" | "label";
  strategy: "team_id" | "state_id" | "priority" | "user_id" | "label_id";
  values: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function teamRef(value: unknown): LinearTeamRef | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  if (!id) return undefined;
  const key = stringValue(value.key);
  const name = stringValue(value.name);
  return {
    id,
    ...(key ? { key } : {}),
    ...(name ? { name } : {})
  };
}

function connectionNodes(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return [];
  return value.nodes;
}

function connectionHasNextPage(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.pageInfo)) return false;
  return value.pageInfo.hasNextPage === true;
}

function connectionEndCursor(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.pageInfo)) return undefined;
  return stringValue(value.pageInfo.endCursor);
}

function normalizeTeam(value: unknown): LinearTeamMetadata | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const key = stringValue(value.key);
  const name = stringValue(value.name);
  if (!id || !key || !name) return null;
  const displayName = stringValue(value.displayName);
  return {
    id,
    key,
    name,
    ...(displayName ? { displayName } : {}),
    ...(typeof value.color === "string" || value.color === null ? { color: value.color } : {})
  };
}

function normalizeUser(value: unknown): LinearUserMetadata | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const name = stringValue(value.name) ?? stringValue(value.displayName);
  const active = booleanValue(value.active);
  const app = booleanValue(value.app);
  if (!id || !name || active === undefined || app === undefined) return null;
  const displayName = stringValue(value.displayName);
  const email = stringValue(value.email);
  return {
    id,
    name,
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    active,
    app
  };
}

function normalizeWorkflowState(value: unknown): LinearWorkflowStateMetadata | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const type = stringValue(value.type);
  const team = teamRef(value.team);
  if (!id || !name || !type || !team) return null;
  return {
    id,
    name,
    type,
    ...(typeof value.color === "string" || value.color === null ? { color: value.color } : {}),
    team
  };
}

function normalizeIssueLabel(value: unknown): LinearIssueLabelMetadata | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const color = stringValue(value.color);
  const isGroup = booleanValue(value.isGroup);
  if (!id || !name || !color || isGroup === undefined) return null;
  const labelTeam = teamRef(value.team);
  return {
    id,
    name,
    color,
    isGroup,
    ...(value.team === null ? { team: null } : labelTeam ? { team: labelTeam } : {})
  };
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function addScopedAlias(values: Record<string, string>, alias: string, id: string): void {
  const normalized = slug(alias);
  if (!normalized) return;
  values[normalized] = id;
}

function addUnambiguousAlias(input: {
  values: Record<string, string>;
  ambiguous: Set<string>;
  alias: string;
  id: string;
  normalize?: (value: string) => string;
}): void {
  const normalize = input.normalize ?? slug;
  const normalized = normalize(input.alias);
  if (!normalized || input.ambiguous.has(normalized)) return;
  const existing = input.values[normalized];
  if (!existing) {
    input.values[normalized] = input.id;
    return;
  }
  if (existing !== input.id) {
    delete input.values[normalized];
    input.ambiguous.add(normalized);
  }
}

export async function discoverLinearMetadata(input: {
  token: string;
  graphqlUrl?: string;
  first?: number;
  fetchImpl?: FetchLike;
}): Promise<LinearMetadataSnapshot> {
  const first = input.first ?? 100;
  const [teams, users, workflowStates, issueLabels] = await Promise.all([
    discoverLinearMetadataConnection({
      ...input,
      first,
      connectionName: "teams",
      operationName: "OpenTagLinearMetadataTeams",
      nodeSelection: "id key name displayName color"
    }),
    discoverLinearMetadataConnection({
      ...input,
      first,
      connectionName: "users",
      operationName: "OpenTagLinearMetadataUsers",
      nodeSelection: "id name displayName email active app"
    }),
    discoverLinearMetadataConnection({
      ...input,
      first,
      connectionName: "workflowStates",
      operationName: "OpenTagLinearMetadataWorkflowStates",
      nodeSelection: "id name type color team { id key name }"
    }),
    discoverLinearMetadataConnection({
      ...input,
      first,
      connectionName: "issueLabels",
      operationName: "OpenTagLinearMetadataIssueLabels",
      nodeSelection: "id name color isGroup team { id key name }"
    })
  ]);
  return {
    teams: teams.map(normalizeTeam).filter((item): item is LinearTeamMetadata => item !== null),
    users: users.map(normalizeUser).filter((item): item is LinearUserMetadata => item !== null),
    workflowStates: workflowStates.map(normalizeWorkflowState).filter((item): item is LinearWorkflowStateMetadata => item !== null),
    issueLabels: issueLabels.map(normalizeIssueLabel).filter((item): item is LinearIssueLabelMetadata => item !== null)
  };
}

async function discoverLinearMetadataConnection(input: {
  token: string;
  graphqlUrl?: string;
  first: number;
  fetchImpl?: FetchLike;
  connectionName: "teams" | "users" | "workflowStates" | "issueLabels";
  operationName: string;
  nodeSelection: string;
}): Promise<unknown[]> {
  const nodes: unknown[] = [];
  let after: string | undefined;
  for (;;) {
    const data = await linearGraphql<Record<string, unknown>>({
      token: input.token,
      ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
      fetchImpl: input.fetchImpl ?? fetch,
      query: `query ${input.operationName}($first: Int!, $after: String) {
  ${input.connectionName}(first: $first, after: $after) {
    nodes { ${input.nodeSelection} }
    pageInfo { hasNextPage endCursor }
  }
}`,
      variables: { first: input.first, after: after ?? null }
    });
    const connection = data[input.connectionName];
    nodes.push(...connectionNodes(connection));
    if (!connectionHasNextPage(connection)) return nodes;
    const endCursor = connectionEndCursor(connection);
    if (!endCursor) throw new Error(`Linear metadata ${input.connectionName} pageInfo did not include endCursor.`);
    after = endCursor;
  }
}

export function createLinearAdapterMappingDrafts(snapshot: LinearMetadataSnapshot): LinearAdapterMappingDraft[] {
  const teams: Record<string, string> = {};
  const ambiguousTeamAliases = new Set<string>();
  for (const team of snapshot.teams) {
    addUnambiguousAlias({ values: teams, ambiguous: ambiguousTeamAliases, alias: team.key, id: team.id });
    addUnambiguousAlias({ values: teams, ambiguous: ambiguousTeamAliases, alias: team.name, id: team.id });
    if (team.displayName) addUnambiguousAlias({ values: teams, ambiguous: ambiguousTeamAliases, alias: team.displayName, id: team.id });
    addScopedAlias(teams, team.id, team.id);
  }

  const states: Record<string, string> = {};
  const ambiguousStateAliases = new Set<string>();
  for (const state of snapshot.workflowStates) {
    addUnambiguousAlias({ values: states, ambiguous: ambiguousStateAliases, alias: state.name, id: state.id });
    addScopedAlias(states, `${state.team.key ?? state.team.id}_${state.name}`, state.id);
    addUnambiguousAlias({ values: states, ambiguous: ambiguousStateAliases, alias: state.type, id: state.id });
  }

  const users: Record<string, string> = {};
  const ambiguousUserAliases = new Set<string>();
  for (const user of snapshot.users) {
    if (!user.active || user.app) continue;
    addUnambiguousAlias({ values: users, ambiguous: ambiguousUserAliases, alias: user.name, id: user.id });
    if (user.displayName) addUnambiguousAlias({ values: users, ambiguous: ambiguousUserAliases, alias: user.displayName, id: user.id });
    if (user.email) {
      addUnambiguousAlias({
        values: users,
        ambiguous: ambiguousUserAliases,
        alias: user.email,
        id: user.id,
        normalize: (value) => value.toLowerCase()
      });
    }
  }

  const labels: Record<string, string> = {};
  const ambiguousLabelAliases = new Set<string>();
  for (const label of snapshot.issueLabels) {
    if (label.isGroup) continue;
    addUnambiguousAlias({ values: labels, ambiguous: ambiguousLabelAliases, alias: label.name, id: label.id });
    addScopedAlias(labels, `${label.team?.key ?? label.team?.id ?? "global"}_${label.name}`, label.id);
  }

  return [
    { adapter: "linear", domain: "team", strategy: "team_id", values: teams },
    { adapter: "linear", domain: "status", strategy: "state_id", values: states },
    { adapter: "linear", domain: "priority", strategy: "priority", values: { urgent: "1", high: "2", medium: "3", low: "4", none: "0" } },
    { adapter: "linear", domain: "assignee", strategy: "user_id", values: users },
    { adapter: "linear", domain: "label", strategy: "label_id", values: labels }
  ];
}
