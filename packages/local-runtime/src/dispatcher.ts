import { serve } from "@hono/node-server";
import {
  createCompositeCallbackSink,
  createDispatcherApp,
  createGitHubCallbackSink,
  createLarkCallbackSink,
  createSlackCallbackSink,
  createTelegramCallbackSink
} from "@opentag/dispatcher";

export type LocalDispatcherRuntimeInput = {
  port: number;
  databasePath: string;
  pairingToken?: string;
  githubToken?: string;
  lark?: {
    appId: string;
    appSecret: string;
    domain: "lark" | "feishu";
  };
  slackBotToken?: string;
  slackBotTokensByAgentId?: Record<string, string>;
  telegramBotToken?: string;
  telegramBotTokensByAgentId?: Record<string, string>;
};

export type LocalDispatcherHandle = {
  url: string;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
};

function parseAgentTokenMap(name: string, raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Value is not a JSON object");
    }
    return Object.keys(parsed).length > 0 ? (parsed as Record<string, string>) : undefined;
  } catch (error) {
    throw new Error(`Failed to parse ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function larkDomainFromEnv(value: string | undefined): "lark" | "feishu" | undefined {
  if (value === undefined) return undefined;
  if (value === "lark" || value === "feishu") return value;
  throw new Error("LARK_DOMAIN must be either lark or feishu");
}

export function dispatcherRuntimeInputFromEnv(env: NodeJS.ProcessEnv): LocalDispatcherRuntimeInput {
  const port = Number(env.PORT ?? "3030");
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, received ${env.PORT ?? "3030"}`);
  }

  const larkDomain = larkDomainFromEnv(env.LARK_DOMAIN);
  if (Boolean(env.LARK_APP_ID) !== Boolean(env.LARK_APP_SECRET)) {
    throw new Error("LARK_APP_ID and LARK_APP_SECRET must be configured together.");
  }
  const slackBotTokensByAgentId = parseAgentTokenMap("OPENTAG_SLACK_BOT_TOKENS_JSON", env.OPENTAG_SLACK_BOT_TOKENS_JSON);
  const telegramBotTokensByAgentId = parseAgentTokenMap(
    "OPENTAG_TELEGRAM_BOT_TOKENS_JSON",
    env.OPENTAG_TELEGRAM_BOT_TOKENS_JSON
  );

  return {
    port,
    databasePath: env.OPENTAG_DATABASE_PATH ?? "opentag.db",
    ...(env.OPENTAG_PAIRING_TOKEN ? { pairingToken: env.OPENTAG_PAIRING_TOKEN } : {}),
    ...(env.OPENTAG_GITHUB_TOKEN ? { githubToken: env.OPENTAG_GITHUB_TOKEN } : {}),
    ...(env.LARK_APP_ID && env.LARK_APP_SECRET
      ? {
          lark: {
            appId: env.LARK_APP_ID,
            appSecret: env.LARK_APP_SECRET,
            domain: larkDomain ?? "lark"
          }
        }
      : {}),
    ...(env.OPENTAG_SLACK_BOT_TOKEN ? { slackBotToken: env.OPENTAG_SLACK_BOT_TOKEN } : {}),
    ...(slackBotTokensByAgentId ? { slackBotTokensByAgentId } : {}),
    ...(env.OPENTAG_TELEGRAM_BOT_TOKEN ? { telegramBotToken: env.OPENTAG_TELEGRAM_BOT_TOKEN } : {}),
    ...(telegramBotTokensByAgentId ? { telegramBotTokensByAgentId } : {})
  };
}

export function startDispatcher(input: LocalDispatcherRuntimeInput): LocalDispatcherHandle {
  const server = serve({
    fetch: createDispatcherApp({
      databasePath: input.databasePath,
      ...(input.pairingToken ? { pairingToken: input.pairingToken } : {}),
      ...(input.githubToken ? { githubApply: { token: input.githubToken } } : {}),
      callbackSink: createCompositeCallbackSink([
        createGitHubCallbackSink({
          ...(input.githubToken ? { token: input.githubToken } : {})
        }),
        createSlackCallbackSink({
          ...(input.slackBotToken ? { botToken: input.slackBotToken } : {}),
          ...(input.slackBotTokensByAgentId ? { botTokensByAgentId: input.slackBotTokensByAgentId } : {})
        }),
        createLarkCallbackSink({
          ...(input.lark
            ? {
                appId: input.lark.appId,
                appSecret: input.lark.appSecret,
                domain: input.lark.domain
              }
            : {})
        }),
        createTelegramCallbackSink({
          ...(input.telegramBotToken ? { botToken: input.telegramBotToken } : {}),
          ...(input.telegramBotTokensByAgentId ? { botTokensByAgentId: input.telegramBotTokensByAgentId } : {})
        })
      ])
    }).fetch,
    port: input.port
  });

  return {
    url: `http://localhost:${input.port}`,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
