/**
 * Version of the normalized Linear backlog read contract exposed by OpenTag.
 *
 * Increment this value only when consumers need to handle a breaking snapshot
 * shape. It is intentionally independent from Linear's GraphQL schema version.
 */
export const LINEAR_BACKLOG_READ_CONTRACT_VERSION = "linear-backlog-read.v1" as const;

export type LinearBacklogReadContractVersion = typeof LINEAR_BACKLOG_READ_CONTRACT_VERSION;

/** A single Linear issue can be addressed by its opaque id or human identifier. */
export type LinearIssueLookup =
  | {
      id: string;
      identifier?: never;
    }
  | {
      id?: never;
      identifier: string;
    };

export type LinearTeamReference = {
  id: string;
  key: string;
  name: string;
};

export type LinearProjectReference = {
  id: string;
  name: string;
  url?: string;
};

export type LinearCycleReference = {
  id: string;
  number?: number;
  name?: string;
  startsAt?: string;
  endsAt?: string;
};

export type LinearUserReference = {
  id: string;
  name: string;
  displayName?: string;
};

export type LinearWorkflowStateReference = {
  id: string;
  name: string;
  /** Linear workflow-state category, preserved without exposing a raw node. */
  type: string;
  color?: string;
};

export type LinearLabelReference = {
  id: string;
  name: string;
  color?: string;
};

export type LinearIssueReference = {
  id: string;
  identifier: string;
  title: string;
  url: string;
};

export type LinearIssuePriority = {
  value: number;
  label?: string;
};

/** Canonical relation directions understood by the OpenTag project planner. */
export const LINEAR_ISSUE_RELATION_KINDS = ["blocks", "blocked_by", "related"] as const;

export type LinearIssueRelationKind = (typeof LINEAR_ISSUE_RELATION_KINDS)[number];

export type LinearIssueRelationSnapshot = {
  kind: LinearIssueRelationKind;
  issue: LinearIssueReference;
};

/**
 * Channel-independent, normalized representation of a Linear issue.
 *
 * Optional fields are omitted when Linear has no value. Arrays are always
 * present, allowing planners and renderers to consume the contract without
 * depending on raw GraphQL connection shapes.
 */
export type LinearIssueSnapshot = LinearIssueReference & {
  description?: string;
  status: LinearWorkflowStateReference;
  priority?: LinearIssuePriority;
  team: LinearTeamReference;
  project?: LinearProjectReference;
  cycle?: LinearCycleReference;
  assignee?: LinearUserReference;
  labels: LinearLabelReference[];
  relations: LinearIssueRelationSnapshot[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  canceledAt?: string;
  dueDate?: string;
  archivedAt?: string;
};

/** Resolve the active cycle when the read executes, rather than at binding time. */
export type LinearCycleSelector =
  | {
      kind: "current";
    }
  | {
      kind: "id";
      id: string;
    };

/**
 * Requested Linear scope. Phase 1 requires a team boundary so list and search
 * operations cannot accidentally read an unbounded workspace.
 */
export type LinearBacklogReadScope = {
  teamId: string;
  projectId?: string;
  cycle?: LinearCycleSelector;
};

export type LinearIssueCompletionFilter = "unfinished" | "completed" | "all";

export type LinearIssueReadFilter = {
  completion?: LinearIssueCompletionFilter;
  stateIds?: string[];
  assigneeIds?: string[];
  labelIds?: string[];
  priorities?: number[];
  includeArchived?: boolean;
};

/** Caller-provided bounds for paginated list and search operations. */
export type LinearReadPagination = {
  /** Page size requested from Linear. */
  first: number;
  /** Optional cursor from which reading resumes. */
  after?: string;
  /** Hard cap on the total number of normalized items returned to the caller. */
  maxItems: number;
};

export type LinearIssueGetRequest = {
  issue: LinearIssueLookup;
};

export type LinearIssueSearchRequest = {
  query: string;
  scope: LinearBacklogReadScope;
  filter?: LinearIssueReadFilter;
  pagination: LinearReadPagination;
};

export type LinearIssueListRequest = {
  scope: LinearBacklogReadScope;
  filter?: LinearIssueReadFilter;
  pagination: LinearReadPagination;
};

/** GraphQL connection state after the final page read by OpenTag. */
export type LinearReadPageInfo = {
  hasNextPage: boolean;
  endCursor?: string;
};

/** Makes configured and applied read limits auditable in a returned snapshot. */
export type LinearReadLimitSnapshot = {
  requestedMaxItems: number;
  appliedMaxItems: number;
  returnedItems: number;
};

export type LinearBoundedReadMetadata = {
  pageInfo: LinearReadPageInfo;
  limits: LinearReadLimitSnapshot;
  /** True when OpenTag stopped before all matching Linear records were read. */
  truncated: boolean;
};

export type LinearBoundedReadResult<T> = LinearBoundedReadMetadata & {
  items: T[];
};

/** The concrete scope resolved from a requested team/project/cycle selector. */
export type LinearResolvedBacklogScope = {
  team: LinearTeamReference;
  project?: LinearProjectReference;
  cycle?: LinearCycleReference;
};

/** Safe source metadata. Tokens, authorization headers, and secrets are forbidden. */
export type LinearReadProvenance = {
  provider: "linear";
  operation: "issue.get" | "issue.search" | "issue.list" | "backlog.snapshot";
  workspaceId?: string;
};

export type LinearIssueGetResult = {
  contractVersion: LinearBacklogReadContractVersion;
  capturedAt: string;
  issue: LinearIssueSnapshot;
  provenance: LinearReadProvenance & {
    operation: "issue.get";
  };
};

export type LinearIssueSearchResult = LinearBoundedReadResult<LinearIssueSnapshot> & {
  contractVersion: LinearBacklogReadContractVersion;
  capturedAt: string;
  request: LinearIssueSearchRequest;
  resolvedScope: LinearResolvedBacklogScope;
  provenance: LinearReadProvenance & {
    operation: "issue.search";
  };
};

export type LinearIssueListResult = LinearBoundedReadResult<LinearIssueSnapshot> & {
  contractVersion: LinearBacklogReadContractVersion;
  capturedAt: string;
  request: LinearIssueListRequest;
  resolvedScope: LinearResolvedBacklogScope;
  provenance: LinearReadProvenance & {
    operation: "issue.list";
  };
};

/**
 * Point-in-time, bounded view of a Linear backlog for project planning.
 *
 * This is a data contract only. Constructing it from Linear GraphQL responses
 * belongs to the backlog snapshot implementation, not to this module.
 */
export type LinearBacklogSnapshot = LinearBoundedReadMetadata & {
  contractVersion: LinearBacklogReadContractVersion;
  capturedAt: string;
  request: LinearIssueListRequest;
  resolvedScope: LinearResolvedBacklogScope;
  issues: LinearIssueSnapshot[];
  provenance: LinearReadProvenance & {
    operation: "backlog.snapshot";
  };
};
