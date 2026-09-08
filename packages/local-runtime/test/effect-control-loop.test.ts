import {
  computeEffectPermitDigestV1,
  computeEffectTargetDigestV1,
  type EffectAcquireRequestV1,
  type EffectEvidenceEnvelopeV1,
  type EffectExecutePermitV1,
} from "@opentag/control-protocol";
import { createPairedRunnerRepository, migratePairedRunnerSchema } from "@opentag/store";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createHostedControlLoop } from "../src/control-v1.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const now = new Date("2026-09-05T01:00:00.000Z");

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
  const input = {
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
    runAttemptNumber: 1,
    fencingTokenDigest: digest("e"),
    effectKind: "github.create_draft_pull_request" as const,
    requestDigest: digest("1"),
    targetDigest: await computeEffectTargetDigestV1(target),
    approvalDigest: digest("3"),
    candidate: { candidateId: "candidate_1", candidateDigest: digest("f") },
    target,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  return { ...input, permitDigest: await computeEffectPermitDigestV1(input) };
}

describe("hosted Control loop Effect cutover", () => {
  it("runs one journaled Effect iteration through the new acquire/evidence endpoints", async () => {
    const sqlite = new Database(":memory:");
    migratePairedRunnerSchema(sqlite);
    const repo = createPairedRunnerRepository(drizzle(sqlite));
    const context = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      contextKind: "runner_control" as const,
      organizationId: "org_1",
      runnerId: "runner_1",
      credentialId: "credential_1",
      registrationGeneration: 1,
      credentialGeneration: 2,
      capabilities: ["relay.effect-authority.v1"] as const,
      targets: [{
        projectTargetId: "target_1",
        bindingDigest: digest("a"),
        bindingGeneration: 4,
        provider: "github" as const,
        owner: "acme",
        repo: "demo",
        defaultExecutor: "codex",
        defaultBranch: "main",
      }],
      observedAt: now.toISOString(),
    };
    const acquireEffectControlV1 = vi.fn(async (request: EffectAcquireRequestV1) => {
      await expect(repo.getLocalEffectAttempt(request.requestId)).resolves.toMatchObject({
        state: "acquire_pending",
        acquireRequest: request,
      });
      return permit(request);
    });
    const recordEffectEvidenceControlV1 = vi.fn(async (evidence: EffectEvidenceEnvelopeV1) => {
      expect(evidence.evidence).toMatchObject({
        kind: "not_started",
        reason: "provider_io_not_begun",
      });
      return {
        effectId: evidence.effectId,
        effectKind: "github.create_draft_pull_request" as const,
        state: "retry_eligible" as const,
        currentAttemptNumber: evidence.effectAttemptNumber,
        currentEvidenceDigest: evidence.evidenceDigest,
        reasonCode: "local.provider_io_not_begun" as const,
        updatedAt: now.toISOString(),
      };
    });
    const loop = createHostedControlLoop({
      config: {
        runnerId: "runner_1",
        relayUrl: "https://control.example",
        runnerToken: "runtime_local_secret",
        repositories: [],
        agents: {},
        controlRegistration: {
          kind: "hosted_control_v1",
          state: "paired",
          operationId: "pair_1",
          registration: {
            schemaVersion: 1,
            protocolVersion: "1.0",
            organizationId: "org_1",
            runnerId: "runner_1",
            credentialId: "credential_1",
            registrationGeneration: 1,
            credentialGeneration: 2,
            credentialPurpose: "runtime",
            createdAt: now.toISOString(),
          },
        },
      } as never,
      databasePath: ":memory:",
      executors: {},
      now: () => now,
      controlClient: {
        getRunnerControlContextV1: vi.fn(async () => context),
        acquireEffectControlV1,
        recordEffectEvidenceControlV1,
      } as never,
      governanceStore: { repo, close: vi.fn() },
    });

    await expect(loop.beforeIteration()).resolves.toBe(true);
    expect(acquireEffectControlV1).toHaveBeenCalledTimes(1);
    expect(recordEffectEvidenceControlV1).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare(
      "SELECT state FROM local_effect_attempts WHERE effect_id = 'effect_1'",
    ).get()).toEqual({ state: "acknowledged" });
    await loop.close();
    sqlite.close();
  });
});
