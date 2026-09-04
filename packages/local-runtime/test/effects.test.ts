import type { OpenTagClient } from "@opentag/client";
import {
  computeEffectPermitDigestV1,
  computeEffectTargetDigestV1,
  type EffectAcquireRequestV1,
  type EffectEvidenceEnvelopeV1,
  type EffectExecutePermitV1,
  type EffectReconciliationPermitV1,
  type EffectViewV1,
} from "@opentag/control-protocol";
import {
  createLocalEffectJournalRepository,
  migratePairedRunnerSchema,
} from "@opentag/store";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  LocalEffectExecutor,
  type GitHubDraftPullRequestEffectAdapter,
  type LocalEffectAuthorityClient,
} from "../src/effects/index.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const NOW = new Date("2026-09-05T01:01:00.000Z");

function fixture() {
  const sqlite = new Database(":memory:");
  migratePairedRunnerSchema(sqlite);
  return { sqlite, repository: createLocalEffectJournalRepository(drizzle(sqlite)) };
}

async function claim(
  repository: ReturnType<typeof createLocalEffectJournalRepository>,
  leaseSeconds = 1,
) {
  const claimed = await repository.claimNextRecoverableLocalEffectAttempt({
    organizationId: "org_1",
    runnerId: "runner_1",
    runnerGeneration: 2,
    leaseOwner: "prior_executor",
    leaseSeconds,
    now: NOW,
  });
  if (!claimed) throw new Error("expected local Effect attempt lease");
  return claimed;
}

async function permit(request: EffectAcquireRequestV1): Promise<EffectExecutePermitV1> {
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
  };
  return { ...digestInput, permitDigest: await computeEffectPermitDigestV1(digestInput) };
}

async function reconciliationPermit(
  request: EffectAcquireRequestV1,
): Promise<EffectReconciliationPermitV1> {
  const execute = await permit(request);
  const { permitDigest: _permitDigest, ...executeInput } = execute;
  const digestInput = {
    ...executeInput,
    permitId: "permit_2",
    permitKind: "reconcile" as const,
    effectAttemptNumber: 2,
    originalExecutePermitId: "permit_1",
    predecessorEvidenceDigest: digest("9"),
    observationPolicy: "github.exact_draft_pr.v1" as const,
  };
  return { ...digestInput, permitDigest: await computeEffectPermitDigestV1(digestInput) };
}

function view(
  evidence: EffectEvidenceEnvelopeV1,
  state: "attention" | "outcome_unknown",
): EffectViewV1 {
  return state === "attention"
    ? {
        effectId: evidence.effectId,
        effectKind: "github.create_draft_pull_request",
        state,
        currentAttemptNumber: evidence.effectAttemptNumber,
        currentEvidenceDigest: evidence.evidenceDigest,
        reasonCode: "github.absent_after_outcome_unknown",
        updatedAt: "2026-09-05T01:02:00.000Z",
      }
    : {
        effectId: evidence.effectId,
        effectKind: "github.create_draft_pull_request",
        state,
        currentAttemptNumber: evidence.effectAttemptNumber,
        currentEvidenceDigest: evidence.evidenceDigest,
        reasonCode: "github.provider_timeout",
        updatedAt: "2026-09-05T01:02:00.000Z",
      };
}

function notStartedAcceptedView(evidence: EffectEvidenceEnvelopeV1): EffectViewV1 {
  return {
    effectId: evidence.effectId,
    effectKind: "github.create_draft_pull_request",
    state: "retry_eligible",
    currentAttemptNumber: evidence.effectAttemptNumber,
    currentEvidenceDigest: evidence.evidenceDigest,
    reasonCode: "local.provider_io_not_begun",
    updatedAt: "2026-09-05T01:02:00.000Z",
  };
}

function client(input: {
  acquire(request: EffectAcquireRequestV1): Promise<EffectExecutePermitV1 | null>;
  record(evidence: EffectEvidenceEnvelopeV1): Promise<EffectViewV1>;
}): LocalEffectAuthorityClient {
  return {
    acquireEffectControlV1: input.acquire,
    recordEffectEvidenceControlV1: input.record,
  } as Pick<OpenTagClient, "acquireEffectControlV1" | "recordEffectEvidenceControlV1">;
}

function options(input: {
  repository: ReturnType<typeof createLocalEffectJournalRepository>;
  client: LocalEffectAuthorityClient;
  adapter: GitHubDraftPullRequestEffectAdapter;
  acquireRequestId?: () => string;
  isWorkAuthorityCurrent?: () => Promise<boolean>;
  now?: () => Date;
  leaseOwner?: string;
}) {
  return {
    organizationId: "org_1",
    runnerId: "runner_1",
    runnerGeneration: 2,
    now: input.now ?? (() => NOW),
    isWorkAuthorityCurrent: input.isWorkAuthorityCurrent ?? (async () => true),
    ...input,
  };
}

describe("LocalEffectExecutor", () => {
  it("persists acquire and provider-I/O boundaries before calling either authority", async () => {
    const { sqlite, repository } = fixture();
    const createDraftPullRequest = vi.fn(async () => {
      await expect(repository.getLocalEffectAttempt("acquire_1")).resolves.toMatchObject({
        state: "provider_io_begun",
      });
      return { kind: "ambiguous" as const, errorCode: "provider_timeout" as const };
    });
    const record = vi.fn(async (evidence: EffectEvidenceEnvelopeV1) => {
      await expect(repository.getLocalEffectAttempt("acquire_1")).resolves.toMatchObject({
        state: "evidence_pending",
        evidence,
      });
      return view(evidence, "outcome_unknown");
    });
    let acquireNumber = 0;
    const acquirePermit = vi.fn(async (request: EffectAcquireRequestV1) => {
      await expect(repository.getLocalEffectAttempt(request.requestId)).resolves.toMatchObject({
        state: "acquire_pending",
        acquireRequest: request,
      });
      return acquireNumber++ === 0 ? permit(request) : null;
    });
    const adapter = {
      createDraftPullRequest,
      observeDraftPullRequest: vi.fn(),
    } satisfies GitHubDraftPullRequestEffectAdapter;
    const executor = new LocalEffectExecutor(options({
      repository,
      client: client({ acquire: acquirePermit, record }),
      adapter,
      acquireRequestId: () => `acquire_${acquireNumber + 1}`,
    }));

    await expect(executor.runOnce()).resolves.toMatchObject({ outcome: "attention" });
    expect(createDraftPullRequest).toHaveBeenCalledTimes(1);
    await expect(executor.runOnce()).resolves.toEqual({ outcome: "idle" });
    expect(createDraftPullRequest).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT state FROM local_effect_attempts").all())
      .toEqual([{ state: "attention" }]);
    sqlite.close();
  });

  it("replays the identical sealed evidence after upload loss without mutating again", async () => {
    const { sqlite, repository } = fixture();
    const envelopes: EffectEvidenceEnvelopeV1[] = [];
    const createDraftPullRequest = vi.fn(async () => ({
      kind: "ambiguous" as const,
      errorCode: "provider_timeout" as const,
    }));
    const record = vi.fn(async (evidence: EffectEvidenceEnvelopeV1) => {
      envelopes.push(evidence);
      if (envelopes.length === 1) throw new Error("injected upload loss");
      return view(evidence, "outcome_unknown");
    });
    let currentTime = NOW;
    const executor = new LocalEffectExecutor(options({
      repository,
      client: client({ acquire: async (request) => permit(request), record }),
      adapter: { createDraftPullRequest, observeDraftPullRequest: vi.fn() },
      acquireRequestId: () => "acquire_1",
      now: () => currentTime,
    }));

    await expect(executor.runOnce()).rejects.toThrow("injected upload loss");
    currentTime = new Date(NOW.getTime() + 61_000);
    await expect(executor.runOnce()).resolves.toMatchObject({ outcome: "attention" });
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]).toEqual(envelopes[0]);
    expect(createDraftPullRequest).toHaveBeenCalledTimes(1);
    sqlite.close();
  });

  it("reports not_started after restart before the provider-I/O marker", async () => {
    const { sqlite, repository } = fixture();
    const created = await repository.createLocalEffectAcquire({
      requestId: "acquire_1",
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 2,
      now: NOW,
    });
    const leased = await claim(repository);
    await repository.acceptLocalEffectPermit({
      acquireRequestId: created.attempt.acquireRequestId,
      permit: await permit(created.attempt.acquireRequest),
      leaseToken: leased.leaseToken,
      now: NOW,
    });
    const record = vi.fn(async (evidence: EffectEvidenceEnvelopeV1) => {
      expect(evidence.evidence).toMatchObject({
        kind: "not_started",
        reason: "provider_io_not_begun",
      });
      return notStartedAcceptedView(evidence);
    });
    const adapter = {
      createDraftPullRequest: vi.fn(),
      observeDraftPullRequest: vi.fn(),
    } satisfies GitHubDraftPullRequestEffectAdapter;
    const executor = new LocalEffectExecutor(options({
      repository,
      client: client({ acquire: vi.fn(), record }),
      adapter,
      now: () => new Date(NOW.getTime() + 2_000),
    }));

    await expect(executor.runOnce()).resolves.toMatchObject({ outcome: "acknowledged" });
    expect(adapter.createDraftPullRequest).not.toHaveBeenCalled();
    expect(adapter.observeDraftPullRequest).not.toHaveBeenCalled();
    sqlite.close();
  });

  it("uses observation only after restart past the provider-I/O marker", async () => {
    const { sqlite, repository } = fixture();
    const created = await repository.createLocalEffectAcquire({
      requestId: "acquire_1",
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 2,
      now: NOW,
    });
    const effectPermit = await permit(created.attempt.acquireRequest);
    const leased = await claim(repository);
    await repository.acceptLocalEffectPermit({
      acquireRequestId: created.attempt.acquireRequestId,
      permit: effectPermit,
      leaseToken: leased.leaseToken,
      now: NOW,
    });
    await repository.markLocalEffectProviderIoBegun({
      acquireRequestId: created.attempt.acquireRequestId,
      permitId: effectPermit.permitId,
      leaseToken: leased.leaseToken,
      leaseSeconds: 1,
      now: NOW,
    });
    const adapter = {
      createDraftPullRequest: vi.fn(),
      observeDraftPullRequest: vi.fn(async () => ({
        kind: "absent" as const,
        observationScope: {
          provider: "github" as const,
          repository: { owner: effectPermit.target.owner, repo: effectPermit.target.repo },
          baseBranch: effectPermit.target.baseBranch,
          headBranch: effectPermit.target.branch,
          expectedHeadSha: effectPermit.target.expectedHeadSha,
          bindingGeneration: effectPermit.target.targetBindingGeneration,
          targetBindingDigest: effectPermit.target.targetBindingDigest,
          observationPolicy: "github.exact_draft_pr.v1" as const,
          observedAt: new Date(NOW.getTime() + 2_000).toISOString(),
        },
      })),
    } satisfies GitHubDraftPullRequestEffectAdapter;
    const executor = new LocalEffectExecutor(options({
      repository,
      client: client({
        acquire: vi.fn(),
        record: async (evidence) => {
          expect(evidence.evidence).toEqual({
            kind: "ambiguous",
            errorCode: "provider_receipt_missing",
          });
          return view(evidence, "outcome_unknown");
        },
      }),
      adapter,
      now: () => new Date(NOW.getTime() + 2_000),
    }));

    await expect(executor.runOnce()).resolves.toMatchObject({ outcome: "attention" });
    expect(adapter.createDraftPullRequest).not.toHaveBeenCalled();
    expect(adapter.observeDraftPullRequest).toHaveBeenCalledTimes(1);
    sqlite.close();
  });

  it("holds a durable owner lease while provider mutation is in flight", async () => {
    const { sqlite, repository } = fixture();
    let releaseMutation!: (evidence: {
      kind: "ambiguous";
      errorCode: "provider_timeout";
    }) => void;
    let mutationEntered!: () => void;
    const entered = new Promise<void>((resolve) => { mutationEntered = resolve; });
    const mutation = new Promise<{
      kind: "ambiguous";
      errorCode: "provider_timeout";
    }>((resolve) => { releaseMutation = resolve; });
    const firstAdapter = {
      createDraftPullRequest: vi.fn(async () => {
        mutationEntered();
        return mutation;
      }),
      observeDraftPullRequest: vi.fn(),
    } satisfies GitHubDraftPullRequestEffectAdapter;
    const first = new LocalEffectExecutor(options({
      repository,
      client: client({
        acquire: async (request) => permit(request),
        record: async (evidence) => view(evidence, "outcome_unknown"),
      }),
      adapter: firstAdapter,
      acquireRequestId: () => "acquire_1",
      leaseOwner: "executor_1",
    }));
    const firstRun = first.runOnce();
    await entered;

    await expect(first.runOnce()).rejects.toThrow("local_effect_executor_reentrant");
    const secondAdapter = {
      createDraftPullRequest: vi.fn(),
      observeDraftPullRequest: vi.fn(),
    } satisfies GitHubDraftPullRequestEffectAdapter;
    const second = new LocalEffectExecutor(options({
      repository,
      client: client({ acquire: async () => null, record: vi.fn() }),
      adapter: secondAdapter,
      acquireRequestId: () => "acquire_2",
      leaseOwner: "executor_2",
    }));
    await expect(second.runOnce()).resolves.toEqual({ outcome: "idle" });
    expect(secondAdapter.createDraftPullRequest).not.toHaveBeenCalled();
    expect(secondAdapter.observeDraftPullRequest).not.toHaveBeenCalled();

    releaseMutation({ kind: "ambiguous", errorCode: "provider_timeout" });
    await expect(firstRun).resolves.toMatchObject({ outcome: "attention" });
    expect(firstAdapter.createDraftPullRequest).toHaveBeenCalledTimes(1);
    sqlite.close();
  });

  it("resumes a pre-observation reconciliation permit and carries its evidence predecessor", async () => {
    const { sqlite, repository } = fixture();
    const created = await repository.createLocalEffectAcquire({
      requestId: "acquire_1",
      organizationId: "org_1",
      runnerId: "runner_1",
      runnerGeneration: 2,
      now: NOW,
    });
    const effectPermit = await reconciliationPermit(created.attempt.acquireRequest);
    const leased = await claim(repository);
    await repository.acceptLocalEffectPermit({
      acquireRequestId: created.attempt.acquireRequestId,
      permit: effectPermit,
      leaseToken: leased.leaseToken,
      now: NOW,
    });
    const createDraftPullRequest = vi.fn();
    const observeDraftPullRequest = vi.fn(async () => ({
      kind: "absent" as const,
      observationScope: {
        provider: "github" as const,
        repository: { owner: effectPermit.target.owner, repo: effectPermit.target.repo },
        baseBranch: effectPermit.target.baseBranch,
        headBranch: effectPermit.target.branch,
        expectedHeadSha: effectPermit.target.expectedHeadSha,
        bindingGeneration: effectPermit.target.targetBindingGeneration,
        targetBindingDigest: effectPermit.target.targetBindingDigest,
        observationPolicy: "github.exact_draft_pr.v1" as const,
        observedAt: new Date(NOW.getTime() + 2_000).toISOString(),
      },
    }));
    const isWorkAuthorityCurrent = vi.fn(async () => false);
    const executor = new LocalEffectExecutor(options({
      repository,
      client: client({
        acquire: vi.fn(),
        record: async (evidence) => {
          expect(evidence.predecessorEvidenceDigest)
            .toBe(effectPermit.predecessorEvidenceDigest);
          return view(evidence, "attention");
        },
      }),
      adapter: { createDraftPullRequest, observeDraftPullRequest },
      isWorkAuthorityCurrent,
      now: () => new Date(NOW.getTime() + 2_000),
    }));

    await expect(executor.runOnce()).resolves.toMatchObject({ outcome: "attention" });
    expect(createDraftPullRequest).not.toHaveBeenCalled();
    expect(observeDraftPullRequest).toHaveBeenCalledTimes(1);
    expect(isWorkAuthorityCurrent).not.toHaveBeenCalled();
    sqlite.close();
  });

  it("never emits execute-only not_started for an expired reconciliation permit", async () => {
    const { sqlite, repository } = fixture();
    const createDraftPullRequest = vi.fn();
    const observeDraftPullRequest = vi.fn();
    const executor = new LocalEffectExecutor(options({
      repository,
      client: client({
        acquire: async (request) => {
          const current = await reconciliationPermit(request);
          const { permitDigest: _permitDigest, ...currentInput } = current;
          const expiredInput = {
            ...currentInput,
            issuedAt: "2026-09-05T00:55:00.000Z",
            expiresAt: "2026-09-05T01:00:00.000Z",
          };
          return {
            ...expiredInput,
            permitDigest: await computeEffectPermitDigestV1(expiredInput),
          };
        },
        record: async (evidence) => {
          expect(evidence.evidence).toEqual({
            kind: "attention",
            reasonCode: "local.reconciliation-permit-expired-before-observation",
          });
          return {
            effectId: evidence.effectId,
            effectKind: "github.create_draft_pull_request",
            state: "attention",
            currentAttemptNumber: evidence.effectAttemptNumber,
            currentEvidenceDigest: evidence.evidenceDigest,
            reasonCode: "local.reconciliation-permit-expired-before-observation",
            updatedAt: NOW.toISOString(),
          };
        },
      }),
      adapter: { createDraftPullRequest, observeDraftPullRequest },
      acquireRequestId: () => "acquire_1",
    }));

    await expect(executor.runOnce()).resolves.toMatchObject({ outcome: "attention" });
    expect(createDraftPullRequest).not.toHaveBeenCalled();
    expect(observeDraftPullRequest).not.toHaveBeenCalled();
    sqlite.close();
  });

  it("fails closed when the acquire journal disappears before permit acceptance", async () => {
    const { sqlite, repository } = fixture();
    const createDraftPullRequest = vi.fn();
    const executor = new LocalEffectExecutor(options({
      repository,
      client: client({
        acquire: async (request) => {
          expect(sqlite.prepare(
            "DELETE FROM local_effect_attempts WHERE acquire_request_id = ?",
          ).run(request.requestId).changes).toBe(1);
          return permit(request);
        },
        record: vi.fn(),
      }),
      adapter: { createDraftPullRequest, observeDraftPullRequest: vi.fn() },
      acquireRequestId: () => "acquire_1",
    }));

    await expect(executor.runOnce()).rejects.toMatchObject({
      code: "LOCAL_EFFECT_JOURNAL_MISSING",
    });
    expect(createDraftPullRequest).not.toHaveBeenCalled();
    sqlite.close();
  });
});
