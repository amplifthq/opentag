import type { OpenTagEvent } from "@opentag/core";
import { createOpenTagClient, createDispatcherAdminClient, createDispatcherClient } from "@opentag/client";
import { createDispatcherApp } from "@opentag/dispatcher";
import { createEchoExecutor } from "@opentag/runner";
import { describe, expect, it } from "vitest";
import { runOneDaemonIteration } from "../src/daemon.js";

const event: OpenTagEvent = {
  id: "evt_integration",
  source: "github",
  sourceEventId: "comment_integration",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "summarize this", intent: "run", args: {} },
  context: [{ kind: "github.issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

function fetchForApp(app: ReturnType<typeof createDispatcherApp>): typeof fetch {
  return (async (url, init) => {
    const parsed = new URL(String(url));
    return app.request(`${parsed.pathname}${parsed.search}`, init);
  }) as typeof fetch;
}

describe("opentagd local integration", () => {
  it("registers a runner, creates a run, executes echo once, and records callback queue events", async () => {
    const delivered: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push(`${message.kind}:${message.body}`);
        }
      }
    });
    const fetchImpl = fetchForApp(app);
    const dispatcherUrl = "http://dispatcher.test";
    const admin = createDispatcherAdminClient({ dispatcherUrl, runnerId: "runner_1", fetchImpl });
    const client = createOpenTagClient({ dispatcherUrl, fetchImpl });

    await admin.registerRunner("Local Runner");
    await admin.bindRepository({
      provider: "github",
      owner: "acme",
      repo: "demo",
      checkoutPath: "/tmp/demo",
      defaultExecutor: "echo"
    });
    await client.createRun({ runId: "run_integration", event });

    const didWork = await runOneDaemonIteration({
      runnerId: "runner_1",
      repositories: [
        {
          provider: "github",
          owner: "acme",
          repo: "demo",
          checkoutPath: "/tmp/demo",
          defaultExecutor: "echo",
          baseBranch: "main",
          pushRemote: "origin"
        }
      ],
      executors: { echo: createEchoExecutor() },
      client: createDispatcherClient({ dispatcherUrl, runnerId: "runner_1", fetchImpl })
    });

    expect(didWork).toBe(true);
    const stored = await client.getRun({ runId: "run_integration" });
    expect(stored.run.status).toBe("succeeded");
    expect(stored.run.result?.summary).toBe("Echoed OpenTag command: summarize this");
    expect(delivered).toEqual([
      "acknowledgement:OpenTag picked this up. Run: `run_integration`",
      "progress:OpenTag progress for `run_integration`: Echo executor started for run_integration",
      "progress:OpenTag progress for `run_integration`: Echo executor completed for run_integration",
      "final:OpenTag finished with **success**.\n\nEchoed OpenTag command: summarize this\n\nVerification:\n- `echo`: passed\n\nNext action: No external state change is suggested for the echo executor result."
    ]);

    const { events } = await client.listRunEvents({ runId: "run_integration" });
    expect(events.map((item) => (item as { type: string }).type)).toEqual([
      "run.created",
      "context_packet.generated",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered",
      "run.claimed",
      "run.running",
      "run.progress",
      "callback.progress.queued",
      "callback.progress.delivered",
      "run.progress",
      "callback.progress.queued",
      "callback.progress.delivered",
      "run.completed",
      "callback.final.queued",
      "callback.final.delivered"
    ]);
  });
});
