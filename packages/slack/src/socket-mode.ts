import WebSocket, { type RawData } from "ws";
import { createSlackDispatcherEventProcessorInput, type SlackDispatcherEventConfig } from "./dispatcher-events.js";
import { createSlackEventProcessor, type SlackAppRuntimeConfig, type SlackEventEnvelope, type SlackEventProcessorInput } from "./events.js";

const SLACK_CONNECTIONS_OPEN_URL = "https://slack.com/api/apps.connections.open";
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

// Slack Web API `error` codes that represent a terminal authentication or
// configuration problem with the app token. Retrying these is pointless: the
// request will fail identically forever, spamming logs and risking rate limits
// or an API ban. Startup must fail loudly so the operator fixes the config,
// rather than the daemon silently looping. Transient/network errors (e.g.
// `ratelimited`, HTTP 5xx, fetch failures) are NOT in this set and are retried.
const TERMINAL_SLACK_ERROR_CODES = [
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  "no_permission",
  "missing_scope",
  "ekm_access_denied"
] as const;

/**
 * Returns true when the error from opening the Socket Mode connection is a
 * terminal auth/config failure that must propagate (reject startup) instead of
 * being retried. The Slack error code is embedded in the thrown Error message by
 * {@link openSlackSocketUrl} (e.g. "...connection failed: invalid_auth").
 */
function isTerminalSlackAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return TERMINAL_SLACK_ERROR_CODES.some((code) => error.message.includes(code));
}

export type SlackSocketModeEnvelope = {
  type?: string;
  envelope_id?: string;
  payload?: SlackEventEnvelope;
  accepts_response_payload?: boolean;
};

export type SlackSocketModeAppInput = {
  appToken: string;
  slackApp: SlackAppRuntimeConfig;
} & SlackEventProcessorInput;

export type SlackSocketModeIngressConfig = SlackDispatcherEventConfig & {
  appToken: string;
  agentId?: string;
  appId?: string;
  callbackUri?: string;
};

export type SlackSocketModeIngressHandle = {
  startPromise: Promise<void>;
  close(): Promise<void>;
};

export type SlackSocketModeDependencies = {
  fetchImpl?: typeof fetch;
  createWebSocket?(url: string): WebSocket;
  reconnectDelayMs?: number;
  log?(message: string): void;
  logError?(message: string, error?: unknown): void;
};

type SlackConnectionsOpenResponse = {
  ok?: boolean;
  url?: string;
  error?: string;
  needed?: string;
  provided?: string;
};

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function openSlackSocketUrl(input: { appToken: string; fetchImpl: typeof fetch }): Promise<string> {
  const response = await input.fetchImpl(SLACK_CONNECTIONS_OPEN_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.appToken}`
    }
  });
  const body = (await response.json().catch(() => ({}))) as SlackConnectionsOpenResponse;
  if (!response.ok || !body.ok || !body.url) {
    const reason = body.error ?? `http_${response.status}`;
    throw new Error(`Slack Socket Mode connection failed: ${reason}`);
  }
  return body.url;
}

function parseSocketEnvelope(data: RawData): SlackSocketModeEnvelope | null {
  try {
    return JSON.parse(rawDataToString(data)) as SlackSocketModeEnvelope;
  } catch {
    return null;
  }
}

async function handleSocketMessage(input: {
  data: RawData;
  socket: WebSocket;
  processor: ReturnType<typeof createSlackEventProcessor>;
  slackApp: SlackAppRuntimeConfig;
  logError(message: string, error?: unknown): void;
}): Promise<void> {
  const envelope = parseSocketEnvelope(input.data);
  if (!envelope?.envelope_id) {
    input.logError("[slack] ignored Socket Mode envelope without envelope_id");
    return;
  }

  input.socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));

  if (envelope.type !== "events_api" || !envelope.payload) {
    return;
  }
  if (input.slackApp.appId && envelope.payload.api_app_id && envelope.payload.api_app_id !== input.slackApp.appId) {
    return;
  }

  await input.processor.process(envelope.payload, input.slackApp);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startSlackSocketModeApp(
  input: SlackSocketModeAppInput,
  dependencies: SlackSocketModeDependencies = {}
): SlackSocketModeIngressHandle {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const createWebSocket = dependencies.createWebSocket ?? ((url: string) => new WebSocket(url));
  const reconnectDelayMs = dependencies.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const logError = dependencies.logError ?? ((message: string, error?: unknown) => (error ? console.error(message, error) : console.error(message)));
  const processor = createSlackEventProcessor(input);
  let closed = false;
  let activeSocket: WebSocket | undefined;

  async function runOneConnection(socketUrl: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const socket = createWebSocket(socketUrl);
      activeSocket = socket;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (activeSocket === socket) activeSocket = undefined;
        resolve();
      };

      socket.once("open", () => {
        log("[slack] Socket Mode connected");
      });
      socket.on("message", (data) => {
        void handleSocketMessage({
          data,
          socket,
          processor,
          slackApp: input.slackApp,
          logError
        }).catch((error: unknown) => {
          logError("[slack] failed to handle Socket Mode event:", error);
        });
      });
      socket.once("close", finish);
      socket.once("error", (error) => {
        if (!closed) {
          logError("[slack] Socket Mode connection error:", error);
        }
        socket.close();
        finish();
      });
    });
  }

  const startPromise = (async () => {
    while (!closed) {
      try {
        const socketUrl = await openSlackSocketUrl({ appToken: input.appToken, fetchImpl });
        await runOneConnection(socketUrl);
      } catch (error) {
        // A terminal auth/config error (invalid app token, missing scope, etc.)
        // will never succeed on retry, so we must NOT swallow it: rethrow so
        // startPromise rejects and startup fails loudly instead of looping
        // forever against Slack's API.
        if (isTerminalSlackAuthError(error)) {
          if (!closed) {
            logError("[slack] terminal Socket Mode auth/config error, aborting:", error);
          }
          throw error;
        }
        // A transient apps.connections.open failure (or any error opening the
        // connection) must NOT reject startPromise: the CLI aborts the entire
        // OpenTag daemon when this promise rejects, so one blip in Slack's API
        // would otherwise take down every other ingress and the dispatcher.
        // Log it and fall through to the shared backoff/retry below.
        if (!closed) {
          logError("[slack] failed to open Socket Mode connection, retrying:", error);
        }
      }
      if (!closed) {
        await wait(reconnectDelayMs);
      }
    }
  })();

  return {
    startPromise,
    async close() {
      closed = true;
      activeSocket?.close();
      await startPromise.catch(() => undefined);
    }
  };
}

export function startSlackSocketModeIngress(
  config: SlackSocketModeIngressConfig,
  dependencies: SlackSocketModeDependencies = {}
): SlackSocketModeIngressHandle {
  return startSlackSocketModeApp(
    {
      appToken: config.appToken,
      slackApp: {
        agentId: config.agentId ?? "opentag",
        ...(config.appId ? { appId: config.appId } : {}),
        ...(config.callbackUri ? { callbackUri: config.callbackUri } : {})
      },
      ...createSlackDispatcherEventProcessorInput(config)
    },
    dependencies
  );
}
