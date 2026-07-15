import { describe, expect, it } from "vitest";
import {
  LINEAR_BACKLOG_READ_CONTRACT_VERSION,
  LINEAR_ISSUE_LIST_MAX_ITEMS,
  listLinearIssues
} from "../src/index.js";

type GraphqlBody = {
  query: string;
  variables: Record<string, unknown>;
};

function bodyFrom(init: RequestInit | undefined): GraphqlBody {
  return JSON.parse(String(init?.body ?? "{}")) as GraphqlBody;
}

function rawIssue(identifier: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `issue_${identifier.toLowerCase().replace("-", "_")}`,
    identifier,
    title: `${identifier} title`,
    url: `https://linear.app/acme/issue/${identifier}`,
    description: null,
    priority: 0,
    priorityLabel: "No priority",
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    completedAt: "2026-07-15T12:00:00.000Z",
    canceledAt: null,
    dueDate: null,
    archivedAt: null,
    state: { id: "state_completed", name: "Done", type: "completed", color: "#5e6ad2" },
    team: { id: "team_amp", key: "AMP", name: "OpenTag" },
    project: null,
    cycle: null,
    assignee: null,
    labels: { nodes: [] },
    ...overrides
  };
}

describe("listLinearIssues", () => {
  it("reads a bounded team issue list across cursor pages", async () => {
    const bodies: GraphqlBody[] = [];
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      bodies.push(body);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team: { id: "team_amp", key: "AMP", name: "OpenTag" } } });
      }
      if (body.query.includes("OpenTagLinearIssueList")) {
        if (body.variables.after === "cursor_start") {
          return Response.json({
            data: {
              issues: {
                nodes: [rawIssue("AMP-115"), rawIssue("AMP-116")],
                pageInfo: { hasNextPage: true, endCursor: "cursor_1" }
              }
            }
          });
        }
        return Response.json({
          data: {
            issues: {
              nodes: [rawIssue("AMP-117")],
              pageInfo: { hasNextPage: false, endCursor: "cursor_2" }
            }
          }
        });
      }
      return Response.json({ errors: [{ message: "unexpected operation" }] });
    }) as typeof fetch;

    const result = await listLinearIssues({
      token: "lin_api_secret",
      fetchImpl,
      request: {
        scope: { teamId: "team_amp" },
        filter: {
          completion: "completed",
          stateIds: ["state_completed"]
        },
        pagination: {
          first: 2,
          after: "cursor_start",
          maxItems: 3
        }
      }
    });

    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.variables).toEqual({ teamId: "team_amp" });
    const firstList = bodies[1];
    expect(firstList?.query).toContain("query OpenTagLinearIssueList");
    expect(firstList?.query).not.toContain("mutation");
    expect(firstList?.variables).toEqual({
      filter: {
        team: { id: { eq: "team_amp" } },
        state: { id: { in: ["state_completed"] }, type: { eq: "completed" } }
      },
      first: 2,
      after: "cursor_start",
      includeArchived: false
    });
    expect(bodies[2]?.variables).toMatchObject({ first: 1, after: "cursor_1" });

    expect(result).toMatchObject({
      contractVersion: LINEAR_BACKLOG_READ_CONTRACT_VERSION,
      resolvedScope: { team: { id: "team_amp", key: "AMP", name: "OpenTag" } },
      pageInfo: { hasNextPage: false, endCursor: "cursor_2" },
      limits: { requestedMaxItems: 3, appliedMaxItems: 3, returnedItems: 3 },
      truncated: false,
      provenance: { provider: "linear", operation: "issue.list" }
    });
    expect(result.items.map((issue) => issue.identifier)).toEqual(["AMP-115", "AMP-116", "AMP-117"]);
    expect(result.items[0]).not.toHaveProperty("priority");
    expect(result.items[0]).not.toHaveProperty("project");
    expect(JSON.stringify(result)).not.toContain("lin_api_secret");
  });

  it("applies list page and total-result caps", async () => {
    const bodies: GraphqlBody[] = [];
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      bodies.push(body);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team: { id: "team_amp", key: "AMP", name: "OpenTag" } } });
      }
      return Response.json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }) as typeof fetch;

    const result = await listLinearIssues({
      token: "lin_api_test",
      fetchImpl,
      request: {
        scope: { teamId: "team_amp" },
        pagination: { first: 500, maxItems: 1_000 }
      }
    });

    expect(bodies[1]?.variables.first).toBe(50);
    expect(result.limits).toEqual({
      requestedMaxItems: 1_000,
      appliedMaxItems: LINEAR_ISSUE_LIST_MAX_ITEMS,
      returnedItems: 0
    });
    expect(result.truncated).toBe(false);
  });

  it("marks the list truncated when the hard result limit stops pagination", async () => {
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team: { id: "team_amp", key: "AMP", name: "OpenTag" } } });
      }
      return Response.json({
        data: {
          issues: {
            nodes: [rawIssue("AMP-117")],
            pageInfo: { hasNextPage: true, endCursor: "cursor_next" }
          }
        }
      });
    }) as typeof fetch;

    const result = await listLinearIssues({
      token: "lin_api_test",
      fetchImpl,
      request: {
        scope: { teamId: "team_amp" },
        pagination: { first: 10, maxItems: 1 }
      }
    });

    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.pageInfo).toEqual({ hasNextPage: true, endCursor: "cursor_next" });
  });

  it("rejects project or cycle scope until the follow-up scope read is implemented", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({ data: {} });
    }) as typeof fetch;

    await expect(
      listLinearIssues({
        token: "lin_api_test",
        fetchImpl,
        request: {
          scope: { teamId: "team_amp", cycle: { kind: "current" } },
          pagination: { first: 10, maxItems: 20 }
        }
      })
    ).rejects.toThrow("Linear issue.list currently supports team scope only");
    expect(called).toBe(false);
  });

  it("includes the list operation name in GraphQL errors", async () => {
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team: { id: "team_amp", key: "AMP", name: "OpenTag" } } });
      }
      return Response.json({ errors: [{ message: "read scope missing" }] });
    }) as typeof fetch;

    await expect(
      listLinearIssues({
        token: "lin_api_test",
        fetchImpl,
        request: {
          scope: { teamId: "team_amp" },
          pagination: { first: 10, maxItems: 20 }
        }
      })
    ).rejects.toThrow("Linear GraphQL OpenTagLinearIssueList failed: 200 read scope missing");
  });
});
