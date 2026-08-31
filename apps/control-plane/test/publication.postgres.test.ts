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

const now = new Date();
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
    await fixture.pool.query(
      `UPDATE cp_runner_readiness SET observed_at=$3, expires_at=$4
       WHERE organization_id=$1 AND runner_id=$2`,
      [principal.organizationId, principal.runnerId, now, new Date(now.getTime() + 60 * 60_000)],
    );
    const hosted = createHostedRunCoordinator({ pool: fixture.pool, clock: { now: () => now }, leaseDurationMs: 60_000,
      idFactory: () => "attempt_publication", tokenFactory: () => "fence_publication", issueSourceContentGrantInTransaction: hostedGrantIssuerFixture });
    const admission = await hostedAdmissionFixture({ runId: candidate.runId, suffix: "publication", organizationId: principal.organizationId,
      runnerId: principal.runnerId, publicationMode: "pull_request",
      queueClaimDeadline: new Date(now.getTime() + 60 * 60_000).toISOString() });
    await hosted.admit({ runId: candidate.runId, admission: admission.admission, policy: admission.policy });
    const outcome = await hosted.claim({ principal, request: hostedClaimRequest({ operationId: "operation_claim_publication", requestId: "request_claim_publication", credentialId: "credential_publication" }) });
    if (outcome.kind !== "claimed") throw new Error("claim failed");
    claim = outcome.claim as typeof claim;
    candidate.attemptId = claim.attempt.id;
    const workspaceAttestation = { workspaceId: "workspace_publication",
      workspacePathDigest: sha256("workspace_path"), repositoryPathDigest: sha256("repository_path"),
      worktreeIdentityDigest: sha256("worktree"), baseRevision: candidate.frozenBaseRevision,
      currentRevision: "c".repeat(40), currentTree: candidate.workspaceTreeDigest,
      workspaceStateDigest: sha256("workspace_state"), attemptId: claim.attempt.id,
      attemptNumber: claim.attempt.number, fencingTokenDigest: claim.attempt.fencingTokenDigest,
      credentialId: principal.credentialId, leaseExpiresAt: claim.attempt.leaseExpiresAt };
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt SET state='succeeded',workspace_attestation=$4::jsonb
       WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3`,
      [principal.organizationId,candidate.runId,claim.attempt.id,JSON.stringify(workspaceAttestation)]);
    await fixture.pool.query(
      `INSERT INTO cp_project_target(organization_id,project_target_id,runner_id,binding_digest,
       provider,owner,repo,default_executor,default_branch,version,updated_at)
       VALUES($1,$2,$3,$4,'github','Acme','Demo','executor_acp','main',1,$5)`,
      [principal.organizationId,candidate.projectTargetId,principal.runnerId,
        admission.admission.projectTarget.digest,now]);
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

  const ownership = (overrides: Partial<Record<string, unknown>> = {}) => ({
    schemaVersion: 1 as const, protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.publication.v1"] as ["relay.publication.v1"],
    requestId: "request_ownership_publication", organizationId: principal.organizationId,
    runnerId: principal.runnerId, runnerGeneration: 1, runId: candidate.runId,
    attemptId: claim.attempt.id, attemptNumber: claim.attempt.number, fencingToken: claim.attempt.fencingToken,
    candidateId: candidate.candidateId, candidateDigest: sha256(candidate),
    projectTargetId: candidate.projectTargetId, targetBindingDigest: `sha256:${"e".repeat(64)}`,
    remote: "origin", baseBranch: "main", frozenBaseRevision: candidate.frozenBaseRevision,
    workspaceTreeDigest: candidate.workspaceTreeDigest, branch: "opentag/run_publication",
    expectedHeadSha: "c".repeat(40), attestedAt: now.toISOString(), ...overrides });

  const approval = (ownershipId: string, ownershipDigest: string,
    overrides: Partial<Record<string, unknown>> = {}) => ({ organizationId: principal.organizationId,
    runnerId: principal.runnerId, runId: candidate.runId, ownershipId, ownershipDigest,
    candidateId: candidate.candidateId, candidateDigest: sha256(candidate),
    approvalId: "approval_publication", approverId: "operator_publication",
    approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), ...overrides });

  const claimOperation = (step: "push_owned_branch" | "create_draft_pull_request") => publisher.claim({ principal,
    runId: candidate.runId, attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
    fencingToken: claim.attempt.fencingToken, candidateId: candidate.candidateId, candidateDigest: sha256(candidate),
    runnerGeneration: 1, step });

  it("freezes exact Runner-owned branch authority before human approval and conflicts on any replay change", async () => {
    await expect(publisher.attestOwnership({ principal, attestation: ownership({
      candidateDigest: sha256("wrong") }) as never })).resolves.toMatchObject({ kind: "rejected" });
    const ownershipRace = await Promise.all([
      publisher.attestOwnership({ principal, attestation: ownership() as never }),
      publisher.attestOwnership({ principal, attestation: ownership() as never }),
    ]);
    expect(ownershipRace.map((result) => result.kind).sort()).toEqual(["recorded", "replayed"]);
    const owned = ownershipRace.find((result) => result.kind !== "rejected")!;
    if (owned.kind === "rejected") return;
    await expect(publisher.attestOwnership({ principal, attestation: ownership() as never }))
      .resolves.toMatchObject({ kind: "replayed", ownershipId: owned.ownershipId });
    await expect(publisher.attestOwnership({ principal, attestation: ownership({ remote: "upstream" }) as never }))
      .resolves.toMatchObject({ kind: "rejected", reason: "ownership_attestation_conflict" });
    await expect(publisher.approve(approval(owned.ownershipId, owned.ownershipDigest,
      { approverId: principal.runnerId }))).resolves.toMatchObject({ kind: "rejected", reason: "self_approval_prohibited" });
    await expect(publisher.approve(approval(owned.ownershipId, sha256("wrong"))))
      .resolves.toMatchObject({ kind: "rejected", reason: "stale_publication_authority" });
    await expect(publisher.approve(approval(owned.ownershipId, owned.ownershipDigest,
      { expiresAt: new Date(now.getTime() - 1).toISOString() }))).resolves.toMatchObject({ kind: "rejected", reason: "approval_expired" });
    const approvalRace = await Promise.all([
      publisher.approve(approval(owned.ownershipId, owned.ownershipDigest)),
      publisher.approve(approval(owned.ownershipId, owned.ownershipDigest)),
    ]);
    expect(approvalRace.map((result) => result.kind).sort()).toEqual(["approved", "replayed"]);
    await expect(publisher.approve(approval(owned.ownershipId, owned.ownershipDigest,
      { approverId: "operator_changed" }))).resolves.toMatchObject({ kind: "rejected", reason: "approval_replay_conflict" });
    await expect(publisher.approve(approval(owned.ownershipId, owned.ownershipDigest,
      { expiresAt: new Date(now.getTime() + 29 * 60_000).toISOString() }))).resolves.toMatchObject({ kind: "rejected", reason: "approval_replay_conflict" });
  });

  it("serializes publication, records start before effects, and authorizes retry only after durable authoritative absence", async () => {
    const pushRace = await Promise.all([
      claimOperation("push_owned_branch"), claimOperation("push_owned_branch"),
    ]);
    expect(pushRace.map((result) => result.kind).sort()).toEqual(["issued", "unavailable"]);
    const push = pushRace.find((result) => result.kind === "issued")!;
    expect(push.kind).toBe("issued");
    if (push.kind !== "issued") return;
    // RED before Slice B: a caller could backdate begunAt past a DB-expired
    // lease and the publisher would accept it. Only the coordinator DB clock
    // may authorize begin.
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt SET lease_expires_at=CURRENT_TIMESTAMP - interval '1 second'
       WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3`,
      [principal.organizationId, candidate.runId, claim.attempt.id],
    );
    await expect(publisher.begin({ principal, fencingToken: claim.attempt.fencingToken,
      capability: push.capability, begunAt: new Date(now.getTime() - 60 * 60_000).toISOString() }))
      .resolves.toEqual({ kind: "stale_fence" });
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt SET lease_expires_at=CURRENT_TIMESTAMP + interval '1 minute'
       WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3`,
      [principal.organizationId, candidate.runId, claim.attempt.id],
    );
    await expect(publisher.begin({ principal, fencingToken: claim.attempt.fencingToken, capability: push.capability, begunAt: now.toISOString() })).resolves.toEqual({ kind: "begun" });
    const receiptSeed = { schemaVersion: 1 as const, protocolVersion: "1.0" as const, receiptId: "receipt_push",
      capabilityId: push.capability.capabilityId, operationId: push.capability.operationId, organizationId: principal.organizationId,
      runId: candidate.runId, attemptId: claim.attempt.id, candidateId: candidate.candidateId, candidateDigest: sha256(candidate),
      step: "push_owned_branch" as const, runnerId: principal.runnerId, runnerGeneration: 1,
      fencingTokenDigest: await computeMaterialActionFencingTokenDigestV1(claim.attempt.fencingToken),
      observation: { kind: "present" as const, headSha: "c".repeat(40) }, outcome: "succeeded" as const, observedAt: now.toISOString() };
    const forgedPush = { ...receiptSeed, receiptId: "receipt_push_forged",
      observation: { kind: "present" as const, headSha: "d".repeat(40) } };
    await expect(publisher.record({ principal, receipt: { ...forgedPush,
      receiptDigest: await computePublicationOperationReceiptDigestV1(forgedPush) } })).resolves.toEqual({ kind: "conflict" });
    await expect(fixture.pool.query(`SELECT 1 FROM cp_publication_receipt WHERE organization_id=$1 AND capability_id=$2`,
      [principal.organizationId, push.capability.capabilityId])).resolves.toMatchObject({ rows: [] });
    const pushReceipt = { ...receiptSeed, receiptDigest: await computePublicationOperationReceiptDigestV1(receiptSeed) };
    await expect(publisher.record({ principal, receipt: pushReceipt })).resolves.toMatchObject({ kind: "recorded" });
    const pr = await claimOperation("create_draft_pull_request");
    expect(pr.kind).toBe("issued");
    if (pr.kind !== "issued") return;
    await publisher.begin({ principal, fencingToken: claim.attempt.fencingToken, capability: pr.capability, begunAt: now.toISOString() });
    const forgedPr = { ...receiptSeed, receiptId: "receipt_pr_forged", capabilityId: pr.capability.capabilityId,
      operationId: pr.capability.operationId, step: "create_draft_pull_request" as const,
      observation: { kind: "present" as const, headSha: "d".repeat(40), externalId: "github_pr_8",
        externalUri: "https://github.com/evil/repo/pull/8", draft: true as const, provider: "github" as const,
        repository: { owner: "evil", repo: "repo" }, baseBranch: "other", state: "open" as const },
      outcome: "succeeded" as const };
    await expect(publisher.record({ principal, receipt: { ...forgedPr,
      receiptDigest: await computePublicationOperationReceiptDigestV1(forgedPr) } })).resolves.toEqual({ kind: "conflict" });
    await expect(fixture.pool.query(`SELECT 1 FROM cp_publication_receipt WHERE organization_id=$1 AND capability_id=$2`,
      [principal.organizationId, pr.capability.capabilityId])).resolves.toMatchObject({ rows: [] });
    const unknownSeed = { ...receiptSeed, receiptId: "receipt_pr_unknown", capabilityId: pr.capability.capabilityId,
      operationId: pr.capability.operationId, step: "create_draft_pull_request" as const,
      observation: { kind: "ambiguous" as const }, outcome: "outcome_unknown" as const };
    await publisher.record({ principal, receipt: { ...unknownSeed, receiptDigest: await computePublicationOperationReceiptDigestV1(unknownSeed) } });
    // RED before Slice B: this became `{ kind: "blocked" }`, which the HTTP
    // handler collapsed into 204 and stranded the exact begun operation.
    await expect(publisher.claimNextForRunner({ principal })).resolves.toMatchObject({
      kind: "reconciliation_pending", capability: { capabilityId: pr.capability.capabilityId,
        operationId: pr.capability.operationId },
    });
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
      observation: { kind: "ambiguous" as const }, outcome: "outcome_unknown" as const };
    await expect(publisher.record({ principal, receipt: { ...presentSeed,
      receiptDigest: await computePublicationOperationReceiptDigestV1(presentSeed) } }))
      .resolves.toMatchObject({ kind: "recorded" });
    // RED before Slice B: an exact provider presence observation remained
    // blocked behind the old unknown receipt rather than settling this step.
    await expect(publisher.reconcile({ principal, capabilityId: retried.capability.capabilityId,
      operationId: retried.capability.operationId, reconciliationId: "reconcile_pr_present",
      observation: { kind: "present", headSha: "c".repeat(40), externalId: "github_pr_7",
        externalUri: "https://github.com/acme/demo/pull/7", draft: true, provider: "github",
        repository: { owner: "acme", repo: "demo" }, baseBranch: "main", state: "open" },
      observedAt: now.toISOString() })).resolves.toEqual({ kind: "settled" });
    await expect(publisher.claimNextForRunner({ principal })).resolves.toMatchObject({
      kind: "completion_pending", capability: { capabilityId: retried.capability.capabilityId },
    });
    await expect(fixture.pool.query<{ step: string; attempt_number: number }>(
      `SELECT step,attempt_number FROM cp_publication_capability
       WHERE organization_id=$1 ORDER BY step,attempt_number`, [principal.organizationId]))
      .resolves.toMatchObject({ rows: [
        { step: "create_draft_pull_request", attempt_number: 1 },
        { step: "create_draft_pull_request", attempt_number: 2 },
        { step: "push_owned_branch", attempt_number: 1 },
      ] });
  });

  it("normalizes canonical repository identity and rejects casing, remote, and base variants for the owned branch", async () => {
    const stored = (await fixture.pool.query<any>(
      `SELECT * FROM cp_publication_branch_ownership WHERE organization_id=$1`,
      [principal.organizationId])).rows[0];
    expect({ provider: stored.provider, owner: stored.owner, repo: stored.repo })
      .toEqual({ provider: "github", owner: "acme", repo: "demo" });
    await expect(fixture.pool.query(
      `INSERT INTO cp_publication_branch_ownership(organization_id,ownership_id,run_id,
       attempt_id,attempt_number,fencing_token_digest,runner_id,runner_generation,candidate_id,
       candidate_digest,project_target_id,target_binding_digest,provider,owner,repo,remote,
       base_branch,frozen_base_revision,workspace_tree_digest,branch,expected_head_sha,
       attestation_digest,attested_at,created_at)
       SELECT organization_id,'ownership_takeover',run_id,attempt_id,attempt_number,
       fencing_token_digest,runner_id,runner_generation,'candidate_takeover',candidate_digest,
       project_target_id,target_binding_digest,provider,owner,repo,'upstream','trunk',
       frozen_base_revision,workspace_tree_digest,upper(branch),expected_head_sha,
       $2,attested_at,created_at FROM cp_publication_branch_ownership
       WHERE organization_id=$1`, [principal.organizationId,sha256("takeover")]))
      .rejects.toMatchObject({ code: "23505" });
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
