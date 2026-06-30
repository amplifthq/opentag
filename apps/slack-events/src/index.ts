import {
  startSlackIngress,
  startSlackSocketModeIngress,
  type SlackEventsApiIngressConfig,
  type SlackSocketModeIngressConfig
} from "@opentag/slack";

function positivePort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? String(fallback));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, received ${value ?? String(fallback)}`);
  }
  return port;
}

function sharedConfigFromEnv(env: NodeJS.ProcessEnv) {
  const dispatcherUrl = env.OPENTAG_DISPATCHER_URL;
  if (!dispatcherUrl) {
    throw new Error("OPENTAG_DISPATCHER_URL is required");
  }
  return {
    dispatcherUrl,
    agentId: env.OPENTAG_SLACK_AGENT_ID ?? "opentag",
    ...(env.OPENTAG_DISPATCHER_TOKEN ? { dispatcherToken: env.OPENTAG_DISPATCHER_TOKEN } : {}),
    ...(env.OPENTAG_SLACK_APP_ID ? { appId: env.OPENTAG_SLACK_APP_ID } : {}),
    ...(env.OPENTAG_SLACK_POST_MESSAGE_URL ? { callbackUri: env.OPENTAG_SLACK_POST_MESSAGE_URL } : {})
  };
}

function eventsApiConfigFromEnv(env: NodeJS.ProcessEnv): SlackEventsApiIngressConfig {
  const signingSecret = env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    throw new Error("SLACK_SIGNING_SECRET is required for Slack Events API mode");
  }
  return {
    ...sharedConfigFromEnv(env),
    signingSecret,
    port: positivePort(env.PORT, 3040)
  };
}

function socketModeConfigFromEnv(env: NodeJS.ProcessEnv): SlackSocketModeIngressConfig {
  const appToken = env.OPENTAG_SLACK_APP_TOKEN ?? env.SLACK_APP_TOKEN;
  if (!appToken) {
    throw new Error("OPENTAG_SLACK_APP_TOKEN is required for Slack Socket Mode");
  }
  return {
    ...sharedConfigFromEnv(env),
    appToken
  };
}

function slackModeFromEnv(env: NodeJS.ProcessEnv): "socket_mode" | "events_api" {
  if (env.OPENTAG_SLACK_MODE === "socket_mode" || env.OPENTAG_SLACK_MODE === "events_api") {
    return env.OPENTAG_SLACK_MODE;
  }
  if (env.OPENTAG_SLACK_MODE) {
    throw new Error(`OPENTAG_SLACK_MODE must be socket_mode or events_api, received ${env.OPENTAG_SLACK_MODE}`);
  }
  return env.OPENTAG_SLACK_APP_TOKEN || env.SLACK_APP_TOKEN ? "socket_mode" : "events_api";
}

const mode = slackModeFromEnv(process.env);

if (mode === "socket_mode") {
  const ingress = startSlackSocketModeIngress(socketModeConfigFromEnv(process.env));
  ingress.startPromise.catch((error: unknown) => {
    console.error("OpenTag Slack Socket Mode ingress failed:", error);
    process.exitCode = 1;
  });
  console.log("OpenTag Slack Socket Mode ingress connecting");
} else {
  const ingress = startSlackIngress(eventsApiConfigFromEnv(process.env));
  console.log(`OpenTag Slack events ingress listening on ${ingress.url}`);
}
