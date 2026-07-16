import { describe, expect, it } from "vitest";
import {
  LINEAR_BACKLOG_READ_CONTRACT_VERSION,
  buildLinearBacklogSnapshot
} from "../src/index.js";

type GraphqlBody = {
  query: string;
  variables: Record<string, unknown>;
};

function bodyFrom(init: RequestInit | undefined): GraphqlBody {
  return JSON.parse(String(init?.body ?? "{}")) as GraphqlBody;
}

function issueReference(identifier: string): Record<string, unknown> {
  return {
    id: `issue_${identifier.toLowerCase().replace("-", "_")}`,
    identifier,
    title: `${identifier} title`,
    url: `https://linear.app/acme/issue/${identifier}`
  };
}

function rawIssue(): Record<string, unknown> {
  return {
    ...issueReference("AMP-119"),
    description: "Build a read-only Linear backlog snapshot.",
    priority: 2,
    priorityLabel: "High",
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    completedAt: null,
    canceledAt: null,
    dueDate: null,
    archivedAt: null,
    state: { id: "state_started", name: "In Progress", type: "started", color: "#f2c94c" },
    team: { id: "team_amp", key: "AMP", name: "OpenTag" },
    project: null,
    cycle: null,
    assignee: null,
    labels: { nodes: [{ id: "label_read", name: "Linear Read", color: "#5e6ad2" }] },
    relations: {
      nodes: [{ type: "blocks", relatedIssue: issueReference("AMP-120") }],
      pageInfo: { hasNextPage: false }
    },
    inverseRelations: {
      nodes: [{ type: "blocks", issue: issueReference("AMP-118") }],
      pageInfo: { hasNextPage: false }
    }
  };
}

describe("buildLinearBacklogSnapshot", () => {
  it("composes a bounded issue list into the planner-facing snapshot contract", async () => {
    const bodies: GraphqlBody[] = [];
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      bodies.push(body);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team: { id: "team_amp", key: "AMP", name: "OpenTag" } } });
      }
      return Response.json({
        data: {
          issues: {
            nodes: [rawIssue()],
            pageInfo: { hasNextPage: true, endCursor: "cursor_next" }
          }
        }
      });
    }) as typeof fetch;

    const request = {
      scope: { teamId: "team_amp" },
      filter: { completion: "unfinished" as const },
      pagination: { first: 25, maxItems: 1 }
    };
    const snapshot = await buildLinearBacklogSnapshot({
      token: "lin_api_secret",
      workspaceId: "workspace_amp",
      fetchImpl,
      request
    });

    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => !body.query.includes("mutation"))).toBe(true);
    expect(snapshot).toMatchObject({
      contractVersion: LINEAR_BACKLOG_READ_CONTRACT_VERSION,
      request,
      resolvedScope: {
        team: { id: "team_amp", key: "AMP", name: "OpenTag" }
      },
      pageInfo: { hasNextPage: true, endCursor: "cursor_next" },
      limits: { requestedMaxItems: 1, appliedMaxItems: 1, returnedItems: 1 },
      truncated: true,
      provenance: {
        provider: "linear",
        operation: "backlog.snapshot",
        workspaceId: "workspace_amp"
      }
    });
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0]?.relations).toEqual([
      { kind: "blocks", issue: issueReference("AMP-120") },
      { kind: "blocked_by", issue: issueReference("AMP-118") }
    ]);
    expect(snapshot).not.toHaveProperty("items");
    expect(JSON.stringify(snapshot)).not.toContain("lin_api_secret");
  });

  it("omits optional workspace provenance when it is not supplied", async () => {
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team: { id: "team_amp", key: "AMP", name: "OpenTag" } } });
      }
      return Response.json({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
      });
    }) as typeof fetch;

    const snapshot = await buildLinearBacklogSnapshot({
      token: "lin_api_test",
      fetchImpl,
      request: {
        scope: { teamId: "team_amp" },
        pagination: { first: 10, maxItems: 20 }
      }
    });

    expect(snapshot.provenance).toEqual({ provider: "linear", operation: "backlog.snapshot" });
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.truncated).toBe(false);
  });

  it("validates workspace provenance before making a Linear request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({ data: {} });
    }) as typeof fetch;

    await expect(
      buildLinearBacklogSnapshot({
        token: "lin_api_test",
        workspaceId: "",
        fetchImpl,
        request: {
          scope: { teamId: "team_amp" },
          pagination: { first: 10, maxItems: 20 }
        }
      })
    ).rejects.toThrow("Linear backlog snapshot workspaceId must be a non-empty string");
    expect(called).toBe(false);
  });
});
