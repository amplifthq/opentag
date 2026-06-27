import { startSlackIngress, type SlackIngressConfig } from "@opentag/slack";

function positivePort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? String(fallback));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, received ${value ?? String(fallback)}`);
  }
  return port;
}

function configFromEnv(env: NodeJS.ProcessEnv): SlackIngressConfig {
  const signingSecret = env.SLACK_SIGNING_SECRET;
  const dispatcherUrl = env.OPENTAG_DISPATCHER_URL;
  if (!dispatcherUrl) {
    throw new Error("OPENTAG_DISPATCHER_URL is required");
  }
  if (!signingSecret) {
    throw new Error("SLACK_SIGNING_SECRET is required");
  }
  return {
    signingSecret,
    dispatcherUrl,
    port: positivePort(env.PORT, 3040),
    agentId: env.OPENTAG_SLACK_AGENT_ID ?? "opentag",
    ...(env.OPENTAG_DISPATCHER_TOKEN ? { dispatcherToken: env.OPENTAG_DISPATCHER_TOKEN } : {}),
    ...(env.OPENTAG_SLACK_APP_ID ? { appId: env.OPENTAG_SLACK_APP_ID } : {}),
    ...(env.OPENTAG_SLACK_POST_MESSAGE_URL ? { callbackUri: env.OPENTAG_SLACK_POST_MESSAGE_URL } : {})
  };
}

const ingress = startSlackIngress(configFromEnv(process.env));
console.log(`OpenTag Slack events ingress listening on ${ingress.url}`);
