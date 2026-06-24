import { serve } from "@hono/node-server";
import { createCompositeCallbackSink, createGitHubCallbackSink, createSlackCallbackSink } from "./callbacks.js";
import { createDispatcherApp } from "./server.js";

const port = Number(process.env.PORT ?? "3030");
const databasePath = process.env.OPENTAG_DATABASE_PATH ?? "opentag.db";

serve({
  fetch: createDispatcherApp({
    databasePath,
    ...(process.env.OPENTAG_PAIRING_TOKEN ? { pairingToken: process.env.OPENTAG_PAIRING_TOKEN } : {}),
    callbackSink: createCompositeCallbackSink([
      createGitHubCallbackSink({
        ...(process.env.OPENTAG_GITHUB_TOKEN ? { token: process.env.OPENTAG_GITHUB_TOKEN } : {})
      }),
      createSlackCallbackSink({
        ...(process.env.OPENTAG_SLACK_BOT_TOKEN ? { botToken: process.env.OPENTAG_SLACK_BOT_TOKEN } : {})
      })
    ])
  }).fetch,
  port
});

console.log(`OpenTag dispatcher listening on http://localhost:${port}`);
