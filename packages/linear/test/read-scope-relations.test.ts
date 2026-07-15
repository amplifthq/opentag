import { describe, expect, it } from "vitest";
import {
  LINEAR_ISSUE_RELATION_MAX_ITEMS,
  getLinearIssue,
  listLinearIssues,
  searchLinearIssues
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

function rawIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...issueReference("AMP-118"),
    description: "Read project, current cycle, and issue relations.",
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
    project: { id: "project_opentag", name: "OpenTag", url: "https://linear.app/acme/project/opentag" },
    cycle: {
      id: "cycle_42",
      number: 42,
      name: "Project Intelligence Phase 1",
      startsAt: "2026-07-14T00:00:00.000Z",
      endsAt: "2026-07-28T00:00:00.000Z"
    },
    assignee: null,
    labels: { nodes: [] },
    relations: {
      nodes: [
        { type: "blocks", relatedIssue: issueReference("AMP-119") },
        { type: "related", relatedIssue: issueReference("AMP-120") },
        { type: "duplicate", relatedIssue: issueReference("AMP-099") }
      ],
      pageInfo: { hasNextPage: false }
    },
    inverseRelations: {
      nodes: [
        { type: "blocks", issue: issueReference("AMP-117") },
        { type: "related", issue: issueReference("AMP-114") }
      ],
      pageInfo: { hasNextPage: false }
    },
    ...overrides
  };
}

const team = { id: "team_amp", key: "AMP", name: "OpenTag" };
const project = {
  id: "project_opentag",
  name: "OpenTag",
  url: "https://linear.app/acme/project/opentag",
  teams: { nodes: [{ id: "team_amp" }] }
};
const currentCycle = {
  id: "cycle_42",
  number: 42,
  name: "Project Intelligence Phase 1",
  startsAt: "2026-07-14T00:00:00.000Z",
  endsAt: "2026-07-28T00:00:00.000Z",
  team: { id: "team_amp" }
};

describe("Linear project, cycle, and relation reads", () => {
  it("resolves project and current-cycle scope before listing issues", async () => {
    const bodies: GraphqlBody[] = [];
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      bodies.push(body);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team } });
      }
      if (body.query.includes("OpenTagLinearResolveIssueReadProject")) {
        return Response.json({ data: { project } });
      }
      if (body.query.includes("OpenTagLinearResolveIssueReadCurrentCycle")) {
        return Response.json({ data: { cycles: { nodes: [currentCycle] } } });
      }
      if (body.query.includes("OpenTagLinearIssueList")) {
        return Response.json({
          data: { issues: { nodes: [rawIssue()], pageInfo: { hasNextPage: false, endCursor: "cursor_end" } } }
        });
      }
      return Response.json({ errors: [{ message: "unexpected operation" }] });
    }) as typeof fetch;

    const result = await listLinearIssues({
      token: "lin_api_secret",
      fetchImpl,
      request: {
        scope: {
          teamId: "team_amp",
          projectId: "project_opentag",
          cycle: { kind: "current" }
        },
        filter: { completion: "unfinished" },
        pagination: { first: 25, maxItems: 50 }
      }
    });

    expect(bodies).toHaveLength(4);
    expect(bodies[1]?.variables).toEqual({ projectId: "project_opentag", teamId: "team_amp" });
    expect(bodies[2]?.variables).toEqual({ teamId: "team_amp" });
    expect(bodies[3]?.variables.filter).toEqual({
      team: { id: { eq: "team_amp" } },
      project: { id: { eq: "project_opentag" } },
      cycle: { id: { eq: "cycle_42" } },
      state: { type: { nin: ["completed", "canceled"] } }
    });
    expect(result.resolvedScope).toEqual({
      team,
      project: { id: "project_opentag", name: "OpenTag", url: "https://linear.app/acme/project/opentag" },
      cycle: {
        id: "cycle_42",
        number: 42,
        name: "Project Intelligence Phase 1",
        startsAt: "2026-07-14T00:00:00.000Z",
        endsAt: "2026-07-28T00:00:00.000Z"
      }
    });
    expect(result.items[0]?.relations).toEqual([
      { kind: "blocks", issue: issueReference("AMP-119") },
      { kind: "related", issue: issueReference("AMP-120") },
      { kind: "blocked_by", issue: issueReference("AMP-117") },
      { kind: "related", issue: issueReference("AMP-114") }
    ]);
    expect(JSON.stringify(result)).not.toContain("lin_api_secret");
  });

  it("resolves an explicit cycle id and applies it to search", async () => {
    const bodies: GraphqlBody[] = [];
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      bodies.push(body);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team } });
      }
      if (body.query.includes("OpenTagLinearResolveIssueReadCycle")) {
        return Response.json({ data: { cycle: currentCycle } });
      }
      return Response.json({
        data: { searchIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }
      });
    }) as typeof fetch;

    const result = await searchLinearIssues({
      token: "lin_api_test",
      fetchImpl,
      request: {
        query: "backlog",
        scope: { teamId: "team_amp", cycle: { kind: "id", id: "cycle_42" } },
        pagination: { first: 10, maxItems: 20 }
      }
    });

    expect(bodies[1]?.variables).toEqual({ cycleId: "cycle_42" });
    expect(bodies[2]?.variables.filter).toEqual({
      team: { id: { eq: "team_amp" } },
      cycle: { id: { eq: "cycle_42" } }
    });
    expect(result.resolvedScope.cycle?.id).toBe("cycle_42");
  });

  it("rejects a project that is outside the requested team before reading issues", async () => {
    const bodies: GraphqlBody[] = [];
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      bodies.push(body);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team } });
      }
      return Response.json({ data: { project: { ...project, teams: { nodes: [] } } } });
    }) as typeof fetch;

    await expect(
      listLinearIssues({
        token: "lin_api_test",
        fetchImpl,
        request: {
          scope: { teamId: "team_amp", projectId: "project_other" },
          pagination: { first: 10, maxItems: 20 }
        }
      })
    ).rejects.toThrow("project project_other is not associated with team team_amp");
    expect(bodies).toHaveLength(2);
  });

  it("rejects current-cycle scope when the team has no active cycle", async () => {
    const fetchImpl = (async (_url, init) => {
      const body = bodyFrom(init);
      if (body.query.includes("OpenTagLinearResolveIssueReadTeam")) {
        return Response.json({ data: { team } });
      }
      return Response.json({ data: { cycles: { nodes: [] } } });
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
    ).rejects.toThrow("could not resolve an active cycle for team team_amp");
  });

  it("fails instead of returning a partial relation snapshot", async () => {
    const fetchImpl = (async () =>
      Response.json({
        data: {
          issue: rawIssue({
            relations: {
              nodes: [{ type: "blocks", relatedIssue: issueReference("AMP-119") }],
              pageInfo: { hasNextPage: true }
            }
          })
        }
      })) as typeof fetch;

    await expect(
      getLinearIssue({
        token: "lin_api_test",
        fetchImpl,
        request: { issue: { identifier: "AMP-118" } }
      })
    ).rejects.toThrow(`exceeded the ${LINEAR_ISSUE_RELATION_MAX_ITEMS}-relation safety limit`);
  });
});
