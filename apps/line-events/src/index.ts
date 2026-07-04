import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import type { OpenTagEvent } from "@opentag/core";
import { createLineEventsApp } from "@opentag/line";

type LineEventsAppInput = Parameters<typeof createLineEventsApp>[0];
type LineAccountConfig = LineEventsAppInput["lineAccounts"][number];
type ControlPlaneEvent = Parameters<
  NonNullable<LineEventsAppInput["recordControlPlaneEvent"]>
>[0];

const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
if (!dispatcherUrl) throw new Error("OPENTAG_DISPATCHER_URL is required");

const dispatcherToken = process.env.OPENTAG_DISPATCHER_TOKEN;
const port = positiveIntegerFromEnv("PORT", process.env.PORT) ?? 3070;
const dispatcherClient = createOpenTagClient({
  dispatcherUrl,
  ...(dispatcherToken ? { pairingToken: dispatcherToken } : {})
});

function positiveIntegerFromEnv(name: string, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function lineAccountsFromEnv(): LineAccountConfig[] {
  const accountsJson = process.env.OPENTAG_LINE_ACCOUNTS_JSON;
  if (accountsJson) {
    try {
      const parsed = JSON.parse(accountsJson);
      if (!Array.isArray(parsed)) throw new Error("Value is not a JSON array");
      return parsed.map((candidate, index): LineAccountConfig => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`Account ${index} must be a JSON object`);
        const record = candidate as Record<string, unknown>;
        if (typeof record.accountId !== "string" || !record.accountId.trim()) throw new Error(`Account ${index} accountId must be a non-empty string`);
        if (typeof record.channelSecret !== "string" || !record.channelSecret.trim()) throw new Error(`Account ${index} channelSecret must be a non-empty string`);
        if (record.agentId !== undefined && (typeof record.agentId !== "string" || !record.agentId.trim())) {
          throw new Error(`Account ${index} agentId must be a non-empty string`);
        }
        if (record.callbackUri !== undefined && typeof record.callbackUri !== "string") throw new Error(`Account ${index} callbackUri must be a string`);
        return {
          accountId: record.accountId,
          channelSecret: record.channelSecret,
          agentId: record.agentId ?? "opentag",
          ...(record.callbackUri ? { callbackUri: record.callbackUri } : {})
        };
      });
    } catch (error) {
      throw new Error(`Failed to parse OPENTAG_LINE_ACCOUNTS_JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!process.env.OPENTAG_LINE_ACCOUNT_ID || !process.env.OPENTAG_LINE_CHANNEL_SECRET) return [];
  return [
    {
      accountId: process.env.OPENTAG_LINE_ACCOUNT_ID,
      channelSecret: process.env.OPENTAG_LINE_CHANNEL_SECRET,
      agentId: process.env.OPENTAG_LINE_AGENT_ID ?? "opentag",
      ...(process.env.OPENTAG_LINE_CALLBACK_URI ? { callbackUri: process.env.OPENTAG_LINE_CALLBACK_URI } : {})
    }
  ];
}

const lineAccounts = lineAccountsFromEnv();
if (lineAccounts.length === 0) throw new Error("Configure OPENTAG_LINE_ACCOUNT_ID/OPENTAG_LINE_CHANNEL_SECRET or OPENTAG_LINE_ACCOUNTS_JSON");
const maxRequestBodyBytes = positiveIntegerFromEnv(
  "OPENTAG_MAX_REQUEST_BODY_BYTES",
  process.env.OPENTAG_MAX_REQUEST_BODY_BYTES
);

serve({
  fetch: createLineEventsApp({
    lineAccounts,
    ...(maxRequestBodyBytes !== undefined ? { maxRequestBodyBytes } : {}),
    async resolveChannelBinding(input) {
      try {
        const { binding } = await dispatcherClient.getChannelBinding({
          provider: "line",
          accountId: input.accountId,
          conversationId: input.conversationId
        });
        return {
          accountId: binding.accountId,
          conversationId: binding.conversationId,
          repoProvider: binding.repoProvider,
          owner: binding.owner,
          repo: binding.repo
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes("channel_binding_not_found")) return null;
        throw error;
      }
    },
    async bindChannel(binding) {
      await dispatcherClient.bindChannel({
        provider: "line",
        accountId: binding.accountId,
        conversationId: binding.conversationId,
        repoProvider: binding.repoProvider ?? "github",
        owner: binding.owner,
        repo: binding.repo
      });
    },
    async createRun(event: OpenTagEvent, input) {
      const runId = input.runId;
      await dispatcherClient.createRun({ runId, event });
      return { runId };
    },
    async recordControlPlaneEvent(event: ControlPlaneEvent) {
      await dispatcherClient.recordControlPlaneEvent(event);
    },
    now: () => new Date().toISOString()
  }).fetch,
  port
});

console.log(`OpenTag LINE events ingress listening on http://localhost:${port}`);
