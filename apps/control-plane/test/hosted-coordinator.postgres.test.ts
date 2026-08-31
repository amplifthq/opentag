import { createHash } from "node:crypto";
import {
  buildHostedLifecycleRequestV1,
  canonicalJsonStringify,
  computeHostedClaimFencingTokenDigestV1,
  type HostedClaimV1,
} from "@opentag/control-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createMaterialActionCoordinator } from "../src/modules/hosted-runs/material-actions.js";
import { createRunnerDirectory, type RuntimePrincipal } from "../src/modules/runners/index.js";
import {
  HOSTED_CAPABILITIES,
  hostedGrantIssuerFixture,
  hostedAdmissionFixture,
  hostedClaimRequest,
  recordHostedReadiness,
} from "./control-fixtures.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function proposalArtifact(input: {
  runId: string;
  attemptId: string;
  attemptNumber: number;
  workspaceId: string;
  workspacePathDigest: string;
  baseRevision: string;
  finalTree: string;
  verificationEvidenceDigests?: string[];
  createdAt?: string;
}) {
  const binaryDiff = "diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n";
  const evidenceInput = {
    schemaVersion: 1 as const,
    kind: "attempt_proposal_evidence" as const,
    attemptId: input.attemptId,
    attemptNumber: input.attemptNumber,
    workspaceId: input.workspaceId,
    workspacePathDigest: input.workspacePathDigest,
    baseRevision: input.baseRevision,
    finalTree: input.finalTree,
    diffDigest: sha256(binaryDiff),
    baseToFinalBinaryDiff: binaryDiff,
    changedFilesDigest: sha256(canonicalJsonStringify(["a.ts"])),
    changedFiles: ["a.ts"],
    verificationEvidenceDigests: input.verificationEvidenceDigests
      ?? [sha256("verification")],
    limitations: ["No remote publication was attempted."],
  };
  const evidenceDigest = sha256(canonicalJsonStringify(evidenceInput));
  const artifactInput = {
    id: `${input.runId}:proposal-evidence`,
    type: "patch_summary" as const,
    kind: "patch" as const,
    title: "Immutable proposal evidence",
    uri: `opentag://run/${encodeURIComponent(input.runId)}/proposal-evidence`,
    summary: "Attempt-bound proposal evidence captured; completion readiness is not assessed here.",
    sourceRunId: input.runId,
    createdAt: input.createdAt ?? "2026-08-15T07:00:00.000Z",
    metadata: { proposalEvidence: { ...evidenceInput, evidenceDigest },
      evidenceDigest, readiness: "not_assessed" as const },
  };
  return { ...artifactInput, metadata: { ...artifactInput.metadata,
    artifactDigest: sha256(canonicalJsonStringify(artifactInput)) } };
}

function resignProposalArtifact(artifact: ReturnType<typeof proposalArtifact>) {
  const evidence = artifact.metadata.proposalEvidence;
  const { evidenceDigest: _evidenceDigest, ...evidenceInput } = evidence;
  const evidenceDigest = sha256(canonicalJsonStringify(evidenceInput));
  const artifactInput = { ...artifact, metadata: { ...artifact.metadata,
    proposalEvidence: { ...evidence, evidenceDigest }, evidenceDigest } };
  delete (artifactInput.metadata as Partial<typeof artifact.metadata>).artifactDigest;
  return { ...artifactInput, metadata: { ...artifactInput.metadata,
    artifactDigest: sha256(canonicalJsonStringify(artifactInput)) } };
}

describe.skipIf(!TEST_DATABASE_URL)("Hosted Coordinator PostgreSQL lifecycle", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let principal: RuntimePrincipal;
  let now = new Date("2026-08-15T07:00:00.000Z");
  let identity = 0;
  const clock = { now: () => new Date(now) };

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock,
      tokenFactory: () => "runtime_hosted_secret",
      idFactory: () => "credential_hosted",
    });
    const registration = await runners.register({
      organizationId: "org_hosted",
      organizationName: "Hosted",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_hosted",
        operationId: "operation_register_hosted",
        runnerId: "runner_hosted",
        capabilities: [...HOSTED_CAPABILITIES],
      },
    });
    if (registration.kind !== "created") throw new Error("registration failed");
    const authenticated = await runners.authenticate("runtime_hosted_secret");
    if (authenticated.kind !== "authenticated") throw new Error("authentication failed");
    principal = authenticated.principal;
    await recordHostedReadiness({
      pool: fixture.pool,
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
    });
  });

  afterAll(async () => {
    await fixture.close();
  });

  const coordinator = () => createHostedRunCoordinator({
    pool: fixture.pool,
    clock,
    leaseDurationMs: 60_000,
    idFactory: (kind) => `${kind}_${++identity}`,
    tokenFactory: (context) => `fence_${context.attemptId}`,
    issueSourceContentGrantInTransaction: hostedGrantIssuerFixture,
  });

  async function admitAndClaim(suffix: string): Promise<HostedClaimV1> {
    const service = coordinator();
    const fixtureInput = await hostedAdmissionFixture({
      runId: `run_${suffix}`,
      suffix,
    });
    const admitted = await service.admit({
      runId: `run_${suffix}`,
      admission: fixtureInput.admission,
      policy: fixtureInput.policy,
    });
    expect(admitted.kind).toMatch(/created|replayed/u);
    const claim = await service.claim({
      principal,
      request: hostedClaimRequest({
        operationId: `operation_claim_${suffix}`,
        requestId: `request_claim_${suffix}`,
        readinessDigest: fixtureInput.readinessDigest,
      }),
    });
    if (claim.kind !== "claimed") throw new Error(`claim failed: ${claim.kind}`);
    return claim.claim;
  }

  it("deduplicates admission to one durable Run identity", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({ runId: "run_1", suffix: "1" });

    const first = await service.admit({ runId: "run_1", admission: input.admission, policy: input.policy });
    const second = await service.admit({ runId: "run_1", admission: input.admission, policy: input.policy });

    expect(first).toMatchObject({ kind: "created", runId: "run_1",
      view: { canonicalStatus: "queued", status: "waiting_for_runner" } });
    expect(second).toEqual({ ...first, kind: "replayed" });
    const rows = await fixture.pool.query(
      "SELECT run_id FROM cp_hosted_run WHERE admission_id = $1",
      [input.admission.admissionId],
    );
    expect(rows.rowCount).toBe(1);
    await fixture.pool.query(
      "DELETE FROM cp_hosted_audit_event WHERE run_id = 'run_1'",
    );
    await fixture.pool.query("DELETE FROM cp_hosted_run WHERE run_id = 'run_1'");
  });

  it("validates and persists content-free workspace attestation through lifecycle receipts", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("workspace_evidence");
    const attestation = { workspaceId: `workspace_${claim.attempt.id}`,
      workspacePathDigest: `sha256:${"1".repeat(64)}`,
      repositoryPathDigest: `sha256:${"2".repeat(64)}`,
      worktreeIdentityDigest: `sha256:${"3".repeat(64)}`,
      baseRevision: "a".repeat(40), currentRevision: "a".repeat(40),
      currentTree: "b".repeat(40), workspaceStateDigest: `sha256:${"4".repeat(64)}`,
      attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
      fencingTokenDigest: claim.attempt.fencingTokenDigest,
      credentialId: claim.authority.credentialId,
      leaseExpiresAt: claim.attempt.leaseExpiresAt };
    const running = await buildHostedLifecycleRequestV1({ action: "running",
      organizationId: claim.organizationId, runnerId: claim.runnerId, runId: claim.runId,
      attempt: { attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch, fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest }, occurredAt: now.toISOString(),
      executorId: claim.executorId,
      executorCapabilityDigest: claim.authority.executorCapabilityDigest,
      workspaceAttestation: attestation });
    await expect(service.lifecycle({ principal, runId: claim.runId, action: "running",
      request: running })).resolves.toMatchObject({ kind: "accepted",
        receipt: { payload: { workspaceAttestation: attestation } } });
    const persisted = await fixture.pool.query<{ workspace_attestation: unknown }>(
      "SELECT workspace_attestation FROM cp_hosted_attempt WHERE organization_id = $1 AND run_id = $2",
      [claim.organizationId, claim.runId]);
    expect(persisted.rows[0]?.workspace_attestation).toEqual(attestation);
    expect(JSON.stringify(persisted.rows[0])).not.toContain("/Users/");
    const wrong = { ...attestation, workspaceId: "workspace_wrong",
      workspacePathDigest: `sha256:${"9".repeat(64)}` };
    const progress = await buildHostedLifecycleRequestV1({ action: "progress",
      organizationId: claim.organizationId, runnerId: claim.runnerId, runId: claim.runId,
      attempt: { attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch, fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest }, occurredAt: now.toISOString(),
      progressId: `progress_${"5".repeat(64)}`, progressDigest: `sha256:${"6".repeat(64)}`,
      workspaceAttestation: wrong });
    await expect(service.lifecycle({ principal, runId: claim.runId, action: "progress",
      request: progress })).resolves.toEqual({ kind: "conflict", reason: "invalid_request" });
    const complete = await buildHostedLifecycleRequestV1({ action: "complete",
      organizationId: claim.organizationId, runnerId: claim.runnerId, runId: claim.runId,
      attempt: { attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch, fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest }, occurredAt: now.toISOString(),
      conclusion: "success", reasonCode: "executor_success",
      resultDigest: `sha256:${"7".repeat(64)}`, artifactDigests: [], evidenceDigests: [],
      workspaceAttestation: wrong });
    await expect(service.lifecycle({ principal, runId: claim.runId, action: "complete",
      request: complete })).resolves.toEqual({ kind: "conflict", reason: "invalid_request" });
  });

  it.each([
    ["proposal_only", "proposal_ready", true, "succeeded", "proposal_ready"],
    ["pull_request", "publication_pending", false, "running", "publication_pending"],
  ] as const)("atomically persists authoritative %s evidence with truthful settlement", async (
    publicationMode, _assessmentState, _accepted, canonicalStatus, status,
  ) => {
    const service = coordinator();
    const suffix = `candidate_${publicationMode}`;
    const input = await hostedAdmissionFixture({ runId: `run_${suffix}`, suffix, publicationMode });
    await service.admit({ runId: `run_${suffix}`, admission: input.admission, policy: input.policy });
    const claimed = await service.claim({ principal, request: hostedClaimRequest({
      operationId: `operation_claim_${suffix}`, requestId: `request_claim_${suffix}`,
      readinessDigest: input.readinessDigest,
    }) });
    if (claimed.kind !== "claimed") throw new Error(`claim failed: ${claimed.kind}`);
    const claim = claimed.claim;
    const attestation = { workspaceId: `workspace_${claim.attempt.id}`,
      workspacePathDigest: `sha256:${"1".repeat(64)}`,
      repositoryPathDigest: `sha256:${"2".repeat(64)}`,
      worktreeIdentityDigest: `sha256:${"3".repeat(64)}`,
      baseRevision: "a".repeat(40), currentRevision: "b".repeat(40),
      currentTree: "c".repeat(40), workspaceStateDigest: `sha256:${"4".repeat(64)}`,
      attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
      fencingTokenDigest: claim.attempt.fencingTokenDigest,
      credentialId: claim.authority.credentialId,
      leaseExpiresAt: claim.attempt.leaseExpiresAt };
    const attempt = { attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
      epoch: claim.attempt.epoch, fencingToken: claim.attempt.fencingToken,
      fencingTokenDigest: claim.attempt.fencingTokenDigest };
    const running = await buildHostedLifecycleRequestV1({ action: "running",
      organizationId: claim.organizationId, runnerId: claim.runnerId, runId: claim.runId,
      attempt, occurredAt: now.toISOString(), executorId: claim.executorId,
      executorCapabilityDigest: claim.authority.executorCapabilityDigest,
      workspaceAttestation: attestation });
    await service.lifecycle({ principal, runId: claim.runId, action: "running", request: running });
    const artifact = proposalArtifact({ runId: claim.runId, attemptId: claim.attempt.id,
      attemptNumber: claim.attempt.number, workspaceId: attestation.workspaceId,
      workspacePathDigest: attestation.workspacePathDigest,
      baseRevision: attestation.baseRevision, finalTree: attestation.currentTree,
      createdAt: "2026-08-14T00:00:00.000Z" });
    const complete = await buildHostedLifecycleRequestV1({ action: "complete",
      organizationId: claim.organizationId, runnerId: claim.runnerId, runId: claim.runId,
      attempt, occurredAt: now.toISOString(), conclusion: "success",
      reasonCode: "executor_success", resultDigest: `sha256:${"5".repeat(64)}`,
      artifactDigests: [artifact.metadata.artifactDigest],
      evidenceDigests: artifact.metadata.proposalEvidence.verificationEvidenceDigests,
      workspaceAttestation: attestation });
    await service.lifecycle({ principal, runId: claim.runId, action: "complete", request: complete });
    const candidateId = `candidate_${claim.runId}`;
    const forgedCallerAssessment = { state: "blocked", accepted: false,
      reasonCodes: ["material_action_unknown"],
      assessedAt: "2099-01-01T00:00:00.000Z" };
    const settlementCommand = { principal, runId: claim.runId, attempt, candidateId,
      proposalArtifact: artifact, assessment: forgedCallerAssessment } as any;
    const mismatchedDigest = structuredClone(artifact);
    mismatchedDigest.metadata.evidenceDigest = sha256("forged-evidence");
    await expect(service.settleProposalCandidate({ ...settlementCommand,
      proposalArtifact: mismatchedDigest })).resolves.toEqual({
        kind: "conflict", reason: "invalid_evidence" });
    await fixture.pool.query("ALTER TABLE cp_hosted_run DISABLE TRIGGER cp_hosted_run_frozen_admission_guard");
    const mismatchedMode = publicationMode === "proposal_only" ? "pull_request" : "proposal_only";
    await fixture.pool.query(
      "UPDATE cp_hosted_run SET publication_mode = $2, completion_mode = $3 WHERE run_id = $1",
      [claim.runId, mismatchedMode,
        mismatchedMode === "proposal_only" ? "proposal_ready" : "pull_request_ready"]);
    await expect(service.settleProposalCandidate(settlementCommand)).resolves.toEqual({
      kind: "conflict", reason: "completion_contract_mismatch" });
    await fixture.pool.query(
      "UPDATE cp_hosted_run SET publication_mode = $2, completion_mode = $3 WHERE run_id = $1",
      [claim.runId, publicationMode,
        publicationMode === "proposal_only" ? "proposal_ready" : "pull_request_ready"]);
    await fixture.pool.query("ALTER TABLE cp_hosted_run ENABLE TRIGGER cp_hosted_run_frozen_admission_guard");
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET material_start_state = 'started_or_ambiguous' WHERE attempt_id = $1",
      [claim.attempt.id]);
    await expect(service.settleProposalCandidate(settlementCommand)).resolves.toEqual({
      kind: "conflict", reason: "material_outcome_unknown" });
    await fixture.pool.query(
      "UPDATE cp_hosted_attempt SET material_start_state = 'open' WHERE attempt_id = $1",
      [claim.attempt.id]);
    await fixture.pool.query(
      "UPDATE cp_hosted_run SET outcome_state = 'outcome_unknown' WHERE run_id = $1",
      [claim.runId]);
    await expect(service.settleProposalCandidate(settlementCommand)).resolves.toEqual({
      kind: "conflict", reason: "material_outcome_unknown" });
    await fixture.pool.query(
      "UPDATE cp_hosted_run SET outcome_state = NULL WHERE run_id = $1", [claim.runId]);
    const concurrent = await Promise.all([
      service.settleProposalCandidate(settlementCommand),
      service.settleProposalCandidate(settlementCommand),
    ]);
    expect(concurrent.map(({ kind }) => kind).sort()).toEqual(["created", "replayed"]);
    expect(concurrent).toEqual(expect.arrayContaining([expect.objectContaining({
      view: { canonicalStatus, status, queueClaimDeadline: claim.hostedAdmission.queueClaimDeadline,
        outcome: null },
    })]));
    const durable = await fixture.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM cp_publication_candidate WHERE run_id = $1",
      [claim.runId]);
    expect(durable.rows[0]?.count).toBe(1);
    const persisted = await fixture.pool.query<{ candidate: any;
      completion_assessment: any; terminal_receipt: any }>(
      `SELECT candidate.candidate, candidate.completion_assessment, run.terminal_receipt
       FROM cp_publication_candidate candidate JOIN cp_hosted_run run
         ON run.organization_id = candidate.organization_id AND run.run_id = candidate.run_id
       WHERE candidate.run_id = $1`, [claim.runId]);
    expect(persisted.rows[0]?.candidate).toMatchObject({ candidateId,
      patchDigest: artifact.metadata.proposalEvidence.diffDigest,
      changedFiles: artifact.metadata.proposalEvidence.changedFiles,
      createdAt: now.toISOString() });
    expect(persisted.rows[0]?.completion_assessment).toMatchObject(
      publicationMode === "proposal_only"
        ? { state: "proposal_ready", accepted: true, assessedAt: now.toISOString() }
        : { state: "publication_pending", accepted: false, assessedAt: now.toISOString() });
    expect(persisted.rows[0]?.terminal_receipt?.assessment).toMatchObject(
      publicationMode === "proposal_only"
        ? { state: "proposal_ready", accepted: true, assessedAt: now.toISOString() }
        : {});
    const beforeReplay = await fixture.pool.query<{ updated_at: Date; terminal_receipt: unknown }>(
      "SELECT updated_at, terminal_receipt FROM cp_hosted_run WHERE run_id = $1", [claim.runId]);
    const conflictingArtifact = structuredClone(artifact);
    conflictingArtifact.metadata.proposalEvidence.baseToFinalBinaryDiff += "forged\n";
    conflictingArtifact.metadata.proposalEvidence.diffDigest = sha256(
      conflictingArtifact.metadata.proposalEvidence.baseToFinalBinaryDiff);
    const resignedConflict = resignProposalArtifact(conflictingArtifact);
    await expect(service.settleProposalCandidate({ ...settlementCommand,
      proposalArtifact: resignedConflict, candidateId: `${candidateId}_conflict` }))
      .resolves.toEqual({ kind: "conflict", reason: "invalid_evidence" });
    now = new Date(now.getTime() + 1_000);
    await expect(service.settleProposalCandidate(settlementCommand))
      .resolves.toMatchObject({ kind: "replayed" });
    const afterReplay = await fixture.pool.query<{ updated_at: Date; terminal_receipt: unknown }>(
      "SELECT updated_at, terminal_receipt FROM cp_hosted_run WHERE run_id = $1", [claim.runId]);
    expect(afterReplay.rows[0]).toEqual(beforeReplay.rows[0]);
  });

  it("rejects Candidate rows whose attempt id and number do not name the same exact Attempt", async () => {
    const claim = await admitAndClaim("candidate_exact_attempt_fk");
    await fixture.pool.query(
      `INSERT INTO cp_hosted_attempt(organization_id, run_id, attempt_number,
         attempt_id, runner_id, credential_id, fencing_token_digest,
         lease_expires_at, material_start_state, state, claimed_at, updated_at)
       SELECT organization_id, run_id, 2, 'attempt_candidate_exact_alternate',
         runner_id, credential_id, fencing_token_digest, lease_expires_at,
         material_start_state, state, claimed_at, updated_at
       FROM cp_hosted_attempt WHERE organization_id = $1 AND run_id = $2
         AND attempt_number = 1`, [claim.organizationId, claim.runId]);
    const insert = (candidateId: string, attemptId: string, attemptNumber: number) => {
      const candidate = { candidateId, runId: claim.runId, attemptId,
        projectTargetId: claim.hostedAdmission.projectTarget.projectTargetId,
        frozenBaseRevision: "a".repeat(40), workspaceTreeDigest: "b".repeat(40),
        patchDigest: `sha256:${"c".repeat(64)}`, changedFiles: ["a.ts"],
        verificationEvidenceIds: [`sha256:${"d".repeat(64)}`],
        publicationPolicyDigest: claim.hostedAdmission.publicationPolicy.digest,
        createdAt: now.toISOString() };
      return fixture.pool.query(
        `INSERT INTO cp_publication_candidate(organization_id, candidate_id, run_id,
           attempt_id, attempt_number, project_target_id, frozen_base_revision,
           workspace_tree_digest, patch_digest, changed_files, verification_evidence_ids,
           publication_policy_digest, candidate, completion_assessment, created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,
        [claim.organizationId, candidateId, claim.runId, attemptId, attemptNumber,
          candidate.projectTargetId, candidate.frozenBaseRevision,
          candidate.workspaceTreeDigest, candidate.patchDigest, candidate.changedFiles,
          candidate.verificationEvidenceIds, candidate.publicationPolicyDigest,
          JSON.stringify(candidate), JSON.stringify({ state: "proposal_ready", accepted: true,
            candidateId, reasonCodes: ["proposal_ready"], assessedAt: now.toISOString() }),
          now.toISOString()]);
    };
    const outcomes = await Promise.allSettled([
      insert("candidate_wrong_id", "attempt_wrong_but_number_valid", 1),
      insert("candidate_wrong_number", claim.attempt.id, 2),
    ]);
    expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(String(outcome.reason)).toMatch(/cp_publication_candidate_attempt_fk|foreign key/iu);
      }
    }
  });

  it("admits while the paired Runner is offline without extending the finite claim deadline", async () => {
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock,
      tokenFactory: () => "runtime_offline_secret",
      idFactory: () => "credential_offline",
    });
    const registration = await runners.register({
      organizationId: principal.organizationId,
      organizationName: "Hosted",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_offline",
        operationId: "operation_register_offline",
        runnerId: "runner_offline",
        capabilities: [...HOSTED_CAPABILITIES],
      },
    });
    expect(registration.kind).toBe("created");
    const offlinePrincipal = await runners.authenticate("runtime_offline_secret");
    if (offlinePrincipal.kind !== "authenticated") throw new Error("authentication failed");
    const deadline = "2026-08-29T00:00:00.000Z";
    const service = coordinator();
    const input = await hostedAdmissionFixture({
      runId: "run_offline",
      suffix: "offline",
      runnerId: "runner_offline",
      queueClaimDeadline: deadline,
    });

    const admitted = await service.admit({
      runId: "run_offline",
      admission: input.admission,
      policy: input.policy,
    });

    expect(admitted).toMatchObject({
      kind: "created",
      view: {
        canonicalStatus: "queued",
        status: "waiting_for_runner",
        queueClaimDeadline: deadline,
      },
    });
    await expect(service.claim({
      principal: offlinePrincipal.principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_offline",
        requestId: "request_claim_offline",
        credentialId: "credential_offline",
      }),
    })).resolves.toEqual({ kind: "empty" });
    await expect(service.inspect({
      organizationId: principal.organizationId,
      runId: "run_offline",
    })).resolves.toMatchObject({
      canonicalStatus: "queued",
      status: "waiting_for_runner",
      queueClaimDeadline: deadline,
    });
  });

  it("rejects a claim whose readiness identity is not current", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({
      runId: "run_wrong_readiness",
      suffix: "9",
    });
    await service.admit({
      runId: "run_wrong_readiness",
      admission: input.admission,
      policy: input.policy,
    });

    await expect(service.claim({
      principal,
      request: {
        ...hostedClaimRequest({
          operationId: "operation_claim_wrong_readiness",
          requestId: "request_claim_wrong_readiness",
        }),
        expectedAuthority: {
          ...hostedClaimRequest({
            operationId: "operation_claim_wrong_readiness",
            requestId: "request_claim_wrong_readiness",
          }).expectedAuthority,
          runnerReadinessReceiptId: "readiness_receipt_untrusted",
        },
      },
    })).resolves.toEqual({
      kind: "conflict",
      reason: "authority_mismatch",
    });

    await fixture.pool.query(
      "DELETE FROM cp_hosted_audit_event WHERE run_id = 'run_wrong_readiness'",
    );
    await fixture.pool.query(
      "DELETE FROM cp_hosted_run WHERE run_id = 'run_wrong_readiness'",
    );
  });

  it("gives exactly one concurrent claimer the lease", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({ runId: "run_2", suffix: "2" });
    await service.admit({ runId: "run_2", admission: input.admission, policy: input.policy });

    const outcomes = await Promise.all([
      service.claim({
        principal,
        request: hostedClaimRequest({
          operationId: "operation_claim_2a",
          requestId: "request_claim_2a",
        }),
      }),
      service.claim({
        principal,
        request: hostedClaimRequest({
          operationId: "operation_claim_2b",
          requestId: "request_claim_2b",
        }),
      }),
    ]);

    expect(outcomes.filter(({ kind }) => kind === "claimed")).toHaveLength(1);
    expect(outcomes.filter(({ kind }) => kind === "empty")).toHaveLength(1);
  });

  it("replays one concurrent claim operation against one pending Run", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({
      runId: "run_claim_replay_one",
      suffix: "d20",
    });
    await service.admit({
      runId: "run_claim_replay_one",
      admission: input.admission,
      policy: input.policy,
    });
    const command = {
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_replay_one",
        requestId: "request_claim_replay_one",
      }),
    };

    const outcomes = await Promise.all([
      service.claim(command),
      service.claim(command),
    ]);

    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "claimed",
      "replayed",
    ]);
    const claims = outcomes.flatMap((outcome) =>
      outcome.kind === "claimed" || outcome.kind === "replayed"
        ? [outcome.claim]
        : []
    );
    expect(claims).toHaveLength(2);
    expect(claims[1]).toEqual(claims[0]);
    const persisted = await fixture.pool.query<{ claim: unknown }>(
      `SELECT claim FROM cp_hosted_claim
       WHERE organization_id = $1 AND operation_id = $2`,
      [principal.organizationId, command.request.operationId],
    );
    expect(JSON.stringify(persisted.rows[0]?.claim)).not.toContain(
      claims[0]?.attempt.fencingToken,
    );
    expect(JSON.stringify(persisted.rows[0]?.claim)).toContain(
      claims[0]?.attempt.fencingTokenDigest,
    );
  });

  it("fails closed when a stored claim cannot be hydrated by the current fencing authority", async () => {
    const input = await hostedAdmissionFixture({
      runId: "run_claim_secret_rotation",
      suffix: "f23secretrotation",
    });
    const original = createHostedRunCoordinator({
      pool: fixture.pool,
      clock,
      leaseDurationMs: 60_000,
      idFactory: (kind) => `${kind}_${++identity}`,
      tokenFactory: () => "fence_original_authority",
      issueSourceContentGrantInTransaction: hostedGrantIssuerFixture,
    });
    await original.admit({
      runId: "run_claim_secret_rotation",
      admission: input.admission,
      policy: input.policy,
    });
    const command = {
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_secret_rotation",
        requestId: "request_claim_secret_rotation",
      }),
    };
    await expect(original.claim(command)).resolves.toMatchObject({
      kind: "claimed",
    });

    const rotated = createHostedRunCoordinator({
      pool: fixture.pool,
      clock,
      leaseDurationMs: 60_000,
      idFactory: (kind) => `${kind}_${++identity}`,
      tokenFactory: () => "fence_rotated_authority",
      issueSourceContentGrantInTransaction: hostedGrantIssuerFixture,
    });
    await expect(rotated.claim(command)).resolves.toEqual({
      kind: "conflict",
      reason: "authority_mismatch",
    });
  });

  it("contains a pre-grant persisted claim as controlled interrupted outcome_unknown", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({ runId: "run_legacy_claim",
      suffix: "legacy_claim" });
    await service.admit({ runId: "run_legacy_claim", admission: input.admission,
      policy: input.policy });
    const request = hostedClaimRequest({ operationId: "operation_legacy_claim",
      requestId: "request_legacy_claim" });
    const first = await service.claim({ principal, request });
    if (first.kind !== "claimed") throw new Error("claim failed");
    await fixture.pool.query(
      `INSERT INTO cp_permission_request(organization_id, permission_request_id,
         run_id, runner_id, attempt_id, attempt_number, action_id, resolution_id,
         permission_request_digest, policy_snapshot_digest, state, request,
         current_receipt, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'waiting','{}','{}',$11,$11)`,
      [principal.organizationId, "permission_legacy_claim", first.claim.runId,
        principal.runnerId, first.claim.attempt.id, first.claim.attempt.number,
        "action_legacy_claim", "resolution_legacy_claim", `sha256:${"6".repeat(64)}`,
        first.claim.admissionPolicySnapshot.receiptDigest, now],
    );
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt SET state = 'needs_approval',
         blocked_permission_request_id = $3,
         blocked_action_descriptor_digest = $4,
         blocked_policy_snapshot_digest = $5
       WHERE organization_id = $1 AND run_id = $2`,
      [principal.organizationId, first.claim.runId, "permission_legacy_claim",
        `sha256:${"7".repeat(64)}`, first.claim.admissionPolicySnapshot.receiptDigest],
    );
    await fixture.pool.query(
      `UPDATE cp_hosted_run SET state = 'needs_approval'
       WHERE organization_id = $1 AND run_id = $2`,
      [principal.organizationId, first.claim.runId],
    );
    await fixture.pool.query(
      `UPDATE cp_hosted_claim SET claim_version = 1,
         claim = claim - 'sourceContentGrant'
       WHERE organization_id = $1 AND operation_id = $2`,
      [principal.organizationId, request.operationId],
    );

    await expect(service.claim({ principal, request: hostedClaimRequest({
      operationId: "operation_legacy_claim_different_poll",
      requestId: "request_legacy_claim_different_poll",
    }) })).resolves.toEqual({ kind: "empty" });

    const exact = await service.claim({ principal, request });
    expect(exact).toMatchObject({
      kind: "legacy_interrupted", runId: "run_legacy_claim",
      outcome: "outcome_unknown",
    });
    const recreated = coordinator();
    await expect(recreated.claim({ principal, request })).resolves.toEqual(exact);
    await expect(service.inspect({ organizationId: principal.organizationId,
      runId: "run_legacy_claim" })).resolves.toMatchObject({
        canonicalStatus: "interrupted", outcome: "outcome_unknown",
        terminalReason: "legacy_claim_authority_unrecoverable",
      });
    expect((await fixture.pool.query<{ state: string; material_start_state: string;
      lease_open: boolean; blocked_permission_request_id: string | null }>(
      `SELECT state, material_start_state, lease_expires_at > $3 AS lease_open,
              blocked_permission_request_id
       FROM cp_hosted_attempt WHERE organization_id = $1 AND run_id = $2`,
      [principal.organizationId, first.claim.runId, now],
    )).rows).toEqual([{ state: "interrupted", material_start_state: "started_or_ambiguous",
      lease_open: false, blocked_permission_request_id: null }]);
    expect((await fixture.pool.query(
      `SELECT state FROM cp_permission_request
       WHERE organization_id = $1 AND permission_request_id = $2`,
      [principal.organizationId, "permission_legacy_claim"],
    )).rows).toEqual([{ state: "revoked" }]);
  });

  it.each([
    ["missing", { sourceContentGrant: { fabricated: true } }],
    ["malformed", { attempt: "not-an-attempt", sourceContentGrant: { fabricated: true } }],
  ] as const)("contains a %s legacy Attempt reference without strict parsing or grant fabrication",
    async (suffix, malformedClaim) => {
      const service = coordinator();
      const input = await hostedAdmissionFixture({ runId: `run_legacy_${suffix}`,
        suffix: `legacy_${suffix}` });
      await service.admit({ runId: `run_legacy_${suffix}`, admission: input.admission,
        policy: input.policy });
      const original = hostedClaimRequest({ operationId: `operation_legacy_${suffix}`,
        requestId: `request_legacy_${suffix}` });
      const claimed = await service.claim({ principal, request: original });
      if (claimed.kind !== "claimed") throw new Error("claim failed");
      await fixture.pool.query(
        `UPDATE cp_hosted_claim SET claim_version = 1, claim = $3::jsonb
         WHERE organization_id = $1 AND operation_id = $2`,
        [principal.organizationId, original.operationId, JSON.stringify(malformedClaim)],
      );

      await expect(coordinator().claim({ principal, request: hostedClaimRequest({
        operationId: `operation_legacy_${suffix}_other`,
        requestId: `request_legacy_${suffix}_other`,
      }) })).resolves.toEqual({ kind: "empty" });
      await expect(coordinator().claim({ principal, request: original }))
        .resolves.toMatchObject({ kind: "legacy_interrupted",
          runId: claimed.claim.runId, outcome: "outcome_unknown" });
      expect(JSON.stringify((await fixture.pool.query(
        `SELECT claim FROM cp_hosted_claim WHERE organization_id = $1 AND operation_id = $2`,
        [principal.organizationId, original.operationId],
      )).rows[0]?.claim)).toBe(JSON.stringify(malformedClaim));
      await expect(service.inspect({ organizationId: principal.organizationId,
        runId: claimed.claim.runId })).resolves.toMatchObject({
          canonicalStatus: "interrupted", outcome: "outcome_unknown",
        });
    });

  it("does not mutate a later unrelated Attempt on stale legacy replay", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({ runId: "run_legacy_stale",
      suffix: "legacy_stale" });
    await service.admit({ runId: "run_legacy_stale", admission: input.admission,
      policy: input.policy });
    const request = hostedClaimRequest({ operationId: "operation_legacy_stale",
      requestId: "request_legacy_stale" });
    const first = await service.claim({ principal, request });
    if (first.kind !== "claimed") throw new Error("claim failed");
    await fixture.pool.query(
      `UPDATE cp_hosted_claim SET claim_version = 1,
         claim = claim - 'sourceContentGrant' WHERE operation_id = $1`,
      [request.operationId]);
    await fixture.pool.query(
      `INSERT INTO cp_hosted_attempt(organization_id, run_id, attempt_number,
         attempt_id, runner_id, credential_id, fencing_token_digest,
         lease_expires_at, material_start_state, state, claimed_at, updated_at)
       VALUES($1,$2,2,$3,$4,$5,$6,$7,'open','claimed',$8,$8)`,
      [principal.organizationId, first.claim.runId, "attempt_legacy_later",
        principal.runnerId, principal.credentialId, `sha256:${"7".repeat(64)}`,
        "2026-08-15T08:00:00.000Z", now]);
    await fixture.pool.query(
      `UPDATE cp_hosted_run SET current_attempt_number = 2, state = 'assigned'
       WHERE organization_id = $1 AND run_id = $2`,
      [principal.organizationId, first.claim.runId]);

    await expect(service.claim({ principal, request })).resolves.toMatchObject({
      kind: "legacy_interrupted", runId: first.claim.runId,
    });
    expect((await fixture.pool.query(
      `SELECT state FROM cp_hosted_attempt WHERE run_id = $1 AND attempt_number = 2`,
      [first.claim.runId])).rows).toEqual([{ state: "claimed" }]);
    await expect(service.inspect({ organizationId: principal.organizationId,
      runId: first.claim.runId })).resolves.toMatchObject({ canonicalStatus: "assigned" });
  });

  it("replays one concurrent claim operation without claiming a second pending Run", async () => {
    const service = coordinator();
    const first = await hostedAdmissionFixture({
      runId: "run_claim_replay_many_a",
      suffix: "a21",
    });
    const second = await hostedAdmissionFixture({
      runId: "run_claim_replay_many_b",
      suffix: "b22",
    });
    await service.admit({
      runId: "run_claim_replay_many_a",
      admission: first.admission,
      policy: first.policy,
    });
    await service.admit({
      runId: "run_claim_replay_many_b",
      admission: second.admission,
      policy: second.policy,
    });
    const command = {
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_replay_many",
        requestId: "request_claim_replay_many",
      }),
    };

    const outcomes = await Promise.all([
      service.claim(command),
      service.claim(command),
    ]);

    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "claimed",
      "replayed",
    ]);
    const claims = outcomes.flatMap((outcome) =>
      outcome.kind === "claimed" || outcome.kind === "replayed"
        ? [outcome.claim]
        : []
    );
    expect(new Set(claims.map(({ runId }) => runId)).size).toBe(1);
    const pendingRuns = await fixture.pool.query(
      `SELECT run_id
       FROM cp_hosted_run
       WHERE run_id IN ('run_claim_replay_many_a', 'run_claim_replay_many_b')
         AND state = 'queued'`,
    );
    expect(pendingRuns.rowCount).toBe(1);
    const pendingRunId = pendingRuns.rows[0]?.run_id as string;
    await fixture.pool.query(
      "DELETE FROM cp_hosted_audit_event WHERE run_id = $1",
      [pendingRunId],
    );
    await fixture.pool.query(
      "DELETE FROM cp_hosted_run WHERE run_id = $1",
      [pendingRunId],
    );
  });

  it("conflicts one concurrent claim operation whose request digest changes", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({
      runId: "run_claim_operation_mismatch",
      suffix: "e20",
    });
    await service.admit({
      runId: "run_claim_operation_mismatch",
      admission: input.admission,
      policy: input.policy,
    });
    const request = hostedClaimRequest({
      operationId: "operation_claim_digest_mismatch",
      requestId: "request_claim_digest_mismatch_a",
    });

    const outcomes = await Promise.all([
      service.claim({ principal, request }),
      service.claim({
        principal,
        request: {
          ...request,
          requestId: "request_claim_digest_mismatch_b",
        },
      }),
    ]);

    expect(outcomes.filter(({ kind }) => kind === "claimed")).toHaveLength(1);
    expect(outcomes.filter(({ kind }) => kind === "conflict")).toEqual([
      { kind: "conflict", reason: "operation_mismatch" },
    ]);
  });

  it("rejects a stale fence and never reopens a completed Run", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("3");
    const staleToken = "stale_fence";
    const stale = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "progress",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: staleToken,
        fencingTokenDigest: await computeHostedClaimFencingTokenDigestV1(
          staleToken,
        ),
      },
      occurredAt: now.toISOString(),
      progressId: `progress_${"1".repeat(64)}`,
      progressDigest: `sha256:${"2".repeat(64)}`,
    });
    await expect(
      service.lifecycle({ principal, runId: claim.runId, action: "progress", request: stale }),
    ).resolves.toEqual({ kind: "stale_fence" });

    const complete = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "complete",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      conclusion: "success",
      reasonCode: "executor_success",
      resultDigest: `sha256:${"3".repeat(64)}`,
      artifactDigests: [],
      evidenceDigests: [],
    });
    const settled = await service.lifecycle({
      principal,
      runId: claim.runId,
      action: "complete",
      request: complete,
    });
    expect(settled.kind).toBe("accepted");

    const late = await buildHostedLifecycleRequestV1({
      ...{
        organizationId: principal.organizationId,
        runnerId: principal.runnerId,
        runId: claim.runId,
        action: "complete" as const,
        attempt: {
          attemptId: claim.attempt.id,
          attemptNumber: claim.attempt.number,
          epoch: claim.attempt.epoch,
          fencingToken: claim.attempt.fencingToken,
          fencingTokenDigest: claim.attempt.fencingTokenDigest,
        },
        occurredAt: new Date(now.getTime() + 1_000).toISOString(),
        conclusion: "failure" as const,
        reasonCode: "executor_failure" as const,
        resultDigest: `sha256:${"4".repeat(64)}`,
        artifactDigests: [],
        evidenceDigests: [],
      },
    });
    await expect(
      service.lifecycle({ principal, runId: claim.runId, action: "complete", request: late }),
    ).resolves.toEqual({ kind: "conflict", reason: "invalid_transition" });
  });

  it.each([
    ["0success", "success", "running", "succeeded", "running"],
    ["1failure", "failure", "failed", "failed", "failed"],
    ["2cancelled", "cancelled", "cancelled", "cancelled", "cancelled"],
    ["3interrupted", "interrupted", "interrupted", "interrupted", "interrupted"],
    ["4timed_out", "timed_out", "timed_out", "timed_out", "timed_out"],
    ["5needs_human", "needs_human", "needs_approval", "needs_approval", "waiting_for_approval"],
  ] as const)("maps executor conclusion %s explicitly", async (
    suffix, conclusion, canonicalStatus, attemptState, status,
  ) => {
    const service = coordinator();
    const claim = await admitAndClaim(suffix);
    const blockedPermission = conclusion === "needs_human" ? {
      permissionRequestId: `permission_${suffix}`,
      actionDescriptorDigest: `sha256:${"c".repeat(64)}`,
      policySnapshotDigest: claim.admissionPolicySnapshot.receiptDigest,
    } : undefined;
    if (blockedPermission) await fixture.pool.query(
      `INSERT INTO cp_permission_request(organization_id, permission_request_id,
         run_id, runner_id, attempt_id, attempt_number, action_id, resolution_id,
         permission_request_digest, policy_snapshot_digest, state, request,
         current_receipt, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'waiting',$11::jsonb,'{}'::jsonb,$12,$12)`,
      [principal.organizationId, blockedPermission.permissionRequestId, claim.runId,
        principal.runnerId, claim.attempt.id, claim.attempt.number,
        `action_${suffix}`, `resolution_${suffix}`, `sha256:${"d".repeat(64)}`,
        blockedPermission.policySnapshotDigest,
        JSON.stringify({ actionDescriptorDigest: blockedPermission.actionDescriptorDigest,
          attempt: { fencingTokenDigest: claim.attempt.fencingTokenDigest } }), now],
    );
    const complete = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "complete",
      attempt: { attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch, fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest },
      occurredAt: now.toISOString(), conclusion,
      reasonCode: `executor_${conclusion}`,
      resultDigest: `sha256:${"8".repeat(64)}`,
      artifactDigests: [], evidenceDigests: [],
      ...(blockedPermission ? { blockedPermission } : {}),
    });
    await expect(service.lifecycle({ principal, runId: claim.runId,
      action: "complete", request: complete })).resolves.toMatchObject({ kind: "accepted" });
    await expect(service.inspect({ organizationId: principal.organizationId,
      runId: claim.runId })).resolves.toMatchObject({ canonicalStatus, status });
    const attempt = await fixture.pool.query<{ state: string }>(
      `SELECT state FROM cp_hosted_attempt WHERE organization_id = $1
       AND run_id = $2 AND attempt_number = $3`,
      [principal.organizationId, claim.runId, claim.attempt.number],
    );
    expect(attempt.rows[0]?.state).toBe(attemptState);
  });

  it("blocks Runner lifecycle bypass while exact approval is pending", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("approval_bypass");
    const attempt = { attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
      epoch: claim.attempt.epoch, fencingToken: claim.attempt.fencingToken,
      fencingTokenDigest: claim.attempt.fencingTokenDigest };
    const needsHuman = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId, runnerId: principal.runnerId,
      runId: claim.runId, action: "complete", attempt, occurredAt: now.toISOString(),
      conclusion: "needs_human", reasonCode: "executor_needs_human",
      resultDigest: `sha256:${"a".repeat(64)}`, artifactDigests: [], evidenceDigests: [],
      blockedPermission: { permissionRequestId: "permission_approval_bypass",
        actionDescriptorDigest: `sha256:${"e".repeat(64)}`,
        policySnapshotDigest: claim.admissionPolicySnapshot.receiptDigest },
    });
    await expect(service.lifecycle({ principal, runId: claim.runId,
      action: "complete", request: needsHuman })).resolves.toEqual({
        kind: "conflict", reason: "invalid_transition",
      });
    await fixture.pool.query(
      `INSERT INTO cp_permission_request(organization_id, permission_request_id,
         run_id, runner_id, attempt_id, attempt_number, action_id, resolution_id,
         permission_request_digest, policy_snapshot_digest, state, request,
         current_receipt, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'waiting',$11::jsonb,'{}'::jsonb,$12,$12)`,
      [principal.organizationId, "permission_approval_bypass", claim.runId,
        principal.runnerId, claim.attempt.id, claim.attempt.number,
        "action_approval_bypass", "resolution_approval_bypass",
        `sha256:${"f".repeat(64)}`, claim.admissionPolicySnapshot.receiptDigest,
        JSON.stringify({ actionDescriptorDigest: `sha256:${"e".repeat(64)}`,
          attempt: { fencingTokenDigest: claim.attempt.fencingTokenDigest } }), now],
    );
    await service.lifecycle({ principal, runId: claim.runId,
      action: "complete", request: needsHuman });
    const running = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId, runnerId: principal.runnerId,
      runId: claim.runId, action: "running", attempt, occurredAt: now.toISOString(),
      executorId: claim.executorId,
      executorCapabilityDigest: claim.authority.executorCapabilityDigest,
    });
    const success = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId, runnerId: principal.runnerId,
      runId: claim.runId, action: "complete", attempt, occurredAt: now.toISOString(),
      conclusion: "success", reasonCode: "executor_success",
      resultDigest: `sha256:${"b".repeat(64)}`, artifactDigests: [], evidenceDigests: [],
    });

    await expect(service.lifecycle({ principal, runId: claim.runId,
      action: "running", request: running })).resolves.toEqual({
        kind: "conflict", reason: "invalid_transition",
      });
    await expect(service.lifecycle({ principal, runId: claim.runId,
      action: "complete", request: success })).resolves.toEqual({
        kind: "conflict", reason: "invalid_transition",
      });
  });

  it("keeps rejected exclusively for reject-start", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("reject_start_state");
    const rejected = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId, runnerId: principal.runnerId,
      runId: claim.runId, action: "reject-start",
      attempt: { attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch, fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest },
      occurredAt: now.toISOString(), executorId: claim.executorId,
      reasonCode: "executor_unavailable",
    });
    await service.lifecycle({ principal, runId: claim.runId,
      action: "reject-start", request: rejected });
    expect((await fixture.pool.query<{ state: string }>(
      "SELECT state FROM cp_hosted_attempt WHERE run_id = $1",
      [claim.runId])).rows[0]?.state).toBe("rejected");
  });

  it("settles cancellation racing completion exactly once", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("4");
    const complete = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "complete",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      conclusion: "success",
      reasonCode: "executor_success",
      resultDigest: `sha256:${"5".repeat(64)}`,
      artifactDigests: [],
      evidenceDigests: [],
    });
    const cancel = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "cancel",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      reasonCode: "operator_cancelled",
    });

    const outcomes = await Promise.all([
      service.lifecycle({
        principal,
        runId: claim.runId,
        action: "cancel",
        request: cancel,
      }),
      service.lifecycle({ principal, runId: claim.runId, action: "complete", request: complete }),
    ]);
    expect(outcomes.filter(({ kind }) => kind === "accepted").length).toBeGreaterThanOrEqual(1);
    const terminal = await service.inspect({ organizationId: "org_hosted", runId: claim.runId });
    expect(terminal?.state).toBe("cancelled");
  });

  it("replays one lifecycle receipt under an identical concurrent operation", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("concurrent_lifecycle");
    const progress = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "progress",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      progressId: `progress_${"8".repeat(64)}`,
      progressDigest: `sha256:${"9".repeat(64)}`,
    });

    const outcomes = await Promise.all([
      service.lifecycle({
        principal,
        runId: claim.runId,
        action: "progress",
        request: progress,
      }),
      service.lifecycle({
        principal,
        runId: claim.runId,
        action: "progress",
        request: progress,
      }),
    ]);

    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "accepted",
      "replayed",
    ]);
    const receipts = await fixture.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM cp_hosted_lifecycle_receipt
       WHERE organization_id = $1 AND operation_id = $2`,
      [principal.organizationId, progress.operationId],
    );
    expect(receipts.rows[0]?.count).toBe(1);
  });

  it("reclaims an expired lease with a new attempt and fences the old one", async () => {
    const service = coordinator();
    const claim = await admitAndClaim("5");
    const materials = createMaterialActionCoordinator({ pool: fixture.pool, clock });
    await expect(materials.recordNotStarted({ principal,
      fencingToken: claim.attempt.fencingToken, runId: claim.runId,
      attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
      proofId: "proof_no_start_5", proofDigest: `sha256:${"5".repeat(64)}` }))
      .resolves.toEqual({ kind: "recorded" });
    now = new Date(now.getTime() + 61_000);
    const reclaimed = await service.claim({
      principal,
      request: hostedClaimRequest({
        operationId: "operation_claim_5b",
        requestId: "request_claim_5b",
      }),
    });
    expect(reclaimed.kind).toBe("claimed");
    if (reclaimed.kind !== "claimed") throw new Error("reclaim failed");
    expect(reclaimed.claim.attempt.number).toBe(2);
    expect(reclaimed.claim.attempt.id).not.toBe(claim.attempt.id);

    const heartbeat = await buildHostedLifecycleRequestV1({
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runId: claim.runId,
      action: "heartbeat",
      attempt: {
        attemptId: claim.attempt.id,
        attemptNumber: claim.attempt.number,
        epoch: claim.attempt.epoch,
        fencingToken: claim.attempt.fencingToken,
        fencingTokenDigest: claim.attempt.fencingTokenDigest,
      },
      occurredAt: now.toISOString(),
      expectedLeaseExpiresAt: claim.attempt.leaseExpiresAt,
    });
    await expect(
      service.lifecycle({ principal, runId: claim.runId, action: "heartbeat", request: heartbeat }),
    ).resolves.toEqual({ kind: "stale_fence" });
  });

  it("rolls back admission if its audit write fails", async () => {
    const service = coordinator();
    const input = await hostedAdmissionFixture({ runId: "run_rollback", suffix: "6" });
    await fixture.pool.query(
      `ALTER TABLE cp_hosted_audit_event
       ADD CONSTRAINT reject_rollback_audit
       CHECK ((event ->> 'runId') <> 'run_rollback')`,
    );
    await expect(
      service.admit({ runId: "run_rollback", admission: input.admission, policy: input.policy }),
    ).rejects.toThrow();
    const row = await fixture.pool.query(
      "SELECT run_id FROM cp_hosted_run WHERE run_id = 'run_rollback'",
    );
    expect(row.rowCount).toBe(0);
    await fixture.pool.query(
      "ALTER TABLE cp_hosted_audit_event DROP CONSTRAINT reject_rollback_audit",
    );
  });
});
