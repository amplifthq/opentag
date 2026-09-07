import {
  computeEffectPermitDigestV1,
  computeEffectTargetDigestV1,
  type EffectAcquireRequestV1,
  type EffectExecutePermitV1,
  type EffectViewV1,
} from "@opentag/core";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  LocalEffectJournalError,
  createLocalEffectJournalRepository,
} from "../src/effect-journal.js";
import { migratePairedRunnerSchema } from "../src/schema.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const T0 = new Date("2026-09-05T01:00:00.000Z");
const T1 = new Date("2026-09-05T01:01:00.000Z");
const T2 = new Date("2026-09-05T01:02:00.000Z");

function repository() {
  const sqlite = new Database(":memory:");
  migratePairedRunnerSchema(sqlite);
  return {
    sqlite,
    repo: createLocalEffectJournalRepository(drizzle(sqlite)),
  };
}

async function acquire(
  repo: ReturnType<typeof createLocalEffectJournalRepository>,
  input: { requestId?: string; runnerId?: string } = {},
) {
  return repo.createLocalEffectAcquire({
    requestId: input.requestId ?? "acquire_1",
    organizationId: "org_1",
    runnerId: input.runnerId ?? "runner_1",
    runnerGeneration: 2,
    now: T0,
  });
}

async function claim(
  repo: ReturnType<typeof createLocalEffectJournalRepository>,
  now = T0,
) {
  const claimed = await repo.claimNextRecoverableLocalEffectAttempt({
    organizationId: "org_1",
    runnerId: "runner_1",
    runnerGeneration: 2,
    leaseOwner: "test_executor",
    leaseSeconds: 600,
    now,
  });
  if (!claimed) throw new Error("expected local Effect attempt lease");
  return claimed;
}

async function permit(
  request: EffectAcquireRequestV1,
  overrides: Partial<EffectExecutePermitV1> = {},
): Promise<EffectExecutePermitV1> {
  const target = {
    projectTargetId: "target_1",
    targetBindingDigest: digest("a"),
    targetBindingGeneration: 4,
    provider: "github" as const,
    owner: "acme",
    repo: "demo",
    remote: "origin",
    baseBranch: "main",
    branch: "opentag/run_1",
    frozenBaseRevision: "b".repeat(40),
    workspaceTreeDigest: "c".repeat(40),
    expectedHeadSha: "d".repeat(40),
  };
  const digestInput = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
    permitId: "permit_1",
    permitKind: "execute" as const,
    effectId: "effect_1",
    effectAttemptNumber: 1,
    organizationId: request.organizationId,
    runnerId: request.runnerId,
    runnerGeneration: request.runnerGeneration,
    acquireRequestId: request.requestId,
    acquireJournalDigest: request.acquireJournalDigest,
    runId: "run_1",
    runAttemptId: "attempt_1",
    runAttemptNumber: 3,
    fencingTokenDigest: digest("e"),
    effectKind: "github.create_draft_pull_request" as const,
    requestDigest: digest("1"),
    targetDigest: await computeEffectTargetDigestV1(target),
    approvalDigest: digest("3"),
    candidate: { candidateId: "candidate_1", candidateDigest: digest("f") },
    target,
    issuedAt: "2026-09-05T01:00:00.000Z",
    expiresAt: "2026-09-05T01:05:00.000Z",
    ...overrides,
  };
  return { ...digestInput, permitDigest: await computeEffectPermitDigestV1(digestInput) };
}

function retryEligibleView(evidenceDigest: string): EffectViewV1 {
  return {
    effectId: "effect_1",
    effectKind: "github.create_draft_pull_request",
    state: "retry_eligible",
    currentAttemptNumber: 1,
    currentEvidenceDigest: evidenceDigest,
    reasonCode: "local.provider_io_not_begun",
    updatedAt: "2026-09-05T01:03:00.000Z",
  };
}

describe("Runner-local Effect journal", () => {
  it("persists an acquire before use, replays it exactly, and rejects identity reuse", async () => {
    const { sqlite, repo } = repository();
    const created = await acquire(repo);
    expect(created).toMatchObject({
      outcome: "created",
      attempt: { state: "acquire_pending", acquireRequestId: "acquire_1" },
    });
    expect(sqlite.prepare(`
      SELECT state, acquire_journal_digest AS acquireJournalDigest
      FROM local_effect_attempts WHERE acquire_request_id = ?
    `).get("acquire_1")).toEqual({
      state: "acquire_pending",
      acquireJournalDigest: created.attempt.acquireJournalDigest,
    });
    const columns = (sqlite.prepare(
      "PRAGMA table_info(local_effect_attempts)",
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(columns).toEqual(expect.arrayContaining([
      "permit_kind",
      "permit_id",
      "effect_id",
      "effect_attempt_number",
      "local_journal_digest",
      "permit_json",
    ]));
    expect(columns).not.toEqual(expect.arrayContaining([
      "permit_digest",
      "effect_kind",
      "effect_request_digest",
      "run_id",
      "run_attempt_id",
      "run_attempt_number",
      "fencing_token_digest",
      "project_target_id",
      "target_digest",
      "approval_digest",
    ]));

    await expect(acquire(repo)).resolves.toMatchObject({
      outcome: "replayed",
      attempt: { acquireJournalDigest: created.attempt.acquireJournalDigest },
    });
    await expect(acquire(repo, { runnerId: "runner_2" })).rejects.toMatchObject({
      code: "LOCAL_EFFECT_ACQUIRE_CONFLICT",
    });
    sqlite.close();
  });

  it("accepts only the permit bound to the durable acquire and rejects journal loss", async () => {
    const { sqlite, repo } = repository();
    const created = await acquire(repo);
    const leased = await claim(repo);
    const exactPermit = await permit(created.attempt.acquireRequest);
    await expect(repo.acceptLocalEffectPermit({
      acquireRequestId: "acquire_1",
      permit: exactPermit,
      leaseToken: leased.leaseToken,
      now: T1,
    })).resolves.toMatchObject({ outcome: "accepted", attempt: { state: "permit_accepted" } });
    await expect(repo.acceptLocalEffectPermit({
      acquireRequestId: "acquire_1",
      permit: exactPermit,
      leaseToken: leased.leaseToken,
      now: T2,
    })).resolves.toMatchObject({ outcome: "replayed" });

    const secondStore = repository();
    const second = await acquire(secondStore.repo, { requestId: "acquire_2" });
    const secondLease = await claim(secondStore.repo);
    const wrongBinding = await permit(second.attempt.acquireRequest, {
      acquireJournalDigest: created.attempt.acquireJournalDigest,
    });
    await expect(secondStore.repo.acceptLocalEffectPermit({
      acquireRequestId: "acquire_2",
      permit: wrongBinding,
      leaseToken: secondLease.leaseToken,
      now: T1,
    })).rejects.toMatchObject({ code: "LOCAL_EFFECT_PERMIT_INVALID" });

    await expect(repo.acceptLocalEffectPermit({
      acquireRequestId: "missing_acquire",
      permit: await permit({
        ...second.attempt.acquireRequest,
        requestId: "missing_acquire",
      }),
      leaseToken: "missing_lease",
    })).rejects.toEqual(new LocalEffectJournalError("LOCAL_EFFECT_JOURNAL_MISSING"));
    secondStore.sqlite.close();
    sqlite.close();
  });

  it("allows only one live executor lease and fences the expired owner", async () => {
    const { sqlite, repo } = repository();
    const created = await acquire(repo);
    const first = await repo.claimNextRecoverableLocalEffectAttempt({
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 2,
      leaseOwner: "executor_1",
      leaseSeconds: 30,
      now: T0,
    });
    expect(first).not.toBeNull();
    await expect(acquire(repo, { requestId: "acquire_2" })).resolves.toMatchObject({
      outcome: "active",
      attempt: { acquireRequestId: "acquire_1" },
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM local_effect_attempts").get())
      .toEqual({ count: 1 });
    await expect(repo.claimNextRecoverableLocalEffectAttempt({
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 2,
      leaseOwner: "executor_2",
      leaseSeconds: 30,
      now: new Date(T0.getTime() + 10_000),
    })).resolves.toBeNull();
    await expect(repo.claimNextRecoverableLocalEffectAttempt({
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 2,
      leaseOwner: "executor_2",
      leaseSeconds: 30,
      now: T1,
    })).resolves.not.toBeNull();
    // T1 is after the 30-second first lease, so executor_2 owns the recovery.
    const recovered = await repo.getLocalEffectAttempt("acquire_1");
    expect(recovered).toMatchObject({ state: "acquire_pending" });
    const exactPermit = await permit(created.attempt.acquireRequest);
    await expect(repo.acceptLocalEffectPermit({
      acquireRequestId: "acquire_1",
      permit: exactPermit,
      leaseToken: first!.leaseToken,
      now: T1,
    })).rejects.toMatchObject({ code: "LOCAL_EFFECT_STATE_CONFLICT" });
    sqlite.close();
  });

  it("freezes provider I/O before evidence and preserves an unknown outcome", async () => {
    const { sqlite, repo } = repository();
    const created = await acquire(repo);
    const leased = await claim(repo);
    const exactPermit = await permit(created.attempt.acquireRequest);
    await repo.acceptLocalEffectPermit({ acquireRequestId: "acquire_1", permit: exactPermit,
      leaseToken: leased.leaseToken, now: T0 });
    await expect(repo.markLocalEffectProviderIoBegun({
      acquireRequestId: "acquire_1",
      permitId: exactPermit.permitId,
      leaseToken: leased.leaseToken,
      leaseSeconds: 600,
      now: T1,
    })).resolves.toBe("begun");
    await expect(repo.markLocalEffectProviderIoBegun({
      acquireRequestId: "acquire_1",
      permitId: exactPermit.permitId,
      leaseToken: leased.leaseToken,
      leaseSeconds: 600,
      now: T1,
    })).resolves.toBe("already_begun");

    const sealed = await repo.sealLocalEffectEvidence({
      acquireRequestId: "acquire_1",
      evidence: { kind: "ambiguous", errorCode: "provider_timeout" },
      leaseToken: leased.leaseToken,
      observedAt: T2,
    });
    expect(sealed.attempt).toMatchObject({
      state: "evidence_pending",
      evidence: { evidence: { kind: "ambiguous", errorCode: "provider_timeout" } },
    });
    const evidenceDigest = sealed.attempt.evidence!.evidenceDigest;
    const unknown: EffectViewV1 = {
      effectId: exactPermit.effectId,
      effectKind: exactPermit.effectKind,
      state: "outcome_unknown",
      currentAttemptNumber: exactPermit.effectAttemptNumber,
      currentEvidenceDigest: evidenceDigest,
      reasonCode: "github.provider_timeout",
      updatedAt: "2026-09-05T01:03:00.000Z",
    };
    await expect(repo.acknowledgeLocalEffectEvidence({
      acquireRequestId: "acquire_1",
      view: unknown,
      leaseToken: leased.leaseToken,
      now: new Date("2026-09-05T01:03:00.000Z"),
    })).resolves.toMatchObject({
      outcome: "attention",
      attempt: { state: "attention", attentionReasonCode: "control.outcome_unknown.github.provider_timeout" },
    });
    await expect(repo.pruneAcknowledgedLocalEffectAttempts({
      now: new Date("2027-01-01T00:00:00.000Z"),
    })).resolves.toEqual({ pruned: 0, acquireRequestIds: [] });
    expect(sqlite.prepare("SELECT state FROM local_effect_attempts").get()).toEqual({ state: "attention" });
    sqlite.close();
  });

  it("records not-started recovery and prunes only safely acknowledged rows", async () => {
    const { sqlite, repo } = repository();
    const created = await acquire(repo);
    const leased = await claim(repo);
    const exactPermit = await permit(created.attempt.acquireRequest);
    const accepted = await repo.acceptLocalEffectPermit({
      acquireRequestId: "acquire_1",
      permit: exactPermit,
      leaseToken: leased.leaseToken,
      now: T0,
    });
    const sealed = await repo.sealLocalEffectEvidence({
      acquireRequestId: "acquire_1",
      evidence: {
        kind: "not_started",
        acquireJournalDigest: accepted.attempt.acquireJournalDigest,
        localJournalDigest: accepted.attempt.localJournalDigest!,
        reason: "provider_io_not_begun",
      },
      leaseToken: leased.leaseToken,
      observedAt: T1,
    });
    await repo.acknowledgeLocalEffectEvidence({
      acquireRequestId: "acquire_1",
      view: retryEligibleView(sealed.attempt.evidence!.evidenceDigest),
      leaseToken: leased.leaseToken,
      now: T2,
    });
    await expect(repo.pruneAcknowledgedLocalEffectAttempts({
      now: new Date("2026-09-12T01:02:00.001Z"),
    })).resolves.toEqual({ pruned: 1, acquireRequestIds: ["acquire_1"] });
    expect(sqlite.prepare("SELECT count(*) AS count FROM local_effect_attempts").get())
      .toEqual({ count: 0 });
    sqlite.close();
  });

  it("rejects provider observations captured before the I/O boundary", async () => {
    const { sqlite, repo } = repository();
    const created = await acquire(repo);
    const leased = await claim(repo);
    const exactPermit = await permit(created.attempt.acquireRequest);
    await repo.acceptLocalEffectPermit({
      acquireRequestId: "acquire_1",
      permit: exactPermit,
      leaseToken: leased.leaseToken,
      now: T0,
    });
    await repo.markLocalEffectProviderIoBegun({
      acquireRequestId: "acquire_1",
      permitId: exactPermit.permitId,
      leaseToken: leased.leaseToken,
      leaseSeconds: 600,
      now: T1,
    });
    await expect(repo.sealLocalEffectEvidence({
      acquireRequestId: "acquire_1",
      leaseToken: leased.leaseToken,
      evidence: {
        kind: "absent",
        observationScope: {
          provider: "github",
          repository: { owner: "acme", repo: "demo" },
          baseBranch: "main",
          headBranch: "opentag/run_1",
          expectedHeadSha: "d".repeat(40),
          bindingGeneration: 4,
          targetBindingDigest: digest("a"),
          observationPolicy: "github.exact_draft_pr.v1",
          observedAt: T0.toISOString(),
        },
      },
      observedAt: T2,
    })).rejects.toMatchObject({ code: "LOCAL_EFFECT_EVIDENCE_INVALID" });
    sqlite.close();
  });
});
