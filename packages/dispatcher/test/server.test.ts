import { describe, expect, it } from "vitest";
import { createDispatcherApp } from "../src/server.js";

const validEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [{ kind: "github.issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }],
  permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

describe("dispatcher API", () => {
  it("requires a bearer token when pairing token auth is configured", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:", pairingToken: "pair_test" });

    const denied = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    expect(denied.status).toBe(401);

    const allowed = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer pair_test" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    expect(allowed.status).toBe(201);
  });

  it("creates and claims an echo run", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const runnerResponse = await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    expect(runnerResponse.status).toBe(201);

    const bindingResponse = await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo",
        allowedActors: ["octocat"]
      })
    });
    expect(bindingResponse.status).toBe(201);

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_1", event: validEvent })
    });
    expect(createResponse.status).toBe(201);

    const claimResponse = await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    expect(claimResponse.status).toBe(200);
    const claimed = await claimResponse.json();
    expect(claimed.run.id).toBe("run_1");
    expect(claimed.event.command.rawText).toBe("fix this");

    const bindingGetResponse = await app.request("/v1/repo-bindings/github/acme/demo");
    const binding = await bindingGetResponse.json();
    expect(binding.binding).toMatchObject({ runnerId: "runner_1", workspacePath: "/Users/test/demo" });
  });

  it("delivers acknowledgement, progress, and final callback messages with audit events", async () => {
    const delivered: { kind: string; body: string }[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push({ kind: message.kind, body: message.body });
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        workspacePath: "/Users/test/demo",
        defaultExecutor: "echo",
        allowedActors: ["octocat"]
      })
    });
    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_2", event: { ...validEvent, id: "evt_2", sourceEventId: "comment_2" } })
    });
    expect(createResponse.status).toBe(201);
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });
    await app.request("/v1/runners/runner_1/runs/run_2/running", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executor: "echo" })
    });
    await app.request("/v1/runners/runner_1/runs/run_2/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "executor.progress", message: "running tests", at: "2026-06-24T00:00:01.000Z" })
    });
    const completeResponse = await app.request("/v1/runners/runner_1/runs/run_2/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: { conclusion: "success", summary: "done" } })
    });
    expect(completeResponse.status).toBe(200);

    const getResponse = await app.request("/v1/runs/run_2");
    const stored = await getResponse.json();
    expect(stored.run.status).toBe("succeeded");
    expect(stored.run.result.summary).toBe("done");
    expect(delivered).toEqual([
      { kind: "acknowledgement", body: "OpenTag picked this up. Run: `run_2`" },
      { kind: "progress", body: "OpenTag progress for `run_2`: running tests" },
      { kind: "final", body: "OpenTag finished with **success**.\n\ndone" }
    ]);

    const eventsResponse = await app.request("/v1/runs/run_2/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "run.created",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.delivered",
      "run.claimed",
      "run.running",
      "run.progress",
      "callback.progress.queued",
      "callback.progress.delivered",
      "run.completed",
      "callback.final.queued",
      "callback.final.delivered"
    ]);
  });

  it("records callback delivery failures without failing run creation", async () => {
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver() {
          throw new Error("provider unavailable");
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" })
    });

    const createResponse = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_callback_fail", event: { ...validEvent, id: "evt_callback_fail", sourceEventId: "comment_callback_fail" } })
    });

    expect(createResponse.status).toBe(201);
    const eventsResponse = await app.request("/v1/runs/run_callback_fail/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toEqual([
      "run.created",
      "callback.acknowledgement.queued",
      "callback.acknowledgement.failed"
    ]);
  });

  it("returns existing runs for duplicate source events without duplicate acknowledgement", async () => {
    const delivered: string[] = [];
    const app = createDispatcherApp({
      databasePath: ":memory:",
      callbackSink: {
        async deliver(message) {
          delivered.push(message.runId);
        }
      }
    });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" })
    });

    const first = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_duplicate_first", event: { ...validEvent, id: "evt_duplicate_first", sourceEventId: "comment_duplicate" } })
    });
    const second = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_duplicate_second", event: { ...validEvent, id: "evt_duplicate_second", sourceEventId: "comment_duplicate" } })
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ duplicate: true, run: { id: "run_duplicate_first" } });
    expect(delivered).toEqual(["run_duplicate_first"]);
  });

  it("rejects runs for repositories without an explicit binding", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_unbound", event: validEvent })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "repo_not_bound" });
  });

  it("rejects write-capable runs from actors outside the repo binding allowlist", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1",
        allowedActors: ["someone-else"]
      })
    });
    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_denied",
        event: {
          ...validEvent,
          permissions: [
            ...validEvent.permissions,
            { scope: "repo:write", reason: "write branch" },
            { scope: "pr:create", reason: "open pull request" }
          ]
        }
      })
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "actor_not_allowed_for_write" });
  });

  it("accepts runner heartbeat for claimed runs", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/runners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner_1", name: "Local Runner" })
    });
    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" })
    });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_heartbeat", event: validEvent })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const response = await app.request("/v1/runners/runner_1/runs/run_heartbeat/heartbeat", { method: "POST" });
    expect(response.status).toBe(200);

    const eventsResponse = await app.request("/v1/runs/run_heartbeat/events");
    const { events } = await eventsResponse.json();
    expect(events.map((event: { type: string }) => event.type)).toContain("run.heartbeat");
  });

  it("rejects status updates from runners that did not claim the run", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" })
    });
    await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_scoped", event: { ...validEvent, id: "evt_scoped", sourceEventId: "comment_scoped" } })
    });
    await app.request("/v1/runners/runner_1/claim", { method: "POST" });

    const wrongRunner = await app.request("/v1/runners/runner_2/runs/run_scoped/running", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executor: "echo" })
    });
    expect(wrongRunner.status).toBe(404);

    const oldEndpoint = await app.request("/v1/runs/run_scoped/running", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executor: "echo" })
    });
    expect(oldEndpoint.status).toBe(410);
  });

  it("stores and returns Slack channel bindings", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    const create = await app.request("/v1/slack-channel-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        teamId: "T123",
        channelId: "C123",
        owner: "acme",
        repo: "demo"
      })
    });
    expect(create.status).toBe(201);

    const get = await app.request("/v1/slack-channel-bindings/T123/C123");
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.binding).toEqual({
      teamId: "T123",
      channelId: "C123",
      owner: "acme",
      repo: "demo"
    });
  });

  it("accepts a Slack event when its repo metadata matches a bound GitHub repo", async () => {
    const app = createDispatcherApp({ databasePath: ":memory:" });

    await app.request("/v1/repo-bindings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        owner: "acme",
        repo: "demo",
        runnerId: "runner_1"
      })
    });

    const response = await app.request("/v1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run_slack_bound",
        event: {
          id: "evt_slack_bound",
          source: "slack",
          sourceEventId: "Ev123",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "slack", providerUserId: "U456", handle: "U456", organizationId: "T123" },
          target: { mention: "<@U_APP>", agentId: "opentag" },
          command: { rawText: "investigate this", intent: "investigate", args: {} },
          context: [],
          permissions: [
            { scope: "chat:postMessage", reason: "reply in thread" },
            { scope: "runner:local", reason: "execute locally" }
          ],
          callback: {
            provider: "slack",
            uri: "https://slack.com/api/chat.postMessage",
            threadKey: "T123|C123|1710000000.000100"
          },
          metadata: {
            teamId: "T123",
            channelId: "C123",
            messageTs: "1710000000.000100",
            repoProvider: "github",
            owner: "acme",
            repo: "demo"
          }
        }
      })
    });

    expect(response.status).toBe(201);
  });
});
