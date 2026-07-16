import { describe, expect, it } from "vitest";
import {
  createSlackLinearBacklogHandler,
  renderSlackLinearBacklogReply,
  resolveSlackLinearBacklogSettings,
  SLACK_LINEAR_BACKLOG_LIMIT
} from "../src/slack-linear-backlog.js";

const CONTEXT = { teamId: "T123", channelId: "C123", threadTs: "1.0", userId: "U1", binding: null };

function issue(n: number, stateName = "Todo", stateType = "unstarted") {
  return { identifier: `AMP-${n}`, title: `Task ${n}`, url: `https://linear.app/a/issue/AMP-${n}`, stateName, stateType };
}

function backlogFetch(nodes: ReturnType<typeof issue>[], hasNextPage = false): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes: nodes.map((entry) => ({
              identifier: entry.identifier,
              title: entry.title,
              url: entry.url,
              state: { name: entry.stateName, type: entry.stateType }
            })),
            pageInfo: { hasNextPage }
          }
        }
      }),
      { status: 200 }
    )) as typeof fetch;
}

describe("resolveSlackLinearBacklogSettings", () => {
  it("prefers platforms.linear over env fallback", () => {
    const settings = resolveSlackLinearBacklogSettings({
      linear: { token: "cfg_token", projectId: "cfg_proj" },
      env: { OPENTAG_LINEAR_API_KEY: "env_token", OPENTAG_LINEAR_PROJECT_ID: "env_proj" }
    });
    expect(settings).toEqual({ token: "cfg_token", projectId: "cfg_proj" });
  });

  it("falls back to OPENTAG_LINEAR_API_KEY / OPENTAG_LINEAR_PROJECT_ID", () => {
    const settings = resolveSlackLinearBacklogSettings({
      env: { OPENTAG_LINEAR_API_KEY: "env_token", OPENTAG_LINEAR_PROJECT_ID: "env_proj" }
    });
    expect(settings).toEqual({ token: "env_token", projectId: "env_proj" });
  });

  it("accepts OPENTAG_LINEAR_TOKEN as the secondary token fallback", () => {
    const settings = resolveSlackLinearBacklogSettings({
      env: { OPENTAG_LINEAR_TOKEN: "env_token2", OPENTAG_LINEAR_PROJECT_ID: "env_proj" }
    });
    expect(settings?.token).toBe("env_token2");
  });

  it("returns null when token or projectId is missing", () => {
    expect(resolveSlackLinearBacklogSettings({ env: { OPENTAG_LINEAR_API_KEY: "t" } })).toBeNull();
    expect(resolveSlackLinearBacklogSettings({ env: { OPENTAG_LINEAR_PROJECT_ID: "p" } })).toBeNull();
    expect(resolveSlackLinearBacklogSettings({})).toBeNull();
  });
});

describe("renderSlackLinearBacklogReply", () => {
  it("renders header with count, source, query time, and one line per issue", () => {
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [issue(131, "In Progress", "started"), issue(153)], fetched: 2, hasMore: false },
      limit: SLACK_LINEAR_BACKLOG_LIMIT,
      queriedAt: "2026-07-16T21:30:45.123Z"
    });
    expect(text).toContain("OpenTag project backlog — 2 open issues (source: Linear, queried 2026-07-16T21:30Z):");
    expect(text).toContain("• <https://linear.app/a/issue/AMP-131|AMP-131> — Task 131  [In Progress]");
    expect(text).toContain("• <https://linear.app/a/issue/AMP-153|AMP-153> — Task 153  [Todo]");
    expect(text).not.toContain("Showing");
  });

  it("truncates at the limit and reports shown/total", () => {
    const issues = Array.from({ length: 25 }, (_, index) => issue(index + 1));
    const text = renderSlackLinearBacklogReply({
      backlog: { issues, fetched: 25, hasMore: false },
      limit: 20,
      queriedAt: "2026-07-16T21:30:00.000Z"
    });
    expect(text).toContain("25 open issues");
    expect(text.match(/^• /gmu)).toHaveLength(20);
    expect(text).toContain("Showing 20 of 25 open issues.");
  });

  it("marks totals as N+ when the Linear page reports more results", () => {
    const issues = Array.from({ length: 100 }, (_, index) => issue(index + 1));
    const text = renderSlackLinearBacklogReply({
      backlog: { issues, fetched: 100, hasMore: true },
      limit: 20,
      queriedAt: "2026-07-16T21:30:00.000Z"
    });
    expect(text).toContain("100+ open issues");
    expect(text).toContain("Showing 20 of 100+ open issues.");
  });

  it("renders an explicit empty-backlog line", () => {
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [], fetched: 0, hasMore: false },
      limit: 20,
      queriedAt: "2026-07-16T21:30:00.000Z"
    });
    expect(text).toContain("0 open issues");
    expect(text).toContain("No unfinished issues in the configured Linear project.");
  });

  it("escapes Linear-controlled title and state text so hostile content cannot inject Slack mrkdwn links", () => {
    const hostileIssue = {
      identifier: "AMP-999",
      title: "<https://evil.example|click here> & more",
      url: "https://linear.app/a/issue/AMP-999",
      stateName: "<b>Weird</b> & State",
      stateType: "started"
    };
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [hostileIssue], fetched: 1, hasMore: false },
      limit: SLACK_LINEAR_BACKLOG_LIMIT,
      queriedAt: "2026-07-16T21:30:00.000Z"
    });
    expect(text).toContain(
      "• <https://linear.app/a/issue/AMP-999|AMP-999> — &lt;https://evil.example|click here&gt; &amp; more  [&lt;b&gt;Weird&lt;/b&gt; &amp; State]"
    );
    // The identifier link itself must stay unescaped so Slack still renders it as a clickable link.
    expect(text).toContain("<https://linear.app/a/issue/AMP-999|AMP-999>");
  });

  it("percent-encodes non-ASCII characters in the Linear issue URL so Slack renders a valid link", () => {
    const nonAsciiIssue = {
      identifier: "AMP-153",
      title: "Task",
      url: "https://linear.app/amplift/issue/AMP-153/slack通过-opentag-linear-查询未完成的-linear-任务",
      stateName: "Todo",
      stateType: "unstarted"
    };
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [nonAsciiIssue], fetched: 1, hasMore: false },
      limit: SLACK_LINEAR_BACKLOG_LIMIT,
      queriedAt: "2026-07-16T21:30:00.000Z"
    });
    expect(text).toContain(
      "• <https://linear.app/amplift/issue/AMP-153/slack%E9%80%9A%E8%BF%87-opentag-linear-%E6%9F%A5%E8%AF%A2%E6%9C%AA%E5%AE%8C%E6%88%90%E7%9A%84-linear-%E4%BB%BB%E5%8A%A1|AMP-153>"
    );
  });

  it("leaves an already-ASCII issue URL byte-identical", () => {
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [issue(153)], fetched: 1, hasMore: false },
      limit: SLACK_LINEAR_BACKLOG_LIMIT,
      queriedAt: "2026-07-16T21:30:00.000Z"
    });
    expect(text).toContain("• <https://linear.app/a/issue/AMP-153|AMP-153>");
  });
});

describe("createSlackLinearBacklogHandler", () => {
  it("replies not-configured when settings are missing", async () => {
    const handler = createSlackLinearBacklogHandler({ env: {} });
    const reply = await handler(CONTEXT);
    expect(reply).toContain("Linear backlog is not configured");
  });

  it("queries Linear and renders the backlog reply", async () => {
    const handler = createSlackLinearBacklogHandler({
      linear: { token: "lin_api_test", projectId: "proj_1" } as never,
      env: {},
      fetchImpl: backlogFetch([issue(153)]),
      now: () => "2026-07-16T21:30:00.000Z"
    });
    const reply = await handler(CONTEXT);
    expect(reply).toContain("1 open issue");
    expect(reply).toContain("AMP-153");
  });

  it("replies a safe unavailable message on API failure and logs without the token", async () => {
    const logged: string[] = [];
    const failingFetch = (async () => new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 500 })) as typeof fetch;
    const handler = createSlackLinearBacklogHandler({
      linear: { token: "lin_api_supersecret", projectId: "proj_1" } as never,
      env: {},
      fetchImpl: failingFetch,
      logError: (message) => logged.push(message)
    });
    const reply = await handler(CONTEXT);
    expect(reply).toContain("Linear API is unavailable");
    expect(logged.join("\n")).toContain("boom");
    expect(logged.join("\n")).not.toContain("supersecret");
    expect(String(reply)).not.toContain("supersecret");
  });
});
