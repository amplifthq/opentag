import { describe, expect, it } from "vitest";
import {
  LINEAR_BACKLOG_READ_CONTRACT_VERSION,
  LINEAR_ISSUE_RELATION_KINDS,
  type LinearBacklogSnapshot,
  type LinearIssueLookup
} from "../src/index.js";

const backlogSnapshot = {
  contractVersion: LINEAR_BACKLOG_READ_CONTRACT_VERSION,
  capturedAt: "2026-07-15T18:30:00.000Z",
  request: {
    scope: {
      teamId: "team_amp",
      projectId: "project_opentag",
      cycle: { kind: "current" }
    },
    filter: { completion: "unfinished" },
    pagination: {
      first: 50,
      maxItems: 100
    }
  },
  resolvedScope: {
    team: { id: "team_amp", key: "AMP", name: "Amplift" },
    project: { id: "project_opentag", name: "OpenTag" },
    cycle: { id: "cycle_42", number: 42, name: "Cycle 42" }
  },
  issues: [
    {
      id: "issue_115",
      identifier: "AMP-115",
      title: "Define Linear backlog read contract and snapshot types",
      url: "https://linear.app/example/issue/AMP-115",
      status: { id: "state_started", name: "In Progress", type: "started" },
      priority: { value: 2, label: "High" },
      team: { id: "team_amp", key: "AMP", name: "Amplift" },
      project: { id: "project_opentag", name: "OpenTag" },
      cycle: { id: "cycle_42", number: 42, name: "Cycle 42" },
      labels: [{ id: "label_linear", name: "Linear" }],
      relations: [
        {
          kind: "blocks",
          issue: {
            id: "issue_116",
            identifier: "AMP-116",
            title: "Implement read-only Linear issue.get and issue.search",
            url: "https://linear.app/example/issue/AMP-116"
          }
        }
      ],
      createdAt: "2026-07-15T17:00:00.000Z",
      updatedAt: "2026-07-15T18:00:00.000Z"
    }
  ],
  pageInfo: {
    hasNextPage: true,
    endCursor: "cursor_1"
  },
  limits: {
    requestedMaxItems: 100,
    appliedMaxItems: 100,
    returnedItems: 1
  },
  truncated: true,
  provenance: {
    provider: "linear",
    operation: "backlog.snapshot",
    workspaceId: "workspace_amp"
  }
} satisfies LinearBacklogSnapshot;

describe("Linear backlog read contract", () => {
  it("uses a stable version and canonical relation directions", () => {
    expect(LINEAR_BACKLOG_READ_CONTRACT_VERSION).toBe("linear-backlog-read.v1");
    expect(LINEAR_ISSUE_RELATION_KINDS).toEqual(["blocks", "blocked_by", "related"]);
  });

  it("represents requested current-cycle scope separately from its resolved cycle", () => {
    expect(backlogSnapshot.request.scope.cycle).toEqual({ kind: "current" });
    expect(backlogSnapshot.resolvedScope.cycle).toMatchObject({ id: "cycle_42", number: 42 });
  });

  it("keeps boundedness, pagination, and provenance explicit", () => {
    expect(backlogSnapshot.truncated).toBe(true);
    expect(backlogSnapshot.pageInfo.hasNextPage).toBe(true);
    expect(backlogSnapshot.limits).toEqual({ requestedMaxItems: 100, appliedMaxItems: 100, returnedItems: 1 });
    expect(backlogSnapshot.provenance).toEqual({
      provider: "linear",
      operation: "backlog.snapshot",
      workspaceId: "workspace_amp"
    });
  });

  it("requires issue lookup by exactly one stable reference", () => {
    const byId = { id: "issue_115" } satisfies LinearIssueLookup;
    const byIdentifier = { identifier: "AMP-115" } satisfies LinearIssueLookup;

    expect(byId).toEqual({ id: "issue_115" });
    expect(byIdentifier).toEqual({ identifier: "AMP-115" });
  });
});
