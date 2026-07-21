import type {
  CompletionAssessment,
  CompletionContract,
  HumanEscalation,
  OpenTagEvent,
  WorkThread
} from "@opentag/core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createOpenTagRepository } from "../src/repository.js";
import { migrateSchema } from "../src/schema.js";

const timestamp = "2026-07-21T10:00:00.000Z";

function workThread(input: { id?: string; anchorId: string }): WorkThread {
  return {
    ...(input.id ? { id: input.id } : {}),
    workItemReference: {
      provider: "github",
      kind: "issue",
      externalId: "acme/demo#42",
      uri: "https://github.com/acme/demo/issues/42",
      ownerContainer: {
        provider: "github",
        id: "acme/demo",
        uri: "https://github.com/acme/demo"
      }
    },
    primaryAnchor: {
      provider: "github",
      kind: "issue_comment",
      externalId: input.anchorId,
      uri: `https://github.com/acme/demo/issues/42#${input.anchorId}`,
      threadKey: "acme/demo#42"
    }
  };
}

function githubEvent(id: string, sourceEventId: string): OpenTagEvent {
  return {
    id,
    source: "github",
    sourceEventId,
    receivedAt: timestamp,
    actor: { provider: "github", providerUserId: "user-1", handle: "octocat" },
    target: { mention: "@opentag", agentId: "opentag" },
    command: { rawText: "fix this", intent: "fix", args: {} },
    context: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/42", visibility: "public" }],
    workItem: workThread({ anchorId: "comment-1" }).workItemReference,
    permissions: [],
    callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/42/comments", threadKey: "acme/demo#42" },
    metadata: { owner: "acme", repo: "demo", issueNumber: 42 }
  };
}

function strictContract(workThreadId: string): CompletionContract {
  return {
    id: "contract-1",
    version: 1,
    workThreadId,
    cycle: 1,
    mode: "governed",
    targetSelectors: [{ key: "primary_change", kind: "change_request", lineage: "current_cycle", cardinality: "exactly_one" }],
    resolvedFrom: [{ scope: "work_context_owner_container", ref: "github:acme/demo", version: "1" }],
    gates: [
      { id: "pr", kind: "artifact", targetKey: "primary_change", artifactKind: "pull_request", minimum: 1 },
      { id: "checks", kind: "verification", targetKey: "primary_change", evidenceKind: "source_control.required_checks", requiredOutcome: "passed", minimumAssurance: "verified" },
      { id: "merge", kind: "external_state", targetKey: "primary_change", provider: "github", requiredState: "merged", minimumAssurance: "verified" }
    ],
    maxAutomaticRetries: 1,
    onSatisfied: "report_only",
    createdAt: timestamp
  };
}

function assessment(input: {
  id: string;
  workThreadId: string;
  sequence: number;
  digestChar: string;
  supersedesAssessmentId?: string;
  state?: CompletionAssessment["state"];
  acceptedAt?: string;
}): CompletionAssessment {
  return {
    id: input.id,
    workThreadId: input.workThreadId,
    contractId: "contract-1",
    contractVersion: 1,
    cycle: 1,
    sequence: input.sequence,
    inputDigest: `sha256:${input.digestChar.repeat(64)}`,
    targetBindings: [{
      key: "primary_change",
      provider: "github",
      resourceRef: "github:acme/demo:pull_request:7",
      resourceVersion: "abc123",
      artifactId: "artifact-pr-7"
    }],
    state: input.state ?? "pending",
    evidenceBacked: true,
    gateResults: [{
      gateId: "checks",
      targetKey: "primary_change",
      state: "missing",
      evidenceIds: [],
      reasonCode: "verification_missing",
      reason: "Required check evidence has not arrived.",
      evaluatedAt: timestamp
    }],
    assessedAt: timestamp,
    assessedBy: "opentag",
    ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
    ...(input.supersedesAssessmentId ? { supersedesAssessmentId: input.supersedesAssessmentId } : {})
  };
}

function repository() {
  const sqlite = new Database(":memory:");
  migrateSchema(sqlite);
  return { sqlite, repo: createOpenTagRepository(drizzle(sqlite)) };
}

describe("completion governance persistence", () => {
  it("adds the governance migration to a legacy database and remains restart-safe", () => {
    const sqlite = new Database(":memory:");
    migrateSchema(sqlite);
    sqlite.exec(`
      DELETE FROM opentag_schema_migrations WHERE id = '2026-07-21-completion-governance-v1';
      DROP TABLE governance_events;
      DROP TABLE human_escalations;
      DROP TABLE completion_assessments;
      DROP TABLE verification_evidence;
      DROP TABLE completion_contracts;
      DROP TABLE work_threads;
    `);

    expect(() => migrateSchema(sqlite)).not.toThrow();
    expect(() => migrateSchema(sqlite)).not.toThrow();

    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      "work_threads",
      "completion_contracts",
      "verification_evidence",
      "completion_assessments",
      "human_escalations",
      "governance_events"
    ]));
    const migration = sqlite.prepare("SELECT id FROM opentag_schema_migrations WHERE id = ?").get("2026-07-21-completion-governance-v1");
    expect(migration).toBeTruthy();
  });

  it("reuses one durable WorkThread across anchors and attaches created runs", async () => {
    const { repo } = repository();
    const first = await repo.upsertWorkThread({ thread: workThread({ id: "legacy-anchor-derived", anchorId: "comment-1" }) });
    const second = await repo.upsertWorkThread({ thread: workThread({ id: "different-anchor-derived", anchorId: "comment-2" }) });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.thread.id).toBe(first.thread.id);
    expect(second.thread.secondaryAnchors).toHaveLength(1);

    const created = await repo.createRun({ id: "run-1", event: githubEvent("event-1", "delivery-1") });
    expect(created.run.thread?.id).toBe(first.thread.id);
    expect((await repo.getRun({ runId: "run-1" }))?.run.thread?.id).toBe(first.thread.id);
  });

  it("keeps contract snapshots immutable and evidence replay-safe", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-1" }) })).thread;
    const contract = strictContract(thread.id);

    await expect(repo.recordCompletionContract({ contract })).resolves.toMatchObject({ created: true });
    await expect(repo.recordCompletionContract({ contract })).resolves.toMatchObject({ created: false });
    await expect(repo.recordCompletionContract({ contract: { ...contract, maxAutomaticRetries: 2 } })).rejects.toThrow(/immutable/u);

    const evidenceInput = {
      workThreadId: thread.id,
      provider: "github",
      deliveryId: "delivery-checks-1",
      subjectRef: "github:acme/demo:pull_request:7",
      subjectVersion: "abc123",
      evidence: {
        id: "evidence-checks-1",
        kind: "source_control.required_checks",
        assurance: "verified" as const,
        subjectRef: "github:acme/demo:pull_request:7:head:abc123",
        summary: "Configured required checks passed for the current head.",
        createdAt: timestamp
      },
      observedAt: timestamp,
      receivedAt: timestamp
    };
    await expect(repo.recordVerificationEvidence(evidenceInput)).resolves.toMatchObject({ created: true });
    await expect(repo.recordVerificationEvidence(evidenceInput)).resolves.toMatchObject({ created: false });
    await expect(repo.recordVerificationEvidence({
      ...evidenceInput,
      payloadDigest: `sha256:${"f".repeat(64)}`
    })).rejects.toThrow(/conflicts/u);
    await expect(repo.listVerificationEvidence({ workThreadId: thread.id })).resolves.toHaveLength(1);
  });

  it("records a reconciled evidence batch atomically and idempotently", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-batch" }) })).thread;
    const records = ["source_control.pull_request", "source_control.required_checks"].map((kind, index) => ({
      id: `evidence-batch-${index}`,
      workThreadId: thread.id,
      provider: "github",
      deliveryId: "delivery-batch-1",
      subjectRef: "github:acme/demo:pull_request:7",
      subjectVersion: "abc123",
      evidence: {
        id: `evidence-batch-${index}`,
        kind,
        assurance: "verified" as const,
        subjectRef: "github:acme/demo:pull_request:7@abc123",
        summary: `${kind}=verified`,
        createdAt: timestamp
      },
      payloadDigest: `sha256:${String(index + 1).repeat(64)}`,
      observedAt: timestamp,
      receivedAt: timestamp
    }));

    await expect(repo.recordVerificationEvidenceBatch({ records })).resolves.toMatchObject({ created: 2 });
    await expect(repo.recordVerificationEvidenceBatch({ records })).resolves.toMatchObject({ created: 0 });
    await expect(repo.listVerificationEvidence({ workThreadId: thread.id })).resolves.toHaveLength(2);

    const { repo: rollbackRepo } = repository();
    const rollbackThread = (await rollbackRepo.upsertWorkThread({ thread: workThread({ anchorId: "comment-rollback" }) })).thread;
    const conflictingIds = records.map((record, index) => ({
      ...record,
      id: "same-primary-key",
      workThreadId: rollbackThread.id,
      deliveryId: "delivery-batch-rollback",
      evidence: { ...record.evidence, id: "same-primary-key", kind: `kind-${index}` }
    }));
    await expect(rollbackRepo.recordVerificationEvidenceBatch({ records: conflictingIds })).rejects.toThrow();
    await expect(rollbackRepo.listVerificationEvidence({ workThreadId: rollbackThread.id })).resolves.toHaveLength(0);
  });

  it("appends one monotonic assessment lineage and rejects a stale head", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-1" }) })).thread;
    await repo.recordCompletionContract({ contract: strictContract(thread.id) });

    const first = assessment({ id: "assessment-1", workThreadId: thread.id, sequence: 1, digestChar: "a" });
    const second = assessment({ id: "assessment-2", workThreadId: thread.id, sequence: 2, digestChar: "b", supersedesAssessmentId: first.id });
    const staleCompetitor = assessment({ id: "assessment-stale", workThreadId: thread.id, sequence: 2, digestChar: "c", supersedesAssessmentId: first.id });

    await expect(repo.appendCompletionAssessment({ assessment: first, expectedCurrentAssessmentId: null })).resolves.toMatchObject({ outcome: "recorded" });
    await expect(repo.appendCompletionAssessment({ assessment: first, expectedCurrentAssessmentId: null })).resolves.toMatchObject({ outcome: "duplicate" });
    await expect(repo.appendCompletionAssessment({ assessment: second, expectedCurrentAssessmentId: first.id })).resolves.toMatchObject({ outcome: "recorded" });
    await expect(repo.appendCompletionAssessment({ assessment: staleCompetitor, expectedCurrentAssessmentId: first.id })).resolves.toMatchObject({
      outcome: "conflict",
      currentAssessment: { id: second.id }
    });

    await expect(repo.listCompletionAssessments({ workThreadId: thread.id })).resolves.toEqual([first, second]);
    await expect(repo.getCurrentCompletionAssessment({ workThreadId: thread.id })).resolves.toEqual(second);
  });

  it("records the completion metric exactly once at the first accepted transition", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-metric" }) })).thread;
    await repo.recordCompletionContract({ contract: strictContract(thread.id) });
    const pending = assessment({ id: "assessment-metric-pending", workThreadId: thread.id, sequence: 1, digestChar: "d" });
    const acceptedAt = "2026-07-21T10:05:00.000Z";
    const accepted = assessment({
      id: "assessment-metric-accepted",
      workThreadId: thread.id,
      sequence: 2,
      digestChar: "e",
      supersedesAssessmentId: pending.id,
      state: "satisfied",
      acceptedAt
    });
    const stillAccepted = assessment({
      id: "assessment-metric-still-accepted",
      workThreadId: thread.id,
      sequence: 3,
      digestChar: "f",
      supersedesAssessmentId: accepted.id,
      state: "satisfied",
      acceptedAt
    });

    await repo.appendCompletionAssessment({ assessment: pending, expectedCurrentAssessmentId: null });
    await repo.appendCompletionAssessment({ assessment: accepted, expectedCurrentAssessmentId: pending.id });
    await repo.appendCompletionAssessment({ assessment: stillAccepted, expectedCurrentAssessmentId: accepted.id });

    const metrics = (await repo.listGovernanceEvents({ workThreadId: thread.id }))
      .filter((event) => event.type === "success_metric.observed");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      subjectId: accepted.id,
      createdAt: acceptedAt,
      payload: {
        metric: "time_to_verified_completion_ms",
        acceptedAt,
        state: "satisfied",
        evidenceBacked: true
      }
    });
  });

  it("loads durable material receipts for a WorkThread with their governed action family", async () => {
    const { sqlite, repo } = repository();
    const created = await repo.createRun({ id: "run-receipt", event: githubEvent("event-receipt", "delivery-receipt") });
    const workThreadId = created.run.thread!.id;
    const receipt = {
      id: "receipt-release-1",
      actionId: "action-release-1",
      provider: "github",
      receiptRef: "github:release:1",
      outcome: "succeeded",
      observedAt: timestamp
    };
    sqlite.prepare(`
      INSERT INTO material_actions (
        id, run_id, attempt_id, action_family, capability, scope_json, target_json,
        risk_tier, status, idempotency_key, attempt_fence_digest, receipt_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receipt.actionId,
      created.run.id,
      "attempt-receipt",
      "release",
      "release:publish",
      "{}",
      "{}",
      "high",
      "succeeded",
      "release-once",
      `sha256:${"a".repeat(64)}`,
      JSON.stringify(receipt),
      timestamp,
      timestamp
    );

    await expect(repo.listMaterialActionReceiptsForWorkThread({ workThreadId })).resolves.toEqual([{
      ...receipt,
      metadata: { actionFamily: "release" }
    }]);
  });

  it("deduplicates active human escalations and retains attributed resolution", async () => {
    const { repo } = repository();
    const thread = (await repo.upsertWorkThread({ thread: workThread({ anchorId: "comment-1" }) })).thread;
    const open: HumanEscalation = {
      id: "escalation-1",
      workThreadId: thread.id,
      class: "verification",
      audience: "repo_owner",
      subjectRef: "github:acme/demo:pull_request:7",
      state: "open",
      blocking: true,
      summary: "Required check evidence is unavailable.",
      reason: "The configured check has not reported for the current head.",
      dedupeKey: "verification:checks:primary_change",
      openedAt: timestamp
    };
    const duplicate = { ...open, id: "escalation-duplicate" };

    await expect(repo.openHumanEscalation({ escalation: open })).resolves.toMatchObject({ created: true });
    await expect(repo.openHumanEscalation({ escalation: duplicate })).resolves.toMatchObject({
      created: false,
      escalation: { id: open.id }
    });

    const resolved: HumanEscalation = {
      ...open,
      state: "resolved",
      resolution: {
        actor: { provider: "github", providerUserId: "owner-1", handle: "repo-owner" },
        reason: "Repository check configuration repaired.",
        resolvedAt: "2026-07-21T10:05:00.000Z"
      }
    };
    await expect(repo.resolveHumanEscalation({ escalation: resolved })).resolves.toMatchObject({ resolved: true });
    await expect(repo.resolveHumanEscalation({ escalation: resolved })).resolves.toMatchObject({ resolved: false });
    await expect(repo.listHumanEscalations({ workThreadId: thread.id })).resolves.toEqual([resolved]);

    const events = await repo.listGovernanceEvents({ workThreadId: thread.id });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "work_thread.created",
      "human_escalation.opened",
      "human_escalation.resolved"
    ]));
  });
});
