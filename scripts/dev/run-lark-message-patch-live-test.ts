import { execFileSync } from "node:child_process";

import { createLarkCallbackSink } from "../../packages/dispatcher/src/callbacks.js";
import { createDispatcherApp } from "../../packages/dispatcher/src/server.js";
import type { CallbackMessage } from "../../packages/dispatcher/src/server.js";
import type { LarkReplyClient } from "../../packages/lark/src/outbound.js";

type JsonObject = Record<string, unknown>;

type DeliveryProbe = {
  kind: CallbackMessage["kind"];
  hasExternal: boolean;
  external?: string;
  hasRich: boolean;
  returnedExternal?: boolean;
  returned?: string;
  error?: string;
};

const LARK_CLI = process.env.OPENTAG_LARK_CLI ?? "lark-cli";
const DEFAULT_REPO = "amplifthq/opentag-test";
const LIVE_TENANT_KEY = "lark-live-e2e";

let idempotencySequence = 0;

async function main(): Promise<void> {
  const authStatus = runLarkCliJson(["auth", "status"], "auth status");
  assertUsableUserIdentity(authStatus);
  assertReadyIdentity(authStatus, "bot");

  const repoRef = parseRepoRef(process.env.OPENTAG_LARK_LIVE_REPO ?? DEFAULT_REPO);
  const source = getOrCreateSourceMessage(authStatus);
  const runnerId = `lark-live-patch-${Date.now().toString(36)}`;
  const runId = `run_lark_patch_${Date.now()}`;
  const channelApplicationId = getString(authStatus, ["appId"]);
  const channelPrincipalCredential = `lark-live-principal-${runId}`;

  const deliveryLog: DeliveryProbe[] = [];
  const liveLarkSink = createLarkCallbackSink({ client: createLiveLarkClient(source.messageId) });
  const app = createDispatcherApp({
    databasePath: ":memory:",
    channelPrincipals: [
      {
        provider: "lark",
        applicationId: channelApplicationId,
        credential: channelPrincipalCredential,
      },
    ],
    callbackSink: {
      async deliver(message) {
        const probe: DeliveryProbe = {
          kind: message.kind,
          hasExternal: Boolean(message.externalMessageId),
          external: message.externalMessageId ? redactId(message.externalMessageId) : undefined,
          hasRich: Boolean(message.rich),
        };
        try {
          const result = await liveLarkSink.deliver(message);
          const externalMessageId =
            result && "externalMessageId" in result && typeof result.externalMessageId === "string"
              ? result.externalMessageId
              : undefined;
          probe.returnedExternal = Boolean(externalMessageId);
          probe.returned = externalMessageId ? redactId(externalMessageId) : undefined;
          return result;
        } catch (error) {
          probe.error = sanitizeError(error);
          throw error;
        } finally {
          deliveryLog.push(probe);
        }
      },
    },
  });

  await requestJson(
    app,
    "/v1/repo-bindings",
    {
      method: "POST",
      body: {
        provider: "github",
        owner: repoRef.owner,
        repo: repoRef.repo,
        runnerId,
        defaultExecutor: "echo",
      },
    },
    201,
  );

  await requestJson(
    app,
    "/v1/channel-bindings",
    {
      method: "POST",
      headers: { "x-opentag-channel-principal": channelPrincipalCredential },
      body: {
        provider: "lark",
        accountId: LIVE_TENANT_KEY,
        conversationId: source.chatId,
        repoProvider: "github",
        owner: repoRef.owner,
        repo: repoRef.repo,
        ownership: {
          mode: "managed",
          exclusive: true,
          applicationId: channelApplicationId,
        },
      },
    },
    201,
  );

  const createRunResponse = await requestJson(
    app,
    "/v1/runs",
    {
      method: "POST",
      headers: { "x-opentag-channel-principal": channelPrincipalCredential },
      body: {
        runId,
        event: createLarkEvent({
          runId,
          owner: repoRef.owner,
          repo: repoRef.repo,
          chatId: source.chatId,
          messageId: source.messageId,
        }),
      },
    },
    201,
  );
  assertEqual(getString(createRunResponse, ["run", "id"]), runId, "dispatcher created the requested run");

  const claimResponse = await requestJson(
    app,
    `/v1/runners/${encodeURIComponent(runnerId)}/claim`,
    { method: "POST", body: { max: 1 } },
    200,
  );
  assertEqual(getString(claimResponse, ["run", "id"]), runId, "dispatcher claimed the requested run");

  await requestJson(
    app,
    `/v1/runners/${encodeURIComponent(runnerId)}/runs/${encodeURIComponent(runId)}/complete`,
    {
      method: "POST",
      body: {
        result: {
          conclusion: "success",
          summary: "Lark message patch live E2E completed.",
          verification: [{ command: "lark message patch", outcome: "passed" }],
        },
      },
    },
    200,
  );

  assertPatchDelivery(deliveryLog);

  console.log(
    JSON.stringify(
      {
        ok: true,
        runId,
        createdSeedMessage: source.created,
        sourceMessage: redactId(source.messageId),
        deliveries: deliveryLog,
      },
      null,
      2,
    ),
  );
}

function createLiveLarkClient(sourceMessageId: string): LarkReplyClient {
  return {
    im: {
      message: {
        async reply(payload) {
          if (!payload) throw new Error("missing Lark reply payload");
          const response = runLarkCliJson(
            [
              "im",
              "+messages-reply",
              "--as",
              "bot",
              "--message-id",
              sourceMessageId,
              "--msg-type",
              String(payload.data.msg_type),
              "--content",
              String(payload.data.content),
              "--reply-in-thread",
              "--idempotency-key",
              nextIdempotencyKey("reply"),
              "--json",
            ],
            "reply status card",
          );
          return { data: { message_id: getString(response, ["data", "message_id"]) } };
        },
        async patch(payload) {
          if (!payload) throw new Error("missing Lark patch payload");
          const response = runLarkCliJson(
            [
              "api",
              "PATCH",
              `/open-apis/im/v1/messages/${payload.path.message_id}`,
              "--as",
              "bot",
              "--data",
              JSON.stringify({ content: payload.data.content }),
              "--json",
            ],
            "patch status card",
          );
          assertLarkOk(response, "patch message");
          return { data: { message_id: payload.path.message_id } };
        },
        async update(payload) {
          if (!payload) throw new Error("missing Lark update payload");
          const response = runLarkCliJson(
            [
              "api",
              "PUT",
              `/open-apis/im/v1/messages/${payload.path.message_id}`,
              "--as",
              "bot",
              "--data",
              JSON.stringify({ content: payload.data.content, msg_type: payload.data.msg_type }),
              "--json",
            ],
            "update status text",
          );
          assertLarkOk(response, "update message");
          return { data: { message_id: payload.path.message_id } };
        },
      },
    },
  };
}

function getOrCreateSourceMessage(authStatus: JsonObject): {
  chatId: string;
  messageId: string;
  created: boolean;
} {
  const envChatId = process.env.OPENTAG_LARK_LIVE_CHAT_ID;
  const envMessageId = process.env.OPENTAG_LARK_LIVE_SOURCE_MESSAGE_ID;
  if (envChatId || envMessageId) {
    if (!envChatId || !envMessageId) {
      throw new Error(
        "set both OPENTAG_LARK_LIVE_CHAT_ID and OPENTAG_LARK_LIVE_SOURCE_MESSAGE_ID, or neither",
      );
    }
    return { chatId: envChatId, messageId: envMessageId, created: false };
  }

  const userOpenId = getString(authStatus, ["identities", "user", "openId"]);
  const response = runLarkCliJson(
    [
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--user-id",
      userOpenId,
      "--text",
      `OpenTag live patch E2E seed ${new Date().toISOString()}`,
      "--idempotency-key",
      nextIdempotencyKey("seed"),
      "--json",
    ],
    "seed source message",
  );
  return {
    chatId: getString(response, ["data", "chat_id"]),
    messageId: getString(response, ["data", "message_id"]),
    created: true,
  };
}

function createLarkEvent(args: {
  runId: string;
  owner: string;
  repo: string;
  chatId: string;
  messageId: string;
}): JsonObject {
  return {
    id: `evt_${args.runId}`,
    source: "lark",
    sourceEventId: `lark-live-patch-${Date.now().toString(36)}`,
    receivedAt: new Date().toISOString(),
    actor: {
      provider: "lark",
      providerUserId: "lark-live-e2e-user",
      displayName: "Lark Live E2E",
    },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "echo Lark message patch live E2E", intent: "run", args: {} },
    context: [
      {
        provider: "lark",
        kind: "message",
        uri: `lark://tenant/${LIVE_TENANT_KEY}/chat/${args.chatId}/message/${args.messageId}`,
        visibility: "organization",
        title: "Lark message",
      },
    ],
    permissions: [],
    callback: {
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: `${LIVE_TENANT_KEY}|${args.chatId}|${args.messageId}`,
    },
    metadata: {
      tenantKey: LIVE_TENANT_KEY,
      chatId: args.chatId,
      messageId: args.messageId,
      repoProvider: "github",
      owner: args.owner,
      repo: args.repo,
    },
  };
}

async function requestJson(
  app: ReturnType<typeof createDispatcherApp>,
  path: string,
  options: { method: string; body?: JsonObject; headers?: Record<string, string> },
  expectedStatus: number,
): Promise<JsonObject> {
  const response = await app.request(path, {
    method: options.method,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const bodyText = await response.text();
  const body = parseJson(bodyText);
  if (response.status !== expectedStatus) {
    throw new Error(
      `${options.method} ${path} returned ${response.status}, expected ${expectedStatus}: ${summarizeBody(body)}`,
    );
  }
  return body;
}

function runLarkCliJson(args: string[], label: string): JsonObject {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const output = execFileSync(LARK_CLI, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024,
      });
      return parseJson(output);
    } catch (error) {
      lastError = larkCliError(error, label);
      if (!isRetryableLarkCliError(lastError) || attempt === 2) {
        throw lastError;
      }
      sleepMs(1500 * (attempt + 1));
    }
  }
  throw lastError ?? new Error(`lark-cli ${label} failed`);
}

function larkCliError(error: unknown, label: string): Error {
  const stdout = parseOptionalJson(getExecOutput(error, "stdout") ?? "");
  const stderr = parseOptionalJson(getExecOutput(error, "stderr") ?? "");
  const parsed = Object.keys(stdout).length > 0 ? stdout : stderr;
  const message =
    typeof parsed.error === "string"
      ? parsed.error
      : getOptionalString(parsed, ["error", "message"]) ?? getOptionalString(parsed, ["message"]);
  const code =
    getOptionalString(parsed, ["error", "code"]) ??
    getOptionalString(parsed, ["code"]) ??
    getExecStatus(error)?.toString();
  return new Error(`lark-cli ${label} failed${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`);
}

function isRetryableLarkCliError(error: Error): boolean {
  return /\b(429|rate limit|too many requests)\b/i.test(error.message);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function assertPatchDelivery(deliveryLog: DeliveryProbe[]): void {
  const acknowledgement = deliveryLog.find((delivery) => delivery.kind === "acknowledgement");
  const final = deliveryLog.find((delivery) => delivery.kind === "final");
  if (!acknowledgement) {
    throw new Error("missing acknowledgement delivery");
  }
  if (!final) {
    throw new Error("missing final delivery");
  }
  if (acknowledgement.error || final.error) {
    throw new Error(`delivery failed: ${acknowledgement.error ?? final.error}`);
  }
  if (!acknowledgement.returnedExternal) {
    throw new Error("acknowledgement did not return an external Lark message id");
  }
  if (!final.hasExternal) {
    throw new Error("final callback did not reuse the acknowledgement external message id");
  }
  if (!final.returnedExternal) {
    throw new Error("final callback patch did not return an external Lark message id");
  }
  if (acknowledgement.returned !== final.external || final.external !== final.returned) {
    throw new Error("final callback did not patch the same Lark message id");
  }
}

function assertReadyIdentity(status: JsonObject, identity: "bot" | "user"): void {
  const ready = getOptionalString(status, ["identities", identity, "status"]);
  if (ready !== "ready") {
    throw new Error(`lark-cli ${identity} identity is not ready`);
  }
}

function assertUsableUserIdentity(status: JsonObject): void {
  const ready = getOptionalString(status, ["identities", "user", "status"]);
  const openId = getOptionalString(status, ["identities", "user", "openId"]);
  if (ready === "ready" || openId) return;
  throw new Error("lark-cli user identity is not ready and has no cached openId");
}

function assertLarkOk(response: JsonObject, action: string): void {
  if (response.ok === false) {
    const message = getOptionalString(response, ["error", "message"]) ?? "unknown Lark API error";
    throw new Error(`${action} failed: ${message}`);
  }
}

function assertEqual(actual: string, expected: string, description: string): void {
  if (actual !== expected) {
    throw new Error(`${description}: expected ${expected}, got ${actual}`);
  }
}

function parseRepoRef(repoRef: string): { owner: string; repo: string } {
  const [owner, repo] = repoRef.split("/");
  if (!owner || !repo || repoRef.split("/").length !== 2) {
    throw new Error("OPENTAG_LARK_LIVE_REPO must be in owner/repo form");
  }
  return { owner, repo };
}

function nextIdempotencyKey(scope: string): string {
  idempotencySequence += 1;
  return `olp-${Date.now().toString(36)}-${idempotencySequence.toString(36)}-${scope}`;
}

function parseJson(text: string): JsonObject {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON value is not an object");
    }
    return parsed as JsonObject;
  } catch {
    throw new Error("expected JSON output");
  }
}

function parseOptionalJson(text: string): JsonObject {
  try {
    return parseJson(text);
  } catch {
    return {};
  }
}

function getString(value: unknown, path: string[]): string {
  const result = getOptionalString(value, path);
  if (!result) {
    throw new Error(`missing ${path.join(".")}`);
  }
  return result;
}

function getOptionalString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(part in current)) {
      return undefined;
    }
    current = (current as JsonObject)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function getExecOutput(error: unknown, key: "stdout" | "stderr"): string | undefined {
  if (!error || typeof error !== "object" || !(key in error)) {
    return undefined;
  }
  const value = (error as { stdout?: unknown; stderr?: unknown })[key];
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return undefined;
}

function getExecStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" ? value : undefined;
}

function summarizeBody(body: JsonObject): string {
  const error = getOptionalString(body, ["error"]) ?? getOptionalString(body, ["error", "message"]);
  return error ?? "unexpected response body";
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\bom_[A-Za-z0-9_-]{8,}/g, "om_...");
  }
  return "unknown error";
}

function redactId(id: string): string {
  if (id.length <= 12) {
    return "[redacted]";
  }
  return `${id.slice(0, 6)}...${id.slice(-6)}`;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: sanitizeError(error) }, null, 2));
  process.exitCode = 1;
});
