import { serve } from "@hono/node-server";
import { createSlackEventsApp } from "./app.js";

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
if (!signingSecret || !dispatcherUrl) {
  throw new Error("SLACK_SIGNING_SECRET and OPENTAG_DISPATCHER_URL are required");
}

const dispatcherToken = process.env.OPENTAG_DISPATCHER_TOKEN;
const port = Number(process.env.PORT ?? "3040");

function dispatcherHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    ...(dispatcherToken ? { authorization: `Bearer ${dispatcherToken}` } : {})
  };
}

serve({
  fetch: createSlackEventsApp({
    signingSecret,
    async resolveChannelBinding(input) {
      const response = await fetch(
        `${dispatcherUrl.replace(/\/$/, "")}/v1/slack-channel-bindings/${input.teamId}/${input.channelId}`,
        { headers: dispatcherHeaders() }
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`Slack channel binding lookup failed: ${response.status}`);
      }
      const body = (await response.json()) as { binding: { teamId: string; channelId: string; owner: string; repo: string } };
      return body.binding;
    },
    async createRun(event) {
      const runId = `run_${Date.now()}`;
      const response = await fetch(`${dispatcherUrl.replace(/\/$/, "")}/v1/runs`, {
        method: "POST",
        headers: dispatcherHeaders(),
        body: JSON.stringify({ runId, event })
      });
      if (!response.ok) {
        throw new Error(`Slack dispatcher create run failed: ${response.status}`);
      }
      return { runId };
    },
    now: () => new Date().toISOString(),
    ...(process.env.OPENTAG_SLACK_POST_MESSAGE_URL ? { callbackUri: process.env.OPENTAG_SLACK_POST_MESSAGE_URL } : {})
  }).fetch,
  port
});

console.log(`OpenTag Slack events ingress listening on http://localhost:${port}`);
