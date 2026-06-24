import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createOpenTagRepository } from "../src/repository.js";
import { migrateSchema } from "../src/schema.js";

const baseEvent = {
  id: "evt_1",
  source: "github" as const,
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github" as const, providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix" as const, args: {} },
  context: [{ kind: "github.issue" as const, uri: "https://github.com/acme/demo/issues/1", visibility: "public" as const }],
  permissions: [{ scope: "issue:comment" as const, reason: "reply to source thread" }],
  callback: { provider: "github" as const, uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

describe("OpenTag repository", () => {
  it("creates and claims a run once", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_1", name: "Local Runner" });
    await repo.createRepoBinding({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1"
    });

    await repo.createRun({
      id: "run_1",
      event: {
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
      }
    });

    const claimed = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    expect(claimed?.run.id).toBe("run_1");
    expect(claimed?.run.status).toBe("assigned");
    expect(claimed?.event.command.rawText).toBe("fix this");

    const secondClaim = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    expect(secondClaim).toBeNull();
  });

  it("only lets the repo-bound runner claim a queued run", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.registerRunner({ runnerId: "runner_2", name: "Runner Two" });
    await repo.createRepoBinding({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo",
      allowedActors: ["octocat"]
    });
    await repo.createRun({
      id: "run_bound",
      event: {
        id: "evt_bound",
        source: "github",
        sourceEventId: "comment_bound",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [],
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      }
    });

    await expect(repo.claimNextRun({ runnerId: "runner_2", leaseSeconds: 60 })).resolves.toBeNull();
    const claimed = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    expect(claimed?.run.id).toBe("run_bound");

    const binding = await repo.getRepoBinding({ provider: "github", owner: "acme", repo: "demo" });
    expect(binding).toMatchObject({
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo",
      allowedActors: ["octocat"]
    });
  });

  it("records runner heartbeats for claimed runs", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" });
    await repo.createRun({
      id: "run_heartbeat",
      event: {
        id: "evt_heartbeat",
        source: "github",
        sourceEventId: "comment_heartbeat",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [],
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      }
    });
    await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });

    await expect(repo.heartbeat({ runId: "run_heartbeat", runnerId: "runner_1" })).resolves.toBe(true);
    const events = await repo.listRunEvents({ runId: "run_heartbeat" });
    expect(events.map((event) => event.type)).toContain("run.heartbeat");
    const heartbeatEvent = events.find((event) => event.type === "run.heartbeat");
    expect(heartbeatEvent?.payload).toMatchObject({ runnerId: "runner_1" });
  });

  it("returns the existing run for duplicate source events", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    const first = await repo.createRun({ id: "run_first", event: baseEvent });
    const second = await repo.createRun({
      id: "run_second",
      event: { ...baseEvent, id: "evt_duplicate_same_source" }
    });

    expect(first.id).toBe("run_first");
    expect(second.id).toBe("run_first");
    const events = await repo.listRunEvents({ runId: "run_first" });
    expect(events.map((event) => event.type)).toEqual(["run.created", "run.duplicate_ignored"]);
  });

  it("requires the assigned runner for status updates", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" });
    await repo.createRun({ id: "run_scoped", event: { ...baseEvent, id: "evt_scoped", sourceEventId: "comment_scoped" } });
    await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });

    await expect(repo.markRunning({ runId: "run_scoped", runnerId: "runner_2", executor: "echo" })).resolves.toBe(false);
    await expect(repo.markRunning({ runId: "run_scoped", runnerId: "runner_1", executor: "echo" })).resolves.toBe(true);
    await expect(
      repo.recordProgress({ runId: "run_scoped", runnerId: "runner_2", message: "wrong runner" })
    ).resolves.toBe(false);
    await expect(repo.recordProgress({ runId: "run_scoped", runnerId: "runner_1", message: "ok" })).resolves.toBe(true);
    await expect(
      repo.completeRun({ runId: "run_scoped", runnerId: "runner_2", result: { conclusion: "success", summary: "done" } })
    ).resolves.toBe(false);
    await expect(
      repo.completeRun({ runId: "run_scoped", runnerId: "runner_1", result: { conclusion: "success", summary: "done" } })
    ).resolves.toBe(true);
  });

  it("requeues runs whose lease has expired", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" });
    await repo.createRun({
      id: "run_expire",
      event: {
        id: "evt_expire",
        source: "github",
        sourceEventId: "comment_expire",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [],
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      }
    });
    await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 0 });
    const requeued = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    expect(requeued?.run.id).toBe("run_expire");

    const events = await repo.listRunEvents({ runId: "run_expire" });
    expect(events.map((event) => event.type)).toContain("run.lease_expired");
  });

  it("stores Slack channel to repo bindings", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createSlackChannelBinding({
      teamId: "T123",
      channelId: "C123",
      owner: "acme",
      repo: "demo"
    });

    await expect(repo.getSlackChannelBinding({ teamId: "T123", channelId: "C123" })).resolves.toEqual({
      teamId: "T123",
      channelId: "C123",
      owner: "acme",
      repo: "demo"
    });
  });

  it("returns registered runners", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });

    await expect(repo.getRunner({ runnerId: "runner_1" })).resolves.toMatchObject({
      runnerId: "runner_1",
      name: "Runner One"
    });
    await expect(repo.getRunner({ runnerId: "missing" })).resolves.toBeNull();
  });

  it("schedules failed callback deliveries for retry", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRun({ id: "run_callback", event: { ...baseEvent, id: "evt_callback", sourceEventId: "comment_callback" } });
    const delivery = await repo.enqueueCallbackDelivery({
      runId: "run_callback",
      kind: "final",
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      body: "done"
    });
    await repo.markCallbackFailed({
      deliveryId: delivery.id,
      error: "provider unavailable",
      nextAttemptAt: "2026-06-24T00:00:10.000Z"
    });

    await expect(
      repo.listPendingCallbackDeliveries({
        limit: 10,
        now: new Date("2026-06-24T00:00:05.000Z")
      })
    ).resolves.toEqual([]);
    await expect(
      repo.listPendingCallbackDeliveries({
        limit: 10,
        now: new Date("2026-06-24T00:00:10.000Z")
      })
    ).resolves.toMatchObject([
      {
        id: delivery.id,
        status: "failed",
        attempts: 1,
        lastError: "provider unavailable",
        nextAttemptAt: "2026-06-24T00:00:10.000Z"
      }
    ]);

    await repo.markCallbackDelivered({ deliveryId: delivery.id });
    await expect(
      repo.listCallbackDeliveries({
        runId: "run_callback"
      })
    ).resolves.toMatchObject([{ id: delivery.id, status: "delivered", attempts: 2 }]);
  });

  it("records a completed result", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRun({
      id: "run_2",
      event: {
        id: "evt_2",
        source: "github",
        sourceEventId: "comment_2",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "run echo", intent: "run", args: {} },
        context: [],
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      }
    });

    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" });
    await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });

    await repo.completeRun({
      runId: "run_2",
      runnerId: "runner_1",
      result: {
        conclusion: "success",
        summary: "done"
      }
    });

    const stored = await repo.getRun({ runId: "run_2" });
    expect(stored?.run.status).toBe("succeeded");
    expect(stored?.run.result?.summary).toBe("done");

    const events = await repo.listRunEvents({ runId: "run_2" });
    expect(events.map((event) => event.type)).toEqual(["run.created", "run.claimed", "run.completed"]);
  });
});
