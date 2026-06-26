import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import { createSlackEventsApp } from "./app.js";

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
if (!dispatcherUrl) {
  throw new Error("OPENTAG_DISPATCHER_URL is required");
}

const dispatcherToken = process.env.OPENTAG_DISPATCHER_TOKEN;
const port = Number(process.env.PORT ?? "3040");
const dispatcherClient = createOpenTagClient({
  dispatcherUrl,
  ...(dispatcherToken ? { pairingToken: dispatcherToken } : {})
});

type SlackAppConfig = {
  signingSecret: string;
  agentId: string;
  appId?: string;
  callbackUri?: string;
};

function slackAppsFromEnv(): SlackAppConfig[] {
  const appsJson = process.env.OPENTAG_SLACK_APPS_JSON;
  if (appsJson) {
    try {
      const parsed = JSON.parse(appsJson);
      if (!Array.isArray(parsed)) {
        throw new Error("Value is not a JSON array");
      }
      return parsed.filter(
        (candidate): candidate is SlackAppConfig =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          typeof candidate.signingSecret === "string" &&
          typeof candidate.agentId === "string"
      );
    } catch (error) {
      throw new Error(
        `Failed to parse OPENTAG_SLACK_APPS_JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!signingSecret) {
    return [];
  }

  return [
    {
      signingSecret,
      agentId: process.env.OPENTAG_SLACK_AGENT_ID ?? "opentag",
      ...(process.env.OPENTAG_SLACK_APP_ID ? { appId: process.env.OPENTAG_SLACK_APP_ID } : {}),
      ...(process.env.OPENTAG_SLACK_POST_MESSAGE_URL ? { callbackUri: process.env.OPENTAG_SLACK_POST_MESSAGE_URL } : {})
    }
  ];
}

const slackApps = slackAppsFromEnv();
if (slackApps.length === 0) {
  throw new Error("Configure SLACK_SIGNING_SECRET or OPENTAG_SLACK_APPS_JSON");
}

serve({
  fetch: createSlackEventsApp({
    slackApps,
    async resolveChannelBinding(input) {
      try {
        const { binding } = await dispatcherClient.getChannelBinding({
          provider: "slack",
          accountId: input.teamId,
          conversationId: input.channelId
        });
        return {
          teamId: binding.accountId,
          channelId: binding.conversationId,
          repoProvider: binding.repoProvider,
          owner: binding.owner,
          repo: binding.repo
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes("channel_binding_not_found")) {
          return null;
        }
        throw error;
      }
    },
    async createRun(event) {
      const runId = `run_${Date.now()}`;
      await dispatcherClient.createRun({ runId, event });
      return { runId };
    },
    async submitThreadAction(action) {
      await dispatcherClient.submitThreadAction(action);
    },
    now: () => new Date().toISOString()
  }).fetch,
  port
});

console.log(`OpenTag Slack events ingress listening on http://localhost:${port}`);
