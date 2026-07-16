import { describe, expect, it } from "vitest";
import { fetchLinearProjectBacklog } from "../src/backlog.js";

type FetchCall = { url: string; body: Record<string, unknown> };

function fetchStub(input: {
  calls: FetchCall[];
  nodes: Array<{ identifier: string; title: string; url: string; state: { name: string; type: string } }>;
  hasNextPage?: boolean;
}): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    input.calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(
      JSON.stringify({ data: { issues: { nodes: input.nodes, pageInfo: { hasNextPage: input.hasNextPage ?? false } } } }),
      { status: 200 }
    );
  }) as typeof fetch;
}

const AMP_153 = { identifier: "AMP-153", title: "Slack linear command", url: "https://linear.app/a/issue/AMP-153", state: { name: "Todo", type: "unstarted" } };
const AMP_131 = { identifier: "AMP-131", title: "OCR fix", url: "https://linear.app/a/issue/AMP-131", state: { name: "In Progress", type: "started" } };
const AMP_9 = { identifier: "AMP-9", title: "Old backlog item", url: "https://linear.app/a/issue/AMP-9", state: { name: "Backlog", type: "backlog" } };

describe("fetchLinearProjectBacklog", () => {
  it("queries unfinished project issues and excludes completed/canceled state types", async () => {
    const calls: FetchCall[] = [];
    await fetchLinearProjectBacklog({ token: "lin_api_test", projectId: "proj_1", fetchImpl: fetchStub({ calls, nodes: [] }) });

    expect(calls).toHaveLength(1);
    const query = String(calls[0]!.body.query);
    expect(query).toContain('nin: ["completed", "canceled"]');
    expect(query).not.toContain("mutation");
    expect(calls[0]!.body.variables).toEqual({ projectId: "proj_1", first: 100 });
  });

  it("sorts by state type (started, unstarted, backlog) then issue number", async () => {
    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], nodes: [AMP_9, AMP_153, AMP_131] })
    });

    expect(backlog.issues.map((issue) => issue.identifier)).toEqual(["AMP-131", "AMP-153", "AMP-9"]);
    expect(backlog.issues[0]).toEqual({ identifier: "AMP-131", title: "OCR fix", url: "https://linear.app/a/issue/AMP-131", stateName: "In Progress", stateType: "started" });
    expect(backlog.fetched).toBe(3);
    expect(backlog.hasMore).toBe(false);
  });

  it("reports hasMore from pageInfo.hasNextPage", async () => {
    const backlog = await fetchLinearProjectBacklog({
      token: "lin_api_test",
      projectId: "proj_1",
      fetchImpl: fetchStub({ calls: [], nodes: [AMP_153], hasNextPage: true })
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
