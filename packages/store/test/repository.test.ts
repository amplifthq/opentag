import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createOpenTagRepository } from "../src/repository.js";
import { migrateSchema } from "../src/schema.js";

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
        metadata: {}
      }
    });

    await repo.completeRun({
      runId: "run_2",
      result: {
        conclusion: "success",
        summary: "done"
      }
    });

    const stored = await repo.getRun({ runId: "run_2" });
    expect(stored?.run.status).toBe("succeeded");
    expect(stored?.run.result?.summary).toBe("done");

    const events = await repo.listRunEvents({ runId: "run_2" });
    expect(events.map((event) => event.type)).toEqual(["run.created", "run.completed"]);
  });
});
