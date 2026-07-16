import { describe, expect, it } from "vitest";
import {
  createSlackLinearBacklogHandler,
  renderSlackLinearBacklogReply,
  resolveSlackLinearBacklogSettings,
  SLACK_LINEAR_BACKLOG_LIMIT
} from "../src/slack-linear-backlog.js";

const CONTEXT = { teamId: "T123", channelId: "C123", threadTs: "1.0", userId: "U1", binding: null };

function issue(n: number, overrides: Partial<{ stateName: string; stateType: string; priority: number; title: string }> = {}) {
  const stateName = overrides.stateName ?? "Todo";
  const stateType = overrides.stateType ?? "unstarted";
  return {
    identifier: `AMP-${n}`,
    title: overrides.title ?? `Task ${n}`,
    url: `https://linear.app/a/issue/AMP-${n}`,
    stateName,
    stateType,
    priority: overrides.priority ?? 0
  };
}

function backlogFetch(
  nodes: ReturnType<typeof issue>[],
  options: { hasNextPage?: boolean; projectName?: string | null } = {}
): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        data: {
          project: options.projectName === undefined ? { name: "opentag" } : options.projectName ? { name: options.projectName } : null,
          issues: {
            nodes: nodes.map((entry) => ({
              identifier: entry.identifier,
              title: entry.title,
              url: entry.url,
              priority: entry.priority,
              state: { name: entry.stateName, type: entry.stateType }
            })),
            pageInfo: { hasNextPage: options.hasNextPage ?? false }
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
  it("renders the header with project name and total, grouped headings, and issue lines", () => {
    const text = renderSlackLinearBacklogReply({
      backlog: {
        issues: [
          issue(140, { stateName: "In Progress", stateType: "started", priority: 1, title: "显示生成失败重试机制" }),
          issue(131, { stateName: "In Progress", stateType: "started", title: "这个ocr把他主人的名字都搞错了；代办 ocr 优化" }),
          issue(153, { priority: 2, title: "Slack：通过 @opentag linear 查询未完成的 Linear 任务" }),
          issue(132, { title: "显示生成失败，the provider returned an empty draft" })
        ],
        fetched: 4,
        hasMore: false,
        projectName: "opentag"
      },
      limit: SLACK_LINEAR_BACKLOG_LIMIT,
      queriedAt: "2026-07-16T22:48:00.000Z"
    });

    const lines = text.split("\n");
    expect(lines).toEqual([
      "*opentag · 4 open*",
      "",
      "🔵 *In Progress (2)*",
      "• <https://linear.app/a/issue/AMP-140|AMP-140> [urgent] 显示生成失败重试机制",
      "• <https://linear.app/a/issue/AMP-131|AMP-131> 这个ocr把他主人的名字都搞错了；代办 ocr 优化",
      "",
      "⚪ *Todo (2)*",
      "• <https://linear.app/a/issue/AMP-153|AMP-153> [high] Slack：通过 @opentag linear 查询未完成的 Linear 任务",
      "• <https://linear.app/a/issue/AMP-132|AMP-132> 显示生成失败，the provider returned an empty draft",
      "",
      "_Linear · queried 22:48 UTC_"
    ]);
  });

  it("falls back to 'Backlog' as the header name when no project name is available", () => {
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [issue(1)], fetched: 1, hasMore: false, projectName: null },
      limit: SLACK_LINEAR_BACKLOG_LIMIT,
      queriedAt: "2026-07-16T22:48:00.000Z"
    });
    expect(text).toContain("*Backlog · 1 open*");
  });

  it("uses no priority marker and a single space before the title when priority has no urgent/high marker", () => {
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [issue(1, { priority: 3 })], fetched: 1, hasMore: false, projectName: "opentag" },
      limit: SLACK_LINEAR_BACKLOG_LIMIT,
      queriedAt: "2026-07-16T22:48:00.000Z"
    });
    expect(text).toContain("• <https://linear.app/a/issue/AMP-1|AMP-1> Task 1");
  });

  it("truncates at the limit, marks a partially-shown group heading, and reports the hidden count in the footer", () => {
    const inProgress = Array.from({ length: 2 }, (_, index) => issue(index + 1, { stateName: "In Progress", stateType: "started" }));
    const todo = Array.from({ length: 30 }, (_, index) => issue(1000 + index));
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [...inProgress, ...todo], fetched: 32, hasMore: false, projectName: "opentag" },
      limit: 20,
      queriedAt: "2026-07-16T22:48:00.000Z"
    });

    expect(text).toContain("*opentag · 32 open* · showing 20");
    expect(text).toContain("🔵 *In Progress (2)*");
    expect(text).toContain("⚪ *Todo (18 of 30)*");
    expect(text.match(/^• /gmu)).toHaveLength(20);
    expect(text).toContain("_Linear · queried 22:48 UTC · 12 more not shown_");
  });

  it("renders N+ totals and hidden counts when Linear reports more pages via hasMore", () => {
    const issues = Array.from({ length: 100 }, (_, index) => issue(index + 1));
    const text = renderSlackLinearBacklogReply({
      backlog: { issues, fetched: 100, hasMore: true, projectName: "opentag" },
      limit: 20,
      queriedAt: "2026-07-16T22:48:00.000Z"
    });

    expect(text).toContain("*opentag · 100+ open* · showing 20");
    expect(text).toContain("_Linear · queried 22:48 UTC · 80+ more not shown_");
  });

  it("renders the empty-backlog layout", () => {
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [], fetched: 0, hasMore: false, projectName: "opentag" },
      limit: 20,
      queriedAt: "2026-07-16T22:48:00.000Z"
    });

    expect(text.split("\n")).toEqual([
      "*opentag · 0 open* 🎉",
      "No unfinished issues in this Linear project.",
      "",
      "_Linear · queried 22:48 UTC_"
    ]);
  });

  it("escapes Linear-controlled title, state, and project name so hostile content cannot inject Slack mrkdwn", () => {
    const hostileIssue = {
      identifier: "AMP-999",
      title: "<https://evil.example|click here> & more",
      url: "https://linear.app/a/issue/AMP-999",
      stateName: "<b>Weird</b> & State",
      stateType: "started",
      priority: 0
    };
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [hostileIssue], fetched: 1, hasMore: false, projectName: "<script>evil</script>" },
      limit: SLACK_LINEAR_BACKLOG_LIMIT,
      queriedAt: "2026-07-16T22:48:00.000Z"
    });

    expect(text).toContain("*&lt;script&gt;evil&lt;/script&gt; · 1 open*");
    expect(text).toContain("🔵 *&lt;b&gt;Weird&lt;/b&gt; &amp; State (1)*");
    expect(text).toContain(
      "• <https://linear.app/a/issue/AMP-999|AMP-999> &lt;https://evil.example|click here&gt; &amp; more"
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
      stateType: "unstarted",
      priority: 0
    };
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [nonAsciiIssue], fetched: 1, hasMore: false, projectName: "opentag" },
      limit: SLACK_LINEAR_BACKLOG_LIMIT,
      queriedAt: "2026-07-16T22:48:00.000Z"
    });
    expect(text).toContain(
      "<https://linear.app/amplift/issue/AMP-153/slack%E9%80%9A%E8%BF%87-opentag-linear-%E6%9F%A5%E8%AF%A2%E6%9C%AA%E5%AE%8C%E6%88%90%E7%9A%84-linear-%E4%BB%BB%E5%8A%A1|AMP-153>"
    );
  });

  it("leaves an already-ASCII issue URL byte-identical", () => {
    const text = renderSlackLinearBacklogReply({
      backlog: { issues: [issue(153)], fetched: 1, hasMore: false, projectName: "opentag" },
      limit: SLACK_LINEAR_BACKLOG_LIMIT,
      queriedAt: "2026-07-16T22:48:00.000Z"
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
      now: () => "2026-07-16T22:48:00.000Z"
    });
    const reply = await handler(CONTEXT);
    expect(reply).toEqual(
      expect.objectContaining({
        textFormat: "mrkdwn",
        text: expect.stringContaining("opentag · 1 open")
      })
    );
    expect(typeof reply === "string" ? reply : reply.text).toContain("AMP-153");
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
