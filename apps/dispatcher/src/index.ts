import { serve } from "@hono/node-server";
import { createCompositeCallbackSink, createDispatcherApp, createGitHubCallbackSink, createSlackCallbackSink } from "@opentag/dispatcher";

const port = Number(process.env.PORT ?? "3030");
const databasePath = process.env.OPENTAG_DATABASE_PATH ?? "opentag.db";

function slackBotTokensByAgentIdFromEnv(): Record<string, string> | undefined {
  const raw = process.env.OPENTAG_SLACK_BOT_TOKENS_JSON;
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as Record<string, string>;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

const slackBotTokensByAgentId = slackBotTokensByAgentIdFromEnv();

serve({
  fetch: createDispatcherApp({
    databasePath,
    ...(process.env.OPENTAG_PAIRING_TOKEN ? { pairingToken: process.env.OPENTAG_PAIRING_TOKEN } : {}),
    callbackSink: createCompositeCallbackSink([
      createGitHubCallbackSink({
        ...(process.env.OPENTAG_GITHUB_TOKEN ? { token: process.env.OPENTAG_GITHUB_TOKEN } : {})
      }),
      createSlackCallbackSink({
        ...(process.env.OPENTAG_SLACK_BOT_TOKEN ? { botToken: process.env.OPENTAG_SLACK_BOT_TOKEN } : {}),
        ...(slackBotTokensByAgentId ? { botTokensByAgentId: slackBotTokensByAgentId } : {})
      })
    ])
  }).fetch,
  port
});

console.log(`OpenTag dispatcher listening on http://localhost:${port}`);
