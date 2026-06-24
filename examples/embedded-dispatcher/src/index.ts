import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import { commandFromRawText, type OpenTagEvent } from "@opentag/core";
import { createDispatcherApp } from "@opentag/dispatcher";
import { Hono } from "hono";

const port = Number(process.env.PORT ?? "3050");
const databasePath = process.env.OPENTAG_DATABASE_PATH ?? "opentag.embedded.db";
const pairingToken = process.env.OPENTAG_PAIRING_TOKEN ?? "dev_pairing_token";
const dispatcherBasePath = "/opentag";

const host = new Hono();
const dispatcher = createDispatcherApp({ databasePath, pairingToken });
const client = createOpenTagClient({
  dispatcherUrl: `http://localhost:${port}${dispatcherBasePath}`,
  pairingToken
});

let runCounter = 0;

host.route(dispatcherBasePath, dispatcher);

host.post("/custom/mention", async (c) => {
  const body = (await c.req.json()) as {
    owner?: string;
    repo?: string;
    actor?: string;
    text?: string;
  };
  if (!body.owner || !body.repo || !body.actor || !body.text) {
    return c.json({ error: "owner, repo, actor, and text are required" }, 422);
  }

  const runId = `run_custom_${++runCounter}`;
  const now = new Date().toISOString();
  const command = commandFromRawText(body.text);
  const event: OpenTagEvent = {
    id: `evt_${runId}`,
    source: "webhook",
    sourceEventId: runId,
    receivedAt: now,
    actor: {
      provider: "github",
      providerUserId: body.actor,
      handle: body.actor
    },
    target: {
      mention: "@opentag",
      agentId: "opentag"
    },
    command,
    context: [
      {
        kind: "text",
        uri: `custom://mentions/${runId}`,
        title: "Custom webhook mention",
        visibility: "private"
      }
    ],
    permissions: [
      { scope: "runner:local", reason: "execute through a paired runner" },
      { scope: "issue:comment", reason: "return a final status to the originating system" }
    ],
    callback: {
      provider: "webhook",
      uri: `custom://mentions/${runId}`
    },
    metadata: {
      repoProvider: "github",
      owner: body.owner,
      repo: body.repo
    }
  };

  const created = await client.createRun({ runId, event });
  return c.json(created, 201);
});

serve({ fetch: host.fetch, port });

console.log(`Embedded OpenTag dispatcher listening on http://localhost:${port}${dispatcherBasePath}`);
