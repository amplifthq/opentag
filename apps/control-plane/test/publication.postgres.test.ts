import { createHash } from "node:crypto";
import {
  canonicalJsonStringify,
  computeMaterialActionFencingTokenDigestV1,
  computePublicationCapabilityDigestV1,
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

  const completion = (fencingToken = claim.attempt.fencingToken) => ({
    schemaVersion: 1 as const, protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.publication.v1"] as ["relay.publication.v1"],
    requestId: "request_complete_publication", organizationId: principal.organizationId,
    runnerId: principal.runnerId, runnerGeneration: 1, runId: candidate.runId,
    attemptId: claim.attempt.id, attemptNumber: claim.attempt.number,
    fencingToken, candidateId: candidate.candidateId,
    candidateDigest: sha256(candidate), observation: { provider: "github" as const,
      repository: { owner: "acme", repo: "demo" }, remote: "origin",
      branch: "opentag/run_publication", baseBranch: "main", pullRequestNumber: 7,
      pullRequestResourceRef: "github:acme/demo:pull_request:7",
      pullRequestUrl: "https://github.com/acme/demo/pull/7", draft: true as const,
      state: "open" as const, headSha: "c".repeat(40), headBranch: "opentag/run_publication",
      headRepository: { owner: "AcMe", repo: "DeMo" }, baseSha: "d".repeat(40),
      checks: { test: "passed" as const }, checksComplete: true,
      observedAt: now.toISOString() } });

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
    // A durable succeeded receipt is authoritative forever: an absence read
    // cannot turn the already-settled operation back into a retry candidate.
    await expect(publisher.reconcile({ principal, capabilityId: push.capability.capabilityId,
      operationId: push.capability.operationId, reconciliationId: "reconcile_push_absent_after_success",
      observation: { kind: "absent" }, observedAt: now.toISOString() }))
      .resolves.toEqual({ kind: "conflict" });
    await expect(claimOperation("push_owned_branch")).resolves.toMatchObject({
      kind: "unavailable", reason: "operation_already_settled" });
    const next = await publisher.claimNextForRunner({ principal });
    expect(next).toMatchObject({ kind: "issued", capability: { step: "create_draft_pull_request" } });
    const pr = next;
    expect(pr.kind).toBe("issued");
    if (pr.kind !== "issued") return;
    await publisher.begin({ principal, fencingToken: claim.attempt.fencingToken, capability: pr.capability, begunAt: now.toISOString() });
    const forgedPr = { ...receiptSeed, receiptId: "receipt_pr_forged", capabilityId: pr.capability.capabilityId,
      operationId: pr.capability.operationId, step: "create_draft_pull_request" as const,
      observation: { kind: "present" as const, headSha: "d".repeat(40), externalId: "github_pr_8",
        externalUri: "https://github.com/evil/repo/pull/8", draft: true as const, provider: "github" as const,
        repository: { owner: "evil", repo: "repo" }, baseBranch: "other", state: "open" as const,
        headBranch: "opentag/wrong", headRepository: { owner: "evil", repo: "repo" } },
      outcome: "succeeded" as const };
    await expect(publisher.record({ principal, receipt: { ...forgedPr,
      receiptDigest: await computePublicationOperationReceiptDigestV1(forgedPr) } })).resolves.toEqual({ kind: "conflict" });
    await expect(fixture.pool.query(`SELECT 1 FROM cp_publication_receipt WHERE organization_id=$1 AND capability_id=$2`,
      [principal.organizationId, pr.capability.capabilityId])).resolves.toMatchObject({ rows: [] });
    const exactPresent = (capability: typeof pr.capability, receiptId: string) => ({ ...receiptSeed, receiptId,
      capabilityId: capability.capabilityId, operationId: capability.operationId,
      step: "create_draft_pull_request" as const, observation: { kind: "present" as const,
        headSha: "c".repeat(40), externalId: "github_pr_7", externalUri: "https://github.com/acme/demo/pull/7",
        draft: true as const, provider: "github" as const, repository: { owner: "acme", repo: "demo" },
        baseBranch: "main", state: "open" as const, headBranch: "opentag/run_publication",
        headRepository: { owner: "AcMe", repo: "DeMo" } }, outcome: "succeeded" as const });
    // Two independently pooled writer transactions.  With reconciliation
    // first, absence wins only before a receipt exists; the delayed receipt is
    // rejected, leaving no contradictory fact or additional begin window.
    const absentFirst = publisher.reconcile({ principal, capabilityId: pr.capability.capabilityId,
      operationId: pr.capability.operationId, reconciliationId: "reconcile_pr_absent",
      observation: { kind: "absent" }, observedAt: now.toISOString() });
    const delayedReceipt = new Promise<Awaited<ReturnType<typeof publisher.record>>>((resolve) => {
      setTimeout(() => { void (async () => {
        const seed = exactPresent(pr.capability, "receipt_pr_late_success");
        resolve(await publisher.record({ principal, receipt: { ...seed,
          receiptDigest: await computePublicationOperationReceiptDigestV1(seed) } }));
      })(); }, 10);
    });
    await expect(Promise.all([absentFirst, delayedReceipt])).resolves.toEqual([
      { kind: "retry_authorized" }, { kind: "conflict" },
    ]);
    const retried = await claimOperation("create_draft_pull_request");
    expect(retried.kind).toBe("issued");
    if (retried.kind !== "issued") return;
    // An older authoritative absence authorizes this one successor only.  It
    // cannot remain a permanent retry token after the latest attempt exists.
    await expect(claimOperation("create_draft_pull_request")).resolves.toMatchObject({
      kind: "unavailable", reason: "capability_nonrenewable",
    });
    await expect(publisher.begin({ principal, fencingToken: claim.attempt.fencingToken,
      capability: retried.capability, begunAt: now.toISOString() })).resolves.toEqual({ kind: "begun" });
    // Reverse lock ordering: a succeeded receipt commits first, then a delayed
    // absence loses.  The reducer must leave the operation settled and never
    // issue a second capability that could begin an effect.
    const receiptFirst = (async () => {
      const seed = exactPresent(retried.capability, "receipt_pr_success");
      return publisher.record({ principal, receipt: { ...seed,
        receiptDigest: await computePublicationOperationReceiptDigestV1(seed) } });
    })();
    const delayedAbsent = new Promise<Awaited<ReturnType<typeof publisher.reconcile>>>((resolve) => {
      setTimeout(() => { void publisher.reconcile({ principal, capabilityId: retried.capability.capabilityId,
        operationId: retried.capability.operationId, reconciliationId: "reconcile_pr_late_absent",
        observation: { kind: "absent" }, observedAt: now.toISOString() }).then(resolve); }, 10);
    });
    await expect(Promise.all([receiptFirst, delayedAbsent])).resolves.toMatchObject([
      { kind: "recorded" }, { kind: "conflict" },
    ]);
    await expect(publisher.claimNextForRunner({ principal })).resolves.toMatchObject({
      kind: "completion_pending", capability: { capabilityId: retried.capability.capabilityId },
    });
    await expect(fixture.pool.query<{ receipt: { observation: { headRepository: unknown } } }>(
      `SELECT receipt FROM cp_publication_receipt WHERE organization_id=$1 AND capability_id=$2`,
      [principal.organizationId, retried.capability.capabilityId],
    )).resolves.toMatchObject({ rows: [{ receipt: { observation: {
      headRepository: { owner: "AcMe", repo: "DeMo" },
    } } }] });
    await expect(fixture.pool.query<{ step: string; attempt_number: number }>(
      `SELECT step,attempt_number FROM cp_publication_capability
       WHERE organization_id=$1 ORDER BY step,attempt_number`, [principal.organizationId]))
      .resolves.toMatchObject({ rows: [
        { step: "create_draft_pull_request", attempt_number: 1 },
        { step: "create_draft_pull_request", attempt_number: 2 },
        { step: "push_owned_branch", attempt_number: 1 },
      ] });
  });

  it.each(["record", "reconcile"] as const)(
  "serializes attempt-one receipt and attempt-two reconciliation when %s starts first",
  async (firstKind) => {
    const suffix = firstKind === "record" ? "receipt_first" : "reconcile_first";
    const runId = `run_publication_lock_race_${suffix}`;
    const attemptId = `attempt_publication_lock_race_${suffix}`;
    const candidateId = `candidate_publication_lock_race_${suffix}`;
    const ownershipId = `ownership_publication_lock_race_${suffix}`;
    const intentId = `publication_intent_lock_race_${suffix}`;
    const operationId = `${intentId}:create_draft_pull_request`;
    const raceCandidate = { ...candidate, runId, attemptId, candidateId };
    const raceCandidateDigest = sha256(raceCandidate);
    await fixture.pool.query(
       `INSERT INTO cp_hosted_run
       SELECT (jsonb_populate_record(NULL::cp_hosted_run, to_jsonb(source) || jsonb_build_object(
         'run_id',$2::text,'admission_id',$3::text,'source_identity_digest',$4::text,'state','running',
         'terminal_kind',NULL,'terminal_receipt',NULL))).*
       FROM cp_hosted_run source WHERE organization_id=$1 AND run_id=$5`,
      [principal.organizationId, runId, `admission_publication_lock_race_${suffix}`,
        sha256(`source_lock_race_${suffix}`), candidate.runId],
    );
    await fixture.pool.query(
       `INSERT INTO cp_hosted_attempt
       SELECT (jsonb_populate_record(NULL::cp_hosted_attempt, to_jsonb(source) || jsonb_build_object(
         'run_id',$2::text,'attempt_id',$3::text,'lease_expires_at',$4::timestamptz))).*
       FROM cp_hosted_attempt source WHERE organization_id=$1 AND run_id=$5 AND attempt_id=$6`,
      [principal.organizationId, runId, attemptId, new Date(now.getTime() + 60_000), candidate.runId, claim.attempt.id],
    );
    await fixture.pool.query(
      `INSERT INTO cp_publication_candidate(organization_id,candidate_id,run_id,attempt_id,attempt_number,
       project_target_id,frozen_base_revision,workspace_tree_digest,patch_digest,changed_files,
       verification_evidence_ids,publication_policy_digest,candidate,completion_assessment,created_at)
       SELECT organization_id,$2,$3,$4,attempt_number,project_target_id,frozen_base_revision,
       workspace_tree_digest,patch_digest,changed_files,verification_evidence_ids,publication_policy_digest,
       $5::jsonb,completion_assessment,created_at FROM cp_publication_candidate
       WHERE organization_id=$1 AND candidate_id=$6`,
      [principal.organizationId, candidateId, runId, attemptId, JSON.stringify(raceCandidate), candidate.candidateId],
    );
    await fixture.pool.query(
      `INSERT INTO cp_publication_branch_ownership(organization_id,ownership_id,run_id,attempt_id,
       attempt_number,fencing_token_digest,runner_id,runner_generation,candidate_id,candidate_digest,
       project_target_id,target_binding_digest,provider,owner,repo,remote,base_branch,frozen_base_revision,
       workspace_tree_digest,branch,expected_head_sha,attestation_digest,attested_at,created_at)
       SELECT organization_id,$2,$3,$4,attempt_number,fencing_token_digest,runner_id,runner_generation,
       $5,$6,project_target_id,target_binding_digest,provider,owner,repo,remote,base_branch,
       frozen_base_revision,workspace_tree_digest,$7,expected_head_sha,$8,attested_at,created_at
       FROM cp_publication_branch_ownership WHERE organization_id=$1 AND candidate_id=$9`,
      [principal.organizationId, ownershipId, runId, attemptId, candidateId, raceCandidateDigest,
        `opentag/run_publication_lock_race_${suffix}`, sha256(`ownership_lock_race_${suffix}`), candidate.candidateId],
    );
    await fixture.pool.query(
      `INSERT INTO cp_publication_intent(organization_id,intent_id,run_id,attempt_id,attempt_number,
       candidate_id,candidate_digest,ownership_id,ownership_digest,approval_id,approver_id,approval_digest,
       repository,branch,expected_head_sha,runner_id,runner_generation,approved_at,expires_at,created_at)
       SELECT organization_id,$2,$3,$4,attempt_number,$5,$6,$7,
       $10,$8,approver_id,approval_digest,repository,$9,expected_head_sha,runner_id,
       runner_generation,approved_at,expires_at,created_at
       FROM cp_publication_intent WHERE organization_id=$1 LIMIT 1`,
      [principal.organizationId, intentId, runId, attemptId, candidateId, raceCandidateDigest,
        ownershipId, `approval_lock_race_${suffix}`, `opentag/run_publication_lock_race_${suffix}`,
        sha256(`ownership_lock_race_${suffix}`)],
    );
    const source = (await fixture.pool.query<{ capability: unknown }>(
      `SELECT capability.capability FROM cp_publication_capability capability
       JOIN cp_publication_intent intent ON intent.organization_id=capability.organization_id
         AND intent.intent_id=capability.intent_id
       WHERE capability.organization_id=$1 AND intent.run_id=$2
         AND capability.step='create_draft_pull_request'
       ORDER BY capability.attempt_number DESC LIMIT 1`,
      [principal.organizationId, candidate.runId],
    )).rows[0]!.capability as Record<string, unknown>;
    const makeCapability = (number: number) => ({ ...source,
      capabilityId: `publication_capability_lock_race_${suffix}_${number}`,
      operationId, idempotencyKey: operationId, runId, attemptId, candidateId,
      candidateDigest: raceCandidateDigest, branch: `opentag/run_publication_lock_race_${suffix}`,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString() });
    const first = makeCapability(1);
    const second = makeCapability(2);
    for (const [number, capability] of [[1, first], [2, second]] as const) {
      await fixture.pool.query(
        `INSERT INTO cp_publication_capability(organization_id,capability_id,intent_id,operation_id,
         idempotency_key,step,attempt_number,capability_digest,capability,issued_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [principal.organizationId, capability.capabilityId, intentId, operationId, operationId,
          capability.step, number, await computePublicationCapabilityDigestV1(capability as never),
          JSON.stringify(capability), capability.issuedAt, capability.expiresAt],
      );
      await fixture.pool.query(
        `INSERT INTO cp_publication_begin(organization_id,capability_id,operation_id,begun_at)
         VALUES($1,$2,$3,$4)`, [principal.organizationId, capability.capabilityId, operationId, now],
      );
    }

    const receiptSeed = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
      receiptId: `receipt_lock_race_one_${suffix}`, capabilityId: first.capabilityId as string, operationId,
      organizationId: principal.organizationId, runId: first.runId as string, attemptId: first.attemptId as string,
      candidateId: first.candidateId as string, candidateDigest: first.candidateDigest as string,
      step: "create_draft_pull_request" as const, runnerId: principal.runnerId,
      runnerGeneration: first.runnerGeneration as number, fencingTokenDigest: first.fencingTokenDigest as string,
      observation: { kind: "present" as const, headSha: first.expectedHeadSha as string,
        externalId: "github_pr_71", externalUri: "https://github.com/acme/demo/pull/71",
        draft: true as const, provider: "github" as const, repository: { owner: "acme", repo: "demo" },
        baseBranch: "main", state: "open" as const, headBranch: `opentag/run_publication_lock_race_${suffix}`,
        headRepository: { owner: "AcMe", repo: "DeMo" } }, outcome: "succeeded" as const,
      observedAt: now.toISOString() };
    const receipt = { ...receiptSeed,
      receiptDigest: await computePublicationOperationReceiptDigestV1(receiptSeed) };
    const firstRunLock = Promise.withResolvers<void>();
    const secondRunLockRequest = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const firstPublisher = createPublicationPublisher({ pool: fixture.pool,
      clock: { now: () => now }, idFactory: () => "unused_lock_race_first",
      testHooks: { onLifecycleLock: async (event) => {
        if (event.resource === "run" && event.phase === "acquired") {
          firstRunLock.resolve();
          await releaseFirst.promise;
        }
      } } });
    const secondPublisher = createPublicationPublisher({ pool: fixture.pool,
      clock: { now: () => now }, idFactory: () => "unused_lock_race_second",
      testHooks: { onLifecycleLock: (event) => {
        if (event.resource === "run" && event.phase === "before") secondRunLockRequest.resolve();
      } } });
    const record = () => firstKind === "record"
      ? firstPublisher.record({ principal, receipt })
      : secondPublisher.record({ principal, receipt });
    const reconcile = () => (firstKind === "reconcile" ? firstPublisher : secondPublisher).reconcile({
      principal, capabilityId: second.capabilityId as string, operationId,
      reconciliationId: `reconcile_lock_race_two_${suffix}`, observation: { kind: "absent" },
      observedAt: now.toISOString() });
    const firstOutcome = firstKind === "record" ? record() : reconcile();
    await firstRunLock.promise;
    const secondOutcome = firstKind === "record" ? reconcile() : record();
    await secondRunLockRequest.promise;
    releaseFirst.resolve();
    await expect(Promise.allSettled([firstOutcome, secondOutcome])).resolves.toEqual(firstKind === "record"
      ? [{ status: "fulfilled", value: { kind: "recorded", receipt } },
          { status: "fulfilled", value: { kind: "conflict" } }]
      : [{ status: "fulfilled", value: { kind: "retry_authorized" } },
          { status: "fulfilled", value: { kind: "conflict" } }]);
    await expect(fixture.pool.query<{ attempt_number: number }>(
      `SELECT attempt_number FROM cp_publication_capability WHERE organization_id=$1 AND intent_id=$2`,
      [principal.organizationId, intentId],
    )).resolves.toMatchObject({ rows: [{ attempt_number: 1 }, { attempt_number: 2 }] });
    await expect(fixture.pool.query<{
      capabilities: number; begins: number; receipts: number; reconciliations: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM cp_publication_capability WHERE organization_id=$1 AND intent_id=$2) capabilities,
         (SELECT count(*)::int FROM cp_publication_begin begin
           JOIN cp_publication_capability capability USING (organization_id,capability_id)
           WHERE begin.organization_id=$1 AND capability.intent_id=$2) begins,
         (SELECT count(*)::int FROM cp_publication_receipt receipt
           JOIN cp_publication_capability capability USING (organization_id,capability_id)
           WHERE receipt.organization_id=$1 AND capability.intent_id=$2) receipts,
         (SELECT count(*)::int FROM cp_publication_reconciliation reconciliation
           JOIN cp_publication_capability capability USING (organization_id,capability_id)
           WHERE reconciliation.organization_id=$1 AND capability.intent_id=$2) reconciliations`,
      [principal.organizationId, intentId],
    )).resolves.toMatchObject({ rows: [{ capabilities: 2, begins: 2,
      receipts: firstKind === "record" ? 1 : 0,
      reconciliations: firstKind === "reconcile" ? 1 : 0 }] });
    await fixture.pool.query(
      `UPDATE cp_hosted_run SET state='succeeded',terminal_kind='succeeded',terminal_receipt=$3::jsonb
       WHERE organization_id=$1 AND run_id=$2`,
      [principal.organizationId, runId, JSON.stringify({ kind: "lock_race_fixture_complete" })],
    );
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

  it.each(["claim_next", "complete"] as const)(
    "starts %s before the competing publication lifecycle at the canonical Run lock",
    async (firstKind) => {
      const before = (await fixture.pool.query<{ capabilities: number; begins: number; completions: number }>(
        `SELECT
           (SELECT count(*)::int FROM cp_publication_capability WHERE organization_id=$1) capabilities,
           (SELECT count(*)::int FROM cp_publication_begin WHERE organization_id=$1) begins,
           (SELECT count(*)::int FROM cp_publication_completion WHERE organization_id=$1) completions`,
        [principal.organizationId],
      )).rows[0]!;
      const canonicalFirstLockPool = {
        connect: async () => {
          const client = await fixture.pool.connect();
          let sawCanonicalRunLock = false;
          return {
            query: async (query: string, values?: unknown[]) => {
              if (query.includes("FOR UPDATE")) {
                const canonicalRunLock = query.includes("FROM cp_hosted_run")
                  && !query.includes("JOIN") && !query.includes("cp_publication_");
                if (!sawCanonicalRunLock && !canonicalRunLock) {
                  throw new Error("publication_lock_before_canonical_run");
                }
                sawCanonicalRunLock ||= canonicalRunLock;
              }
              return client.query(query, values);
            },
            release: () => client.release(),
          };
        },
      };
      const firstRunLock = Promise.withResolvers<void>();
      const secondRunLockRequest = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const firstPublisher = createPublicationPublisher({ pool: canonicalFirstLockPool as never,
        clock: { now: () => now }, idFactory: () => "unused_claim_complete_first",
        testHooks: { onLifecycleLock: async (event) => {
          if (event.runId === candidate.runId && event.resource === "run" && event.phase === "acquired") {
            firstRunLock.resolve();
            await releaseFirst.promise;
          }
        } } });
      const secondPublisher = createPublicationPublisher({ pool: canonicalFirstLockPool as never,
        clock: { now: () => now }, idFactory: () => "unused_claim_complete_second",
        testHooks: { onLifecycleLock: (event) => {
          if (event.runId === candidate.runId && event.resource === "run" && event.phase === "before") {
            secondRunLockRequest.resolve();
          }
        } } });
      const run = (subject: typeof firstPublisher, kind: typeof firstKind) => kind === "claim_next"
        ? subject.claimNextForRunner({ principal })
        : subject.complete({ principal, completion: completion("wrong_fence_publication") });
      const secondKind = firstKind === "claim_next" ? "complete" : "claim_next";
      const firstOutcome = run(firstPublisher, firstKind);
      await Promise.race([
        firstRunLock.promise,
        firstOutcome.then(() => { throw new Error("first_operation_returned_before_run_lock"); }),
      ]);
      const secondOutcome = run(secondPublisher, secondKind);
      await Promise.race([
        secondRunLockRequest.promise,
        secondOutcome.then(() => { throw new Error("second_operation_returned_before_requesting_run_lock"); }),
      ]);
      releaseFirst.resolve();
      const outcomes = await Promise.allSettled([firstOutcome, secondOutcome]);
      expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      expect(outcomes).not.toSatisfy((values) => values.some((outcome) => outcome.status === "rejected"
        && ["40P01", "55P03", "57014"].includes(String((outcome.reason as { code?: string }).code))));
      const values = outcomes.map((outcome) => outcome.status === "fulfilled" ? outcome.value : null);
      expect(values).toContainEqual({ kind: "stale_fence" });
      expect(values).toContainEqual(firstKind === "claim_next"
        ? expect.objectContaining({ kind: "completion_pending" })
        : { kind: "empty" });
      await expect(fixture.pool.query(
        `SELECT
           (SELECT count(*)::int FROM cp_publication_capability WHERE organization_id=$1) capabilities,
           (SELECT count(*)::int FROM cp_publication_begin WHERE organization_id=$1) begins,
           (SELECT count(*)::int FROM cp_publication_completion WHERE organization_id=$1) completions`,
        [principal.organizationId],
      )).resolves.toMatchObject({ rows: [before] });
    },
  );

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
    const exactCompletion = completion();
    await expect(publisher.complete({ principal, completion: exactCompletion })).resolves.toEqual({ kind: "ready", projection: "ready_for_review" });
    await expect(publisher.complete({ principal, completion: exactCompletion })).resolves.toEqual({ kind: "replayed" });
    await expect(publisher.complete({ principal, completion: { ...exactCompletion,
      observation: { ...exactCompletion.observation, checks: { test: "pending" as const } } } }))
      .resolves.toEqual({ kind: "conflict", reason: "completion_replay_mismatch" });
    // Reconnecting or restarting the same Runner only consults the immutable
    // coordinator ledger; a terminal completion never causes a blind write.
    await expect(publisher.claimNextForRunner({ principal })).resolves.toEqual({ kind: "empty" });
    await expect(fixture.pool.query<{ state: string; terminal_kind: string; terminal_receipt: { kind: string } }>(
      `SELECT state,terminal_kind,terminal_receipt FROM cp_hosted_run WHERE organization_id=$1 AND run_id=$2`,
      [principal.organizationId, candidate.runId],
    )).resolves.toMatchObject({ rows: [{ state: "succeeded", terminal_kind: "succeeded",
      terminal_receipt: { kind: "ready_for_review" } }] });
    await expect(fixture.pool.query<{ observation: { headRepository: unknown } }>(
      `SELECT observation FROM cp_publication_completion WHERE organization_id=$1 AND run_id=$2`,
      [principal.organizationId, candidate.runId],
    )).resolves.toMatchObject({ rows: [{ observation: {
      headRepository: { owner: "AcMe", repo: "DeMo" },
    } }] });
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
