import { createHash } from "node:crypto";
import { parseThreadActionCommand, type OpenTagEvent } from "@opentag/core";
import { encodeDiscordThreadKey, normalizeDiscordInteraction, type DiscordChannelBinding } from "./normalize.js";

export type DiscordGatewayThreadActionInput = {
  id: string;
  rawText: string;
  actor: {
    provider: "discord";
    providerUserId: string;
    handle: string;
  };
  callback: {
    provider: "discord";
    uri: string;
    threadKey: string;
  };
  metadata: Record<string, unknown>;
};

export type DiscordGatewayAppInput = {
  botToken: string;
  gatewayUrl?: string;
  apiBaseUrl?: string;
  callbackBaseUrl?: string;
  resolveChannelBinding(input: { applicationId: string; channelId: string }): Promise<DiscordChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: DiscordGatewayThreadActionInput): Promise<unknown>;
  notifyChannel?(input: { channelId: string; content: string }): Promise<void>;
  onBackgroundError?(error: unknown): void;
  now(): string;
};

export type DiscordGatewayHandle = {
  startPromise: Promise<void>;
  close(): Promise<void>;
};

export type DiscordGatewayWebSocket = {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type DiscordGatewayDependencies = {
  createWebSocket?(url: string): DiscordGatewayWebSocket;
  fetchImpl?: typeof fetch;
  reconnectDelayMs?: number;
  log?(message: string): void;
  logError?(message: string, error?: unknown): void;
};

type GatewayPayload = {
  op?: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

type ExtractedInteraction = {
  interactionId: string;
  interactionToken: string;
  applicationId: string;
  channelId: string;
  guildId?: string;
  userId: string;
  username?: string;
  prompt: string;
  executor?: string;
};

const DEFAULT_DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DEFAULT_DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
const RESPONSE_TYPE_PONG = 1;
const RESPONSE_TYPE_CHANNEL_MESSAGE = 4;
const NO_MENTIONS = { parse: [] as string[] };

function defaultCreateWebSocket(url: string): DiscordGatewayWebSocket {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => DiscordGatewayWebSocket }).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("Discord Gateway mode requires a WebSocket implementation. Use Node.js 22+ or configure --discord-mode webhook.");
  }
  return new WebSocketCtor(url);
}

function dataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

function parseGatewayPayload(data: unknown): GatewayPayload | null {
  try {
    const parsed = JSON.parse(dataToString(data));
    return parsed && typeof parsed === "object" ? (parsed as GatewayPayload) : null;
  } catch {
    return null;
  }
}

function optionValue(options: unknown, name: string): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const option of options) {
    if (option && typeof option === "object" && (option as { name?: unknown }).name === name) {
      const value = (option as { value?: unknown }).value;
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

function extractInteraction(payload: Record<string, unknown>): ExtractedInteraction | null {
  const interactionId = typeof payload.id === "string" ? payload.id : undefined;
  const interactionToken = typeof payload.token === "string" ? payload.token : undefined;
  const applicationId = typeof payload.application_id === "string" ? payload.application_id : undefined;
  const channelId = typeof payload.channel_id === "string" ? payload.channel_id : undefined;
  const guildId = typeof payload.guild_id === "string" ? payload.guild_id : undefined;

  const member = payload.member as { user?: { id?: unknown; username?: unknown } } | undefined;
  const directUser = payload.user as { id?: unknown; username?: unknown } | undefined;
  const user = member?.user ?? directUser;
  const userId = typeof user?.id === "string" ? user.id : undefined;
  const username = typeof user?.username === "string" ? user.username : undefined;

  const data = payload.data as { options?: unknown } | undefined;
  const prompt = optionValue(data?.options, "prompt");
  const executor = optionValue(data?.options, "executor");

  if (!interactionId || !interactionToken || !applicationId || !channelId || !userId || !prompt) return null;

  return {
    interactionId,
    interactionToken,
    applicationId,
    channelId,
    ...(guildId ? { guildId } : {}),
    userId,
    ...(username ? { username } : {}),
    prompt,
    ...(executor ? { executor } : {})
  };
}

function actionId(interactionId: string, payload: unknown): string {
  const bodyHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
  return `approval_discord_${interactionId}_${bodyHash}`;
}

async function postInteractionCallback(input: {
  apiBaseUrl: string;
  botToken: string;
  interactionId: string;
  interactionToken: string;
  body: unknown;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const response = await input.fetchImpl(`${input.apiBaseUrl}/interactions/${input.interactionId}/${input.interactionToken}/callback`, {
    method: "POST",
    headers: {
      authorization: `Bot ${input.botToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(input.body)
  });
  if (!response.ok) {
    throw new Error(`Discord interaction callback failed: ${response.status} ${await response.text()}`);
  }
}

async function notifyDiscordChannel(input: {
  apiBaseUrl: string;
  botToken: string;
  channelId: string;
  content: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const response = await input.fetchImpl(`${input.apiBaseUrl}/channels/${input.channelId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bot ${input.botToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ content: input.content, allowed_mentions: NO_MENTIONS })
  });
  if (!response.ok) {
    throw new Error(`Discord channel notice failed: ${response.status} ${await response.text()}`);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleInteractionCreate(input: {
  app: DiscordGatewayAppInput;
  body: Record<string, unknown>;
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  reportBackgroundError(error: unknown): void;
}): Promise<void> {
  const interactionType = input.body.type;
  const interactionId = typeof input.body.id === "string" ? input.body.id : undefined;
  const interactionToken = typeof input.body.token === "string" ? input.body.token : undefined;
  if (interactionType === INTERACTION_TYPE_PING && interactionId && interactionToken) {
    await postInteractionCallback({
      apiBaseUrl: input.apiBaseUrl,
      botToken: input.app.botToken,
      interactionId,
      interactionToken,
      body: { type: RESPONSE_TYPE_PONG },
      fetchImpl: input.fetchImpl
    });
    return;
  }

  if (interactionType !== INTERACTION_TYPE_APPLICATION_COMMAND) return;
  const interaction = extractInteraction(input.body);
  if (!interaction) return;

  const respond = (content: string) =>
    postInteractionCallback({
      apiBaseUrl: input.apiBaseUrl,
      botToken: input.app.botToken,
      interactionId: interaction.interactionId,
      interactionToken: interaction.interactionToken,
      body: { type: RESPONSE_TYPE_CHANNEL_MESSAGE, data: { content, allowed_mentions: NO_MENTIONS } },
      fetchImpl: input.fetchImpl
    });

  if (!interaction.prompt.trim()) {
    await respond("Please include a prompt after /opentag.");
    return;
  }

  const notify =
    input.app.notifyChannel ??
    ((notice: { channelId: string; content: string }) =>
      notifyDiscordChannel({
        apiBaseUrl: input.apiBaseUrl,
        botToken: input.app.botToken,
        channelId: notice.channelId,
        content: notice.content,
        fetchImpl: input.fetchImpl
      }));

  const runDeferred = (work: () => Promise<void>, failureNotice: string) => {
    void Promise.resolve()
      .then(work)
      .catch((error) => {
        input.reportBackgroundError(error);
        notify({ channelId: interaction.channelId, content: failureNotice }).catch(input.reportBackgroundError);
      });
  };

  if (parseThreadActionCommand(interaction.prompt)) {
    const submitThreadAction = input.app.submitThreadAction;
    if (!submitThreadAction) {
      await respond("Thread actions are not supported on this dispatcher.");
      return;
    }
    const action: DiscordGatewayThreadActionInput = {
      id: actionId(interaction.interactionId, input.body),
      rawText: interaction.prompt,
      actor: {
        provider: "discord",
        providerUserId: interaction.userId,
        handle: interaction.username ?? interaction.userId
      },
      callback: {
        provider: "discord",
        uri: `${input.app.callbackBaseUrl ?? input.apiBaseUrl}/channels/${interaction.channelId}/messages`,
        threadKey: encodeDiscordThreadKey({
          ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
          channelId: interaction.channelId,
          anchorId: interaction.interactionId
        })
      },
      metadata: {
        repoProvider: "discord",
        applicationId: interaction.applicationId,
        channelId: interaction.channelId,
        ...(interaction.guildId ? { guildId: interaction.guildId } : {})
      }
    };
    await respond("Received.");
    runDeferred(async () => {
      await submitThreadAction(action);
    }, "Sorry, that action couldn't be processed. Please try again.");
    return;
  }

  await respond("Received. OpenTag is working.");
  runDeferred(async () => {
    const binding = await input.app.resolveChannelBinding({
      applicationId: interaction.applicationId,
      channelId: interaction.channelId
    });
    if (!binding) {
      await notify({
        channelId: interaction.channelId,
        content: "This channel is not bound to a repository. Bind it before using /opentag."
      });
      return;
    }
    const event = normalizeDiscordInteraction({
      interactionId: interaction.interactionId,
      applicationId: interaction.applicationId,
      channelId: interaction.channelId,
      ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
      userId: interaction.userId,
      ...(interaction.username ? { username: interaction.username } : {}),
      prompt: interaction.prompt,
      ...(interaction.executor ? { executor: interaction.executor } : {}),
      binding,
      ...(input.app.callbackBaseUrl ? { callbackBaseUrl: input.app.callbackBaseUrl } : {}),
      receivedAt: input.app.now()
    });
    if (event) {
      await input.app.createRun(event);
    }
  }, "Sorry, OpenTag couldn't start this run. Please try again.");
}

export function startDiscordGateway(input: DiscordGatewayAppInput, dependencies: DiscordGatewayDependencies = {}): DiscordGatewayHandle {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  if (!dependencies.createWebSocket && !(globalThis as { WebSocket?: unknown }).WebSocket) {
    throw new Error("Discord Gateway mode requires a WebSocket implementation. Use Node.js 22+ or configure --discord-mode webhook.");
  }
  const createWebSocket = dependencies.createWebSocket ?? defaultCreateWebSocket;
  const reconnectDelayMs = dependencies.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const gatewayUrl = input.gatewayUrl ?? DEFAULT_DISCORD_GATEWAY_URL;
  const apiBaseUrl = input.apiBaseUrl ?? DEFAULT_DISCORD_API_BASE_URL;
  const log = dependencies.log ?? ((message: string) => console.log(message));
  const logError = dependencies.logError ?? ((message: string, error?: unknown) => (error ? console.error(message, error) : console.error(message)));
  const reportBackgroundError =
    input.onBackgroundError ??
    ((error: unknown) => {
      logError("[discord] Gateway background task failed:", error);
    });

  let closed = false;
  let activeSocket: DiscordGatewayWebSocket | undefined;

  async function runOneConnection(): Promise<void> {
    await new Promise<void>((resolve) => {
      const socket = createWebSocket(gatewayUrl);
      activeSocket = socket;
      let settled = false;
      let lastSequence: number | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

      const sendHeartbeat = () => {
        socket.send(JSON.stringify({ op: 1, d: lastSequence }));
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (activeSocket === socket) activeSocket = undefined;
        resolve();
      };

      socket.onopen = () => {
        log("[discord] Gateway connected");
      };
      socket.onmessage = (event) => {
        const payload = parseGatewayPayload(event.data);
        if (!payload) {
          logError("[discord] ignored invalid Gateway payload");
          return;
        }
        if (typeof payload.s === "number") {
          lastSequence = payload.s;
        }
        if (payload.op === 10) {
          const heartbeatInterval =
            payload.d && typeof payload.d === "object" && typeof (payload.d as { heartbeat_interval?: unknown }).heartbeat_interval === "number"
              ? (payload.d as { heartbeat_interval: number }).heartbeat_interval
              : undefined;
          if (heartbeatInterval) {
            heartbeatTimer = setInterval(sendHeartbeat, heartbeatInterval);
          }
          socket.send(
            JSON.stringify({
              op: 2,
              d: {
                token: input.botToken,
                intents: 0,
                properties: {
                  os: typeof process !== "undefined" ? process.platform : "unknown",
                  browser: "opentag",
                  device: "opentag"
                }
              }
            })
          );
          return;
        }
        if (payload.op === 1) {
          sendHeartbeat();
          return;
        }
        if (payload.op === 7 || payload.op === 9) {
          socket.close();
          return;
        }
        if (payload.op === 0 && payload.t === "INTERACTION_CREATE" && payload.d && typeof payload.d === "object") {
          void handleInteractionCreate({
            app: input,
            body: payload.d as Record<string, unknown>,
            apiBaseUrl,
            fetchImpl,
            reportBackgroundError
          }).catch((error: unknown) => {
            logError("[discord] failed to handle Gateway interaction:", error);
          });
        }
      };
      socket.onclose = finish;
      socket.onerror = (error) => {
        if (!closed) {
          logError("[discord] Gateway connection error:", error);
        }
        socket.close();
        finish();
      };
    });
  }

  const startPromise = (async () => {
    while (!closed) {
      try {
        await runOneConnection();
      } catch (error) {
        if (!closed) {
          logError("[discord] failed to open Gateway connection, retrying:", error);
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
      activeSocket?.close(1000, "OpenTag shutting down");
      await startPromise.catch(() => undefined);
    }
  };
}
