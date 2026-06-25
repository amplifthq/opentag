import { serve } from "@hono/node-server";
import { createCompositeCallbackSink, createDispatcherApp, createGitHubCallbackSink, createLarkCallbackSink, createSlackCallbackSink } from "@opentag/dispatcher";

const port = Number(process.env.PORT ?? "3030");
const databasePath = process.env.OPENTAG_DATABASE_PATH ?? "opentag.db";

function slackBotTokensByAgentIdFromEnv(): Record<string, string> | undefined {
  const raw = process.env.OPENTAG_SLACK_BOT_TOKENS_JSON;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Value is not a JSON object");
    }
    return Object.keys(parsed).length > 0 ? (parsed as Record<string, string>) : undefined;
  } catch (error) {
    throw new Error(
      `Failed to parse OPENTAG_SLACK_BOT_TOKENS_JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const slackBotTokensByAgentId = slackBotTokensByAgentIdFromEnv();

serve({
  fetch: createDispatcherApp({
    databasePath,
    ...(process.env.OPENTAG_PAIRING_TOKEN ? { pairingToken: process.env.OPENTAG_PAIRING_TOKEN } : {}),
    ...(process.env.OPENTAG_GITHUB_TOKEN ? { githubApply: { token: process.env.OPENTAG_GITHUB_TOKEN } } : {}),
    callbackSink: createCompositeCallbackSink([
      createGitHubCallbackSink({
        ...(process.env.OPENTAG_GITHUB_TOKEN ? { token: process.env.OPENTAG_GITHUB_TOKEN } : {})
      }),
      createSlackCallbackSink({
        ...(process.env.OPENTAG_SLACK_BOT_TOKEN ? { botToken: process.env.OPENTAG_SLACK_BOT_TOKEN } : {}),
        ...(slackBotTokensByAgentId ? { botTokensByAgentId: slackBotTokensByAgentId } : {})
      }),
      createLarkCallbackSink({
        ...(process.env.LARK_APP_ID ? { appId: process.env.LARK_APP_ID } : {}),
        ...(process.env.LARK_APP_SECRET ? { appSecret: process.env.LARK_APP_SECRET } : {}),
        ...(process.env.LARK_DOMAIN === "feishu" ? { domain: "feishu" as const } : {})
      })
    ])
  }).fetch,
  port
});

console.log(`OpenTag dispatcher listening on http://localhost:${port}`);
