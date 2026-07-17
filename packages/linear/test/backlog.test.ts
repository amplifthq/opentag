import { describe, expect, it } from "vitest";
import { fetchLinearProjectBacklog } from "../src/backlog.js";

type FetchCall = { url: string; body: Record<string, unknown> };

function fetchStub(input: {
  calls: FetchCall[];
  project?: { name: string } | null;
  nodes: Array<{
    identifier: string;
    title: string;
    url: string;
    priority?: number | null;
    state: { name: string; type: string };
  }>;
  hasNextPage?: boolean;
}): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    input.calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(
      JSON.stringify({
        data: {
          project: input.project ?? null,
          issues: { nodes: input.nodes, pageInfo: { hasNextPage: input.hasNextPage ?? false } }
        }
      }),
      { status: 200 }
    );
  }) as typeof fetch;
}

const AMP_153 = {
  identifier: "AMP-153",
  title: "Slack linear command",
  url: "https://linear.app/a/issue/AMP-153",
  priority: 2,
  state: { name: "Todo", type: "unstarted" }
};
const AMP_131 = {
  identifier: "AMP-131",
  title: "OCR fix",
  url: "https://linear.app/a/issue/AMP-131",
  priority: 0,
  state: { name: "In Progress", type: "started" }
};
const AMP_9 = {
  identifier: "AMP-9",
  title: "Old backlog item",
  url: "https://linear.app/a/issue/AMP-9",
  priority: 4,
  state: { name: "Backlog", type: "backlog" }
};

describe("fetchLinearProjectBacklog", () => {
  it("queries unfinished project issues, the project name, and excludes completed/canceled state types", async () => {
    const calls: FetchCall[] = [];
    await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls, project: { name: "opentag" }, nodes: [] })
    });

    expect(calls).toHaveLength(1);
    const query = String(calls[0]!.body.query);
    expect(query).toContain('nin: ["completed", "canceled"]');
    expect(query).toContain("project(id: $projectKey)");
    expect(query).toContain("priority");
    expect(query).not.toContain("mutation");
    expect(calls[0]!.body.variables).toEqual({ projectId: "proj_1", projectKey: "proj_1", first: 100 });
  });

  it("sorts by state type (started, unstarted, backlog) then priority then issue number", async () => {
    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], project: { name: "opentag" }, nodes: [AMP_9, AMP_153, AMP_131] })
    });

    expect(backlog.issues.map((issue) => issue.identifier)).toEqual(["AMP-131", "AMP-153", "AMP-9"]);
    expect(backlog.issues[0]).toEqual({
      identifier: "AMP-131",
      title: "OCR fix",
      url: "https://linear.app/a/issue/AMP-131",
      stateName: "In Progress",
      stateType: "started",
      priority: 0
    });
    expect(backlog.fetched).toBe(3);
    expect(backlog.hasMore).toBe(false);
  });

  it("sorts by priority within a single state type: urgent, then high, then medium, then none", async () => {
    const none = {
      identifier: "AMP-4",
      title: "None",
      url: "https://linear.app/a/issue/AMP-4",
      priority: 0,
      state: { name: "Todo", type: "unstarted" }
    };
    const medium = {
      identifier: "AMP-3",
      title: "Medium",
      url: "https://linear.app/a/issue/AMP-3",
      priority: 3,
      state: { name: "Todo", type: "unstarted" }
    };
    const urgent = {
      identifier: "AMP-1",
      title: "Urgent",
      url: "https://linear.app/a/issue/AMP-1",
      priority: 1,
      state: { name: "Todo", type: "unstarted" }
    };
    const high = {
      identifier: "AMP-2",
      title: "High",
      url: "https://linear.app/a/issue/AMP-2",
      priority: 2,
      state: { name: "Todo", type: "unstarted" }
    };

    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], project: { name: "opentag" }, nodes: [none, medium, urgent, high] })
    });

    expect(backlog.issues.map((issue) => issue.identifier)).toEqual(["AMP-1", "AMP-2", "AMP-3", "AMP-4"]);
  });

  it("maps the project name from the GraphQL response", async () => {
    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], project: { name: "opentag" }, nodes: [] })
    });

    expect(backlog.projectName).toBe("opentag");
  });

  it("rejects when the Linear project is missing or inaccessible instead of resolving an empty backlog", async () => {
    const resultPromise = fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], project: null, nodes: [] })
    });

    await expect(resultPromise).rejects.toThrow(/not found or inaccessible/i);
  });

  it("maps missing or null priority to 0", async () => {
    const missingPriorityField = {
      identifier: "AMP-5",
      title: "No priority field",
      url: "https://linear.app/a/issue/AMP-5",
      state: { name: "Todo", type: "unstarted" }
    };
    const nullPriority = {
      identifier: "AMP-6",
      title: "Null priority",
      url: "https://linear.app/a/issue/AMP-6",
      priority: null,
      state: { name: "Todo", type: "unstarted" }
    };

    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], project: { name: "opentag" }, nodes: [missingPriorityField, nullPriority] })
    });

    expect(backlog.issues.every((issue) => issue.priority === 0)).toBe(true);
  });

  it("reports hasMore from pageInfo.hasNextPage", async () => {
    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], project: { name: "opentag" }, nodes: [AMP_153], hasNextPage: true })
    });

    expect(backlog.hasMore).toBe(true);
  });

  it("propagates GraphQL failures without embedding the token", async () => {
    const failingFetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), { status: 429 })) as typeof fetch;

    await expect(
      fetchLinearProjectBacklog({ token: "lin_api_supersecret", projectId: "proj_1", fetchImpl: failingFetch })
    ).rejects.toThrow(/rate limited/);
    await expect(
      fetchLinearProjectBacklog({ token: "lin_api_supersecret", projectId: "proj_1", fetchImpl: failingFetch })
    ).rejects.not.toThrow(/supersecret/);
  });
});
