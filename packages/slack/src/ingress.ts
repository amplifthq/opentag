import { createHmac, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createSlackDispatcherEventProcessorInput } from "./dispatcher-events.js";
import { createSlackEventProcessor, type SlackAppRuntimeConfig, type SlackEventEnvelope, type SlackEventProcessorInput } from "./events.js";

export type SlackEventsAppInput = {
  slackApps: Array<
    SlackAppRuntimeConfig & {
      signingSecret: string;
    }
  >;
  clock?: () => number;
} & SlackEventProcessorInput;

export type SlackEventsApiIngressConfig = {
  signingSecret: string;
  dispatcherUrl: string;
  dispatcherToken?: string;
  port?: number;
  agentId?: string;
  appId?: string;
  callbackUri?: string;
};

export type SlackIngressConfig = SlackEventsApiIngressConfig;

export type SlackIngressHandle = {
  url: string;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
};

export function computeSlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
}): string {
  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const digest = createHmac("sha256", input.signingSecret).update(base).digest("hex");
  return `v0=${digest}`;
}

export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
}): boolean {
  const expected = computeSlackSignature(input);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(input.signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifySlackTimestamp(input: { timestamp: string; nowMs: number; toleranceSeconds?: number }): boolean {
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  const ageSeconds = Math.abs(Math.floor(input.nowMs / 1000) - timestampSeconds);
  return ageSeconds <= toleranceSeconds;
}

export function createSlackEventsApp(input: SlackEventsAppInput) {
  const app = new Hono();
  const processor = createSlackEventProcessor(input);

  function parseSlackPayload(rawBody: string): SlackEventEnvelope | null {
    try {
      return JSON.parse(rawBody) as SlackEventEnvelope;
    } catch {
      return null;
    }
  }

  function resolveSlackApp(inputValue: {
    apiAppId?: string;
    rawBody: string;
    signature: string;
    timestamp: string;
  }) {
    const candidates = inputValue.apiAppId
      ? input.slackApps.filter((candidate) => !candidate.appId || candidate.appId === inputValue.apiAppId)
      : input.slackApps;
    if (candidates.length === 0) {
      return { error: "unknown_slack_app" as const };
    }
    const slackApp = candidates.find((candidate) =>
      verifySlackSignature({
        signingSecret: candidate.signingSecret,
        timestamp: inputValue.timestamp,
        rawBody: inputValue.rawBody,
        signature: inputValue.signature
      })
    );
    return slackApp ? { slackApp } : { error: "invalid_signature" as const };
  }

  app.post("/slack/events", async (c) => {
    const timestamp = c.req.header("x-slack-request-timestamp");
    const signature = c.req.header("x-slack-signature");
    if (!timestamp || !signature) {
      return c.json({ error: "missing_signature_headers" }, 401);
    }
    if (!verifySlackTimestamp({ timestamp, nowMs: input.clock?.() ?? Date.now() })) {
      return c.json({ error: "stale_signature_timestamp" }, 401);
    }
    const rawBody = await c.req.text();
    const payload = parseSlackPayload(rawBody);
    if (!payload) {
      return c.json({ error: "invalid_json" }, 400);
    }
    const resolvedSlackApp = resolveSlackApp({
      rawBody,
      signature,
      timestamp,
      ...(payload.api_app_id ? { apiAppId: payload.api_app_id } : {})
    });
    if ("error" in resolvedSlackApp) {
      return c.json({ error: resolvedSlackApp.error }, 401);
    }
    const result = await processor.process(payload, resolvedSlackApp.slackApp);
    if (result.kind === "text") {
      return c.text(result.body, result.status);
    }
    return c.json(result.body, result.status);
  });

  return app;
}

export function startSlackIngress(config: SlackEventsApiIngressConfig): SlackIngressHandle {
  const port = config.port ?? 3040;
  const server = serve({
    fetch: createSlackEventsApp({
      slackApps: [
        {
          signingSecret: config.signingSecret,
          agentId: config.agentId ?? "opentag",
          ...(config.appId ? { appId: config.appId } : {}),
          ...(config.callbackUri ? { callbackUri: config.callbackUri } : {})
        }
      ],
      ...createSlackDispatcherEventProcessorInput(config)
    }).fetch,
    port
  });

  return {
    url: `http://localhost:${port}`,
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
