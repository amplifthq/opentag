import { projectTargetRefFromLocalPath } from "@opentag/core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ChannelBindingCorruptionError, createOpenTagRepository } from "../src/repository.js";
import { migrateSchema } from "../src/schema.js";

function githubIssueContext(issueNumber: number) {
  return [
    {
      provider: "github" as const,
      kind: "issue" as const,
      uri: `https://github.com/acme/demo/issues/${issueNumber}`,
      visibility: "public" as const
    }
  ];
}

function githubIssueWorkItem(issueNumber: number) {
  return {
    provider: "github" as const,
    kind: "issue" as const,
    externalId: `acme/demo#${issueNumber}`,
    uri: `https://github.com/acme/demo/issues/${issueNumber}`,
    ownerContainer: {
      provider: "github" as const,
      id: "acme/demo",
      uri: "https://github.com/acme/demo"
    }
  };
}

function larkEvent(input: { id: string; sourceEventId: string; owner?: string; repo?: string; chatId?: string }): Parameters<ReturnType<typeof createOpenTagRepository>["createRun"]>[0]["event"] {
  const owner = input.owner ?? "acme";
  const repo = input.repo ?? "demo";
  const chatId = input.chatId ?? "oc_chat";
  return {
    id: input.id,
    source: "lark",
    sourceEventId: input.sourceEventId,
    receivedAt: "2026-06-24T00:00:00.000Z",
    actor: { provider: "lark", providerUserId: "ou_sender", handle: "ming" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "fix this", intent: "fix", args: {} },
    context: [],
    permissions: [{ scope: "chat:postMessage", reason: "reply in source chat" }],
    callback: { provider: "lark", uri: "lark://im/v1/messages", threadKey: `tenant_1|${chatId}|om_msg` },
    metadata: {
      tenantKey: "tenant_1",
      chatId,
      repoProvider: "github",
      owner,
      repo
    }
  };
}

describe("OpenTag repository", () => {
  it("migrates legacy callback deliveries before creating the idempotency index", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE callback_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        uri TEXT NOT NULL,
        body TEXT NOT NULL,
        thread_key TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    expect(() => migrateSchema(sqlite)).not.toThrow();
    const columns = sqlite.prepare("PRAGMA table_info(callback_deliveries)").all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain("idempotency_key");
    const indexes = sqlite.prepare("PRAGMA index_list(callback_deliveries)").all() as { name: string }[];
    expect(indexes.map((index) => index.name)).toContain("callback_deliveries_idempotency_key_idx");
  });

  it("migrates repository-required channel bindings to nullable repository fields without losing rows", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE channel_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        repo_provider TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO channel_bindings (
        provider, account_id, conversation_id, repo_provider, owner, repo, metadata_json, created_at
      ) VALUES ('slack', 'T123', 'C456', 'github', 'acme', 'demo', NULL, '2026-07-12T00:00:00.000Z');
    `);

    migrateSchema(sqlite);
    const columns = sqlite.prepare("PRAGMA table_info(channel_bindings)").all() as Array<{ name: string; notnull: number }>;
    expect(columns.filter((column) => ["repo_provider", "owner", "repo"].includes(column.name)).every((column) => column.notnull === 0)).toBe(true);
    const repo = createOpenTagRepository(drizzle(sqlite));
    await expect(repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" })).resolves.toMatchObject({
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    });
  });

  it("migrates legacy Linear relay installations before OAuth auth metadata", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE linear_relay_installations (
        id TEXT PRIMARY KEY,
        webhook_path TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        token TEXT NOT NULL,
        graphql_url TEXT,
        repo_provider TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        team_id TEXT,
        team_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    expect(() => migrateSchema(sqlite)).not.toThrow();
    const relayColumns = sqlite.prepare("PRAGMA table_info(linear_relay_installations)").all() as { name: string }[];
    expect(relayColumns.map((column) => column.name)).toContain("auth_json");
    expect(relayColumns.map((column) => column.name)).toContain("organization_id");
    const relayIndexes = sqlite.prepare("PRAGMA index_list(linear_relay_installations)").all() as { name: string }[];
    expect(relayIndexes.map((index) => index.name)).toContain("linear_relay_installations_organization_idx");
    const oauthStateColumns = sqlite.prepare("PRAGMA table_info(linear_oauth_install_states)").all() as { name: string }[];
    expect(oauthStateColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["state", "installation_id", "webhook_secret", "redirect_uri", "scopes_json", "expires_at"])
    );
  });

  it("stores Linear relay OAuth auth and install state", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await expect(
      repo.upsertLinearRelayInstallation({
        id: "install_123",
        webhookPath: "/linear/webhooks/install_123",
        webhookSecret: "linear_webhook_secret",
        token: "linear_access_token",
        auth: {
          method: "oauth_app",
          actor: "app",
          clientId: "linear_client",
          refreshToken: "linear_refresh_token",
          accessTokenExpiresAt: "2026-07-07T01:00:00.000Z",
          scopes: ["read", "write", "comments:create"]
        },
        graphqlUrl: "https://linear.example/graphql",
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        organizationId: "org_linear_1",
        teamKey: "ENG"
      })
    ).resolves.toMatchObject({
      id: "install_123",
      auth: {
        method: "oauth_app",
        actor: "app",
        clientId: "linear_client",
        refreshToken: "linear_refresh_token",
        scopes: ["read", "write", "comments:create"]
      },
      graphqlUrl: "https://linear.example/graphql",
      organizationId: "org_linear_1",
      teamKey: "ENG"
    });

    await expect(repo.getLinearRelayInstallationByWebhookPath({ webhookPath: "/linear/webhooks/install_123" })).resolves.toMatchObject({
      id: "install_123",
      token: "linear_access_token",
      auth: {
        method: "oauth_app",
        refreshToken: "linear_refresh_token"
      }
    });
    await expect(repo.getLinearRelayInstallationByOrganizationId({ organizationId: "org_linear_1" })).resolves.toMatchObject({
      id: "install_123",
      token: "linear_access_token"
    });

    await expect(repo.deleteLinearRelayInstallation({ id: "install_123" })).resolves.toBe(true);
    await expect(repo.getLinearRelayInstallationByOrganizationId({ organizationId: "org_linear_1" })).resolves.toBeNull();
    await expect(repo.deleteLinearRelayInstallation({ id: "install_123" })).resolves.toBe(false);

    await repo.createLinearOAuthInstallState({
      state: "linear_state",
      installationId: "install_456",
      webhookPath: "/linear/webhooks/install_456",
      webhookSecret: "linear_webhook_secret_456",
      redirectUri: "https://relay.example/linear/oauth/callback",
      graphqlUrl: "https://linear.example/graphql",
      repoProvider: "github",
      owner: "acme",
      repo: "demo",
      teamId: "team_eng",
      scopes: ["read", "comments:create"],
      expiresAt: "2026-07-07T00:10:00.000Z"
    });

    await expect(repo.getLinearOAuthInstallState({ state: "linear_state" })).resolves.toMatchObject({
      state: "linear_state",
      installationId: "install_456",
      webhookPath: "/linear/webhooks/install_456",
      redirectUri: "https://relay.example/linear/oauth/callback",
      scopes: ["read", "comments:create"],
      teamId: "team_eng"
    });

    await repo.completeLinearOAuthInstallState({ state: "linear_state", completedAt: "2026-07-07T00:01:00.000Z" });
    await expect(repo.getLinearOAuthInstallState({ state: "linear_state" })).resolves.toMatchObject({
      completedAt: "2026-07-07T00:01:00.000Z"
    });
  });

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
        context: githubIssueContext(1),
        workItem: githubIssueWorkItem(1),
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo", issueNumber: 1 }
      }
    });

    const claimed = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    expect(claimed?.run.id).toBe("run_1");
    expect(claimed?.run.status).toBe("assigned");
    expect(claimed?.run.thread?.workItemReference).toMatchObject({ provider: "github", kind: "issue", externalId: "acme/demo#1" });
    expect(claimed?.run.contextPacket?.summary).toBe("fix this");
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

  it("cancels a queued run and prevents late successful completion from overriding it", async () => {
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
      id: "run_cancel",
      event: {
        id: "evt_cancel",
        source: "github",
        sourceEventId: "comment_cancel",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: githubIssueContext(1),
        workItem: githubIssueWorkItem(1),
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      }
    });

    await expect(repo.cancelRun({ runId: "run_cancel", requestedBy: "lark:ou_sender" })).resolves.toMatchObject({
      outcome: "cancelled",
      run: {
        id: "run_cancel",
        status: "cancelled",
        result: { conclusion: "cancelled" }
      }
    });
    await expect(
      repo.completeRun({
        runId: "run_cancel",
        result: { conclusion: "success", summary: "late success" }
      })
    ).resolves.toBe("not_found");
    await expect(repo.getRun({ runId: "run_cancel" })).resolves.toMatchObject({
      run: {
        status: "cancelled",
        result: { conclusion: "cancelled" }
      }
    });
    const events = await repo.listRunEvents({ runId: "run_cancel" });
    expect(events.map((event) => event.type)).toContain("run.cancel_requested");
    expect(events.find((event) => event.type === "run.cancel_requested")?.payload).toMatchObject({
      terminalReason: "cancelled_by_user",
      terminalSemantics: "A human stop request is not a successful completion and does not auto-promote queued follow-ups.",
      requestedBy: "lark:ou_sender"
    });
  });

  it("records timed_out as a terminal run status and prevents late success from overriding it", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRun({
      id: "run_timeout",
      event: {
        id: "evt_timeout",
        source: "github",
        sourceEventId: "comment_timeout",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: githubIssueContext(1),
        workItem: githubIssueWorkItem(1),
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      }
    });
    await repo.markRunning({ runId: "run_timeout", executor: "echo" });

    await expect(
      repo.completeRun({
        runId: "run_timeout",
        result: {
          conclusion: "timed_out",
          summary: "Echo exceeded the configured hard timeout of 5ms."
        }
      })
    ).resolves.toBe("completed");
    await expect(
      repo.completeRun({
        runId: "run_timeout",
        result: { conclusion: "success", summary: "late success" }
      })
    ).resolves.toBe("not_found");
    await expect(repo.getRun({ runId: "run_timeout" })).resolves.toMatchObject({
      run: {
        status: "timed_out",
        result: { conclusion: "timed_out" }
      }
    });
  });

  it("records interrupted as a terminal run status and prevents late success from overriding it", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRun({
      id: "run_interrupted",
      event: {
        id: "evt_interrupted",
        source: "github",
        sourceEventId: "comment_interrupted",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: githubIssueContext(1),
        workItem: githubIssueWorkItem(1),
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      }
    });
    await repo.markRunning({ runId: "run_interrupted", executor: "external-agent" });

    await expect(
      repo.completeRun({
        runId: "run_interrupted",
        result: {
          conclusion: "interrupted",
          summary: "External agent session ended before finalization."
        }
      })
    ).resolves.toBe("completed");
    await expect(
      repo.completeRun({
        runId: "run_interrupted",
        result: { conclusion: "success", summary: "late success" }
      })
    ).resolves.toBe("not_found");
    await expect(repo.getRun({ runId: "run_interrupted" })).resolves.toMatchObject({
      run: {
        status: "interrupted",
        result: { conclusion: "interrupted" }
      }
    });
  });

  it("finds a cancelable run by source container and Project Target", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRun({
      id: "run_lark_active",
      event: larkEvent({ id: "evt_lark_active", sourceEventId: "msg_lark_active" })
    });
    await repo.markRunning({ runId: "run_lark_active", executor: "echo" });

    await expect(
      repo.findCancelableRunForSourceContainer({
        source: "lark",
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        metadata: { tenantKey: "tenant_1", chatId: "oc_chat" }
      })
    ).resolves.toMatchObject({
      run: { id: "run_lark_active", status: "running" }
    });
    await expect(
      repo.findCancelableRunForSourceContainer({
        source: "lark",
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        metadata: { tenantKey: "tenant_1", chatId: "other_chat" }
      })
    ).resolves.toBeNull();
  });

  it("keeps same-name local Project Targets distinct by local path identity", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);
    const firstProject = projectTargetRefFromLocalPath("/Users/test/work/app");
    const secondProject = projectTargetRefFromLocalPath("/Users/test/archive/app");

    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.registerRunner({ runnerId: "runner_2", name: "Runner Two" });
    await repo.createRepoBinding({
      ...firstProject,
      runnerId: "runner_1",
      workspacePath: "/Users/test/work/app",
      defaultExecutor: "echo"
    });
    await repo.createRepoBinding({
      ...secondProject,
      runnerId: "runner_2",
      workspacePath: "/Users/test/archive/app",
      defaultExecutor: "echo"
    });

    await repo.createRun({
      id: "run_first_local",
      event: {
        id: "evt_first_local",
        source: "lark",
        sourceEventId: "message_first_local",
        receivedAt: "2026-06-26T00:00:00.000Z",
        actor: { provider: "lark", providerUserId: "ou_user" },
        target: { mention: "@app", agentId: "opentag" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [],
        permissions: [{ scope: "runner:local", reason: "execute locally" }],
        callback: { provider: "lark", uri: "lark://im/v1/messages", threadKey: "tk|oc|om_1" },
        metadata: { repoProvider: firstProject.provider, owner: firstProject.owner, repo: firstProject.repo }
      }
    });
    await repo.createRun({
      id: "run_second_local",
      event: {
        id: "evt_second_local",
        source: "lark",
        sourceEventId: "message_second_local",
        receivedAt: "2026-06-26T00:00:00.000Z",
        actor: { provider: "lark", providerUserId: "ou_user" },
        target: { mention: "@app", agentId: "opentag" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [],
        permissions: [{ scope: "runner:local", reason: "execute locally" }],
        callback: { provider: "lark", uri: "lark://im/v1/messages", threadKey: "tk|oc|om_2" },
        metadata: { repoProvider: secondProject.provider, owner: secondProject.owner, repo: secondProject.repo }
      }
    });

    await expect(repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 })).resolves.toMatchObject({
      run: { id: "run_first_local" }
    });
    await expect(repo.claimNextRun({ runnerId: "runner_2", leaseSeconds: 60 })).resolves.toMatchObject({
      run: { id: "run_second_local" }
    });
    await expect(repo.getRepoBinding(firstProject)).resolves.toMatchObject({
      workspacePath: "/Users/test/work/app"
    });
    await expect(repo.getRepoBinding(secondProject)).resolves.toMatchObject({
      workspacePath: "/Users/test/archive/app"
    });
  });

  it("records runner heartbeats for claimed runs", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await expect(repo.getRunner({ runnerId: "runner_1" })).resolves.toMatchObject({
      runnerId: "runner_1",
      heartbeatAt: expect.any(String)
    });
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
    const claimed = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    await expect(repo.getRunner({ runnerId: "runner_1" })).resolves.toMatchObject({
      runnerId: "runner_1",
      heartbeatAt: expect.any(String)
    });

    await expect(
      repo.heartbeat({
        runId: "run_heartbeat",
        runnerId: "runner_1",
        attemptId: claimed!.attemptId,
        fencingToken: claimed!.fencingToken
      })
    ).resolves.toBe("updated");
    await expect(repo.getRunner({ runnerId: "runner_1" })).resolves.toMatchObject({
      runnerId: "runner_1",
      heartbeatAt: expect.any(String)
    });
    const events = await repo.listRunEvents({ runId: "run_heartbeat" });
    expect(events.map((event) => event.type)).toContain("run.heartbeat");
    const heartbeatEvent = events.find((event) => event.type === "run.heartbeat");
    expect(heartbeatEvent?.payload).toMatchObject({ runnerId: "runner_1" });
    expect(heartbeatEvent).toMatchObject({ visibility: "debug", importance: "low" });
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

  it("fences stale attempts after lease recovery", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" });
    await repo.createRun({ id: "run_fenced", event: larkEvent({ id: "evt_fenced", sourceEventId: "message_fenced" }) });

    const first = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 0 });
    expect(first).toMatchObject({ attemptId: expect.any(String), fencingToken: expect.any(String), attemptNumber: 1 });

    const second = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    expect(second).toMatchObject({ attemptId: expect.any(String), fencingToken: expect.any(String), attemptNumber: 2 });
    expect(second?.attemptId).not.toBe(first?.attemptId);
    expect(second?.fencingToken).not.toBe(first?.fencingToken);

    const staleLease = {
      runId: "run_fenced",
      runnerId: "runner_1",
      attemptId: first!.attemptId,
      fencingToken: first!.fencingToken
    };
    await expect(repo.heartbeat(staleLease)).resolves.toBe("stale_attempt");
    await expect(repo.recordProgress({ ...staleLease, message: "late progress" })).resolves.toBe("stale_attempt");
    await expect(
      repo.completeRun({ ...staleLease, result: { conclusion: "success", summary: "late completion" } })
    ).resolves.toBe("stale_attempt");

    const activeLease = {
      runId: "run_fenced",
      runnerId: "runner_1",
      attemptId: second!.attemptId,
      fencingToken: second!.fencingToken
    };
    await expect(repo.heartbeat(activeLease)).resolves.toBe("updated");
    await expect(repo.markRunning({
      ...activeLease,
      executor: first!.fencingToken,
      executorCapability: { nested: { historicalFence: first!.fencingToken } },
      idempotencyKey: first!.fencingToken
    })).resolves.toBe("running");
    await expect(repo.recordProgress({
      ...activeLease,
      message: `current progress ${first!.fencingToken}`,
      type: first!.fencingToken,
      idempotencyKey: first!.fencingToken
    })).resolves.toMatchObject({ outcome: "recorded", event: { type: "run.progress" } });
    await expect(
      repo.completeRun({
        ...activeLease,
        result: {
          conclusion: "success",
          summary: `current completion ${first!.fencingToken}`,
          artifacts: [{ title: "result", uri: "workspace/result.md", metadata: { historicalFence: first!.fencingToken } }],
          verification: [{ command: "verify", outcome: "passed", excerpt: first!.fencingToken }]
        },
        idempotencyKey: first!.fencingToken
      })
    ).resolves.toBe("completed");

    const storedRun = await repo.getRun({ runId: "run_fenced" });
    const storedAttempts = await repo.listAttempts({ runId: "run_fenced" });
    expect(storedAttempts).toMatchObject([
      { id: first!.attemptId, number: 1, status: "interrupted" },
      { id: second!.attemptId, number: 2, status: "succeeded" }
    ]);
    const events = await repo.listRunEvents({ runId: "run_fenced" });
    expect(events.filter((event) => event.type === "run.progress")).toHaveLength(1);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    const durable = JSON.stringify({ storedRun, storedAttempts, events });
    expect(durable).not.toContain(first!.fencingToken);
    expect(durable).not.toContain(second!.fencingToken);
  });

  it("sanitizes runner output and callback payloads before any durable write", async () => {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);
    await repo.registerRunner({ runnerId: "runner_safe", name: "Safe Runner" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_safe" });
    await repo.createRun({ id: "run_safe_output", event: larkEvent({ id: "evt_safe_output", sourceEventId: "msg_safe_output" }) });
    const claimed = await repo.claimNextRun({ runnerId: "runner_safe", leaseSeconds: 60 });
    if (!claimed) throw new Error("expected claimed run");
    const lease = {
      runId: "run_safe_output",
      runnerId: "runner_safe",
      attemptId: claimed.attemptId,
      fencingToken: claimed.fencingToken
    };
    const providerToken = "xoxb\x2d1234567890-abcdefghijklmnopqrstuvwxyz";

    await expect(
      repo.markRunning({
        ...lease,
        executor: claimed.fencingToken,
        executorCapability: { nested: { credential: "opaque-executor-secret", fence: claimed.fencingToken } },
        idempotencyKey: claimed.fencingToken
      })
    ).resolves.toBe("running");
    await expect(
      repo.recordProgress({
        ...lease,
        message: `using ${providerToken} and ${claimed.fencingToken}`,
        type: claimed.fencingToken,
        idempotencyKey: claimed.fencingToken
      })
    ).resolves.toMatchObject({ outcome: "recorded", event: { message: "using [redacted] and [redacted]" } });
    const providerFailure = `provider failed ${claimed.fencingToken} Bearer ${providerToken} -----BEGIN PRIVATE KEY----- secret`;
    await repo.appendRunEvent({
      runId: "run_safe_output",
      type: "source_receipt.failed",
      payload: { provider: "lark", error: providerFailure },
      message: providerFailure
    });
    await repo.appendRunEvent({
      runId: "run_safe_output",
      type: "callback.progress.failed",
      payload: { provider: "lark", reason: "delayed_status_card", error: providerFailure },
      message: providerFailure
    });
    await expect(
      repo.completeRun({
        ...lease,
        result: {
          conclusion: "success",
          summary: `done with ${providerToken}`,
          artifacts: [
            {
              title: "credential report",
              uri: "workspace/report.md",
              metadata: { accessToken: "opaque-secret" }
            }
          ],
          verification: [{ command: "check", outcome: "passed", excerpt: `fence=${claimed.fencingToken}` }]
        },
        idempotencyKey: claimed.fencingToken
      })
    ).resolves.toBe("completed");
    await repo.enqueueCallbackDelivery({
      runId: "run_safe_output",
      kind: "final",
      provider: "slack",
      uri: "https://example.test/callback",
      body: `callback ${providerToken}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `Bearer ${providerToken}` } }],
      rich: { accessToken: "opaque-callback-secret" }
    });

    const durable = {
      stored: await repo.getRun({ runId: "run_safe_output" }),
      events: await repo.listRunEvents({ runId: "run_safe_output" }),
      callbacks: await repo.claimPendingCallbackDeliveries({ limit: 10 })
    };
    const serialized = JSON.stringify(durable);
    expect(serialized).not.toContain(providerToken);
    expect(serialized).not.toContain(claimed.fencingToken);
    expect(serialized).not.toContain("opaque-secret");
    expect(serialized).not.toContain("opaque-executor-secret");
    expect(serialized).not.toContain("opaque-callback-secret");
    expect(serialized).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(serialized).toContain("[redacted]");
  });

  it("rolls back run assignment and attempt creation when the claimed event cannot be persisted", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" });
    await repo.createRun({ id: "run_claim_atomic", event: larkEvent({ id: "evt_claim_atomic", sourceEventId: "message_claim_atomic" }) });
    sqlite.exec(`
      CREATE TEMP TRIGGER fail_run_claimed
      BEFORE INSERT ON run_events
      WHEN NEW.type = 'run.claimed'
      BEGIN
        SELECT RAISE(ABORT, 'injected run.claimed failure');
      END;
    `);

    await expect(repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 })).rejects.toThrow("injected run.claimed failure");
    await expect(repo.getRun({ runId: "run_claim_atomic" })).resolves.toMatchObject({ run: { status: "queued" } });
    await expect(repo.listAttempts({ runId: "run_claim_atomic" })).resolves.toEqual([]);
    expect((await repo.listRunEvents({ runId: "run_claim_atomic" })).filter((event) => event.type === "run.claimed")).toHaveLength(0);

    sqlite.exec("DROP TRIGGER fail_run_claimed");
    await expect(repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 })).resolves.toMatchObject({
      run: { id: "run_claim_atomic", status: "assigned" },
      attemptNumber: 1
    });
  });

  it("rolls back terminal state and completion materialization when an event insert aborts", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" });
    await repo.createRun({ id: "run_complete_atomic", event: larkEvent({ id: "evt_complete_atomic", sourceEventId: "message_complete_atomic" }) });
    const claimed = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    const completion = {
      runId: "run_complete_atomic",
      runnerId: "runner_1",
      attemptId: claimed!.attemptId,
      fencingToken: claimed!.fencingToken,
      result: {
        conclusion: "success" as const,
        summary: "Prepared an atomic proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_complete_atomic",
            createdAt: "2026-07-12T00:00:00.000Z",
            summary: "Add the bug label.",
            intents: [
              {
                intentId: "intent_complete_atomic",
                domain: "labels",
                action: "add_label",
                summary: "Add the bug label.",
                params: { label: "bug" }
              }
            ]
          }
        ]
      }
    };
    sqlite.exec(`
      CREATE TEMP TRIGGER fail_completion_materialization
      BEFORE INSERT ON run_events
      WHEN NEW.type = 'proposal.snapshot.created'
      BEGIN
        SELECT RAISE(ABORT, 'injected completion materialization failure');
      END;
    `);

    await expect(repo.completeRun(completion)).rejects.toThrow("injected completion materialization failure");
    await expect(repo.getRun({ runId: "run_complete_atomic" })).resolves.toMatchObject({ run: { status: "assigned" } });
    await expect(repo.listAttempts({ runId: "run_complete_atomic" })).resolves.toMatchObject([
      { id: claimed!.attemptId, status: "assigned" }
    ]);
    await expect(repo.getSuggestedChanges({ proposalId: "proposal_complete_atomic" })).resolves.toBeNull();
    expect(
      (await repo.listRunEvents({ runId: "run_complete_atomic" })).filter((event) =>
        ["proposal.snapshot.created", "artifact.created", "run.completed", "success_metric.observed"].includes(event.type)
      )
    ).toHaveLength(0);

    sqlite.exec("DROP TRIGGER fail_completion_materialization");
    await expect(repo.completeRun(completion)).resolves.toBe("completed");
    await expect(repo.getSuggestedChanges({ proposalId: "proposal_complete_atomic" })).resolves.toMatchObject({
      runId: "run_complete_atomic"
    });
  });

  it("treats duplicate completion from the same active attempt as idempotent", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" });
    await repo.createRun({ id: "run_attempt_replay", event: larkEvent({ id: "evt_attempt_replay", sourceEventId: "message_attempt_replay" }) });
    const claimed = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    const lease = {
      runId: "run_attempt_replay",
      runnerId: "runner_1",
      attemptId: claimed!.attemptId,
      fencingToken: claimed!.fencingToken,
      result: { conclusion: "success" as const, summary: "done once" }
    };

    await expect(repo.completeRun(lease)).resolves.toBe("completed");
    await expect(repo.completeRun(lease)).resolves.toBe("duplicate");
    await expect(repo.listRunEvents({ runId: "run_attempt_replay" })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "run.completed", message: "done once" })])
    );
    const events = await repo.listRunEvents({ runId: "run_attempt_replay" });
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
  });

  it("stores generic channel to repo bindings", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.upsertChannelBinding({
      provider: "telegram",
      accountId: "bot_123",
      conversationId: "chat_456",
      repoProvider: "github",
      owner: "acme",
      repo: "demo",
      metadata: { title: "Ops chat" }
    });

    await expect(repo.getChannelBinding({ provider: "telegram", accountId: "bot_123", conversationId: "chat_456" })).resolves.toEqual({
      provider: "telegram",
      accountId: "bot_123",
      conversationId: "chat_456",
      repoProvider: "github",
      owner: "acme",
      repo: "demo",
      metadata: { title: "Ops chat" }
    });
  });

  it("deletes generic channel bindings without touching repo bindings", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRepoBinding({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1"
    });
    await repo.upsertChannelBinding({
      provider: "lark",
      accountId: "tenant_1",
      conversationId: "oc_chat",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    });

    await expect(
      repo.deleteChannelBinding({ provider: "lark", accountId: "tenant_1", conversationId: "oc_chat" })
    ).resolves.toBe(true);
    await expect(
      repo.getChannelBinding({ provider: "lark", accountId: "tenant_1", conversationId: "oc_chat" })
    ).resolves.toBeNull();
    await expect(repo.getRepoBinding({ provider: "github", owner: "acme", repo: "demo" })).resolves.toMatchObject({
      runnerId: "runner_1"
    });
    await expect(
      repo.deleteChannelBinding({ provider: "lark", accountId: "tenant_1", conversationId: "oc_chat" })
    ).resolves.toBe(false);
  });

  it.each([
    ["invalid JSON", "{bad-json"],
    ["JSON null", "null"],
    ["an array", "[]"],
    ["a string primitive", "\"legacy\""],
    ["a number primitive", "42"]
  ])("fails closed when channel binding metadata is %s", async (_label, metadataJson) => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    sqlite.prepare(`
      INSERT INTO channel_bindings (
        provider, account_id, conversation_id, repo_provider, owner, repo, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("telegram", "bot_123", "chat_456", "github", "acme", "demo", metadataJson, "2026-06-25T00:00:00.000Z");

    await expect(
      repo.getChannelBinding({ provider: "telegram", accountId: "bot_123", conversationId: "chat_456" })
    ).rejects.toBeInstanceOf(ChannelBindingCorruptionError);
  });

  it.each([
    ["management", { management: "managed" }],
    ["ownership", { ownership: { mode: "managed", exclusive: true, applicationId: "A123" } }],
    ["metadata", { metadata: { title: "reserved envelope" } }],
    ["a deleted discriminator", { management: "managed", metadata: {}, ownership: { mode: "managed", exclusive: true, applicationId: "A123" } }]
  ])("rejects a versionless channel binding object containing reserved v2 field %s", async (_label, stored) => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(drizzle(sqlite));
    sqlite.prepare(`
      INSERT INTO channel_bindings (
        provider, account_id, conversation_id, repo_provider, owner, repo, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("slack", "T123", "C456", "github", "acme", "demo", JSON.stringify(stored), "2026-06-25T00:00:00.000Z");

    await expect(
      repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" })
    ).rejects.toBeInstanceOf(ChannelBindingCorruptionError);
  });

  it("stores Slack channel bindings through the generic channel binding table", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createSlackChannelBinding({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "gitlab",
      owner: "acme",
      repo: "demo"
    });

    await expect(repo.getSlackChannelBinding({ teamId: "T123", channelId: "C123" })).resolves.toEqual({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "gitlab",
      owner: "acme",
      repo: "demo"
    });
    await expect(repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C123" })).resolves.toEqual({
      provider: "slack",
      accountId: "T123",
      conversationId: "C123",
      repoProvider: "gitlab",
      owner: "acme",
      repo: "demo"
    });
  });

  it("preserves generic metadata when Slack compatibility upserts the same binding", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.upsertChannelBinding({
      provider: "slack",
      accountId: "T123",
      conversationId: "C123",
      repoProvider: "github",
      owner: "acme",
      repo: "demo",
      metadata: { source: "seed", labels: ["triage"] }
    });

    await repo.createSlackChannelBinding({
      teamId: "T123",
      channelId: "C123",
      repoProvider: "gitlab",
      owner: "acme",
      repo: "demo"
    });

    await expect(repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C123" })).resolves.toEqual({
      provider: "slack",
      accountId: "T123",
      conversationId: "C123",
      repoProvider: "gitlab",
      owner: "acme",
      repo: "demo",
      metadata: { source: "seed", labels: ["triage"] }
    });
  });

  it("claims pending callback deliveries only once", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.enqueueCallbackDelivery({
      runId: "run_delivery",
      kind: "acknowledgement",
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      body: "hello"
    });

    const first = await repo.claimPendingCallbackDeliveries({ limit: 10 });
    const second = await repo.claimPendingCallbackDeliveries({ limit: 10 });

    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe("delivering");
    expect(second).toEqual([]);
  });

  it("deduplicates equivalent callback deliveries before sending", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    const first = await repo.enqueueCallbackDelivery({
      runId: "run_callback_dedupe",
      kind: "final",
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: "tenant|chat|message",
      statusMessageKey: "run_callback_dedupe:final",
      body: "Done.",
      rich: { provider: "lark", payload: { header: { title: "Done" } } }
    });
    const second = await repo.enqueueCallbackDelivery({
      runId: "run_callback_dedupe",
      kind: "final",
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: "tenant|chat|message",
      statusMessageKey: "run_callback_dedupe:final",
      body: "Done.",
      rich: { provider: "lark", payload: { header: { title: "Done" } } }
    });

    expect(second.id).toBe(first.id);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    const pending = await repo.claimPendingCallbackDeliveries({ limit: 10 });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.rich).toEqual({ provider: "lark", payload: { header: { title: "Done" } } });
    const events = await repo.listRunEvents({ runId: "run_callback_dedupe" });
    expect(events.map((event) => event.type)).toEqual(["callback.final.queued", "callback.final.duplicate"]);
    expect(events.at(-1)?.message).toBe("Duplicate callback delivery suppressed.");
  });

  it("records external callback message ids for status updates", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    const delivery = await repo.enqueueCallbackDelivery({
      runId: "run_callback_external_id",
      kind: "acknowledgement",
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: "tenant|chat|message",
      statusMessageKey: "run_callback_external_id:status",
      body: "Received."
    });
    await repo.markCallbackDelivered({ deliveryId: delivery.id, externalMessageId: "om_status" });

    await expect(
      repo.findCallbackExternalMessageId({
        runId: "run_callback_external_id",
        provider: "lark",
        threadKey: "tenant|chat|message",
        statusMessageKey: "run_callback_external_id:status"
      })
    ).resolves.toBe("om_status");

    const events = await repo.listRunEvents({ runId: "run_callback_external_id" });
    expect(events.at(-1)).toMatchObject({
      type: "callback.acknowledgement.delivered",
      payload: expect.objectContaining({
        externalMessageId: "om_status"
      })
    });
  });

  it("reclaims stale delivering rows and respects retry backoff for failed deliveries", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.enqueueCallbackDelivery({
      runId: "run_retry",
      kind: "acknowledgement",
      provider: "github",
      uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
      body: "hello"
    });

    // Claim the delivery so it moves to "delivering".
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const claimed = await repo.claimPendingCallbackDeliveries({ limit: 10, now: t0 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("delivering");

    // Mark it failed with a future nextAttemptAt.
    const deliveryId = claimed[0]!.id;
    const retryAt = "2026-01-01T00:01:00.000Z";
    await repo.markCallbackFailed({ deliveryId, error: "timeout", nextAttemptAt: retryAt });

    // Before retry window: should not be claimed.
    const beforeRetry = new Date("2026-01-01T00:00:30.000Z");
    const tooEarly = await repo.claimPendingCallbackDeliveries({ limit: 10, now: beforeRetry });
    expect(tooEarly).toHaveLength(0);

    // After retry window: should be claimable again.
    const afterRetry = new Date("2026-01-01T00:02:00.000Z");
    const reclaimed = await repo.claimPendingCallbackDeliveries({ limit: 10, now: afterRetry });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.attempts).toBe(1);

    // A still-fresh delivering row should not be reclaimed.
    const freshNow = new Date("2026-01-01T00:02:05.000Z");
    const notStale = await repo.claimPendingCallbackDeliveries({ limit: 10, now: freshNow, staleDeliveryThresholdMs: 60_000 });
    expect(notStale).toHaveLength(0);

    // Once the stale threshold passes, the delivering row should be reclaimed.
    const staleNow = new Date("2026-01-01T00:03:10.000Z");
    const staleReclaimed = await repo.claimPendingCallbackDeliveries({ limit: 10, now: staleNow, staleDeliveryThresholdMs: 60_000 });
    expect(staleReclaimed).toHaveLength(1);
    expect(staleReclaimed[0]?.attempts).toBe(1);
  });

  it("records a callback suppression audit event when the retry budget is exhausted", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.registerRunner({ runnerId: "runner_callback_guard", name: "Callback Guard" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_callback_guard" });
    await repo.createRun({
      id: "run_callback_storm_guard",
      event: larkEvent({ id: "evt_callback_storm_guard", sourceEventId: "msg_callback_storm_guard" })
    });
    const runClaim = await repo.claimNextRun({ runnerId: "runner_callback_guard", leaseSeconds: 60 });
    if (!runClaim) throw new Error("expected callback guard run claim");

    await repo.enqueueCallbackDelivery({
      runId: "run_callback_storm_guard",
      kind: "final",
      provider: "lark",
      uri: "lark://im/v1/messages",
      threadKey: "tenant|chat|message",
      statusMessageKey: "run_callback_storm_guard:final",
      body: "Done."
    });

    const claimed = await repo.claimPendingCallbackDeliveries({ limit: 10, maxAttempts: 1 });
    expect(claimed).toHaveLength(1);
    await repo.markCallbackFailed({
      deliveryId: claimed[0]!.id,
      error: `rate_limited ${runClaim.fencingToken} xoxb\x2d1234567890-abcdefghijklmnopqrstuvwxyz Bearer ghp\x5fabcdefghijklmnopqrstuvwxyz123456 -----BEGIN PRIVATE KEY----- secret`,
      maxAttempts: 1
    });

    await expect(repo.claimPendingCallbackDeliveries({ limit: 10, maxAttempts: 1 })).resolves.toEqual([]);

    const events = await repo.listRunEvents({ runId: "run_callback_storm_guard" });
    expect(events.filter((event) => event.type.startsWith("callback.")).map((event) => event.type)).toEqual([
      "callback.final.queued",
      "callback.final.failed",
      "callback.final.suppressed"
    ]);
    expect(events.at(-1)).toMatchObject({
      visibility: "audit",
      importance: "high",
      message: "Callback delivery retry budget exhausted; further delivery attempts are suppressed to avoid duplicate storms."
    });
    const failedRow = sqlite.prepare("SELECT last_error FROM callback_deliveries WHERE id = ?").get(claimed[0]!.id);
    const failurePersistence = JSON.stringify({ failedRow, events });
    expect(failurePersistence).not.toContain(runClaim.fencingToken);
    expect(failurePersistence).not.toContain("xoxb\x2d1234567890-abcdefghijklmnopqrstuvwxyz");
    expect(failurePersistence).not.toContain("ghp\x5fabcdefghijklmnopqrstuvwxyz123456");
    expect(failurePersistence).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(failurePersistence).toContain("[redacted]");
  });

  it("records control-plane events that are not tied to a run", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.appendControlPlaneEvent({
      type: "security.auth_failed",
      severity: "warn",
      subject: "GET /v1/runners/:runnerId",
      payload: { reason: "invalid_pairing_token", tokenFingerprint: "abc123" },
      createdAt: "2026-06-24T00:00:00.000Z"
    });
    await repo.appendControlPlaneEvent({
      type: "admission.needs_human_decision",
      severity: "info",
      subject: "run_1",
      payload: { reasonCode: "repo_not_bound" },
      createdAt: "2026-06-24T00:00:01.000Z"
    });

    await expect(repo.listControlPlaneEvents()).resolves.toMatchObject([
      {
        type: "security.auth_failed",
        severity: "warn",
        subject: "GET /v1/runners/:runnerId",
        payload: { reason: "invalid_pairing_token", tokenFingerprint: "abc123" }
      },
      {
        type: "admission.needs_human_decision",
        severity: "info",
        subject: "run_1",
        payload: { reasonCode: "repo_not_bound" }
      }
    ]);
    await expect(repo.listControlPlaneEvents({ type: "security.auth_failed" })).resolves.toMatchObject([
      { type: "security.auth_failed", severity: "warn" }
    ]);
    await expect(repo.listControlPlaneEvents({ severity: "info" })).resolves.toMatchObject([
      { type: "admission.needs_human_decision", severity: "info" }
    ]);
  });

  it("summarizes repeated control-plane events into alert candidates", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.appendControlPlaneEvent({
      type: "security.auth_failed",
      severity: "warn",
      subject: "GET /v1/runners/:runnerId",
      payload: { tokenFingerprint: "old" },
      createdAt: "2026-06-23T23:59:59.000Z"
    });
    for (let index = 0; index < 3; index += 1) {
      await repo.appendControlPlaneEvent({
        type: "security.auth_failed",
        severity: "warn",
        subject: "GET /v1/runners/:runnerId",
        payload: { tokenFingerprint: "token_a" },
        createdAt: `2026-06-24T00:00:0${index}.000Z`
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await repo.appendControlPlaneEvent({
        type: "security.request_body_rejected",
        severity: "warn",
        subject: "POST /v1/runs",
        payload: { endpoint: "POST /v1/runs", reason: "request_body_too_large" },
        createdAt: `2026-06-24T00:01:0${index}.000Z`
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await repo.appendControlPlaneEvent({
        type: "security.request_body_rejected",
        severity: "warn",
        subject: "slack:POST /slack/events",
        payload: { provider: "slack", endpoint: "POST /slack/events", reason: "invalid_request_body" },
        createdAt: `2026-06-24T00:01:1${index}.000Z`
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await repo.appendControlPlaneEvent({
        type: "admission.needs_human_decision",
        severity: "warn",
        subject: `run_unbound_${index}`,
        payload: { projectTarget: "github:acme/demo", decision: { reasonCode: "repo_not_bound" } },
        createdAt: `2026-06-24T00:02:0${index}.000Z`
      });
    }
    for (let index = 0; index < 3; index += 1) {
      await repo.appendControlPlaneEvent({
        type: "security.signature_failed",
        severity: "warn",
        subject: "github:POST /github/webhooks",
        payload: { provider: "github", endpoint: "POST /github/webhooks", reason: "invalid_signature" },
        createdAt: `2026-06-24T00:03:0${index}.000Z`
      });
    }
    await repo.appendControlPlaneEvent({
      type: "security.token_misuse",
      severity: "warn",
      subject: "slack:app_token",
      payload: { provider: "slack", tokenKind: "app_token", reason: "token_revoked" },
      createdAt: "2026-06-24T00:04:00.000Z"
    });
    await repo.registerRunner({ runnerId: "runner_1", name: "Local Runner" });
    await repo.createRepoBinding({ provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" });
    for (let index = 0; index < 3; index += 1) {
      await repo.createRun({
        id: `run_claim_${index}`,
        event: larkEvent({
          id: `evt_claim_${index}`,
          sourceEventId: `msg_claim_${index}`
        })
      });
      await expect(repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 })).resolves.toBeTruthy();
    }

    const alerts = await repo.summarizeControlPlaneAlerts({
      since: "2026-06-24T00:00:00.000Z",
      thresholds: { abnormal_runner_claim_rate: 3 }
    });
    expect(alerts).toHaveLength(7);
    expect(alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "repeated_auth_failures",
          eventType: "security.auth_failed",
          count: 3,
          threshold: 3,
          subject: "token_a"
        }),
        expect.objectContaining({
          type: "repeated_large_payload_rejections",
          eventType: "security.request_body_rejected",
          count: 2,
          threshold: 2,
          subject: "POST /v1/runs"
        }),
        expect.objectContaining({
          type: "repeated_invalid_request_body",
          eventType: "security.request_body_rejected",
          count: 2,
          threshold: 2,
          subject: "POST /slack/events"
        }),
        expect.objectContaining({
          type: "repeated_unknown_project_targets",
          eventType: "admission.needs_human_decision",
          count: 2,
          threshold: 2,
          subject: "github:acme/demo"
        }),
        expect.objectContaining({
          type: "repeated_signature_failures",
          eventType: "security.signature_failed",
          count: 3,
          threshold: 3,
          subject: "github:POST /github/webhooks"
        }),
        expect.objectContaining({
          type: "token_misuse",
          eventType: "security.token_misuse",
          count: 1,
          threshold: 1,
          subject: "slack:app_token"
        }),
        expect.objectContaining({
          type: "abnormal_runner_claim_rate",
          eventType: "run.claimed",
          count: 3,
          threshold: 3,
          subject: "runner_1"
        })
      ])
    );
  });

  it("summarizes alert candidates from the most recent event window", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    for (let index = 0; index < 3; index += 1) {
      await repo.appendControlPlaneEvent({
        type: "security.auth_failed",
        severity: "warn",
        subject: "GET /v1/runners/:runnerId",
        payload: { tokenFingerprint: "old_token" },
        createdAt: `2026-06-24T00:00:0${index}.000Z`
      });
    }
    for (let index = 0; index < 3; index += 1) {
      await repo.appendControlPlaneEvent({
        type: "security.auth_failed",
        severity: "warn",
        subject: "GET /v1/runners/:runnerId",
        payload: { tokenFingerprint: "recent_token" },
        createdAt: `2026-06-24T00:01:0${index}.000Z`
      });
    }

    await expect(repo.summarizeControlPlaneAlerts({ limit: 3 })).resolves.toEqual([
      expect.objectContaining({
        type: "repeated_auth_failures",
        count: 3,
        subject: "recent_token",
        firstSeenAt: "2026-06-24T00:01:00.000Z",
        lastSeenAt: "2026-06-24T00:01:02.000Z"
      })
    ]);
  });

  it("replays createRun idempotently for the same source event", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    const githubEvent = {
      id: "evt_duplicate",
      source: "github" as const,
      sourceEventId: "comment_duplicate",
      receivedAt: "2026-06-24T00:00:00.000Z",
      actor: { provider: "github" as const, providerUserId: "42", handle: "octocat" },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "fix this", intent: "fix" as const, args: {} },
      context: [],
      permissions: [{ scope: "issue:comment" as const, reason: "reply to source thread" }],
      callback: { provider: "github" as const, uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
      metadata: { owner: "acme", repo: "demo" }
    };

    const first = await repo.createRun({ id: "run_duplicate_1", event: githubEvent });
    const second = await repo.createRun({ id: "run_duplicate_2", event: githubEvent });

    expect(first.run.id).toBe("run_duplicate_1");
    expect(first.created).toBe(true);
    expect(second.run.id).toBe("run_duplicate_1");
    expect(second.created).toBe(false);

    const events = await repo.listRunEvents({ runId: "run_duplicate_1" });
    expect(events.map((event) => event.type)).toContain("admission.decided");
    expect(events.map((event) => event.type)).toContain("run.create_idempotent_replay");
    expect(events.find((event) => event.type === "run.create_idempotent_replay")?.payload).toMatchObject({
      eventId: "evt_duplicate",
      requestedRunId: "run_duplicate_2",
      provenance: {
        source: "github",
        sourceEventId: "comment_duplicate",
        sourceDeliveryId: null,
        signatureState: "unknown",
        projectTarget: { ref: "github:acme/demo", provider: "github", owner: "acme", repo: "demo" },
        admissionDecision: {
          action: "drop_duplicate",
          reasonCode: "duplicate_source_event",
          eventId: "evt_duplicate",
          activeRunId: "run_duplicate_1"
        },
        expectedRunnerId: null
      }
    });
  });

  it("replays createRun idempotently for the same source delivery id", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    const baseEvent = {
      id: "evt_delivery_1",
      source: "github" as const,
      sourceEventId: "comment_delivery_1",
      receivedAt: "2026-06-24T00:00:00.000Z",
      actor: { provider: "github" as const, providerUserId: "42", handle: "octocat" },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "fix this", intent: "fix" as const, args: {} },
      context: [],
      permissions: [{ scope: "issue:comment" as const, reason: "reply to source thread" }],
      callback: { provider: "github" as const, uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
      metadata: { owner: "acme", repo: "demo", sourceDeliveryId: "delivery_replay_1", webhookSignatureVerified: true }
    };

    const first = await repo.createRun({ id: "run_delivery_1", event: baseEvent });
    const replay = await repo.createRun({
      id: "run_delivery_2",
      event: {
        ...baseEvent,
        id: "evt_delivery_2",
        sourceEventId: "comment_delivery_2"
      }
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe("run_delivery_1");
    expect(replay.replayKind).toBe("source_delivery");
    expect(replay.replayDecision.reasonCode).toBe("duplicate_source_delivery");
    await expect(repo.getRun({ runId: "run_delivery_2" })).resolves.toBeNull();

    const events = await repo.listRunEvents({ runId: "run_delivery_1" });
    expect(events.find((event) => event.type === "run.create_idempotent_replay")?.payload).toMatchObject({
      eventId: "evt_delivery_2",
      requestedRunId: "run_delivery_2",
      replayKey: { kind: "source_delivery", source: "github", deliveryId: "delivery_replay_1" },
      provenance: {
        source: "github",
        sourceEventId: "comment_delivery_2",
        sourceDeliveryId: "delivery_replay_1",
        signatureState: "verified",
        admissionDecision: {
          action: "drop_duplicate",
          reasonCode: "duplicate_source_delivery",
          eventId: "evt_delivery_2",
          activeRunId: "run_delivery_1"
        }
      }
    });
  });

  it("prunes stale source delivery replay keys only after the associated run is terminal", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    const eventWithDelivery = (input: {
      id: string;
      sourceEventId: string;
      deliveryId: string;
    }): Parameters<typeof repo.createRun>[0]["event"] => ({
      id: input.id,
      source: "github",
      sourceEventId: input.sourceEventId,
      receivedAt: "2026-06-24T00:00:00.000Z",
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "fix this", intent: "fix", args: {} },
      context: [],
      permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
      callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
      metadata: {
        owner: "acme",
        repo: "demo",
        sourceDeliveryId: input.deliveryId,
        webhookSignatureVerified: true
      }
    });

    await repo.createRun({
      id: "run_terminal_delivery",
      event: eventWithDelivery({
        id: "evt_terminal_delivery",
        sourceEventId: "comment_terminal_delivery",
        deliveryId: "delivery_terminal"
      })
    });
    await repo.completeRun({
      runId: "run_terminal_delivery",
      result: { conclusion: "success", summary: "done" }
    });

    await repo.createRun({
      id: "run_active_delivery",
      event: eventWithDelivery({
        id: "evt_active_delivery",
        sourceEventId: "comment_active_delivery",
        deliveryId: "delivery_active"
      })
    });
    await repo.createRun({
      id: "run_fresh_delivery",
      event: eventWithDelivery({
        id: "evt_fresh_delivery",
        sourceEventId: "comment_fresh_delivery",
        deliveryId: "delivery_fresh"
      })
    });
    await repo.completeRun({
      runId: "run_fresh_delivery",
      result: { conclusion: "success", summary: "fresh" }
    });

    sqlite
      .prepare("UPDATE source_deliveries SET created_at = ? WHERE delivery_id IN (?, ?)")
      .run("2026-06-24T00:00:00.000Z", "delivery_terminal", "delivery_active");

    await expect(repo.pruneSourceDeliveries({ olderThan: "2026-06-25T00:00:00.000Z" })).resolves.toEqual({
      scanned: 2,
      pruned: 1,
      retainedActive: 1
    });

    await expect(
      repo.createRun({
        id: "run_terminal_delivery_after_prune",
        event: eventWithDelivery({
          id: "evt_terminal_delivery_after_prune",
          sourceEventId: "comment_terminal_delivery_after_prune",
          deliveryId: "delivery_terminal"
        })
      })
    ).resolves.toMatchObject({ created: true, run: { id: "run_terminal_delivery_after_prune" } });

    await expect(
      repo.createRun({
        id: "run_active_delivery_replay",
        event: eventWithDelivery({
          id: "evt_active_delivery_replay",
          sourceEventId: "comment_active_delivery_replay",
          deliveryId: "delivery_active"
        })
      })
    ).resolves.toMatchObject({
      created: false,
      replayKind: "source_delivery",
      run: { id: "run_active_delivery" }
    });
  });

  it("rejects invalid source delivery retention cutoffs", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await expect(repo.pruneSourceDeliveries({ olderThan: "not-a-timestamp", limit: Number.NaN })).rejects.toThrow(
      "olderThan must be a valid timestamp."
    );
  });

  it("deduplicates runner running retries by idempotency key", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRun({
      id: "run_running_replay",
      event: {
        id: "evt_running_replay",
        source: "github",
        sourceEventId: "comment_running_replay",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "run echo", intent: "run", args: {} },
        context: [],
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      }
    });

    await expect(
      repo.markRunning({
        runId: "run_running_replay",
        executor: "echo",
        runTimeoutMs: 30_000,
        idempotencyKey: "runner_1:run_running_replay:running"
      })
    ).resolves.toBe("running");
    await expect(
      repo.markRunning({
        runId: "run_running_replay",
        executor: "codex",
        runTimeoutMs: 60_000,
        idempotencyKey: "runner_1:run_running_replay:running"
      })
    ).resolves.toBe("duplicate");

    await expect(repo.getRun({ runId: "run_running_replay" })).resolves.toMatchObject({
      run: {
        status: "running",
        executor: "echo"
      }
    });
    const events = await repo.listRunEvents({ runId: "run_running_replay" });
    expect(events.filter((event) => event.type === "run.running")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          executor: "echo",
          runTimeoutMs: 30_000,
          idempotencyKey: "runner_1:run_running_replay:running"
        })
      })
    ]);
    expect(JSON.stringify(events)).not.toContain("codex");
    expect(JSON.stringify(events)).not.toContain("60000");
  });

  it("records run provenance on creation for hosted relay auditability", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRepoBinding({
      provider: "github",
      owner: "acme",
      repo: "demo",
      runnerId: "runner_1",
      workspacePath: "/Users/test/demo",
      defaultExecutor: "echo"
    });

    const event = {
      id: "evt_provenance",
      source: "github" as const,
      sourceEventId: "comment_provenance",
      receivedAt: "2026-06-24T00:00:00.000Z",
      actor: { provider: "github" as const, providerUserId: "42", handle: "octocat" },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "fix this", intent: "fix" as const, args: {} },
      context: [],
      permissions: [{ scope: "issue:comment" as const, reason: "reply to source thread" }],
      callback: { provider: "github" as const, uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        sourceDeliveryId: "delivery_123",
        webhookSignatureVerified: true
      }
    };

    await repo.createRun({ id: "run_provenance", event });

    const events = await repo.listRunEvents({ runId: "run_provenance" });
    expect(events.find((runEvent) => runEvent.type === "run.created")?.payload).toMatchObject({
      eventId: "evt_provenance",
      provenance: {
        source: "github",
        sourceEventId: "comment_provenance",
        sourceDeliveryId: "delivery_123",
        signatureState: "verified",
        projectTarget: { ref: "github:acme/demo", provider: "github", owner: "acme", repo: "demo" },
        admissionDecision: {
          action: "start",
          reasonCode: "new_event",
          eventId: "evt_provenance"
        },
        expectedRunnerId: "runner_1"
      }
    });
  });

  it("preserves the generated context packet snapshot even if event derivation changes later", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRun({
      id: "run_snapshot_1",
      event: {
        id: "evt_snapshot_1",
        source: "github",
        sourceEventId: "comment_snapshot_1",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: githubIssueContext(1),
        workItem: githubIssueWorkItem(1),
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      }
    });

    sqlite
      .prepare("UPDATE runs SET event_json = ? WHERE id = ?")
      .run(
        JSON.stringify({
          id: "evt_snapshot_1",
          source: "github",
          sourceEventId: "comment_snapshot_1",
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "github", providerUserId: "42", handle: "octocat" },
          target: { mention: "@opentag", agentId: "opentag" },
          command: { rawText: "this mutated event should not rewrite the packet", intent: "explain", args: {} },
          context: [],
          permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
          callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
          metadata: { owner: "acme", repo: "demo" }
        }),
        "run_snapshot_1"
      );

    const stored = await repo.getRun({ runId: "run_snapshot_1" });
    expect(stored?.run.contextPacket?.summary).toBe("fix this");
    expect(stored?.run.contextPacket?.sourcePointers).toHaveLength(1);
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
    expect(stored?.run.contextPacket?.assembly?.stages).toContain("emit");

    const events = await repo.listRunEvents({ runId: "run_2" });
    expect(events.map((event) => event.type)).toEqual(["admission.decided", "run.created", "context_packet.generated", "run.completed"]);
    expect(events[0]).toMatchObject({ visibility: "audit", importance: "normal" });
    expect(events[1]).toMatchObject({ visibility: "audit", importance: "low" });
    expect(events[2]).toMatchObject({ visibility: "audit", importance: "normal", message: "run echo" });
    expect(events[3]).toMatchObject({ visibility: "audit", importance: "high", message: "done" });
  });

  it("deduplicates completed results by idempotency key", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRun({
      id: "run_completion_replay",
      event: {
        id: "evt_completion_replay",
        source: "github",
        sourceEventId: "comment_completion_replay",
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

    await expect(
      repo.completeRun({
        runId: "run_completion_replay",
        result: { conclusion: "success", summary: "done" },
        idempotencyKey: "runner_1:run_completion_replay:complete:1"
      })
    ).resolves.toBe("completed");
    await expect(
      repo.completeRun({
        runId: "run_completion_replay",
        result: { conclusion: "failure", summary: "retry should not replace result" },
        idempotencyKey: "runner_1:run_completion_replay:complete:1"
      })
    ).resolves.toBe("duplicate");

    await expect(repo.getRun({ runId: "run_completion_replay" })).resolves.toMatchObject({
      run: {
        status: "succeeded",
        result: { conclusion: "success", summary: "done" }
      }
    });
    const events = await repo.listRunEvents({ runId: "run_completion_replay" });
    expect(events.filter((event) => event.type === "run.completed")).toEqual([
      expect.objectContaining({
        message: "done",
        payload: expect.objectContaining({
          idempotencyKey: "runner_1:run_completion_replay:complete:1"
        })
      })
    ]);
    expect(JSON.stringify(events)).not.toContain("retry should not replace result");
  });

  it("does not write completion artifacts for missing runs", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await expect(
      repo.completeRun({
        runId: "missing_run",
        result: {
          conclusion: "needs_human",
          summary: "Proposal ready.",
          suggestedChanges: [
            {
              proposalId: "proposal_missing_run",
              createdAt: "2026-06-24T00:00:01.000Z",
              summary: "Add label.",
              intents: [{ intentId: "intent_label", domain: "labels", action: "add_label", summary: "Add label.", params: { label: "bug" } }]
            }
          ]
        }
      })
    ).rejects.toThrow("Run not found: missing_run");
    await expect(repo.listRunEvents({ runId: "missing_run" })).resolves.toEqual([]);
    await expect(repo.getSuggestedChanges({ proposalId: "proposal_missing_run" })).resolves.toBeNull();
  });

  it("uses supplied progress timestamps as audit event timestamps", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.recordProgress({
      runId: "run_progress_time",
      message: "delayed progress",
      type: "executor.progress",
      at: "2026-06-24T00:00:01.000Z"
    });

    await expect(repo.listRunEvents({ runId: "run_progress_time" })).resolves.toEqual([
      expect.objectContaining({
        createdAt: "2026-06-24T00:00:01.000Z",
        payload: expect.objectContaining({ at: "2026-06-24T00:00:01.000Z" })
      })
    ]);
  });

  it("deduplicates runner progress events by idempotency key", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await expect(
      repo.recordProgress({
        runId: "run_progress_replay",
        message: "external hook progress",
        type: "ingest.hermes.post_llm_call",
        at: "2026-06-24T00:00:01.000Z",
        idempotencyKey: "hermes:run_progress_replay:post_llm_call:1"
      })
    ).resolves.toMatchObject({ outcome: "recorded", event: { message: "external hook progress" } });
    await expect(
      repo.recordProgress({
        runId: "run_progress_replay",
        message: "external hook progress duplicate",
        type: "ingest.hermes.post_llm_call",
        at: "2026-06-24T00:00:02.000Z",
        idempotencyKey: "hermes:run_progress_replay:post_llm_call:1"
      })
    ).resolves.toMatchObject({ outcome: "duplicate", event: { message: "external hook progress" } });

    await expect(repo.listRunEvents({ runId: "run_progress_replay" })).resolves.toEqual([
      expect.objectContaining({
        type: "run.progress",
        message: "external hook progress",
        payload: expect.objectContaining({
          idempotencyKey: "hermes:run_progress_replay:post_llm_call:1"
        })
      })
    ]);
  });

  it("stores needs_human results as needs_approval", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRun({
      id: "run_needs_human",
      event: {
        id: "evt_needs_human",
        source: "github",
        sourceEventId: "comment_needs_human",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "propose labels", intent: "run", args: {} },
        context: [],
        permissions: [{ scope: "issue:comment", reason: "reply to source thread" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo", issueNumber: 1 }
      }
    });

    await repo.completeRun({
      runId: "run_needs_human",
      result: {
        conclusion: "needs_human",
        summary: "Proposal ready.",
        suggestedChanges: [
          {
            proposalId: "proposal_needs_human",
            createdAt: "2026-06-24T00:00:01.000Z",
            summary: "Add label.",
            intents: [{ intentId: "intent_label", domain: "labels", action: "add_label", summary: "Add label.", params: { label: "bug" } }]
          }
        ]
      }
    });

    await expect(repo.getRun({ runId: "run_needs_human" })).resolves.toMatchObject({
      run: { status: "needs_approval", result: { conclusion: "needs_human" } }
    });
  });

  it("persists proposals, approvals, apply plans, and metric events", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.createRun({
      id: "run_protocol",
      event: {
        id: "evt_protocol",
        source: "github",
        sourceEventId: "comment_protocol",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "label this bug", intent: "run", args: {} },
        context: githubIssueContext(2),
        workItem: githubIssueWorkItem(2),
        permissions: [
          { scope: "issue:comment", reason: "reply to source thread" },
          { scope: "repo:write", reason: "mutate issue labels after approval" }
        ],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/2/comments" },
        metadata: { owner: "acme", repo: "demo", issueNumber: 2 }
      }
    });

    await repo.completeRun({
      runId: "run_protocol",
      result: {
        conclusion: "needs_human",
        summary: "Prepared label proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_protocol",
            createdAt: "2026-06-24T00:00:01.000Z",
            sourceRunId: "run_protocol",
            summary: "Add bug label.",
            intents: [
              {
                intentId: "intent_label_bug",
                domain: "labels",
                action: "add_label",
                summary: "Add the bug label.",
                params: { label: "bug" }
              },
              {
                intentId: "intent_status_ready",
                domain: "status",
                action: "set_status",
                summary: "Set status to ready.",
                params: { status: "ready" }
              }
            ]
          }
        ]
      }
    });

    const storedProposal = await repo.getSuggestedChanges({ proposalId: "proposal_protocol" });
    expect(storedProposal?.snapshot.intents[0]?.intentId).toBe("intent_label_bug");

    const decision = await repo.recordApprovalDecision({
      id: "approval_protocol",
      proposalId: "proposal_protocol",
      approvedIntentIds: ["intent_label_bug"],
      approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
      approvedAt: "2026-06-24T00:00:02.000Z",
      scope: "manual"
    });
    expect(decision?.approvedIntentIds).toEqual(["intent_label_bug"]);
    const secondDecision = await repo.recordApprovalDecision({
      id: "approval_protocol_status",
      proposalId: "proposal_protocol",
      approvedIntentIds: ["intent_status_ready"],
      approvedBy: { provider: "github", providerUserId: "43", handle: "reviewer" },
      approvedAt: "2026-06-24T00:00:02.500Z",
      scope: "manual"
    });
    expect(secondDecision?.approvedIntentIds).toEqual(["intent_status_ready"]);

    const planResult = await repo.createApplyPlanOnce({
      id: "apply_protocol",
      proposalId: "proposal_protocol",
      approvalDecisionId: "approval_protocol",
      adapter: "github"
    });
    expect(planResult?.created).toBe(true);
    const plan = planResult?.plan;
    expect(plan).toMatchObject({
      id: "apply_protocol",
      proposalId: "proposal_protocol",
      mode: "preflight_then_per_intent",
      outcomes: [{ intentId: "intent_label_bug", outcome: "skipped" }]
    });
    expect(plan?.outcomes?.[0]?.message).toContain("adapter execution is not implemented");

    await expect(repo.getApprovalDecision({ id: "approval_protocol" })).resolves.toMatchObject({ id: "approval_protocol" });
    await expect(repo.getApprovalDecision({ id: "approval_protocol_status" })).resolves.toMatchObject({ id: "approval_protocol_status" });
    await expect(repo.getApplyPlan({ id: "apply_protocol" })).resolves.toMatchObject({ id: "apply_protocol" });
    await expect(
      repo.createApplyPlanOnce({
        id: "apply_protocol",
        proposalId: "proposal_protocol",
        approvalDecisionId: "approval_protocol",
        adapter: "github"
      })
    ).resolves.toMatchObject({
      created: false,
      plan: { id: "apply_protocol" }
    });

    const events = await repo.listRunEvents({ runId: "run_protocol" });
    expect(events.map((event) => event.type)).toContain("proposal.snapshot.created");
    expect(events.map((event) => event.type)).toContain("approval.decision.recorded");
    expect(events.map((event) => event.type)).toContain("apply_plan.created");
    expect(events.filter((event) => event.type === "apply_plan.created")).toHaveLength(1);
    expect(events.filter((event) => event.type === "success_metric.observed").map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "time_to_first_useful_artifact" }),
        expect.objectContaining({ metric: "external_write_approval_rate" })
      ])
    );

    const metrics = await repo.getRunMetrics({ runId: "run_protocol" });
    expect(metrics).toMatchObject({
      runId: "run_protocol",
      humanCallbackCount: 0,
      suggestedChangesCount: 2,
      approvalDecisionCount: 2,
      applyPlanCount: 1,
      childRunCount: 0,
      applyOutcomeCounts: {
        applied: 0,
        skipped: 1,
        failed: 0,
        stale: 0,
        unsupported: 0
      },
      staleIntentCount: 0
    });
    await expect(repo.getRepoMetrics({ provider: "github", owner: "acme", repo: "demo" })).resolves.toMatchObject({
      scope: "repo",
      scopeId: "github:acme/demo",
      runCount: 1,
      suggestedChangesCount: 2,
      approvalDecisionCount: 2,
      applyPlanCount: 1
    });
    const storedRun = await repo.getRun({ runId: "run_protocol" });
    const threadId = storedRun?.run.thread?.id;
    expect(threadId).toBeTruthy();
    await expect(repo.getWorkThreadMetrics({ threadId: threadId! })).resolves.toMatchObject({
      scope: "work_thread",
      scopeId: threadId,
      runCount: 1,
      suggestedChangesCount: 2,
      approvalDecisionCount: 2,
      applyPlanCount: 1
    });
  });

  it("uses repo policy rules during apply preflight", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.upsertRepoPolicyRule({
      provider: "github",
      owner: "acme",
      repo: "demo",
      rule: {
        id: "deny_labels_from_primary_anchor",
        scope: "primary_anchor_override",
        effect: "deny",
        capabilityId: "set_labels",
        reason: "Repo policy denies label mutation for this anchor."
      }
    });
    await expect(repo.listRepoPolicyRules({ provider: "github", owner: "acme", repo: "demo" })).resolves.toEqual([
      expect.objectContaining({ id: "deny_labels_from_primary_anchor", effect: "deny" })
    ]);
    await repo.upsertRepoPolicyRule({
      provider: "github",
      owner: "acme",
      repo: "other",
      rule: {
        id: "deny_labels_from_primary_anchor",
        scope: "primary_anchor_override",
        effect: "allow",
        capabilityId: "set_labels",
        reason: "Different repo may reuse the same rule id."
      }
    });
    await expect(repo.listRepoPolicyRules({ provider: "github", owner: "acme", repo: "demo" })).resolves.toEqual([
      expect.objectContaining({ id: "deny_labels_from_primary_anchor", effect: "deny" })
    ]);
    await expect(repo.listRepoPolicyRules({ provider: "github", owner: "acme", repo: "other" })).resolves.toEqual([
      expect.objectContaining({ id: "deny_labels_from_primary_anchor", effect: "allow" })
    ]);

    await repo.createRun({
      id: "run_policy",
      event: {
        id: "evt_policy",
        source: "github",
        sourceEventId: "comment_policy",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "label this", intent: "run", args: {} },
        context: githubIssueContext(4),
        workItem: githubIssueWorkItem(4),
        permissions: [
          { scope: "issue:comment", reason: "reply to source thread" },
          { scope: "repo:write", reason: "mutate labels after approval" }
        ],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/4/comments" },
        metadata: { owner: "acme", repo: "demo", issueNumber: 4 }
      }
    });
    await repo.completeRun({
      runId: "run_policy",
      result: {
        conclusion: "needs_human",
        summary: "Prepared label proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_policy",
            createdAt: "2026-06-24T00:00:01.000Z",
            summary: "Add blocked label.",
            intents: [
              {
                intentId: "intent_label_blocked",
                domain: "labels",
                action: "add_label",
                summary: "Add blocked label.",
                params: { label: "blocked" }
              }
            ]
          }
        ]
      }
    });
    await repo.recordApprovalDecision({
      id: "approval_policy",
      proposalId: "proposal_policy",
      approvedIntentIds: ["intent_label_blocked"],
      approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
      approvedAt: "2026-06-24T00:00:02.000Z",
      scope: "manual"
    });

    const plan = await repo.createApplyPlan({
      id: "apply_policy",
      proposalId: "proposal_policy",
      approvalDecisionId: "approval_policy"
    });

    expect(plan?.outcomes).toEqual([
      expect.objectContaining({
        intentId: "intent_label_blocked",
        outcome: "unsupported",
        message: "OpenTag policy denied capability set_labels: Repo policy denies label mutation for this anchor."
      })
    ]);
  });

  it("stores repo mutation mappings and includes them in apply plans", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    await repo.upsertRepoMutationMapping({
      provider: "github",
      owner: "acme",
      repo: "demo",
      mapping: {
        id: "github_status_labels",
        adapter: "github",
        domain: "status",
        strategy: "label",
        values: { blocked: "status/blocked" }
      }
    });
    await expect(repo.listRepoMutationMappings({ provider: "github", owner: "acme", repo: "demo" })).resolves.toEqual([
      expect.objectContaining({ id: "github_status_labels", domain: "status" })
    ]);
    await repo.upsertRepoMutationMapping({
      provider: "github",
      owner: "acme",
      repo: "other",
      mapping: {
        id: "github_status_labels",
        adapter: "github",
        domain: "status",
        strategy: "label",
        values: { blocked: "other/blocked" }
      }
    });
    await expect(repo.listRepoMutationMappings({ provider: "github", owner: "acme", repo: "demo" })).resolves.toEqual([
      expect.objectContaining({ id: "github_status_labels", values: { blocked: "status/blocked" } })
    ]);

    await repo.createRun({
      id: "run_mapping",
      event: {
        id: "evt_mapping",
        source: "github",
        sourceEventId: "comment_mapping",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "mark blocked", intent: "run", args: {} },
        context: githubIssueContext(5),
        workItem: githubIssueWorkItem(5),
        permissions: [
          { scope: "issue:comment", reason: "reply to source thread" },
          { scope: "repo:write", reason: "mutate status after approval" }
        ],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/5/comments" },
        metadata: { owner: "acme", repo: "demo", issueNumber: 5 }
      }
    });
    await repo.completeRun({
      runId: "run_mapping",
      result: {
        conclusion: "needs_human",
        summary: "Prepared status proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_mapping",
            createdAt: "2026-06-24T00:00:01.000Z",
            summary: "Mark blocked.",
            intents: [
              {
                intentId: "intent_status_blocked",
                domain: "status",
                action: "transition_status",
                summary: "Mark blocked.",
                params: { status: "blocked" }
              }
            ]
          }
        ]
      }
    });
    await repo.recordApprovalDecision({
      id: "approval_mapping",
      proposalId: "proposal_mapping",
      approvedIntentIds: ["intent_status_blocked"],
      approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
      approvedAt: "2026-06-24T00:00:02.000Z",
      scope: "manual"
    });

    const plan = await repo.createApplyPlan({
      id: "apply_mapping",
      proposalId: "proposal_mapping",
      approvalDecisionId: "approval_mapping",
      adapter: "github"
    });

    expect(plan?.outcomes).toEqual([expect.objectContaining({ intentId: "intent_status_blocked", outcome: "skipped" })]);
    expect(plan?.adapterPlan).toMatchObject({
      mappings: [{ id: "github_status_labels", domain: "status", values: { blocked: "status/blocked" } }]
    });
  });

  it("computes domain-scoped proposal supersession", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    const baseEvent = {
      id: "evt_lineage_1",
      source: "github" as const,
      sourceEventId: "comment_lineage_1",
      receivedAt: "2026-06-24T00:00:00.000Z",
      actor: { provider: "github" as const, providerUserId: "42", handle: "octocat" },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "triage this", intent: "run" as const, args: {} },
      context: githubIssueContext(3),
      workItem: githubIssueWorkItem(3),
      permissions: [
        { scope: "issue:comment" as const, reason: "reply to source thread" },
        { scope: "repo:write" as const, reason: "mutate issue metadata after approval" }
      ],
      callback: { provider: "github" as const, uri: "https://api.github.com/repos/acme/demo/issues/3/comments" },
      metadata: { owner: "acme", repo: "demo", issueNumber: 3 }
    };

    await repo.createRun({ id: "run_lineage_1", event: baseEvent });
    await repo.completeRun({
      runId: "run_lineage_1",
      result: {
        conclusion: "needs_human",
        summary: "Prepared initial proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_lineage_1",
            createdAt: "2026-06-24T00:00:01.000Z",
            summary: "Set priority and assignee.",
            intents: [
              { intentId: "intent_priority_p1", domain: "priority", action: "set_priority", summary: "Set P1.", params: { priority: "P1" } },
              { intentId: "intent_assignee_alice", domain: "assignee", action: "set_assignee", summary: "Assign Alice.", params: { assignee: "alice" } }
            ]
          }
        ]
      }
    });

    await repo.createRun({ id: "run_lineage_2", event: { ...baseEvent, id: "evt_lineage_2", sourceEventId: "comment_lineage_2" } });
    await repo.completeRun({
      runId: "run_lineage_2",
      result: {
        conclusion: "needs_human",
        summary: "Prepared refined proposal.",
        suggestedChanges: [
          {
            proposalId: "proposal_lineage_2",
            createdAt: "2026-06-24T00:00:02.000Z",
            summary: "Refine priority.",
            intents: [
              { intentId: "intent_priority_p0", domain: "priority", action: "set_priority", summary: "Set P0.", params: { priority: "P0" } }
            ]
          }
        ]
      }
    });

    const lineage = await repo.getProposalLineage({ proposalId: "proposal_lineage_1" });
    expect(lineage?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proposalId: "proposal_lineage_1",
          intentId: "intent_priority_p1",
          domain: "priority",
          status: "superseded",
          supersededByProposalId: "proposal_lineage_2"
        }),
        expect.objectContaining({
          proposalId: "proposal_lineage_1",
          intentId: "intent_assignee_alice",
          domain: "assignee",
          status: "current"
        }),
        expect.objectContaining({
          proposalId: "proposal_lineage_2",
          intentId: "intent_priority_p0",
          domain: "priority",
          status: "current"
        })
      ])
    );

    await repo.recordApprovalDecision({
      id: "approval_lineage",
      proposalId: "proposal_lineage_1",
      approvedIntentIds: ["intent_priority_p1", "intent_assignee_alice"],
      approvedBy: { provider: "github", providerUserId: "42", handle: "octocat" },
      approvedAt: "2026-06-24T00:00:03.000Z",
      scope: "manual"
    });
    const plan = await repo.createApplyPlan({
      id: "apply_lineage",
      proposalId: "proposal_lineage_1",
      approvalDecisionId: "approval_lineage"
    });

    expect(plan?.outcomes).toEqual([
      expect.objectContaining({ intentId: "intent_priority_p1", outcome: "stale" }),
      expect.objectContaining({ intentId: "intent_assignee_alice", outcome: "skipped" })
    ]);
  });
});

describe("non-repository runner eligibility", () => {
  function ordinaryEvent(id: string, metadata: Record<string, unknown> = {}) {
    return {
      id: `evt_${id}`,
      source: "slack",
      sourceEventId: `source_${id}`,
      receivedAt: "2026-07-12T00:00:00.000Z",
      actor: { provider: "slack", providerUserId: "U123", handle: "alice" },
      target: { mention: "@opentag", agentId: "opentag", executorHint: "custom" },
      command: { rawText: "summarize this thread", intent: "run", args: {} },
      context: [],
      permissions: [],
      callback: { provider: "slack", uri: "https://example.com/callback" },
      metadata
    } as const;
  }

  it("lets a registered runner claim an ordinary run without a Project Target", async () => {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);
    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.createRun({ id: "run_scratch", event: ordinaryEvent("scratch") });

    const claimed = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });

    expect(claimed).toMatchObject({ run: { id: "run_scratch" }, event: { id: "evt_scratch" }, attemptNumber: 1 });
  });

  it("does not let an unbound repository target fall back to scratch eligibility", async () => {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);
    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.createRun({
      id: "run_unbound_repo",
      event: ordinaryEvent("unbound_repo", { repoProvider: "github", owner: "acme", repo: "private" })
    });

    await expect(repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 })).resolves.toBeNull();
  });
});

describe("repository-optional channel bindings", () => {
  it("refuses to let a different application take over an exclusive managed channel binding", async () => {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);

    await repo.upsertChannelBinding({
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      ownership: { mode: "managed", exclusive: true, applicationId: "A123", botId: "U123" }
    });
    await expect(repo.upsertChannelBinding({
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      ownership: { mode: "managed", exclusive: true, applicationId: "A999", botId: "U999" }
    })).rejects.toThrow(/managed channel binding.*different application/iu);
    await expect(repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" })).resolves.toMatchObject({
      ownership: { mode: "managed", exclusive: true, applicationId: "A123", botId: "U123" }
    });
  });

  it("does not let the Slack compatibility store method mutate a managed binding", async () => {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);

    await repo.upsertChannelBinding({
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      repoProvider: "github",
      owner: "acme",
      repo: "original",
      ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
    });

    await expect(repo.createSlackChannelBinding({
      teamId: "T123",
      channelId: "C456",
      repoProvider: "github",
      owner: "acme",
      repo: "replacement"
    })).rejects.toThrow(/managed channel binding.*compatibility/iu);
    await expect(repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" }))
      .resolves.toMatchObject({ repo: "original" });
  });

  it("does not delete a managed binding after its authorized snapshot has been rebound", async () => {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);
    const original = {
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      repoProvider: "github",
      owner: "acme",
      repo: "original",
      ownership: { mode: "managed" as const, exclusive: true as const, applicationId: "A123" }
    };
    await repo.upsertChannelBinding(original);
    const authorizedSnapshot = await repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" });
    expect(authorizedSnapshot).not.toBeNull();

    await repo.upsertChannelBinding({
      ...original,
      repo: "replacement",
      ownership: { mode: "managed", exclusive: true, applicationId: "A999" },
      allowManagedOwnershipOverride: true
    });

    await expect(repo.deleteChannelBinding({
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      expectedBinding: authorizedSnapshot!
    })).resolves.toBe(false);
    await expect(repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" }))
      .resolves.toMatchObject({ repo: "replacement", ownership: { applicationId: "A999" } });
  });

  it("fails closed when persisted managed ownership is malformed", async () => {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);

    await repo.upsertChannelBinding({
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      ownership: { mode: "managed", exclusive: true, applicationId: "A123", botId: "U123" }
    });
    sqlite.prepare("UPDATE channel_bindings SET metadata_json = ? WHERE provider = ? AND account_id = ? AND conversation_id = ?").run(
      JSON.stringify({
        __opentagChannelBindingRecord: 2,
        management: "managed",
        ownership: { mode: "managed", exclusive: true, applicationId: "bad\u0000application" }
      }),
      "slack",
      "T123",
      "C456"
    );

    await expect(repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" }))
      .rejects.toBeInstanceOf(ChannelBindingCorruptionError);
  });

  it.each([
    {
      name: "ownership is missing",
      record: { __opentagChannelBindingRecord: 2, management: "managed" }
    },
    {
      name: "the record version is altered",
      record: {
        __opentagChannelBindingRecord: 999,
        management: "managed",
        ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
      }
    }
  ])("fails closed when $name", async ({ record }) => {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);
    await repo.upsertChannelBinding({
      provider: "slack",
      accountId: "T123",
      conversationId: "C456",
      ownership: { mode: "managed", exclusive: true, applicationId: "A123" }
    });
    sqlite.prepare("UPDATE channel_bindings SET metadata_json = ?").run(JSON.stringify(record));

    await expect(repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" }))
      .rejects.toBeInstanceOf(ChannelBindingCorruptionError);
  });

  it("stores a generic channel binding with no repository target", async () => {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);

    await repo.upsertChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" });

    await expect(repo.getChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" })).resolves.toEqual({
      provider: "slack",
      accountId: "T123",
      conversationId: "C456"
    });
    const columns = sqlite.prepare("PRAGMA table_info(channel_bindings)").all() as Array<{ name: string; notnull: number }>;
    expect(columns.filter((column) => ["repo_provider", "owner", "repo"].includes(column.name)).every((column) => column.notnull === 0)).toBe(true);
  });

  it("rejects partial repository fields at the store boundary", async () => {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);

    await expect(
      repo.upsertChannelBinding({
        provider: "slack",
        accountId: "T123",
        conversationId: "C456",
        owner: "acme"
      })
    ).rejects.toThrow(/repository|repoProvider|owner|repo/u);
  });
});

describe("durable ACP material actions", () => {
  function permissionEvent(id: string) {
    return {
      id: `evt_${id}`,
      source: "slack",
      sourceEventId: `source_${id}`,
      receivedAt: "2026-07-12T00:00:00.000Z",
      actor: { provider: "slack", providerUserId: "U123", handle: "alice" },
      target: { mention: "@opentag", agentId: "opentag", executorHint: "custom" },
      command: { rawText: "publish the package", intent: "run", args: {} },
      context: [],
      permissions: [],
      callback: { provider: "slack", uri: "https://example.com/callback", threadKey: "T123|C456|ts1" },
      metadata: { teamId: "T123", channelId: "C456" }
    } as const;
  }

  async function claimedRepository(leaseSeconds = 60, fixedAttemptId?: string, fixedFencingToken = "fixed-test-fencing-token") {
    const sqlite = new Database(":memory:");
    const repo = createOpenTagRepository(drizzle(sqlite));
    migrateSchema(sqlite);
    await repo.registerRunner({ runnerId: "runner_1", name: "Runner One" });
    await repo.upsertChannelBinding({ provider: "slack", accountId: "T123", conversationId: "C456" });
    await repo.createRun({ id: "run_action", event: permissionEvent("action") });
    const claimed = await repo.claimNextRun({ runnerId: "runner_1", leaseSeconds });
    if (!claimed) throw new Error("expected claimed run");
    if (!fixedAttemptId) return { sqlite, repo, claimed };
    sqlite.prepare("UPDATE attempts SET id = ?, fencing_token = ? WHERE id = ?").run(fixedAttemptId, fixedFencingToken, claimed.attemptId);
    sqlite.prepare("UPDATE runs SET current_attempt_id = ? WHERE id = ?").run(fixedAttemptId, "run_action");
    return { sqlite, repo, claimed: { ...claimed, attemptId: fixedAttemptId, fencingToken: fixedFencingToken } };
  }

  async function approvalIdentity(
    repo: ReturnType<typeof createOpenTagRepository>,
    action: { id: string; proposalId?: string; proposalHash?: string }
  ) {
    if (!action.proposalId || !action.proposalHash) throw new Error("expected governed approval action");
    const proposal = await repo.getSuggestedChanges({ proposalId: action.proposalId });
    const approvalEpoch = proposal?.snapshot.metadata?.["approvalEpoch"];
    if (typeof approvalEpoch !== "string") throw new Error("expected approval epoch");
    return { actionId: action.id, proposalHash: action.proposalHash, approvalEpoch };
  }

  it("waits on the existing proposal approval path, creates an attempt grant, and reuses a known-success receipt", async () => {
    const { repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const request = {
      toolCallId: "tool_1",
      title: "Publish package",
      kind: "publish",
      permissionScopes: ["npm:publish"],
      mode: "ask" as const,
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "@acme/pkg",
      targetConstraints: { queryMode: "canonical", reuse: "exact", urlQuery: { environment: "staging", force: "false" } },
      targetFingerprint: `sha256:${"1".repeat(64)}`
    };
    const waiting = await repo.requestActionPermission({ ...lease, request });
    expect(waiting).toMatchObject({ state: "waiting", action: { status: "waiting_approval", riskTier: "high" } });
    expect(waiting?.action.attemptFenceDigest).not.toBe(claimed.fencingToken);
    await expect(repo.getRun({ runId: "run_action" })).resolves.toMatchObject({ run: { status: "needs_approval" } });
    await expect(repo.heartbeat({ ...lease, leaseSeconds: 60 })).resolves.toBe("updated");
    await expect(repo.recordProgress({ ...lease, message: "Waiting for the governed decision." })).resolves.toMatchObject({ outcome: "recorded" });
    await expect(repo.getRun({ runId: "run_action" })).resolves.toMatchObject({ run: { status: "needs_approval" } });

    const premature = await repo.recordMaterialActionReceipt({
      ...lease,
      actionId: waiting!.action.id,
      receipt: { id: "receipt_too_early", actionId: waiting!.action.id, provider: "npm", receiptRef: "npm:early", outcome: "succeeded", observedAt: "2026-07-12T00:00:30.000Z" }
    });
    expect(premature?.state).toBe("waiting");
    expect(premature?.action.receipt).toBeUndefined();

    const proposalId = waiting?.action.proposalId;
    expect(proposalId).toBeTruthy();
    const storedProposal = await repo.getSuggestedChanges({ proposalId: proposalId! });
    expect(storedProposal?.snapshot.intents[0]?.params).toMatchObject({
      target: { targetConstraints: { queryMode: "canonical", reuse: "exact", urlQuery: { environment: "staging", force: "false" } } }
    });
    expect(JSON.stringify(storedProposal)).not.toMatch(/authorization|password|secret|token=/iu);
    await repo.recordApprovalDecision({
      id: "approval_once",
      proposalId: proposalId!,
      approvedIntentIds: [`intent_${waiting!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123", handle: "alice" },
      approvedAt: "2026-07-12T00:01:00.000Z",
      scope: "manual",
      metadata: {
        source: "thread_action",
        permissionDecision: "allow_once",
        ...await approvalIdentity(repo, waiting!.action)
      }
    });
    const allowed = await repo.resolveActionPermission({ ...lease, actionId: waiting!.action.id });
    expect(allowed).toMatchObject({ state: "authorized", decision: "allow_once", action: { status: "executing" } });
    await expect(repo.getRun({ runId: "run_action" })).resolves.toMatchObject({ run: { status: "running" } });

    const receipt = {
      id: "receipt_1",
      actionId: waiting!.action.id,
      provider: "npm",
      connectionId: "npm:team",
      targetFingerprint: `sha256:${"1".repeat(64)}`,
      receiptRef: "npm:publish:acme-pkg@1.0.0",
      outcome: "succeeded" as const,
      observedAt: "2026-07-12T00:02:00.000Z"
    };
    await expect(repo.recordMaterialActionReceipt({ ...lease, actionId: waiting!.action.id, receipt: { ...receipt, actionId: "action_other" } })).rejects.toThrow(/actionId/u);
    await repo.recordMaterialActionReceipt({ ...lease, actionId: waiting!.action.id, receipt });
    await expect(repo.requestActionPermission({ ...lease, request: { ...request, toolCallId: "tool_retry" } })).resolves.toMatchObject({
      state: "reconciled",
      decision: "deny",
      receipt: { receiptRef: "npm:publish:acme-pkg@1.0.0" }
    });
  });

  it("converges concurrent semantic request replays on one durable action", async () => {
    const { repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const request = { toolCallId: "tool_1", title: "Publish package", kind: "publish", permissionScopes: ["npm:publish"], mode: "ask" as const, provider: "npm" };
    const results = await Promise.all([
      repo.requestActionPermission({ ...lease, request }),
      repo.requestActionPermission({ ...lease, request: { ...request, toolCallId: "tool_retry" } })
    ]);
    expect(results[0]?.action.id).toBe(results[1]?.action.id);
    expect(results.every((result) => result?.state === "waiting")).toBe(true);
  });

  it("keeps provider and credential-safe target fingerprints in action identity and never broadens allow_once", async () => {
    const { repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const firstRequest = {
      toolCallId: "tool_target_a",
      title: "Execute deployment",
      kind: "execute",
      targetFingerprint: `sha256:${"a".repeat(64)}`,
      permissionScopes: ["deploy:write"],
      mode: "auto" as const,
      provider: "acp"
    };
    const first = await repo.requestActionPermission({ ...lease, request: firstRequest });
    const second = await repo.requestActionPermission({
      ...lease,
      request: { ...firstRequest, toolCallId: "tool_target_b", targetFingerprint: `sha256:${"b".repeat(64)}` }
    });
    const otherProvider = await repo.requestActionPermission({
      ...lease,
      request: { ...firstRequest, toolCallId: "tool_target_c", provider: "connector" }
    });
    expect(first).toMatchObject({ state: "waiting", action: { status: "waiting_approval" } });
    expect(new Set([first?.action.id, second?.action.id, otherProvider?.action.id]).size).toBe(3);

    await repo.recordApprovalDecision({
      id: "approval_exact_once",
      proposalId: first!.action.proposalId!,
      approvedIntentIds: [`intent_${first!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: "2026-07-12T00:01:00.000Z",
      scope: "manual",
      metadata: {
        source: "thread_action",
        permissionDecision: "allow_once",
        ...await approvalIdentity(repo, first!.action)
      }
    });
    await expect(repo.resolveActionPermission({ ...lease, actionId: first!.action.id })).resolves.toMatchObject({ state: "authorized", decision: "allow_once" });
    await expect(repo.resolveActionPermission({ ...lease, actionId: second!.action.id })).resolves.toMatchObject({ state: "waiting" });
  });

  it("reuses allow_run for a distinct exact action inside the approved structured resource scope only", async () => {
    const { repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const first = await repo.requestActionPermission({
      ...lease,
      request: {
        toolCallId: "tool_scope_next",
        title: "Publish report next",
        kind: "execute",
        provider: "npm",
        connectionId: "npm:team",
        operation: "publish",
        resource: "@acme/report",
        resourceVersion: "next",
        targetFingerprint: `sha256:${"1".repeat(64)}`,
        grantScope: { package: "@acme/report", versions: "*" },
        permissionScopes: ["npm:publish"],
        mode: "ask"
      }
    });
    await repo.recordApprovalDecision({
      id: "approval_bounded_run",
      proposalId: first!.action.proposalId!,
      approvedIntentIds: [`intent_${first!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: "2026-07-12T00:01:00.000Z",
      scope: "manual",
      metadata: {
        permissionDecision: "allow_run",
        ...await approvalIdentity(repo, first!.action)
      }
    });
    await expect(repo.resolveActionPermission({ ...lease, actionId: first!.action.id })).resolves.toMatchObject({ state: "authorized", decision: "allow_run" });

    const inside = await repo.requestActionPermission({
      ...lease,
      request: {
        toolCallId: "tool_scope_stable",
        title: "Publish report stable",
        kind: "execute",
        provider: "npm",
        connectionId: "npm:team",
        operation: "publish",
        resource: "@acme/report",
        resourceVersion: "stable",
        targetFingerprint: `sha256:${"2".repeat(64)}`,
        grantScope: { package: "@acme/report", versions: "*" },
        permissionScopes: ["npm:publish"],
        mode: "auto"
      }
    });
    expect(inside).toMatchObject({ state: "authorized", decision: "allow_run", action: { status: "executing" } });
    expect(inside!.action.id).not.toBe(first!.action.id);

    await expect(repo.requestActionPermission({
      ...lease,
      request: {
        toolCallId: "tool_scope_outside",
        title: "Publish other stable",
        kind: "execute",
        provider: "npm",
        connectionId: "npm:team",
        operation: "publish",
        resource: "@acme/other",
        resourceVersion: "stable",
        targetFingerprint: `sha256:${"3".repeat(64)}`,
        grantScope: { package: "@acme/other", versions: "*" },
        permissionScopes: ["npm:publish"],
        mode: "auto"
      }
    })).resolves.toMatchObject({ state: "waiting", action: { status: "waiting_approval" } });
  });

  it("does not offer or persist run reuse for an unsafe or unclassified exact target", async () => {
    const { sqlite, repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const waiting = await repo.requestActionPermission({
      ...lease,
      request: {
        toolCallId: "tool_non_reusable",
        title: "Publish signed target",
        kind: "execute",
        provider: "npm",
        connectionId: "npm:team",
        operation: "publish",
        resource: "https://example.test/report",
        targetFingerprint: `sha256:${"9".repeat(64)}`,
        targetConstraints: { queryMode: "credential_stripped", queryFingerprint: `sha256:${"8".repeat(64)}`, reuse: "deny" },
        permissionScopes: ["npm:publish"],
        mode: "ask"
      }
    });
    const proposal = await repo.getSuggestedChanges({ proposalId: waiting!.action.proposalId! });
    expect(proposal?.snapshot.intents[0]?.params?.["decisions"]).toEqual(["allow_once", "deny"]);
    await repo.recordApprovalDecision({
      id: "approval_non_reusable",
      proposalId: waiting!.action.proposalId!,
      approvedIntentIds: [`intent_${waiting!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: "2026-07-12T00:01:00.000Z",
      scope: "manual",
      metadata: { permissionDecision: "allow_run", ...await approvalIdentity(repo, waiting!.action) }
    });
    await expect(repo.resolveActionPermission({ ...lease, actionId: waiting!.action.id })).resolves.toMatchObject({ state: "authorized", decision: "allow_once" });
    expect(sqlite.prepare("SELECT attempt_id AS attemptId FROM grants").get()).toEqual({ attemptId: claimed.attemptId });
  });

  it("keeps denied exact targets out of opaque one-shot action identity while retaining their stored constraints", async () => {
    const firstFixture = await claimedRepository(60, "attempt_opaque_identity");
    const secondFixture = await claimedRepository(60, "attempt_opaque_identity");
    const request = {
      toolCallId: "tool_opaque_identity",
      title: "Publish signed target",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      permissionScopes: ["npm:publish"],
      mode: "ask" as const
    };
    const first = await firstFixture.repo.requestActionPermission({
      runnerId: "runner_1",
      runId: "run_action",
      attemptId: firstFixture.claimed.attemptId,
      fencingToken: firstFixture.claimed.fencingToken,
      request: {
        ...request,
        resource: "https://example.test/report-blue",
        targetFingerprint: `sha256:${"a".repeat(64)}`,
        targetConstraints: { queryMode: "credential_stripped", reuse: "deny", exactTarget: "blue" }
      }
    });
    const second = await secondFixture.repo.requestActionPermission({
      runnerId: "runner_1",
      runId: "run_action",
      attemptId: secondFixture.claimed.attemptId,
      fencingToken: secondFixture.claimed.fencingToken,
      request: {
        ...request,
        resource: "https://example.test/report-green",
        targetFingerprint: `sha256:${"b".repeat(64)}`,
        targetConstraints: { queryMode: "credential_stripped", reuse: "deny", exactTarget: "green" }
      }
    });

    expect(first).toMatchObject({ state: "waiting", action: { scope: { targetConstraints: { exactTarget: "blue" } } } });
    expect(second).toMatchObject({ state: "waiting", action: { scope: { targetConstraints: { exactTarget: "green" } } } });
    expect(second!.action.id).toBe(first!.action.id);
    expect(second!.action.idempotencyKey).toBe(first!.action.idempotencyKey);
    expect(second!.action.proposalId).toBe(first!.action.proposalId);
    expect(second!.action.proposalHash).toBe(first!.action.proposalHash);
    await expect(approvalIdentity(secondFixture.repo, second!.action)).resolves.toEqual(
      await approvalIdentity(firstFixture.repo, first!.action)
    );
  });

  it("keys agent-controlled opaque tool identity to private Attempt fencing material", async () => {
    const firstFixture = await claimedRepository(60, "attempt_keyed_identity", "first-private-fencing-key");
    const secondFixture = await claimedRepository(60, "attempt_keyed_identity", "second-private-fencing-key");
    const request = {
      toolCallId: "authorization=agent-controlled-sensitive-value",
      title: "Publish signed target",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "https://example.test/report",
      targetConstraints: { queryMode: "credential_stripped", reuse: "deny", exactTarget: "blue" },
      permissionScopes: ["npm:publish"],
      mode: "ask" as const
    };
    const first = await firstFixture.repo.requestActionPermission({
      runnerId: "runner_1",
      runId: "run_action",
      attemptId: firstFixture.claimed.attemptId,
      fencingToken: firstFixture.claimed.fencingToken,
      request
    });
    const second = await secondFixture.repo.requestActionPermission({
      runnerId: "runner_1",
      runId: "run_action",
      attemptId: secondFixture.claimed.attemptId,
      fencingToken: secondFixture.claimed.fencingToken,
      request
    });

    expect(first).toMatchObject({ state: "waiting" });
    expect(second).toMatchObject({ state: "waiting" });
    expect(second!.action.id).not.toBe(first!.action.id);
    expect(second!.action.idempotencyKey).not.toBe(first!.action.idempotencyKey);
    expect(JSON.stringify([first, second])).not.toContain(request.toolCallId);
  });

  it("fails closed when one opaque tool identity drifts to a different denied exact target", async () => {
    const { sqlite, repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const request = {
      toolCallId: "tool_drifting_identity",
      title: "Publish signed target",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      permissionScopes: ["npm:publish"],
      mode: "ask" as const
    };
    const waiting = await repo.requestActionPermission({
      ...lease,
      request: {
        ...request,
        resource: "https://example.test/report-blue",
        targetFingerprint: `sha256:${"a".repeat(64)}`,
        targetConstraints: { queryMode: "credential_stripped", reuse: "deny", exactTarget: "blue" }
      }
    });
    await repo.recordApprovalDecision({
      id: "approval_before_target_drift",
      proposalId: waiting!.action.proposalId!,
      approvedIntentIds: [`intent_${waiting!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: "2026-07-12T00:01:00.000Z",
      scope: "manual",
      metadata: { permissionDecision: "allow_once", ...await approvalIdentity(repo, waiting!.action) }
    });

    const drifted = await repo.requestActionPermission({
      ...lease,
      request: {
        ...request,
        resource: "https://example.test/report-green",
        targetFingerprint: `sha256:${"b".repeat(64)}`,
        targetConstraints: { queryMode: "credential_stripped", reuse: "deny", exactTarget: "green" }
      }
    });

    expect(drifted).toMatchObject({
      state: "denied",
      decision: "deny",
      action: {
        id: waiting!.action.id,
        status: "cancelled",
        scope: { targetConstraints: { exactTarget: "blue" } }
      }
    });
    expect(JSON.stringify(drifted)).not.toContain("green");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM material_actions").get()).toEqual({ count: 1 });
    await expect(repo.resolveActionPermission({ ...lease, actionId: waiting!.action.id })).resolves.toMatchObject({
      state: "denied",
      action: { status: "cancelled" }
    });
  });

  it("keeps distinct opaque tool calls eligible for separate exact one-shot approvals", async () => {
    const { sqlite, repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const request = {
      title: "Publish signed target",
      kind: "execute",
      provider: "npm",
      connectionId: "npm:team",
      operation: "publish",
      resource: "https://example.test/report",
      targetConstraints: { queryMode: "credential_stripped", reuse: "deny", exactTarget: "blue" },
      permissionScopes: ["npm:publish"],
      mode: "ask" as const
    };
    const first = await repo.requestActionPermission({ ...lease, request: { ...request, toolCallId: "tool_one_shot_first" } });
    await repo.recordApprovalDecision({
      id: "approval_one_shot_first",
      proposalId: first!.action.proposalId!,
      approvedIntentIds: [`intent_${first!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: "2026-07-12T00:01:00.000Z",
      scope: "manual",
      metadata: { permissionDecision: "allow_once", ...await approvalIdentity(repo, first!.action) }
    });
    await expect(repo.resolveActionPermission({ ...lease, actionId: first!.action.id })).resolves.toMatchObject({
      state: "authorized",
      decision: "allow_once"
    });

    const second = await repo.requestActionPermission({ ...lease, request: { ...request, toolCallId: "tool_one_shot_second" } });
    expect(second).toMatchObject({ state: "waiting" });
    expect(second!.action.id).not.toBe(first!.action.id);
    expect(second!.action.proposalHash).not.toBe(first!.action.proposalHash);
    await repo.recordApprovalDecision({
      id: "approval_one_shot_second",
      proposalId: second!.action.proposalId!,
      approvedIntentIds: [`intent_${second!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: "2026-07-12T00:02:00.000Z",
      scope: "manual",
      metadata: { permissionDecision: "allow_once", ...await approvalIdentity(repo, second!.action) }
    });
    await expect(repo.resolveActionPermission({ ...lease, actionId: second!.action.id })).resolves.toMatchObject({
      state: "authorized",
      decision: "allow_once"
    });
    const grantedActionIds = (sqlite.prepare("SELECT constraints_json AS constraintsJson FROM grants").all() as Array<{ constraintsJson: string }>).map(
      ({ constraintsJson }) => String((JSON.parse(constraintsJson) as Record<string, unknown>)["actionId"])
    ).sort();
    expect(grantedActionIds).toEqual([first!.action.id, second!.action.id].sort());
  });

  it("rolls back grant-based authorization when the grant is revoked or Attempt is reassigned during creation", async () => {
    for (const interleaving of ["revoke_grant", "reassign_attempt"] as const) {
      const { sqlite, repo, claimed } = await claimedRepository();
      const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
      const grantScope = { package: "@acme/report", versions: "*" };
      const first = await repo.requestActionPermission({
        ...lease,
        request: {
          toolCallId: `tool_${interleaving}_first`, title: "Publish report next", kind: "execute", provider: "npm",
          connectionId: "npm:team", operation: "publish", resource: "@acme/report", resourceVersion: "next",
          targetFingerprint: `sha256:${"4".repeat(64)}`, grantScope, permissionScopes: ["npm:publish"], mode: "ask"
        }
      });
      await repo.recordApprovalDecision({
        id: `approval_${interleaving}`,
        proposalId: first!.action.proposalId!,
        approvedIntentIds: [`intent_${first!.action.id}`],
        approvedBy: { provider: "slack", providerUserId: "U123" },
        approvedAt: "2026-07-12T00:01:00.000Z",
        scope: "manual",
        metadata: { permissionDecision: "allow_run", ...await approvalIdentity(repo, first!.action) }
      });
      await repo.resolveActionPermission({ ...lease, actionId: first!.action.id });
      sqlite.exec(interleaving === "revoke_grant" ? `
        CREATE TRIGGER force_grant_revoke
        AFTER INSERT ON material_actions
        BEGIN
          UPDATE grants SET revoked_at = '2026-07-12T00:01:30.000Z' WHERE run_id = NEW.run_id;
        END
      ` : `
        CREATE TRIGGER force_attempt_reassignment_during_creation
        AFTER INSERT ON material_actions
        BEGIN
          UPDATE runs SET current_attempt_id = 'attempt_forced_reassignment' WHERE id = NEW.run_id;
        END
      `);
      const second = await repo.requestActionPermission({
        ...lease,
        request: {
          toolCallId: `tool_${interleaving}_second`, title: "Publish report stable", kind: "execute", provider: "npm",
          connectionId: "npm:team", operation: "publish", resource: "@acme/report", resourceVersion: "stable",
          targetFingerprint: `sha256:${"5".repeat(64)}`, grantScope, permissionScopes: ["npm:publish"], mode: "auto"
        }
      });
      expect(second).toBeNull();
      expect(sqlite.prepare("SELECT count(*) AS count FROM material_actions").get()).toEqual({ count: 1 });
      expect(sqlite.prepare("SELECT count(*) AS count FROM grants WHERE revoked_at IS NOT NULL").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT current_attempt_id AS attemptId FROM runs WHERE id = ?").get("run_action")).toEqual({ attemptId: claimed.attemptId });
    }
  });

  it("keeps repeat non-material Auto permissions usable without releasing a receipt-tracked execution", async () => {
    const { repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const request = {
      toolCallId: "tool_read_once",
      title: "Read report metadata",
      kind: "read",
      provider: "acp",
      connectionId: "acp:agent-managed",
      operation: "read",
      resource: "@acme/report",
      permissionScopes: [] as string[],
      mode: "auto" as const
    };
    const first = await repo.requestActionPermission({ ...lease, request });
    expect(first).toMatchObject({ state: "authorized", decision: "allow_once", action: { status: "authorized" } });
    const repeated = await repo.requestActionPermission({ ...lease, request: { ...request, toolCallId: "tool_read_again" } });
    expect(repeated).toMatchObject({ state: "authorized", decision: "allow_once", action: { id: first!.action.id, status: "authorized" } });
    expect(repeated!.action.receipt).toBeUndefined();
  });

  it("keeps the first proposal terminal decision immutable and validates governed proposal identity", async () => {
    const { repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const waiting = await repo.requestActionPermission({
      ...lease,
      request: {
        toolCallId: "tool_terminal",
        title: "Publish package",
        kind: "publish",
        targetFingerprint: `sha256:${"c".repeat(64)}`,
        permissionScopes: ["npm:publish"],
        mode: "ask",
        provider: "npm"
      }
    });
    const identity = {
      ...await approvalIdentity(repo, waiting!.action),
      permissionDecision: "allow_once"
    };
    const invalid = await repo.recordApprovalDecision({
      id: "approval_invalid_hash",
      proposalId: waiting!.action.proposalId!,
      approvedIntentIds: [`intent_${waiting!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: "2026-07-12T00:00:30.000Z",
      scope: "manual",
      metadata: { ...identity, proposalHash: "tampered" }
    });
    expect(invalid).toBeNull();

    const first = await repo.recordApprovalDecision({
      id: "approval_first_terminal",
      proposalId: waiting!.action.proposalId!,
      approvedIntentIds: [`intent_${waiting!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: "2026-07-12T00:01:00.000Z",
      scope: "manual",
      metadata: identity
    });
    const conflicting = await repo.recordApprovalDecision({
      id: "approval_conflicting_terminal",
      proposalId: waiting!.action.proposalId!,
      approvedIntentIds: [],
      rejectedIntentIds: [`intent_${waiting!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U999" },
      approvedAt: "2026-07-12T00:02:00.000Z",
      scope: "manual",
      metadata: { ...identity, permissionDecision: "deny" }
    });
    expect(conflicting).toEqual(first);
    await expect(repo.resolveActionPermission({ ...lease, actionId: waiting!.action.id })).resolves.toMatchObject({ state: "authorized", decision: "allow_once" });
  });

  it("cancels an expired waiting proposal and creates a new approval epoch for the replacement Attempt", async () => {
    const waitingFixture = await claimedRepository(0);
    const firstLease = { runnerId: "runner_1", runId: "run_action", attemptId: waitingFixture.claimed.attemptId, fencingToken: waitingFixture.claimed.fencingToken };
    const request = {
      toolCallId: "tool_rebind",
      title: "Publish package",
      kind: "publish",
      targetFingerprint: `sha256:${"d".repeat(64)}`,
      permissionScopes: ["npm:publish"],
      mode: "ask" as const,
      provider: "npm"
    };
    const waiting = await waitingFixture.repo.requestActionPermission({ ...firstLease, request });
    const secondClaim = await waitingFixture.repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    const secondLease = { runnerId: "runner_1", runId: "run_action", attemptId: secondClaim!.attemptId, fencingToken: secondClaim!.fencingToken };
    const replacement = await waitingFixture.repo.requestActionPermission({ ...secondLease, request: { ...request, toolCallId: "tool_replacement" } });
    expect(replacement).toMatchObject({
      state: "waiting",
      action: { status: "waiting_approval", attemptId: secondClaim!.attemptId }
    });
    expect(replacement!.action.id).not.toBe(waiting!.action.id);
    expect(replacement!.action.proposalId).not.toBe(waiting!.action.proposalId);
    expect(replacement!.action.proposalHash).not.toBe(waiting!.action.proposalHash);
    const stale = await waitingFixture.repo.resolveActionPermission({ ...firstLease, actionId: waiting!.action.id });
    expect(stale).toMatchObject({ state: "stale" });
    expect(stale).not.toHaveProperty("decision");

    const executingFixture = await claimedRepository(0);
    const executingFirstLease = { runnerId: "runner_1", runId: "run_action", attemptId: executingFixture.claimed.attemptId, fencingToken: executingFixture.claimed.fencingToken };
    const executingRequest = {
      toolCallId: "tool_execute",
      title: "Read metadata",
      kind: "execute",
      targetFingerprint: `sha256:${"e".repeat(64)}`,
      permissionScopes: [],
      mode: "autonomous" as const,
      provider: "acp"
    };
    const executing = await executingFixture.repo.requestActionPermission({ ...executingFirstLease, request: executingRequest });
    expect(executing).toMatchObject({ state: "authorized", action: { status: "executing" } });
    const executingSecondClaim = await executingFixture.repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    const executingSecondLease = { runnerId: "runner_1", runId: "run_action", attemptId: executingSecondClaim!.attemptId, fencingToken: executingSecondClaim!.fencingToken };
    const staleReceipt = await executingFixture.repo.recordMaterialActionReceipt({
      ...executingFirstLease,
      actionId: executing!.action.id,
      receipt: {
        id: "receipt_from_stale_attempt",
        actionId: executing!.action.id,
        provider: "acp",
        receiptRef: "acp:stale-attempt",
        outcome: "succeeded",
        observedAt: "2026-07-12T00:02:00.000Z"
      }
    });
    expect(staleReceipt).toMatchObject({ state: "stale", action: { id: executing!.action.id, status: "unknown" } });
    expect(staleReceipt).not.toHaveProperty("decision");
    expect(staleReceipt?.action.receipt).toBeUndefined();
    expect(JSON.stringify(await executingFixture.repo.listRunEvents({ runId: "run_action" }))).not.toContain("receipt_from_stale_attempt");
    await expect(executingFixture.repo.requestActionPermission({ ...executingSecondLease, request: { ...executingRequest, toolCallId: "tool_execute_retry" } })).resolves.toMatchObject({
      state: "unknown",
      action: { id: executing!.action.id, status: "unknown" }
    });
  });

  it("selects the replacement action epoch by Attempt number when timestamps tie", async () => {
    const fixture = await claimedRepository(0);
    const firstLease = {
      runnerId: "runner_1",
      runId: "run_action",
      attemptId: fixture.claimed.attemptId,
      fencingToken: fixture.claimed.fencingToken
    };
    const request = {
      toolCallId: "tool_same_timestamp_first",
      title: "Publish package",
      kind: "publish",
      targetFingerprint: `sha256:${"f".repeat(64)}`,
      permissionScopes: ["npm:publish"],
      mode: "ask" as const,
      provider: "npm"
    };
    const first = await fixture.repo.requestActionPermission({ ...firstLease, request });
    const secondClaim = await fixture.repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    if (!first || !secondClaim) throw new Error("expected replacement Attempt and approval epoch");
    const secondLease = {
      runnerId: "runner_1",
      runId: "run_action",
      attemptId: secondClaim.attemptId,
      fencingToken: secondClaim.fencingToken
    };
    const replacement = await fixture.repo.requestActionPermission({
      ...secondLease,
      request: { ...request, toolCallId: "tool_same_timestamp_replacement" }
    });
    if (!replacement) throw new Error("expected replacement action epoch");

    fixture.sqlite.prepare("UPDATE material_actions SET created_at = ? WHERE id IN (?, ?)")
      .run("2026-07-12T00:00:00.000Z", first.action.id, replacement.action.id);
    fixture.sqlite.exec(`
      CREATE TRIGGER reject_duplicate_current_epoch_insert
      BEFORE INSERT ON material_actions
      WHEN NEW.id = '${replacement.action.id}'
      BEGIN
        SELECT RAISE(FAIL, 'current action epoch must be read, not inserted again');
      END;
    `);

    await expect(fixture.repo.requestActionPermission({
      ...secondLease,
      request: { ...request, toolCallId: "tool_same_timestamp_retry" }
    })).resolves.toMatchObject({
      state: "waiting",
      action: { id: replacement.action.id, attemptId: secondClaim.attemptId, status: "waiting_approval" }
    });
  });

  it("rejects a decision submitted after its approval Attempt lease expired", async () => {
    const fixture = await claimedRepository(60);
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: fixture.claimed.attemptId, fencingToken: fixture.claimed.fencingToken };
    const waiting = await fixture.repo.requestActionPermission({
      ...lease,
      request: { toolCallId: "tool_late_decision", title: "Publish package", kind: "publish", permissionScopes: ["npm:publish"], mode: "ask", provider: "npm" }
    });
    const proposal = await fixture.repo.getSuggestedChanges({ proposalId: waiting!.action.proposalId! });
    await fixture.repo.heartbeat({ ...lease, leaseSeconds: 0 });

    await expect(fixture.repo.recordApprovalDecision({
      id: "approval_after_expiry",
      proposalId: waiting!.action.proposalId!,
      approvedIntentIds: [`intent_${waiting!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: new Date().toISOString(),
      scope: "manual",
      metadata: {
        permissionDecision: "allow_once",
        actionId: waiting!.action.id,
        proposalHash: waiting!.action.proposalHash,
        approvalEpoch: proposal!.snapshot.metadata!["approvalEpoch"]
      }
    })).resolves.toBeNull();
  });

  it("does not let an unconsumed allow_once decision authorize a replacement Attempt", async () => {
    const fixture = await claimedRepository(60);
    const firstLease = { runnerId: "runner_1", runId: "run_action", attemptId: fixture.claimed.attemptId, fencingToken: fixture.claimed.fencingToken };
    const request = {
      toolCallId: "tool_unconsumed_once",
      title: "Publish package",
      kind: "publish",
      permissionScopes: ["npm:publish"],
      mode: "ask" as const,
      provider: "npm"
    };
    const first = await fixture.repo.requestActionPermission({ ...firstLease, request });
    await fixture.repo.recordApprovalDecision({
      id: "approval_unconsumed_once",
      proposalId: first!.action.proposalId!,
      approvedIntentIds: [`intent_${first!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: new Date().toISOString(),
      scope: "manual",
      metadata: { permissionDecision: "allow_once", ...await approvalIdentity(fixture.repo, first!.action) }
    });
    await fixture.repo.heartbeat({ ...firstLease, leaseSeconds: 0 });
    const secondClaim = await fixture.repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    const replacement = await fixture.repo.requestActionPermission({
      runnerId: "runner_1",
      runId: "run_action",
      attemptId: secondClaim!.attemptId,
      fencingToken: secondClaim!.fencingToken,
      request: { ...request, toolCallId: "tool_replacement_once" }
    });

    expect(replacement).toMatchObject({ state: "waiting", action: { status: "waiting_approval", attemptId: secondClaim!.attemptId } });
    expect(replacement!.action.id).not.toBe(first!.action.id);
  });

  it("keeps an explicit allow_run grant valid across replacement Attempts", async () => {
    const fixture = await claimedRepository(60);
    const firstLease = { runnerId: "runner_1", runId: "run_action", attemptId: fixture.claimed.attemptId, fencingToken: fixture.claimed.fencingToken };
    const grantScope = { package: "@acme/report", versions: "*" };
    const first = await fixture.repo.requestActionPermission({
      ...firstLease,
      request: {
        toolCallId: "tool_allow_run_next", title: "Publish report next", kind: "execute", provider: "npm",
        connectionId: "npm:team", operation: "publish", resource: "@acme/report", resourceVersion: "next",
        targetFingerprint: `sha256:${"6".repeat(64)}`, grantScope, permissionScopes: ["npm:publish"], mode: "ask"
      }
    });
    await fixture.repo.recordApprovalDecision({
      id: "approval_cross_attempt_run",
      proposalId: first!.action.proposalId!,
      approvedIntentIds: [`intent_${first!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: new Date().toISOString(),
      scope: "manual",
      metadata: { permissionDecision: "allow_run", ...await approvalIdentity(fixture.repo, first!.action) }
    });
    await expect(fixture.repo.resolveActionPermission({ ...firstLease, actionId: first!.action.id })).resolves.toMatchObject({ state: "authorized", decision: "allow_run" });
    await fixture.repo.heartbeat({ ...firstLease, leaseSeconds: 0 });
    const secondClaim = await fixture.repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });
    const second = await fixture.repo.requestActionPermission({
      runnerId: "runner_1",
      runId: "run_action",
      attemptId: secondClaim!.attemptId,
      fencingToken: secondClaim!.fencingToken,
      request: {
        toolCallId: "tool_allow_run_stable", title: "Publish report stable", kind: "execute", provider: "npm",
        connectionId: "npm:team", operation: "publish", resource: "@acme/report", resourceVersion: "stable",
        targetFingerprint: `sha256:${"7".repeat(64)}`, grantScope, permissionScopes: ["npm:publish"], mode: "auto"
      }
    });

    expect(second).toMatchObject({ state: "authorized", decision: "allow_run", action: { status: "executing", attemptId: secondClaim!.attemptId } });
  });

  it("reconciles an unknown action once with sanitized, auditable evidence", async () => {
    const fixture = await claimedRepository(0);
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: fixture.claimed.attemptId, fencingToken: fixture.claimed.fencingToken };
    const executing = await fixture.repo.requestActionPermission({
      ...lease,
      request: {
        toolCallId: "tool_unknown_reconcile", title: "Publish report", kind: "execute", provider: "npm",
        connectionId: "npm:team", operation: "publish", resource: "@acme/report",
        targetFingerprint: `sha256:${"8".repeat(64)}`, permissionScopes: ["npm:publish"], mode: "autonomous"
      }
    });
    await fixture.repo.claimNextRun({ runnerId: "runner_1", leaseSeconds: 60 });

    const first = await fixture.repo.reconcileUnknownMaterialAction({
      actionId: executing!.action.id,
      outcome: "succeeded",
      idempotencyKey: "reconcile_provider_check_1",
      receiptRef: "npm:publish:@acme/report",
      source: "control_plane_admin",
      actorId: "pairing_admin",
      evidence: [{
        id: "evidence_provider_1", kind: "provider_lookup", assurance: "verified", subjectRef: "@acme/report",
        summary: "Provider confirms the package was published.", createdAt: new Date().toISOString(),
        metadata: { authorization: "Bearer must-not-persist" }
      }]
    });
    const replay = await fixture.repo.reconcileUnknownMaterialAction({
      actionId: executing!.action.id,
      outcome: "succeeded",
      idempotencyKey: "reconcile_provider_check_1",
      receiptRef: "npm:publish:@acme/report",
      source: "control_plane_admin",
      actorId: "pairing_admin"
    });
    const conflict = await fixture.repo.reconcileUnknownMaterialAction({
      actionId: executing!.action.id,
      outcome: "failed",
      idempotencyKey: "reconcile_conflict",
      receiptRef: "npm:publish:@acme/report",
      source: "control_plane_admin",
      actorId: "pairing_admin"
    });

    expect(first).toMatchObject({ outcome: "reconciled", action: { status: "succeeded" } });
    expect(replay).toMatchObject({ outcome: "replayed", action: { status: "succeeded" } });
    expect(conflict).toMatchObject({ outcome: "conflict", action: { status: "succeeded" } });
    expect(JSON.stringify(first)).not.toContain("must-not-persist");
    await expect(fixture.repo.listControlPlaneEvents({ type: "material_action.reconciled" })).resolves.toHaveLength(1);
  });

  it("rolls back grant creation and execution release when ownership changes inside the authorization transaction", async () => {
    const { sqlite, repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const waiting = await repo.requestActionPermission({
      ...lease,
      request: { toolCallId: "tool_interleave", title: "Publish package", kind: "publish", permissionScopes: ["npm:publish"], mode: "ask", provider: "npm" }
    });
    await repo.recordApprovalDecision({
      id: "approval_interleave",
      proposalId: waiting!.action.proposalId!,
      approvedIntentIds: [`intent_${waiting!.action.id}`],
      approvedBy: { provider: "slack", providerUserId: "U123" },
      approvedAt: "2026-07-12T00:01:00.000Z",
      scope: "manual",
      metadata: { permissionDecision: "allow_once", ...await approvalIdentity(repo, waiting!.action) }
    });
    sqlite.exec(`
      CREATE TRIGGER force_action_reassignment
      BEFORE UPDATE OF status ON material_actions
      WHEN NEW.status = 'executing'
      BEGIN
        UPDATE runs SET current_attempt_id = 'attempt_forced_reassignment' WHERE id = NEW.run_id;
      END
    `);
    await expect(repo.resolveActionPermission({ ...lease, actionId: waiting!.action.id })).resolves.toMatchObject({ state: "stale", reason: expect.stringMatching(/ownership changed/u) });
    expect(sqlite.prepare("SELECT status FROM material_actions WHERE id = ?").get(waiting!.action.id)).toEqual({ status: "waiting_approval" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM grants WHERE run_id = ?").get("run_action")).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT current_attempt_id AS attemptId FROM runs WHERE id = ?").get("run_action")).toEqual({ attemptId: claimed.attemptId });
  });

  it("accepts only the first fenced terminal receipt and strips credential-bearing receipt fields", async () => {
    const { repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const allowed = await repo.requestActionPermission({
      ...lease,
      request: { toolCallId: "tool_receipt", title: "Read metadata", kind: "execute", permissionScopes: [], mode: "autonomous", provider: "connector", connectionId: "connector:team", operation: "write", resource: "report:123", targetFingerprint: `sha256:${"a".repeat(64)}` }
    });
    const success = {
      id: "receipt_success",
      actionId: allowed!.action.id,
      provider: "connector",
      connectionId: "connector:team",
      targetFingerprint: `sha256:${"a".repeat(64)}`,
      receiptRef: "connector:operation:123",
      outcome: "succeeded" as const,
      externalId: "operation_123",
      externalUri: "https://connector.example/operations/123?access_token=secret#authorization",
      observedAt: "2026-07-12T00:02:00.000Z",
      metadata: {
        assurance: "trusted_provider",
        toolCallId: "tool_receipt",
        authorization: "Bearer secret",
        cookie: "session=secret",
        password: "hunter2",
        credential: "private",
        private_key: "pem-data",
        statusCode: 200
      }
    };
    await expect(repo.recordMaterialActionReceipt({
      ...lease,
      actionId: allowed!.action.id,
      receipt: { ...success, id: "receipt_wrong_provider", provider: "other" }
    })).rejects.toThrow(/provider.*approved target/u);
    await expect(repo.recordMaterialActionReceipt({
      ...lease,
      actionId: allowed!.action.id,
      receipt: { ...success, id: "receipt_wrong_connection", connectionId: "connector:other" }
    })).rejects.toThrow(/connectionId.*approved target/u);
    await expect(repo.recordMaterialActionReceipt({
      ...lease,
      actionId: allowed!.action.id,
      receipt: { ...success, id: "receipt_wrong_target", targetFingerprint: `sha256:${"b".repeat(64)}` }
    })).rejects.toThrow(/targetFingerprint.*approved target/u);
    const [winner, loser] = await Promise.all([
      repo.recordMaterialActionReceipt({ ...lease, actionId: allowed!.action.id, receipt: success }),
      repo.recordMaterialActionReceipt({ ...lease, actionId: allowed!.action.id, receipt: { ...success, id: "receipt_failed", outcome: "failed" } })
    ]);
    expect(winner).toMatchObject({ state: "reconciled", action: { status: "succeeded", receipt: { id: "receipt_success", externalUri: "https://connector.example/operations/123" } } });
    expect(loser).toMatchObject({ state: "reconciled", action: { receipt: { id: "receipt_success" } } });
    const events = await repo.listRunEvents({ runId: "run_action" });
    const durable = JSON.stringify(events);
    expect(durable).not.toContain("access_token");
    expect(durable).not.toContain("Bearer secret");
    expect(durable).not.toContain("session=secret");
    expect(durable).not.toContain("hunter2");
    expect(durable).not.toContain("pem-data");
    const second = await claimedRepository();
    const secondLease = { runnerId: "runner_1", runId: "run_action", attemptId: second.claimed.attemptId, fencingToken: second.claimed.fencingToken };
    const secondAllowed = await second.repo.requestActionPermission({ ...secondLease, request: { toolCallId: "tool_secret_ref", title: "Read metadata", kind: "execute", permissionScopes: [], mode: "autonomous", provider: "connector" } });
    await expect(second.repo.recordMaterialActionReceipt({
      ...secondLease,
      actionId: secondAllowed!.action.id,
      receipt: { id: "receipt_secret_id", actionId: secondAllowed!.action.id, provider: "connector", receiptRef: "connector:operation:456", externalId: "password=hunter2", outcome: "succeeded", observedAt: "2026-07-12T00:02:00.000Z" }
    })).rejects.toThrow(/externalId.*credential-like/u);
    await expect(second.repo.recordMaterialActionReceipt({
      ...secondLease,
      actionId: secondAllowed!.action.id,
      receipt: { id: "receipt_secret", actionId: secondAllowed!.action.id, provider: "connector", receiptRef: "authorization=Bearer secret", outcome: "succeeded", observedAt: "2026-07-12T00:02:00.000Z" }
    })).rejects.toThrow(/credential-like/u);
    await expect(second.repo.recordMaterialActionReceipt({
      ...secondLease,
      actionId: secondAllowed!.action.id,
      receipt: {
        id: "receipt_evidence",
        actionId: secondAllowed!.action.id,
        provider: "connector",
        receiptRef: "connector:operation:789",
        outcome: "unknown",
        observedAt: "2026-07-12T00:02:00.000Z",
        evidence: [{ id: "ev_1", kind: "log", assurance: "reported", subjectRef: "op", summary: "done", createdAt: "2026-07-12T00:02:00.000Z" }]
      }
    })).rejects.toThrow(/evidence.*safe-list/u);
    expect(JSON.stringify(await second.repo.listRunEvents({ runId: "run_action" }))).not.toContain("Bearer secret");
  });

  it("stops automatic retry when the provider outcome is unknown", async () => {
    const { repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const request = { toolCallId: "tool_1", title: "Read metadata", kind: "execute", permissionScopes: [], mode: "autonomous" as const, provider: "acp" };
    const allowed = await repo.requestActionPermission({ ...lease, request });
    expect(allowed?.state).toBe("authorized");
    await repo.recordMaterialActionReceipt({
      ...lease,
      actionId: allowed!.action.id,
      receipt: { id: "receipt_unknown", actionId: allowed!.action.id, provider: "acp", receiptRef: "acp:tool_1", outcome: "unknown", observedAt: "2026-07-12T00:02:00.000Z" }
    });
    await expect(repo.requestActionPermission({ ...lease, request: { ...request, toolCallId: "tool_retry" } })).resolves.toMatchObject({ state: "unknown" });
  });

  it("never treats a generic ACP self-report as a trusted known outcome", async () => {
    const { repo, claimed } = await claimedRepository();
    const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
    const allowed = await repo.requestActionPermission({
      ...lease,
      request: { toolCallId: "tool_generic", title: "Execute remote action", kind: "execute", permissionScopes: [], mode: "autonomous", provider: "acp" }
    });
    await expect(repo.recordMaterialActionReceipt({
      ...lease,
      actionId: allowed!.action.id,
      receipt: { id: "receipt_generic", actionId: allowed!.action.id, provider: "acp", receiptRef: "acp:self-report", outcome: "succeeded", observedAt: "2026-07-12T00:02:00.000Z" }
    })).resolves.toMatchObject({ state: "unknown", action: { status: "unknown", receipt: { outcome: "unknown" } } });
  });

  it("downgrades a connector known outcome when either side lacks an exact target fingerprint", async () => {
    for (const missing of ["approved", "receipt"] as const) {
      const { repo, claimed } = await claimedRepository();
      const lease = { runnerId: "runner_1", runId: "run_action", attemptId: claimed.attemptId, fencingToken: claimed.fencingToken };
      const fingerprint = `sha256:${"f".repeat(64)}`;
      const allowed = await repo.requestActionPermission({
        ...lease,
        request: {
          toolCallId: `tool_missing_${missing}`, title: "Execute connector action", kind: "execute", provider: "connector",
          connectionId: "connector:team", operation: "write", resource: "report:123", permissionScopes: [], mode: "autonomous",
          ...(missing === "approved" ? {} : { targetFingerprint: fingerprint })
        }
      });
      await expect(repo.recordMaterialActionReceipt({
        ...lease,
        actionId: allowed!.action.id,
        receipt: {
          id: `receipt_missing_${missing}`, actionId: allowed!.action.id, provider: "connector", connectionId: "connector:team",
          ...(missing === "receipt" ? {} : { targetFingerprint: fingerprint }),
          receiptRef: `connector:missing:${missing}`, outcome: "succeeded", observedAt: "2026-07-12T00:02:00.000Z"
        }
      })).resolves.toMatchObject({ state: "unknown", action: { status: "unknown", receipt: { outcome: "unknown" } } });
    }
  });

  it("fences every executing material action to unknown when its Attempt terminates", async () => {
    for (const conclusion of ["success", "failure", "cancelled"] as const) {
      const fixture = await claimedRepository();
      const lease = { runnerId: "runner_1", runId: "run_action", attemptId: fixture.claimed.attemptId, fencingToken: fixture.claimed.fencingToken };
      const action = await fixture.repo.requestActionPermission({
        ...lease,
        request: { toolCallId: `tool_${conclusion}`, title: "Execute remote action", kind: "execute", permissionScopes: [], mode: "autonomous", provider: "acp" }
      });
      expect(action).toMatchObject({ state: "authorized", action: { status: "executing" } });
      await expect(fixture.repo.completeRun({ ...lease, result: { conclusion, summary: conclusion } })).resolves.toBe("completed");
      expect(fixture.sqlite.prepare("SELECT status FROM material_actions WHERE id = ?").get(action!.action.id)).toEqual({ status: "unknown" });
      await expect(fixture.repo.requestActionPermission({
        ...lease,
        request: { toolCallId: `retry_${conclusion}`, title: "Execute remote action", kind: "execute", permissionScopes: [], mode: "autonomous", provider: "acp" }
      })).resolves.toBeNull();
      const events = await fixture.repo.listRunEvents({ runId: "run_action" });
      expect(JSON.stringify(events)).not.toContain('"outcome":"succeeded"');
    }
  });
});
