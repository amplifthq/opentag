import { fetchLinearProjectBacklog, type LinearBacklogIssue, type LinearProjectBacklog } from "@opentag/linear";
import { escapeSlackText, type SlackEventProcessorInput } from "@opentag/slack";
import type { OpenTagCliConfig } from "./config.js";

export const SLACK_LINEAR_BACKLOG_LIMIT = 20;
export const SLACK_LINEAR_BACKLOG_TIMEOUT_MS = 10_000;

const NOT_CONFIGURED_TEXT =
  "Linear backlog is not configured. Set platforms.linear.projectId and a Linear token in the OpenTag config, or export OPENTAG_LINEAR_API_KEY and OPENTAG_LINEAR_PROJECT_ID.";
const UNAVAILABLE_TEXT = "Linear API is unavailable right now; try again later.";

// Emoji shown before each state-type group heading; anything not in this map
// (unknown/future Linear state types) falls back to a neutral marker.
const STATE_TYPE_EMOJI: Record<string, string> = {
  started: "🔵",
  unstarted: "⚪",
  backlog: "⚫",
  triage: "🟣"
};

export function resolveSlackLinearBacklogSettings(input: {
  linear?: { token?: string | undefined; projectId?: string | undefined; graphqlUrl?: string | undefined } | undefined;
  env?: NodeJS.ProcessEnv;
}): { token: string; projectId: string; graphqlUrl?: string } | null {
  const env = input.env ?? {};
  const token = input.linear?.token ?? env.OPENTAG_LINEAR_API_KEY ?? env.OPENTAG_LINEAR_TOKEN;
  const projectId = input.linear?.projectId ?? env.OPENTAG_LINEAR_PROJECT_ID;
  if (!token?.trim() || !projectId?.trim()) return null;
  const graphqlUrl = input.linear?.graphqlUrl ?? env.OPENTAG_LINEAR_GRAPHQL_URL;
  return { token: token.trim(), projectId: projectId.trim(), ...(graphqlUrl ? { graphqlUrl } : {}) };
}

function priorityMarker(priority: number): string {
  if (priority === 1) return " [urgent]";
  if (priority === 2) return " [high]";
  return "";
}

function renderIssueLine(issue: LinearBacklogIssue): string {
  const marker = priorityMarker(issue.priority);
  return `• <${encodeURI(issue.url)}|${escapeSlackText(issue.identifier)}>${marker} ${escapeSlackText(issue.title)}`;
}

type IssueGroup = { stateName: string; stateType: string; issues: LinearBacklogIssue[] };

// Groups the already-limited "shown" issues by stateName, preserving the
// order in which each stateName is first encountered in the sorted list.
function groupShownIssues(shown: LinearBacklogIssue[]): IssueGroup[] {
  const groups: IssueGroup[] = [];
  const byStateName = new Map<string, IssueGroup>();
  for (const issue of shown) {
    let group = byStateName.get(issue.stateName);
    if (!group) {
      group = { stateName: issue.stateName, stateType: issue.stateType, issues: [] };
      byStateName.set(issue.stateName, group);
      groups.push(group);
    }
    group.issues.push(issue);
  }
  return groups;
}

export function renderSlackLinearBacklogReply(input: {
  backlog: LinearProjectBacklog;
  limit: number;
  queriedAt: string;
}): string {
  const { backlog, limit, queriedAt } = input;
  const shown = backlog.issues.slice(0, limit);
  const name = escapeSlackText(backlog.projectName ?? "Backlog");
  const truncated = backlog.fetched > limit || backlog.hasMore;
  const queriedHhMm = queriedAt.slice(11, 16);

  const lines: string[] = [];
  if (backlog.fetched === 0) {
    lines.push(`*${name} · 0 open* 🎉`);
    lines.push("No unfinished issues in this Linear project.");
  } else {
    const totalLabel = backlog.hasMore ? `${backlog.fetched}+` : String(backlog.fetched);
    const showingSuffix = truncated ? ` · showing ${shown.length}` : "";
    lines.push(`*${name} · ${totalLabel} open*${showingSuffix}`);

    for (const group of groupShownIssues(shown)) {
      const totalInGroup = backlog.issues.filter((issue) => issue.stateName === group.stateName).length;
      const shownInGroup = group.issues.length;
      const countLabel = shownInGroup < totalInGroup ? `${shownInGroup} of ${totalInGroup}` : String(totalInGroup);
      const emoji = STATE_TYPE_EMOJI[group.stateType] ?? "▫️";
      lines.push("");
      lines.push(`${emoji} *${escapeSlackText(group.stateName)} (${countLabel})*`);
      for (const issue of group.issues) {
        lines.push(renderIssueLine(issue));
      }
    }
  }

  lines.push("");
  if (truncated) {
    const hiddenCount = backlog.fetched - shown.length;
    const hiddenLabel = backlog.hasMore ? `${hiddenCount}+` : String(hiddenCount);
    lines.push(`_Linear · queried ${queriedHhMm} UTC · ${hiddenLabel} more not shown_`);
  } else {
    lines.push(`_Linear · queried ${queriedHhMm} UTC_`);
  }
  return lines.join("\n");
}

export function createSlackLinearBacklogHandler(input: {
  linear?: OpenTagCliConfig["platforms"]["linear"];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => string;
  logError?: (message: string) => void;
}): NonNullable<SlackEventProcessorInput["linear"]> {
  const now = input.now ?? (() => new Date().toISOString());
  const logError = input.logError ?? ((message: string) => console.error(message));
  return async () => {
    const settings = resolveSlackLinearBacklogSettings({
      ...(input.linear ? { linear: input.linear } : {}),
      env: input.env ?? process.env
    });
    if (!settings) return NOT_CONFIGURED_TEXT;
    try {
      const backlog = await fetchLinearProjectBacklog({
        token: settings.token,
        projectId: settings.projectId,
        ...(settings.graphqlUrl ? { graphqlUrl: settings.graphqlUrl } : {}),
        fetchImpl: input.fetchImpl ?? fetch,
        timeoutMs: SLACK_LINEAR_BACKLOG_TIMEOUT_MS
      });
      return {
        text: renderSlackLinearBacklogReply({ backlog, limit: SLACK_LINEAR_BACKLOG_LIMIT, queriedAt: now() }),
        textFormat: "mrkdwn" as const
      };
    } catch (error) {
      // linearGraphql error messages contain the HTTP status and GraphQL error
      // text only — never the token — so the message is safe for local logs.
      logError(`[slack] linear backlog query failed: ${error instanceof Error ? error.message : String(error)}`);
      return UNAVAILABLE_TEXT;
    }
  };
}
