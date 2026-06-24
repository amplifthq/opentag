import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import { createSlackEventsApp } from "./app.js";

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
if (!signingSecret || !dispatcherUrl) {
  throw new Error("SLACK_SIGNING_SECRET and OPENTAG_DISPATCHER_URL are required");
}

const dispatcherToken = process.env.OPENTAG_DISPATCHER_TOKEN;
const port = Number(process.env.PORT ?? "3040");
const dispatcherClient = createOpenTagClient({
  dispatcherUrl,
  ...(dispatcherToken ? { pairingToken: dispatcherToken } : {})
});

serve({
  fetch: createSlackEventsApp({
    signingSecret,
    async resolveChannelBinding(input) {
      try {
        const { binding } = await dispatcherClient.getSlackChannelBinding(input);
        return binding;
      } catch (error) {
        if (error instanceof Error && error.message.includes("slack_channel_binding_not_found")) {
          return null;
        }
        throw error;
      }
    },
    async createRun(event) {
      const runId = `run_${event.source}_${event.sourceEventId}`.replace(/[^a-zA-Z0-9._-]/g, "_");
      await dispatcherClient.createRun({ runId, event });
      return { runId };
    },
    now: () => new Date().toISOString(),
    ...(process.env.OPENTAG_SLACK_POST_MESSAGE_URL ? { callbackUri: process.env.OPENTAG_SLACK_POST_MESSAGE_URL } : {})
  }).fetch,
  port
});

console.log(`OpenTag Slack events ingress listening on http://localhost:${port}`);
