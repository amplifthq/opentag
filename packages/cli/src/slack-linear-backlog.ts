import { fetchLinearProjectBacklog, type LinearProjectBacklog } from "@opentag/linear";
import type { SlackEventProcessorInput } from "@opentag/slack";
import type { OpenTagCliConfig } from "./config.js";

export const SLACK_LINEAR_BACKLOG_LIMIT = 20;
export const SLACK_LINEAR_BACKLOG_TIMEOUT_MS = 10_000;

const NOT_CONFIGURED_TEXT =
  "Linear backlog is not configured. Set platforms.linear.projectId and a Linear token in the OpenTag config, or export OPENTAG_LINEAR_API_KEY and OPENTAG_LINEAR_PROJECT_ID.";
const UNAVAILABLE_TEXT = "Linear API is unavailable right now; try again later.";

export function resolveSlackLinearBacklogSettings(input: {
  linear?: { token?: string; projectId?: string; graphqlUrl?: string } | undefined;
  env?: NodeJS.ProcessEnv;
}): { token: string; projectId: string; graphqlUrl?: string } | null {
  const env = input.env ?? {};
  const token = input.linear?.token ?? env.OPENTAG_LINEAR_API_KEY ?? env.OPENTAG_LINEAR_TOKEN;
  const projectId = input.linear?.projectId ?? env.OPENTAG_LINEAR_PROJECT_ID;
  if (!token?.trim() || !projectId?.trim()) return null;
  const graphqlUrl = input.linear?.graphqlUrl ?? env.OPENTAG_LINEAR_GRAPHQL_URL;
  return { token: token.trim(), projectId: projectId.trim(), ...(graphqlUrl ? { graphqlUrl } : {}) };
}

// "2026-07-16T21:30:45.123Z" -> "2026-07-16T21:30Z": minute precision keeps the
// reply short while still time-stamping the data source.
function formatQueriedAt(iso: string): string {
  return iso.replace(/:\d{2}\.\d{3}Z$/u, "Z");
}

export function renderSlackLinearBacklogReply(input: {
  backlog: LinearProjectBacklog;
  limit: number;
  queriedAt: string;
}): string {
  const shown = input.backlog.issues.slice(0, input.limit);
  const totalLabel = input.backlog.hasMore ? `${input.backlog.fetched}+` : String(input.backlog.fetched);
  const noun = input.backlog.fetched === 1 && !input.backlog.hasMore ? "open issue" : "open issues";
  const lines = [`OpenTag project backlog — ${totalLabel} ${noun} (source: Linear, queried ${formatQueriedAt(input.queriedAt)}):`];
  if (shown.length === 0) {
    lines.push("No unfinished issues in the configured Linear project.");
  }
  for (const issue of shown) {
    lines.push(`• <${issue.url}|${issue.identifier}> — ${issue.title}  [${issue.stateName}]`);
  }
  if (input.backlog.issues.length > shown.length || input.backlog.hasMore) {
    lines.push(`Showing ${shown.length} of ${totalLabel} open issues.`);
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
      return renderSlackLinearBacklogReply({ backlog, limit: SLACK_LINEAR_BACKLOG_LIMIT, queriedAt: now() });
    } catch (error) {
      // linearGraphql error messages contain the HTTP status and GraphQL error
      // text only — never the token — so the message is safe for local logs.
      logError(`[slack] linear backlog query failed: ${error instanceof Error ? error.message : String(error)}`);
      return UNAVAILABLE_TEXT;
    }
  };
}
