import type { OpenTagEvent } from "@opentag/core";
import { describe, expect, it } from "vitest";
import { createOpenTagClient } from "../src/index.js";

const event: OpenTagEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("@opentag/client", () => {
  it("creates dispatcher runs with validated event payloads and auth headers", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test/",
      pairingToken: "pair_1",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          idempotentReplay: true,
          run: {
            id: "run_1",
            eventId: "evt_1",
            status: "queued",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          }
        });
      }
    });

    const { run, idempotentReplay } = await client.createRun({ runId: "run_1", event });

    expect(run.id).toBe("run_1");
    expect(idempotentReplay).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://dispatcher.test/v1/runs");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer pair_1"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      runId: "run_1",
      event: { id: "evt_1", command: { rawText: "fix this" } }
    });
  });

  it("returns null when a runner claim has no available work", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () => new Response(null, { status: 204 })
    });

    await expect(client.claim({ runnerId: "runner_1" })).resolves.toBeNull();
  });

  it("parses claimed run responses", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () =>
        jsonResponse({
          run: {
            id: "run_1",
            eventId: "evt_1",
            status: "assigned",
            assignedRunnerId: "runner_1",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          },
          event
        })
    });

    const claimed = await client.claim({ runnerId: "runner_1" });

    expect(claimed?.run.status).toBe("assigned");
    expect(claimed?.event.id).toBe("evt_1");
  });

  it("includes dispatcher error bodies in thrown errors", async () => {
    const client = createOpenTagClient({
      dispatcherUrl: "http://dispatcher.test",
      fetchImpl: async () => jsonResponse({ error: "repo_not_bound" }, 403)
    });

    await expect(client.createRun({ runId: "run_1", event })).rejects.toThrow(
      'createRun failed: 403 {"error":"repo_not_bound"}'
    );
  });
});
