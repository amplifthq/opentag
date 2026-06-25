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

  it("ignores malformed channel binding metadata instead of throwing", async () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    migrateSchema(sqlite);
    const repo = createOpenTagRepository(db);

    sqlite.exec(`
      INSERT INTO channel_bindings (
        provider,
        account_id,
        conversation_id,
        repo_provider,
        owner,
        repo,
        metadata_json,
        created_at
      ) VALUES (
        'telegram',
        'bot_123',
        'chat_456',
        'github',
        'acme',
        'demo',
        '{bad-json',
        '2026-06-25T00:00:00.000Z'
      );
    `);

    await expect(repo.getChannelBinding({ provider: "telegram", accountId: "bot_123", conversationId: "chat_456" })).resolves.toEqual({
      provider: "telegram",
      accountId: "bot_123",
      conversationId: "chat_456",
      repoProvider: "github",
      owner: "acme",
      repo: "demo"
    });
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
    expect(events.map((event) => event.type)).toContain("run.create_idempotent_replay");
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
    expect(events.map((event) => event.type)).toEqual(["run.created", "context_packet.generated", "run.completed"]);
    expect(events[0]).toMatchObject({ visibility: "audit", importance: "low" });
    expect(events[1]).toMatchObject({ visibility: "audit", importance: "normal", message: "run echo" });
    expect(events[2]).toMatchObject({ visibility: "audit", importance: "high", message: "done" });
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
        context: [{ kind: "github.issue", uri: "https://github.com/acme/demo/issues/2", visibility: "public" }],
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

    const plan = await repo.createApplyPlan({
      id: "apply_protocol",
      proposalId: "proposal_protocol",
      approvalDecisionId: "approval_protocol",
      adapter: "github"
    });
    expect(plan).toMatchObject({
      id: "apply_protocol",
      proposalId: "proposal_protocol",
      mode: "preflight_then_per_intent",
      outcomes: [{ intentId: "intent_label_bug", outcome: "skipped" }]
    });
    expect(plan?.outcomes?.[0]?.message).toContain("adapter execution is not implemented");

    await expect(repo.getApprovalDecision({ id: "approval_protocol" })).resolves.toMatchObject({ id: "approval_protocol" });
    await expect(repo.getApplyPlan({ id: "apply_protocol" })).resolves.toMatchObject({ id: "apply_protocol" });

    const events = await repo.listRunEvents({ runId: "run_protocol" });
    expect(events.map((event) => event.type)).toContain("proposal.snapshot.created");
    expect(events.map((event) => event.type)).toContain("approval.decision.recorded");
    expect(events.map((event) => event.type)).toContain("apply_plan.created");
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
      suggestedChangesCount: 1,
      approvalDecisionCount: 1,
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
      suggestedChangesCount: 1,
      approvalDecisionCount: 1,
      applyPlanCount: 1
    });
    const storedRun = await repo.getRun({ runId: "run_protocol" });
    const threadId = storedRun?.run.thread?.id;
    expect(threadId).toBeTruthy();
    await expect(repo.getWorkThreadMetrics({ threadId: threadId! })).resolves.toMatchObject({
      scope: "work_thread",
      scopeId: threadId,
      runCount: 1,
      suggestedChangesCount: 1,
      approvalDecisionCount: 1,
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
        context: [{ kind: "github.issue", uri: "https://github.com/acme/demo/issues/4", visibility: "public" }],
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
        context: [{ kind: "github.issue", uri: "https://github.com/acme/demo/issues/5", visibility: "public" }],
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
      context: [{ kind: "github.issue" as const, uri: "https://github.com/acme/demo/issues/3", visibility: "public" as const }],
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
