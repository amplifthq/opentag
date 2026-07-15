import { describe, expect, it } from "vitest";
import {
  LINEAR_BACKLOG_READ_CONTRACT_VERSION,
  LINEAR_ISSUE_SEARCH_MAX_ITEMS,
  getLinearIssue,
  searchLinearIssues
} from "../src/index.js";

const rawIssue = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "issue_116",
  identifier: "AMP-116",
  title: "Implement read-only Linear issue.get and issue.search",
  url: "https://linear.app/acme/issue/AMP-116/test",
  description: "Read Linear without depending on a channel adapter.",
  priority: 2,
  priorityLabel: "High",
  createdAt: "2026-07-14T10:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  dueDate: "2026-07-20",
  archivedAt: null,
  state: { id: "state_started", name: "In Progress", type: "started", color: "#f2c94c" },
  team: { id: "team_amp", key: "AMP", name: "OpenTag" },
  project: { id: "project_opentag", name: "opentag", url: "https://linear.app/acme/project/opentag" },
  cycle: {
    id: "cycle_1",
    number: 1,
    name: "Project Intelligence Phase 1",
    startsAt: "2026-07-14T00:00:00.000Z",
    endsAt: "2026-07-28T00:00:00.000Z"
  },
  assignee: { id: "user_1", name: "chen", displayName: "Chen" },
  labels: { nodes: [{ id: "label_read", name: "Linear Read", color: "#5e6ad2" }] },
  ...overrides
});

type GraphqlBody = {
  query: string;
  variables: Record<string, unknown>;
};

function bodyFrom(init: RequestInit | undefined): GraphqlBody {
  return JSON.parse(String(init?.body ?? "{}")) as GraphqlBody;
}

describe("getLinearIssue", () => {
  it.each([
    [{ id: "issue_116" }, "issue_116"],
    [{ identifier: "AMP-116" }, "AMP-116"]
  ] as const)("reads an issue by lookup %o", async (issue, expectedId) => {
    let body: GraphqlBody | undefined;
    const fetchImpl = (async (_url, init) => {
      body = bodyFrom(init);
      return Response.json({ data: { issue: rawIssue() } });
    }) as typeof fetch;

    const result = await getLinearIssue({
      token: "lin_api_secret",
      request: { issue },
      fetchImpl
    });

    expect(body?.query).toContain("query OpenTagLinearIssueGet");
    expect(body?.query).not.toContain("mutation");
    expect(body?.variables).toEqual({ id: expectedId });
    expect(result).toMatchObject({
      contractVersion: LINEAR_BACKLOG_READ_CONTRACT_VERSION,
      issue: {
        id: "issue_116",
        identifier: "AMP-116",
        status: { id: "state_started", name: "In Progress", type: "started" },
        priority: { value: 2, label: "High" },
        team: { id: "team_amp", key: "AMP", name: "OpenTag" },
        project: { id: "project_opentag", name: "opentag" },
        cycle: { id: "cycle_1", number: 1 },
        assignee: { id: "user_1", name: "chen", displayName: "Chen" },
        labels: [{ id: "label_read", name: "Linear Read", color: "#5e6ad2" }],
        relations: []
      },
      provenance: { provider: "linear", operation: "issue.get" }
    });
    expect(result.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(JSON.stringify(result)).not.toContain("lin_api_secret");
  });

  it("fails clearly when Linear returns a malformed issue node", async () => {
    const fetchImpl = (async () => Response.json({ data: { issue: rawIssue({ labels: undefined }) } })) as typeof fetch;

    await expect(
      getLinearIssue({ token: "lin_api_test", request: { issue: { identifier: "AMP-116" } }, fetchImpl })
    ).rejects.toThrow("Linear issue.labels must be an object");
  });

  it("preserves the read operation name in GraphQL errors", async () => {
    const fetchImpl = (async () => Response.json({ errors: [{ message: "issue not found" }] })) as typeof fetch;

    await expect(
      getLinearIssue({ token: "lin_api_test", request: { issue: { identifier: "AMP-404" } }, fetchImpl })
    ).rejects.toThrow("Linear GraphQL OpenTagLinearIssueGet failed: 200 issue not found");
  });
});

describe("searchLinearIssues", () => {
  it("resolves scope, enforces filters, paginates, and returns bounded snapshots", async () => {
    const bodies: GraphqlBody[] = [];
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      bodies.push(body);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({
          data: { team: { id: "team_amp", key: "AMP", name: "OpenTag" } }
        });
      }
      if (body.query.includes("OpenTagLinearIssueSearch")) {
        const after = body.variables.after;
        if (after === null) {
          return Response.json({
            data: {
              searchIssues: {
                nodes: [rawIssue(), rawIssue({ id: "issue_117", identifier: "AMP-117", title: "Implement issue.list" })],
                pageInfo: { hasNextPage: true, endCursor: "cursor_1" }
              }
            }
          });
        }
        return Response.json({
          data: {
            searchIssues: {
              nodes: [rawIssue({ id: "issue_118", identifier: "AMP-118", title: "Read project, cycle, and relations" })],
              pageInfo: { hasNextPage: true, endCursor: "cursor_2" }
            }
          }
        });
      }
      return Response.json({ errors: [{ message: "unexpected operation" }] });
    }) as typeof fetch;

    const result = await searchLinearIssues({
      token: "lin_api_secret",
      fetchImpl,
      request: {
        query: "linear backlog",
        scope: { teamId: "team_amp" },
        filter: {
          completion: "unfinished",
          stateIds: ["state_started"],
          assigneeIds: ["user_1"],
          labelIds: ["label_read"],
          priorities: [1, 2],
          includeArchived: true
        },
        pagination: { first: 2, maxItems: 3 }
      }
    });

    expect(bodies).toHaveLength(3);
    const scopeBody = bodies[0];
    expect(scopeBody?.query).toContain("query OpenTagLinearResolveIssueReadTeam");
    expect(scopeBody?.variables).toEqual({ teamId: "team_amp" });

    const firstSearch = bodies[1];
    expect(firstSearch?.query).toContain("query OpenTagLinearIssueSearch");
    expect(firstSearch?.query).not.toContain("mutation");
    expect(firstSearch?.variables).toMatchObject({
      term: "linear backlog",
      teamId: "team_amp",
      first: 2,
      after: null,
      includeArchived: true,
      filter: {
        team: { id: { eq: "team_amp" } },
        state: { id: { in: ["state_started"] }, type: { nin: ["completed", "canceled"] } },
        assignee: { id: { in: ["user_1"] } },
        labels: { id: { in: ["label_read"] } },
        priority: { in: [1, 2] }
      }
    });
    expect(bodies[2]?.variables).toMatchObject({ first: 1, after: "cursor_1" });

    expect(result.items.map((issue) => issue.identifier)).toEqual(["AMP-116", "AMP-117", "AMP-118"]);
    expect(result).toMatchObject({
      resolvedScope: {
        team: { id: "team_amp", key: "AMP", name: "OpenTag" }
      },
      pageInfo: { hasNextPage: true, endCursor: "cursor_2" },
      limits: { requestedMaxItems: 3, appliedMaxItems: 3, returnedItems: 3 },
      truncated: true,
      provenance: { provider: "linear", operation: "issue.search" }
    });
    expect(JSON.stringify(result)).not.toContain("lin_api_secret");
  });

  it("applies the connector max while keeping a complete empty result untruncated", async () => {
    const bodies: GraphqlBody[] = [];
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      bodies.push(body);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team: { id: "team_amp", key: "AMP", name: "OpenTag" } } });
      }
      return Response.json({
        data: { searchIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
      });
    }) as typeof fetch;

    const result = await searchLinearIssues({
      token: "lin_api_test",
      fetchImpl,
      request: {
        query: "nothing",
        scope: { teamId: "team_amp" },
        pagination: { first: 500, maxItems: 1_000 }
      }
    });

    expect(bodies[1]?.variables.first).toBe(50);
    expect(result.limits).toEqual({
      requestedMaxItems: 1_000,
      appliedMaxItems: LINEAR_ISSUE_SEARCH_MAX_ITEMS,
      returnedItems: 0
    });
    expect(result.truncated).toBe(false);
  });

  it("keeps project and cycle scope out of AMP-116 instead of silently broadening it", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({ data: {} });
    }) as typeof fetch;

    await expect(
      searchLinearIssues({
        token: "lin_api_test",
        fetchImpl,
        request: {
          query: "backlog",
          scope: { teamId: "team_amp", projectId: "project_opentag" },
          pagination: { first: 10, maxItems: 20 }
        }
      })
    ).rejects.toThrow("project and cycle scope are not implemented yet");
    expect(called).toBe(false);
  });

  it("validates search bounds before calling Linear", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({ data: {} });
    }) as typeof fetch;

    await expect(
      searchLinearIssues({
        token: "lin_api_test",
        fetchImpl,
        request: {
          query: "backlog",
          scope: { teamId: "team_amp" },
          pagination: { first: 0, maxItems: 10 }
        }
      })
    ).rejects.toThrow("pagination.first must be a positive integer");
    expect(called).toBe(false);
  });
});
