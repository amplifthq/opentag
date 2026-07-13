import type {
  SlackChannelPrincipalConfig,
  SlackEventsApiIngressConfig,
  SlackSocketModeIngressConfig
} from "@opentag/slack";

type SharedSlackIngressConfig = {
  dispatcherUrl: string;
  agentId: string;
  dispatcherToken?: string;
  botToken?: string;
  bindingAdminUserIds?: string[];
  runTimeoutMs?: number;
  maxRequestBodyBytes?: number;
  callbackUri?: string;
} & SlackChannelPrincipalConfig;

function positivePort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? String(fallback));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, received ${value ?? String(fallback)}`);
  }
  return port;
}

function positiveIntegerFromEnv(name: string, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function csvList(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}

function optionalNonBlankEnv(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function sharedConfigFromEnv(env: NodeJS.ProcessEnv): SharedSlackIngressConfig {
  const dispatcherUrl = env.OPENTAG_DISPATCHER_URL;
  if (!dispatcherUrl) {
    throw new Error("OPENTAG_DISPATCHER_URL is required");
  }
  const appId = optionalNonBlankEnv("OPENTAG_SLACK_APP_ID", env.OPENTAG_SLACK_APP_ID);
  const channelPrincipalCredential = optionalNonBlankEnv(
    "OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL",
    env.OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL
  );
  if (Boolean(appId) !== Boolean(channelPrincipalCredential)) {
    throw new Error("OPENTAG_SLACK_APP_ID and OPENTAG_SLACK_CHANNEL_PRINCIPAL_CREDENTIAL must be configured together.");
  }
  const botToken = env.OPENTAG_SLACK_BOT_TOKEN ?? env.SLACK_BOT_TOKEN;
  const runTimeoutMs = positiveIntegerFromEnv("OPENTAG_RUN_TIMEOUT_MS", env.OPENTAG_RUN_TIMEOUT_MS);
  const maxRequestBodyBytes = positiveIntegerFromEnv("OPENTAG_MAX_REQUEST_BODY_BYTES", env.OPENTAG_MAX_REQUEST_BODY_BYTES);
  const bindingAdminUserIds = csvList(env.OPENTAG_SLACK_BINDING_ADMIN_USER_IDS);
  const shared = {
    dispatcherUrl,
    agentId: env.OPENTAG_SLACK_AGENT_ID ?? "opentag",
    ...(env.OPENTAG_DISPATCHER_TOKEN ? { dispatcherToken: env.OPENTAG_DISPATCHER_TOKEN } : {}),
    ...(botToken ? { botToken } : {}),
    ...(bindingAdminUserIds ? { bindingAdminUserIds } : {}),
    ...(runTimeoutMs ? { runTimeoutMs } : {}),
    ...(maxRequestBodyBytes ? { maxRequestBodyBytes } : {}),
    ...(env.OPENTAG_SLACK_POST_MESSAGE_URL ? { callbackUri: env.OPENTAG_SLACK_POST_MESSAGE_URL } : {})
  };
  return appId && channelPrincipalCredential ? { ...shared, appId, channelPrincipalCredential } : shared;
}

export function eventsApiConfigFromEnv(env: NodeJS.ProcessEnv): SlackEventsApiIngressConfig {
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

export function socketModeConfigFromEnv(env: NodeJS.ProcessEnv): SlackSocketModeIngressConfig {
  const appToken = env.OPENTAG_SLACK_APP_TOKEN ?? env.SLACK_APP_TOKEN;
  if (!appToken) {
    throw new Error("OPENTAG_SLACK_APP_TOKEN is required for Slack Socket Mode");
  }
  return {
    ...sharedConfigFromEnv(env),
    appToken
  };
}

export function slackModeFromEnv(env: NodeJS.ProcessEnv): "socket_mode" | "events_api" {
  if (env.OPENTAG_SLACK_MODE === "socket_mode" || env.OPENTAG_SLACK_MODE === "events_api") {
    return env.OPENTAG_SLACK_MODE;
  }
  if (env.OPENTAG_SLACK_MODE) {
    throw new Error(`OPENTAG_SLACK_MODE must be socket_mode or events_api, received ${env.OPENTAG_SLACK_MODE}`);
  }
  return env.OPENTAG_SLACK_APP_TOKEN || env.SLACK_APP_TOKEN ? "socket_mode" : "events_api";
}
