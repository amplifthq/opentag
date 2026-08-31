import { createHash } from "node:crypto";
import {
  canonicalJsonStringify,
  computeMaterialActionFencingTokenDigestV1,
  computePublicationOperationReceiptDigestV1,
} from "@opentag/control-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createPublicationPublisher } from "../src/modules/publication-candidates/publisher.js";
import { createRunnerDirectory, type RuntimePrincipal } from "../src/modules/runners/index.js";
import { hostedAdmissionFixture, hostedClaimRequest, hostedGrantIssuerFixture, recordHostedReadiness } from "./control-fixtures.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const now = new Date("2026-08-15T12:00:00.000Z");
const sha256 = (value: unknown) => `sha256:${createHash("sha256")
  .update(canonicalJsonStringify(value)).digest("hex")}`;

describe.skipIf(!TEST_DATABASE_URL)("exact-approved publication PostgreSQL authority", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let principal: RuntimePrincipal;
  let claim: Awaited<ReturnType<ReturnType<typeof createHostedRunCoordinator>["claim"]>> extends { kind: "claimed"; claim: infer T } ? T : never;
  let publisher: ReturnType<typeof createPublicationPublisher>;
  const candidate = { candidateId: "candidate_publication", runId: "run_publication",
    attemptId: "", projectTargetId: "target_publication", frozenBaseRevision: "a".repeat(40),
    workspaceTreeDigest: "b".repeat(40), patchDigest: sha256("patch"),
    changedFiles: ["packages/local-runtime/src/pr.ts"], verificationEvidenceIds: [sha256("verify")],
    publicationPolicyDigest: sha256("policy"), createdAt: now.toISOString() };
  const repository = { provider: "github" as const, owner: "acme", repo: "demo", remote: "origin", baseBranch: "main" };

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const runners = createRunnerDirectory({ pool: fixture.pool, clock: { now: () => now },
      idFactory: () => "credential_publication", tokenFactory: () => "runtime_publication_secret" });
    const registration = await runners.register({ organizationId: "org_publication", organizationName: "Publication",
      request: { schemaVersion: 1, protocolVersion: "1.0", requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_publication", operationId: "operation_register_publication", runnerId: "runner_publication",
        capabilities: ["relay.claim-fence.v1", "relay.hosted-admission.v1", "relay.hosted-claim.v1", "relay.lifecycle.v1", "relay.publication.v1", "relay.readiness.v1", "relay.source-content-redeem.v1"] } });
    if (registration.kind !== "created") throw new Error("registration failed");
    const authenticated = await runners.authenticate("runtime_publication_secret");
    if (authenticated.kind !== "authenticated") throw new Error("authentication failed");
    principal = authenticated.principal;
    await recordHostedReadiness({ pool: fixture.pool, organizationId: principal.organizationId, runnerId: principal.runnerId });
    const hosted = createHostedRunCoordinator({ pool: fixture.pool, clock: { now: () => now }, leaseDurationMs: 60_000,
      idFactory: () => "attempt_publication", tokenFactory: () => "fence_publication", issueSourceContentGrantInTransaction: hostedGrantIssuerFixture });
    const admission = await hostedAdmissionFixture({ runId: candidate.runId, suffix: "publication", organizationId: principal.organizationId,
      runnerId: principal.runnerId, publicationMode: "pull_request" });
    await hosted.admit({ runId: candidate.runId, admission: admission.admission, policy: admission.policy });
    const outcome = await hosted.claim({ principal, request: hostedClaimRequest({ operationId: "operation_claim_publication", requestId: "request_claim_publication", credentialId: "credential_publication" }) });
    if (outcome.kind !== "claimed") throw new Error("claim failed");
    claim = outcome.claim as typeof claim;
    candidate.attemptId = claim.attempt.id;
    await fixture.pool.query(
      `INSERT INTO cp_publication_candidate(organization_id,candidate_id,run_id,attempt_id,attempt_number,project_target_id,frozen_base_revision,workspace_tree_digest,patch_digest,changed_files,verification_evidence_ids,publication_policy_digest,candidate,completion_assessment,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,
      [principal.organizationId, candidate.candidateId, candidate.runId, candidate.attemptId, claim.attempt.number,
        candidate.projectTargetId, candidate.frozenBaseRevision, candidate.workspaceTreeDigest, candidate.patchDigest,
        candidate.changedFiles, candidate.verificationEvidenceIds, candidate.publicationPolicyDigest, JSON.stringify(candidate),
        JSON.stringify({ state: "proposal_ready", accepted: true, candidateId: candidate.candidateId, reasonCodes: ["proposal_ready"], assessedAt: now.toISOString() }), now]);
    let id = 0;
    publisher = createPublicationPublisher({ pool: fixture.pool, clock: { now: () => now }, idFactory: (kind) => `publication_${kind}_${++id}` });
  });

  afterAll(async () => fixture.close());

  const approval = (overrides: Partial<Record<string, unknown>> = {}) => ({ organizationId: principal.organizationId,
    runnerId: principal.runnerId, runId: candidate.runId, attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
    fencingToken: claim.attempt.fencingToken, candidateId: candidate.candidateId, candidateDigest: sha256(candidate),
    approvalId: "approval_publication", approverId: "operator_publication", repository,
    branch: "opentag/run_publication", expectedHeadSha: "c".repeat(40), runnerGeneration: 1,
    approvedAt: now.toISOString(), expiresAt: "2026-08-15T12:30:00.000Z", ...overrides });

  const claimOperation = (step: "push_owned_branch" | "create_draft_pull_request") => publisher.claim({ principal,
    runId: candidate.runId, attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
    fencingToken: claim.attempt.fencingToken, candidateId: candidate.candidateId, candidateDigest: sha256(candidate),
    runnerGeneration: 1, step });

  it("requires a distinct actor and exact Candidate, Attempt/fence, branch, generation, and unexpired pull-request policy", async () => {
    await expect(publisher.approve(approval({ approverId: principal.runnerId }))).resolves.toMatchObject({ kind: "rejected", reason: "self_approval_prohibited" });
    await expect(publisher.approve(approval({ candidateDigest: sha256("wrong") }))).resolves.toMatchObject({ kind: "rejected", reason: "candidate_digest_mismatch" });
    await expect(publisher.approve(approval({ branch: "main" }))).resolves.toMatchObject({ kind: "rejected", reason: "target_branch_write_prohibited" });
    await expect(publisher.approve(approval({ expiresAt: "2026-08-15T11:59:59.000Z" }))).resolves.toMatchObject({ kind: "rejected", reason: "approval_expired" });
    await expect(publisher.approve(approval())).resolves.toMatchObject({ kind: "approved" });
    await expect(publisher.approve(approval())).resolves.toMatchObject({ kind: "replayed" });
  });

  it("serializes publication, records start before effects, and authorizes retry only after durable authoritative absence", async () => {
    const push = await claimOperation("push_owned_branch");
    expect(push.kind).toBe("issued");
    if (push.kind !== "issued") return;
    await expect(publisher.begin({ principal, fencingToken: claim.attempt.fencingToken, capability: push.capability, begunAt: now.toISOString() })).resolves.toEqual({ kind: "begun" });
    const receiptSeed = { schemaVersion: 1 as const, protocolVersion: "1.0" as const, receiptId: "receipt_push",
      capabilityId: push.capability.capabilityId, operationId: push.capability.operationId, organizationId: principal.organizationId,
      runId: candidate.runId, attemptId: claim.attempt.id, candidateId: candidate.candidateId, candidateDigest: sha256(candidate),
      step: "push_owned_branch" as const, runnerId: principal.runnerId, runnerGeneration: 1,
      fencingTokenDigest: await computeMaterialActionFencingTokenDigestV1(claim.attempt.fencingToken),
      observation: { kind: "present" as const, headSha: "c".repeat(40) }, outcome: "succeeded" as const, observedAt: now.toISOString() };
    const pushReceipt = { ...receiptSeed, receiptDigest: await computePublicationOperationReceiptDigestV1(receiptSeed) };
    await expect(publisher.record({ principal, receipt: pushReceipt })).resolves.toMatchObject({ kind: "recorded" });
    const pr = await claimOperation("create_draft_pull_request");
    expect(pr.kind).toBe("issued");
    if (pr.kind !== "issued") return;
    await publisher.begin({ principal, fencingToken: claim.attempt.fencingToken, capability: pr.capability, begunAt: now.toISOString() });
    const unknownSeed = { ...receiptSeed, receiptId: "receipt_pr_unknown", capabilityId: pr.capability.capabilityId,
      operationId: pr.capability.operationId, step: "create_draft_pull_request" as const,
      observation: { kind: "ambiguous" as const }, outcome: "outcome_unknown" as const };
    await publisher.record({ principal, receipt: { ...unknownSeed, receiptDigest: await computePublicationOperationReceiptDigestV1(unknownSeed) } });
    await expect(claimOperation("create_draft_pull_request")).resolves.toMatchObject({ kind: "unavailable", reason: "reconciliation_required" });
    await expect(publisher.reconcile({ principal, capabilityId: pr.capability.capabilityId, operationId: pr.capability.operationId,
      reconciliationId: "reconcile_pr_absent", observation: { kind: "absent" }, observedAt: now.toISOString() })).resolves.toEqual({ kind: "retry_authorized" });
    const retried = await claimOperation("create_draft_pull_request");
    expect(retried.kind).toBe("issued");
    if (retried.kind !== "issued") return;
    await expect(publisher.begin({ principal, fencingToken: claim.attempt.fencingToken,
      capability: retried.capability, begunAt: now.toISOString() })).resolves.toEqual({ kind: "begun" });
    const presentSeed = { ...receiptSeed, receiptId: "receipt_pr_present",
      capabilityId: retried.capability.capabilityId, operationId: retried.capability.operationId,
      step: "create_draft_pull_request" as const,
      observation: { kind: "present" as const, headSha: "c".repeat(40),
        externalId: "github_pr_7", externalUri: "https://github.com/acme/demo/pull/7", draft: true as const },
      outcome: "succeeded" as const };
    await expect(publisher.record({ principal, receipt: { ...presentSeed,
      receiptDigest: await computePublicationOperationReceiptDigestV1(presentSeed) } }))
      .resolves.toMatchObject({ kind: "recorded" });
  });

  it("settles exactly once only after successful receipts and frozen checks prove exact-head readiness", async () => {
    // Candidate settlement is intentionally non-terminal for pull_request,
    // while Executor completion has already made this attempt successful.
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt SET state = 'succeeded'
       WHERE organization_id = $1 AND run_id = $2 AND attempt_number = $3`,
      [principal.organizationId, candidate.runId, claim.attempt.number],
    );
    await fixture.pool.query(
      `UPDATE cp_hosted_run SET state = 'running', terminal_kind = NULL, terminal_receipt = NULL
       WHERE organization_id = $1 AND run_id = $2`,
      [principal.organizationId, candidate.runId],
    );
    const completion = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.publication.v1"] as ["relay.publication.v1"],
      requestId: "request_complete_publication", organizationId: principal.organizationId,
      runnerId: principal.runnerId, runnerGeneration: 1, runId: candidate.runId,
      attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
      fencingToken: claim.attempt.fencingToken, candidateId: candidate.candidateId,
      candidateDigest: sha256(candidate), observation: { provider: "github" as const,
        repository: { owner: "acme", repo: "demo" }, remote: "origin",
        branch: "opentag/run_publication", baseBranch: "main", pullRequestNumber: 7,
        pullRequestResourceRef: "github:acme/demo:pull_request:7",
        pullRequestUrl: "https://github.com/acme/demo/pull/7", draft: true as const,
        state: "open" as const, headSha: "c".repeat(40), baseSha: "d".repeat(40),
        checks: { test: "passed" as const }, checksComplete: true,
        observedAt: now.toISOString() } };
    await expect(publisher.complete({ principal, completion })).resolves.toEqual({ kind: "ready", projection: "ready_for_review" });
    await expect(publisher.complete({ principal, completion })).resolves.toEqual({ kind: "replayed" });
    await expect(publisher.complete({ principal, completion: { ...completion,
      observation: { ...completion.observation, checks: { test: "pending" as const } } } }))
      .resolves.toEqual({ kind: "conflict", reason: "completion_replay_mismatch" });
    // Reconnecting or restarting the same Runner only consults the immutable
    // coordinator ledger; a terminal completion never causes a blind write.
    await expect(publisher.claimNextForRunner({ principal })).resolves.toEqual({ kind: "empty" });
    await expect(fixture.pool.query<{ state: string; terminal_kind: string; terminal_receipt: { kind: string } }>(
      `SELECT state,terminal_kind,terminal_receipt FROM cp_hosted_run WHERE organization_id=$1 AND run_id=$2`,
      [principal.organizationId, candidate.runId],
    )).resolves.toMatchObject({ rows: [{ state: "succeeded", terminal_kind: "succeeded",
      terminal_receipt: { kind: "ready_for_review" } }] });
    await expect(fixture.pool.query(
      `UPDATE cp_publication_completion SET branch = 'other' WHERE organization_id=$1 AND run_id=$2`,
      [principal.organizationId, candidate.runId],
    )).rejects.toThrow("publication_authority_immutable");
  });

  it("keeps publication authority rows immutable after approval", async () => {
    await expect(fixture.pool.query("UPDATE cp_publication_intent SET branch = 'other' WHERE organization_id = $1", [principal.organizationId]))
      .rejects.toThrow("publication_authority_immutable");
  });
});
