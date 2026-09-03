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
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
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

  const createLockTestPool = (guardCanonicalFirstLock = false) => {
    const backendPid = Promise.withResolvers<number>();
    return {
      backendPid: backendPid.promise,
      pool: {
        connect: async () => {
          const client = await fixture.pool.connect();
          backendPid.resolve((await client.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]!.pid);
          let sawCanonicalRunLock = false;
          return {
            query: async (query: string, values?: unknown[]) => {
              if (query.includes("FOR UPDATE")) {
                const canonicalRunLock = query.includes("FROM cp_hosted_run")
                  && !query.includes("JOIN") && !query.includes("cp_publication_");
                if (guardCanonicalFirstLock && !sawCanonicalRunLock && !canonicalRunLock) {
                  throw new Error("publication_lock_before_canonical_run");
                }
                sawCanonicalRunLock ||= canonicalRunLock;
              }
              const result = await client.query(query, values);
              if (query === "BEGIN") {
                await client.query("SET LOCAL lock_timeout = '3s'");
                await client.query("SET LOCAL statement_timeout = '5s'");
              }
              return result;
            },
            release: () => client.release(),
          };
        },
      },
    };
  };

  const createRedemptionRacePool = () => {
    const backendPid = Promise.withResolvers<number>();
    const runLockRequested = Promise.withResolvers<void>();
    const runLockAcquired = Promise.withResolvers<void>();
    const releaseRunLock = Promise.withResolvers<void>();
    const firstLockViolation = Promise.withResolvers<never>();
    let firstLock = true;
    let gateRunLock = true;
    return {
      backendPid: backendPid.promise,
      runLockRequested: runLockRequested.promise,
      runLockAcquired: runLockAcquired.promise,
      waitForRunLock: Promise.race([runLockRequested.promise, firstLockViolation.promise]),
      releaseRunLock: releaseRunLock.resolve,
      pool: {
        connect: async () => {
          const client = await fixture.pool.connect();
          backendPid.resolve((await client.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]!.pid);
          return {
            query: async (query: string, values?: unknown[]) => {
              const canonicalRunLock = query.includes("FOR UPDATE")
                && query.includes("FROM cp_hosted_run") && !query.includes("JOIN");
              if (query.includes("FOR UPDATE") && firstLock) {
                firstLock = false;
                if (!canonicalRunLock) {
                  const error = new Error("redemption_lock_before_canonical_run");
                  firstLockViolation.reject(error);
                  throw error;
                }
              }
              if (canonicalRunLock) runLockRequested.resolve();
              const result = await client.query(query, values);
              if (query === "BEGIN") {
                await client.query("SET LOCAL lock_timeout = '3s'");
                await client.query("SET LOCAL statement_timeout = '5s'");
              }
              if (canonicalRunLock && gateRunLock) {
                gateRunLock = false;
                runLockAcquired.resolve();
                await releaseRunLock.promise;
              }
              return result;
            },
            release: () => client.release(),
          };
        },
      },
    };
  };

  const expectBackendWaitingOnLock = async (backendPid: Promise<number>) => {
    const pid = await backendPid;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await fixture.pool.query(
        `SELECT 1 FROM pg_stat_activity activity
         WHERE activity.pid=$1 AND activity.wait_event_type='Lock'
           AND EXISTS (SELECT 1 FROM pg_locks lock WHERE lock.pid=activity.pid AND NOT lock.granted)`,
        [pid],
      );
      if (waiting.rowCount === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("publication_backend_did_not_wait_on_lock");
  };

  const expectBackendWaitingOnAdvisoryLock = async (backendPid: Promise<number>) => {
    const pid = await backendPid;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await fixture.pool.query(
        `SELECT 1 FROM pg_stat_activity activity
         WHERE activity.pid=$1 AND activity.wait_event_type='Lock'
           AND EXISTS (SELECT 1 FROM pg_locks lock WHERE lock.pid=activity.pid
             AND lock.locktype='advisory' AND NOT lock.granted)`,
        [pid],
      );
      if (waiting.rowCount === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("publication_backend_did_not_wait_on_advisory_lock");
  };

  const createFreshApprovalAuthority = async (suffix: string, runnerId = principal.runnerId) => {
    const runId = `run_publication_approval_${suffix}`;
    const attemptId = `attempt_publication_approval_${suffix}`;
    const candidateId = `candidate_publication_approval_${suffix}`;
    const ownershipId = `ownership_publication_approval_${suffix}`;
    const branch = `opentag/run_publication_approval_${suffix}`;
    const freshCandidate = { ...candidate, runId, attemptId, candidateId };
    const candidateDigest = sha256(freshCandidate);
    const ownershipDigest = sha256(`ownership_publication_approval_${suffix}`);
    const sourceOwnership = await fixture.pool.query<{ ownership_id: string }>(
      `SELECT ownership_id FROM cp_publication_branch_ownership
       WHERE organization_id=$1 AND candidate_id=$2`,
      [principal.organizationId, candidate.candidateId],
    );
    if (sourceOwnership.rowCount === 0) {
      const recorded = await publisher.attestOwnership({ principal, attestation: ownership() as never });
      if (recorded.kind === "rejected") throw new Error(`approval_fixture_ownership_${recorded.reason}`);
    }
    if (runnerId !== principal.runnerId) {
      await fixture.pool.query(
        `INSERT INTO cp_runner
         SELECT (jsonb_populate_record(NULL::cp_runner, to_jsonb(source) || jsonb_build_object(
           'runner_id',$2::text,'current_credential_id',$3::text,'display_name',$2::text))).*
         FROM cp_runner source WHERE organization_id=$1 AND runner_id=$4`,
        [principal.organizationId, runnerId, `credential_publication_approval_${suffix}`, principal.runnerId],
      );
    }
    await fixture.pool.query(
      `INSERT INTO cp_hosted_run
       SELECT (jsonb_populate_record(NULL::cp_hosted_run, to_jsonb(source) || jsonb_build_object(
         'run_id',$2::text,'admission_id',$3::text,'source_identity_digest',$4::text,'state','running',
         'terminal_kind',NULL,'terminal_receipt',NULL,'runner_id',$5::text))).*
       FROM cp_hosted_run source WHERE organization_id=$1 AND run_id=$6`,
      [principal.organizationId, runId, `admission_publication_approval_${suffix}`,
        sha256(`source_publication_approval_${suffix}`), runnerId, candidate.runId],
    );
    await fixture.pool.query(
      `INSERT INTO cp_hosted_attempt
       SELECT (jsonb_populate_record(NULL::cp_hosted_attempt, to_jsonb(source) || jsonb_build_object(
         'run_id',$2::text,'attempt_id',$3::text,'lease_expires_at',$4::timestamptz,'runner_id',$5::text))).*
       FROM cp_hosted_attempt source WHERE organization_id=$1 AND run_id=$6 AND attempt_id=$7`,
      [principal.organizationId, runId, attemptId, new Date(now.getTime() + 60_000), runnerId,
        candidate.runId, claim.attempt.id],
    );
    await fixture.pool.query(
      `INSERT INTO cp_publication_candidate(organization_id,candidate_id,run_id,attempt_id,attempt_number,
       project_target_id,frozen_base_revision,workspace_tree_digest,patch_digest,changed_files,
       verification_evidence_ids,publication_policy_digest,candidate,completion_assessment,created_at)
       SELECT organization_id,$2,$3,$4,attempt_number,project_target_id,frozen_base_revision,
       workspace_tree_digest,patch_digest,changed_files,verification_evidence_ids,publication_policy_digest,
       $5::jsonb,completion_assessment,created_at FROM cp_publication_candidate
       WHERE organization_id=$1 AND candidate_id=$6`,
      [principal.organizationId, candidateId, runId, attemptId, JSON.stringify(freshCandidate), candidate.candidateId],
    );
    await fixture.pool.query(
      `INSERT INTO cp_publication_branch_ownership(organization_id,ownership_id,run_id,attempt_id,
       attempt_number,fencing_token_digest,runner_id,runner_generation,candidate_id,candidate_digest,
       project_target_id,target_binding_digest,provider,owner,repo,remote,base_branch,frozen_base_revision,
       workspace_tree_digest,branch,expected_head_sha,attestation_digest,attested_at,created_at)
       SELECT organization_id,$2,$3,$4,attempt_number,fencing_token_digest,$10,runner_generation,
       $5,$6,project_target_id,target_binding_digest,provider,owner,repo,remote,base_branch,
       frozen_base_revision,workspace_tree_digest,$7,expected_head_sha,$8,attested_at,created_at
       FROM cp_publication_branch_ownership WHERE organization_id=$1 AND candidate_id=$9`,
      [principal.organizationId, ownershipId, runId, attemptId, candidateId, candidateDigest,
        branch, ownershipDigest, candidate.candidateId, runnerId],
    );
    return { runId, attemptId, candidateId, candidateDigest, ownershipId, ownershipDigest, runnerId };
  };

  const freshApproval = (authority: Awaited<ReturnType<typeof createFreshApprovalAuthority>>,
    overrides: Partial<Record<string, unknown>> = {}) => ({
    organizationId: principal.organizationId, runnerId: authority.runnerId, runId: authority.runId,
    ownershipId: authority.ownershipId, ownershipDigest: authority.ownershipDigest,
    candidateId: authority.candidateId, candidateDigest: authority.candidateDigest,
    approvalId: `approval_publication_${authority.candidateId}`, approverId: "operator_publication",
    approvedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), ...overrides });

  const closeFreshApprovalRuns = async (...runIds: string[]) => {
    await fixture.pool.query(
      `UPDATE cp_hosted_run
       SET state='succeeded',terminal_kind='succeeded',terminal_receipt=$3::jsonb
       WHERE organization_id=$1 AND run_id=ANY($2::text[])`,
      [principal.organizationId, runIds, JSON.stringify({ kind: "approval_fixture_complete" })],
    );
  };

  const createAdvisoryGatePool = () => {
    const backendPid = Promise.withResolvers<number>();
    const advisoryAcquired = Promise.withResolvers<void>();
    const releaseAdvisory = Promise.withResolvers<void>();
    let gateFirstAdvisoryLock = true;
    return {
      backendPid: backendPid.promise,
      advisoryAcquired: advisoryAcquired.promise,
      releaseAdvisory: releaseAdvisory.resolve,
      pool: {
        connect: async () => {
          const client = await fixture.pool.connect();
          backendPid.resolve((await client.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0]!.pid);
          return {
            query: async (query: string, values?: unknown[]) => {
              const result = await client.query(query, values);
              if (query === "BEGIN") {
                await client.query("SET LOCAL lock_timeout = '3s'");
                await client.query("SET LOCAL statement_timeout = '5s'");
              }
              if (gateFirstAdvisoryLock && query.includes("pg_advisory_xact_lock")) {
                gateFirstAdvisoryLock = false;
                advisoryAcquired.resolve();
                await releaseAdvisory.promise;
              }
              return result;
            },
            release: () => client.release(),
          };
        },
      },
    };
  };

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

  it("treats approvalId as immutable approval authority across fresh candidates", async () => {
    const first = await createFreshApprovalAuthority("approval_id_sequential_first");
    const second = await createFreshApprovalAuthority("approval_id_sequential_second");
    const firstApproval = freshApproval(first, { approvalId: "approval_publication_sequential" });
    await expect(publisher.approve(firstApproval)).resolves.toEqual({
      kind: "approved", intentId: expect.any(String),
    });
    await expect(publisher.approve(firstApproval)).resolves.toEqual({
      kind: "replayed", intentId: expect.any(String),
    });
    await expect(publisher.approve(freshApproval(first, { approvalId: "approval_publication_new" })))
      .resolves.toEqual({ kind: "rejected", reason: "approval_replay_conflict" });
    await expect(publisher.approve(freshApproval(first, { approverId: "operator_changed" })))
      .resolves.toEqual({ kind: "rejected", reason: "approval_replay_conflict" });
    await expect(publisher.approve(freshApproval(first, {
      expiresAt: new Date(now.getTime() + 29 * 60_000).toISOString(),
    }))).resolves.toEqual({ kind: "rejected", reason: "approval_replay_conflict" });
    await expect(publisher.approve(freshApproval(second, { approvalId: firstApproval.approvalId }))).resolves.toEqual({
      kind: "rejected", reason: "approval_replay_conflict",
    });
    await expect(fixture.pool.query<{ intents: number; capabilities: number; begins: number; completions: number }>(
      `SELECT
         (SELECT count(*)::int FROM cp_publication_intent WHERE organization_id=$1
           AND approval_id=$2) intents,
         (SELECT count(*)::int FROM cp_publication_capability WHERE organization_id=$1
           AND intent_id IN (SELECT intent_id FROM cp_publication_intent WHERE organization_id=$1 AND approval_id=$2)) capabilities,
         (SELECT count(*)::int FROM cp_publication_begin WHERE organization_id=$1
           AND capability_id IN (SELECT capability_id FROM cp_publication_capability WHERE organization_id=$1
             AND intent_id IN (SELECT intent_id FROM cp_publication_intent WHERE organization_id=$1 AND approval_id=$2))) begins,
         (SELECT count(*)::int FROM cp_publication_completion WHERE organization_id=$1
           AND run_id IN ($3,$4)) completions`,
      [principal.organizationId, firstApproval.approvalId, first.runId, second.runId],
    )).resolves.toMatchObject({ rows: [{ intents: 1, capabilities: 0, begins: 0, completions: 0 }], rowCount: 1 });
    await closeFreshApprovalRuns(first.runId, second.runId);
  });

  it("serializes concurrent first approval for one fresh candidate at its Run lock", async () => {
    const authority = await createFreshApprovalAuthority("approval_same_candidate");
    const firstRunLock = Promise.withResolvers<void>();
    const secondRunLockRequest = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const firstLockPool = createLockTestPool(true);
    const secondLockPool = createLockTestPool(true);
    const firstPublisher = createPublicationPublisher({ pool: firstLockPool.pool as never,
      clock: { now: () => now }, idFactory: () => "approval_same_candidate_first",
      testHooks: { onLifecycleLock: async (event) => {
        if (event.runId === authority.runId && event.resource === "run" && event.phase === "after") {
          firstRunLock.resolve();
          await releaseFirst.promise;
        }
      } } });
    const secondPublisher = createPublicationPublisher({ pool: secondLockPool.pool as never,
      clock: { now: () => now }, idFactory: () => "approval_same_candidate_second",
      testHooks: { onLifecycleLock: (event) => {
        if (event.runId === authority.runId && event.resource === "run" && event.phase === "before") {
          secondRunLockRequest.resolve();
        }
      } } });
    const first = firstPublisher.approve(freshApproval(authority));
    await firstRunLock.promise;
    const second = secondPublisher.approve(freshApproval(authority));
    await secondRunLockRequest.promise;
    await expectBackendWaitingOnLock(secondLockPool.backendPid);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "approved", intentId: expect.any(String) },
      { kind: "replayed", intentId: expect.any(String) },
    ]);
    await expect(fixture.pool.query<{ candidates: number; ownerships: number; intents: number; capabilities: number; begins: number; completions: number }>(
      `SELECT
         (SELECT count(*)::int FROM cp_publication_candidate WHERE organization_id=$1 AND candidate_id=$2) candidates,
         (SELECT count(*)::int FROM cp_publication_branch_ownership WHERE organization_id=$1 AND ownership_id=$3) ownerships,
         (SELECT count(*)::int FROM cp_publication_intent WHERE organization_id=$1 AND candidate_id=$2) intents,
         (SELECT count(*)::int FROM cp_publication_capability WHERE organization_id=$1
           AND intent_id IN (SELECT intent_id FROM cp_publication_intent WHERE organization_id=$1 AND candidate_id=$2)) capabilities,
         (SELECT count(*)::int FROM cp_publication_begin WHERE organization_id=$1
           AND capability_id IN (SELECT capability_id FROM cp_publication_capability WHERE organization_id=$1
             AND intent_id IN (SELECT intent_id FROM cp_publication_intent WHERE organization_id=$1 AND candidate_id=$2))) begins,
         (SELECT count(*)::int FROM cp_publication_completion WHERE organization_id=$1 AND run_id=$4) completions`,
      [principal.organizationId, authority.candidateId, authority.ownershipId, authority.runId],
    )).resolves.toMatchObject({ rows: [{ candidates: 1, ownerships: 1, intents: 1, capabilities: 0, begins: 0, completions: 0 }], rowCount: 1 });
    await closeFreshApprovalRuns(authority.runId);
  });

  it.each(["left", "right"] as const)(
    "serializes concurrent first approval by approvalId when %s candidate starts first",
    async (firstCandidate) => {
      const left = await createFreshApprovalAuthority(`approval_id_race_left_${firstCandidate}`,
        `runner_publication_approval_left_${firstCandidate}`);
      const right = await createFreshApprovalAuthority(`approval_id_race_right_${firstCandidate}`,
        `runner_publication_approval_right_${firstCandidate}`);
      const firstAuthority = firstCandidate === "left" ? left : right;
      const secondAuthority = firstCandidate === "left" ? right : left;
      const firstRunLock = Promise.withResolvers<void>();
      const secondRunLock = Promise.withResolvers<void>();
      const firstLockPool = createAdvisoryGatePool();
      const secondLockPool = createLockTestPool(true);
      const approvalId = `approval_publication_race_${firstCandidate}`;
      const firstPublisher = createPublicationPublisher({ pool: firstLockPool.pool as never,
        clock: { now: () => now }, idFactory: () => `approval_id_race_${firstCandidate}_winner`,
        testHooks: { onLifecycleLock: (event) => {
          if (event.runId === firstAuthority.runId && event.resource === "run" && event.phase === "after") {
            firstRunLock.resolve();
          }
        } } });
      const secondPublisher = createPublicationPublisher({ pool: secondLockPool.pool as never,
        clock: { now: () => now }, idFactory: () => `approval_id_race_${firstCandidate}_loser`,
        testHooks: { onLifecycleLock: (event) => {
          if (event.runId === secondAuthority.runId && event.resource === "run" && event.phase === "after") {
            secondRunLock.resolve();
          }
        } } });
      const first = firstPublisher.approve(freshApproval(firstAuthority, { approvalId }));
      await firstRunLock.promise;
      await firstLockPool.advisoryAcquired;
      const second = secondPublisher.approve(freshApproval(secondAuthority, { approvalId }));
      await secondRunLock.promise;
      try {
        await expectBackendWaitingOnAdvisoryLock(secondLockPool.backendPid);
      } finally {
        firstLockPool.releaseAdvisory();
      }
      await expect(Promise.all([first, second])).resolves.toEqual([
        { kind: "approved", intentId: expect.any(String) },
        { kind: "rejected", reason: "approval_replay_conflict" },
      ]);
      await expect(fixture.pool.query<{ intents: number; capabilities: number; begins: number; completions: number }>(
        `SELECT
           (SELECT count(*)::int FROM cp_publication_intent WHERE organization_id=$1 AND approval_id=$2) intents,
           (SELECT count(*)::int FROM cp_publication_capability WHERE organization_id=$1
             AND intent_id IN (SELECT intent_id FROM cp_publication_intent WHERE organization_id=$1 AND approval_id=$2)) capabilities,
           (SELECT count(*)::int FROM cp_publication_begin WHERE organization_id=$1
             AND capability_id IN (SELECT capability_id FROM cp_publication_capability WHERE organization_id=$1
               AND intent_id IN (SELECT intent_id FROM cp_publication_intent WHERE organization_id=$1 AND approval_id=$2))) begins,
           (SELECT count(*)::int FROM cp_publication_completion WHERE organization_id=$1 AND run_id IN ($3,$4)) completions`,
        [principal.organizationId, approvalId, left.runId, right.runId],
      )).resolves.toMatchObject({ rows: [{ intents: 1, capabilities: 0, begins: 0, completions: 0 }], rowCount: 1 });
      await closeFreshApprovalRuns(left.runId, right.runId);
    },
  );

  it.each(["approve", "claim"] as const)(
    "serializes approval replay and operation claim when %s starts first",
    async (firstKind) => {
      const owned = (await fixture.pool.query<{ ownership_id: string; attestation_digest: string }>(
        `SELECT ownership_id,attestation_digest FROM cp_publication_branch_ownership
         WHERE organization_id=$1 AND candidate_id=$2`,
        [principal.organizationId, candidate.candidateId],
      )).rows[0]!;
      const firstRunLock = Promise.withResolvers<void>();
      const secondRunLockRequest = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const firstLockPool = createLockTestPool(true);
      const secondLockPool = createLockTestPool(true);
      const firstPublisher = createPublicationPublisher({ pool: firstLockPool.pool as never,
        clock: { now: () => now }, idFactory: () => "unused_approval_claim_first",
        testHooks: { onLifecycleLock: async (event) => {
          if (event.runId === candidate.runId && event.resource === "run" && event.phase === "after") {
            firstRunLock.resolve();
            await releaseFirst.promise;
          }
        } } });
      const secondPublisher = createPublicationPublisher({ pool: secondLockPool.pool as never,
        clock: { now: () => now }, idFactory: () => "unused_approval_claim_second",
        testHooks: { onLifecycleLock: (event) => {
          if (event.runId === candidate.runId && event.resource === "run" && event.phase === "before") {
            secondRunLockRequest.resolve();
          }
        } } });
      const run = (subject: typeof publisher, kind: typeof firstKind) => kind === "approve"
        ? subject.approve(approval(owned.ownership_id, owned.attestation_digest))
        : subject.claim({ principal, runId: candidate.runId, attemptId: claim.attempt.id,
            attemptNumber: claim.attempt.number, fencingToken: "wrong_approval_race_fence",
            candidateId: candidate.candidateId, candidateDigest: sha256(candidate),
            runnerGeneration: 1, step: "push_owned_branch" });
      const secondKind = firstKind === "approve" ? "claim" : "approve";
      const firstOutcome = run(firstPublisher, firstKind);
      await firstRunLock.promise;
      const secondOutcome = run(secondPublisher, secondKind);
      await secondRunLockRequest.promise;
      await expectBackendWaitingOnLock(secondLockPool.backendPid);
      releaseFirst.resolve();
      const outcomes = await Promise.allSettled([firstOutcome, secondOutcome]);
      expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      const values = outcomes.map((outcome) => outcome.status === "fulfilled" ? outcome.value : null);
      expect(values).toContainEqual(expect.objectContaining({ kind: "replayed" }));
      expect(values).toContainEqual({ kind: "unavailable", reason: "exact_publication_authority_missing" });
    },
  );

  const sourceContentPublicationRace = async (first: "publication" | "redemption") => {
      const authority = await createFreshApprovalAuthority(`source_redeem_race_${first}`);
      await expect(publisher.approve(freshApproval(authority))).resolves.toEqual({
        kind: "approved", intentId: expect.any(String),
      });
      const key = Buffer.alloc(32, 9);
      const contentId = claim.hostedAdmission.sourceContextEnvelope.contentId;
      const custody = createRelayContentCustody({ pool: fixture.pool,
        clock: { now: () => now }, key: { key, keyVersion: "relay-v1" } });
      await custody.store({ organizationId: principal.organizationId, installationId: "publication_race",
        sourceAppId: "github", sourceDeliveryId: "publication_race",
        sourceMessageId: "publication_race",
        sourceVersionRef: claim.hostedAdmission.sourceContextEnvelope.sourceVersionRef,
        purpose: "source_context", contentId, payload: { text: "bounded" },
        expiresAt: new Date(now.getTime() + 30 * 60_000) });
      const grant = await custody.issueReadGrant({ organizationId: principal.organizationId,
        runId: authority.runId, attemptId: authority.attemptId,
        fenceDigest: claim.attempt.fencingTokenDigest, contentIds: [contentId],
        purpose: "source_context", expiresAt: new Date(claim.attempt.leaseExpiresAt) });
      const request = { schemaVersion: 1 as const, protocolVersion: "1.0" as const,
        requiredCapabilities: ["relay.source-content-redeem.v1"] as const,
        requestId: `request_publication_redeem_race_${first}`,
        operationId: `operation_publication_redeem_race_${first}`,
        organizationId: principal.organizationId, runnerId: principal.runnerId,
        runId: authority.runId,
        expectedAuthority: { credentialId: principal.credentialId,
          registrationGeneration: principal.registrationGeneration,
          credentialGeneration: principal.credentialGeneration },
        attempt: { attemptId: authority.attemptId, attemptNumber: claim.attempt.number,
          epoch: claim.attempt.epoch, fencingTokenDigest: claim.attempt.fencingTokenDigest,
          leaseExpiresAt: claim.attempt.leaseExpiresAt }, grant,
        admissionEnvelopeDigest: claim.hostedAdmission.envelopeDigest,
        contentEnvelope: claim.hostedAdmission.sourceContextEnvelope };
      const redemptionPool = createRedemptionRacePool();
      const redemptionCustody = createRelayContentCustody({ pool: redemptionPool.pool as never,
        clock: { now: () => now }, key: { key, keyVersion: "relay-v1" } });
      const redemptionCoordinator = createHostedRunCoordinator({ pool: redemptionPool.pool as never,
        clock: { now: () => now }, leaseDurationMs: 60_000,
        idFactory: () => "unused_publication_redeem_race",
        tokenFactory: () => "unused_publication_redeem_race",
        issueSourceContentGrantInTransaction: hostedGrantIssuerFixture });
      const publicationRunRequested = Promise.withResolvers<void>();
      const publicationRunAcquired = Promise.withResolvers<void>();
      const releasePublication = Promise.withResolvers<void>();
      const publicationPool = createLockTestPool(true);
      const racePublisher = createPublicationPublisher({ pool: publicationPool.pool as never,
        clock: { now: () => now }, idFactory: () => `publication_redeem_race_${first}`,
        testHooks: { onLifecycleLock: async (event) => {
          if (event.runId !== authority.runId || event.resource !== "run") return;
          if (event.phase === "before") publicationRunRequested.resolve();
          else {
            publicationRunAcquired.resolve();
            await releasePublication.promise;
          }
        } } });
      const publish = () => racePublisher.claim({ principal, runId: authority.runId,
        attemptId: authority.attemptId, attemptNumber: claim.attempt.number,
        fencingToken: claim.attempt.fencingToken, candidateId: authority.candidateId,
        candidateDigest: authority.candidateDigest,
        runnerGeneration: principal.credentialGeneration,
        step: "push_owned_branch" });
      const redeem = () => redemptionCustody.read({ ...grant, organizationId: principal.organizationId,
        runId: authority.runId, attemptId: authority.attemptId,
        fenceDigest: claim.attempt.fencingTokenDigest, contentIds: [contentId],
        purpose: "source_context", authorizeInTransaction: (client) =>
          redemptionCoordinator.validateSourceContentRedemptionInTransaction(client, { principal, request }) })
        .then(() => ({ kind: "redeemed" as const }))
        .catch((error: unknown) => ({ kind: "rejected" as const,
          reason: error instanceof Error ? error.message : String(error) }));

      let publication: ReturnType<typeof publish>;
      let redemption: ReturnType<typeof redeem>;
      try {
        if (first === "publication") {
          publication = publish();
          await publicationRunAcquired.promise;
          redemption = redeem();
          await redemptionPool.waitForRunLock;
          await expectBackendWaitingOnLock(redemptionPool.backendPid);
          releasePublication.resolve();
          await redemptionPool.runLockAcquired;
          redemptionPool.releaseRunLock();
        } else {
          redemption = redeem();
          await redemptionPool.runLockAcquired;
          publication = publish();
          await publicationRunRequested.promise;
          await expectBackendWaitingOnLock(publicationPool.backendPid);
          redemptionPool.releaseRunLock();
          await publicationRunAcquired.promise;
          releasePublication.resolve();
        }
        const [publicationResult, redemptionResult] = await Promise.all([publication!, redemption!]);
        expect(publicationResult).toEqual({ kind: "issued", capability: expect.any(Object) });
        expect(redemptionResult).toEqual({ kind: "rejected", reason: "source_content_grant_stale" });
        expect(JSON.stringify([publicationResult, redemptionResult])).not.toMatch(/40P01|55P03|57014/);
      } finally {
        redemptionPool.releaseRunLock();
        releasePublication.resolve();
      }
      await expect(fixture.pool.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM cp_source_content_read_grant WHERE grant_id=$1`, [grant.grantId],
      )).resolves.toMatchObject({ rows: [{ consumed_at: null }], rowCount: 1 });
      await expect(fixture.pool.query<{ capabilities: number; begins: number; receipts: number }>(
        `SELECT (SELECT count(*)::int FROM cp_publication_capability capability
                  JOIN cp_publication_intent intent ON intent.organization_id=capability.organization_id
                    AND intent.intent_id=capability.intent_id
                  WHERE capability.organization_id=$1 AND intent.run_id=$2) capabilities,
                (SELECT count(*)::int FROM cp_publication_begin WHERE organization_id=$1
                  AND capability_id IN (SELECT capability.capability_id FROM cp_publication_capability capability
                    JOIN cp_publication_intent intent ON intent.organization_id=capability.organization_id
                      AND intent.intent_id=capability.intent_id
                    WHERE capability.organization_id=$1 AND intent.run_id=$2)) begins,
                (SELECT count(*)::int FROM cp_publication_receipt WHERE organization_id=$1
                  AND capability_id IN (SELECT capability.capability_id FROM cp_publication_capability capability
                    JOIN cp_publication_intent intent ON intent.organization_id=capability.organization_id
                      AND intent.intent_id=capability.intent_id
                    WHERE capability.organization_id=$1 AND intent.run_id=$2)) receipts`,
        [principal.organizationId, authority.runId],
      )).resolves.toMatchObject({ rows: [{ capabilities: 1, begins: 0, receipts: 0 }], rowCount: 1 });
      await closeFreshApprovalRuns(authority.runId);
  };

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
    await expect(publisher.reconcile({ principal, capabilityId: pr.capability.capabilityId,
      operationId: pr.capability.operationId, reconciliationId: "reconcile_pr_ambiguous",
      observation: { kind: "ambiguous" }, observedAt: now.toISOString() }))
      .resolves.toEqual({ kind: "outcome_unknown" });
    await expect(publisher.claimNextForRunner({ principal })).resolves.toMatchObject({
      kind: "reconciliation_pending", capability: {
        capabilityId: pr.capability.capabilityId },
    });
    await expect(publisher.reconcile({ principal, capabilityId: pr.capability.capabilityId,
      operationId: pr.capability.operationId, reconciliationId: "reconcile_pr_ambiguous",
      observation: { kind: "ambiguous" },
      observedAt: new Date(now.getTime() + 1_000).toISOString() }))
      .resolves.toEqual({ kind: "outcome_unknown" });
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
    await expect(fixture.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM cp_publication_reconciliation
       WHERE organization_id=$1 AND capability_id=$2`,
      [principal.organizationId, pr.capability.capabilityId]))
      .resolves.toMatchObject({ rows: [{ count: 2 }] });
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

  it("begins only after the canonical Run, Attempt, Runner, and Intent locks", async () => {
    const capability = (await fixture.pool.query<{ capability: unknown }>(
      `SELECT capability FROM cp_publication_capability
       WHERE organization_id=$1 AND step='push_owned_branch' ORDER BY attempt_number LIMIT 1`,
      [principal.organizationId],
    )).rows[0]!.capability as never;
    const lockPool = createLockTestPool(true);
    const acquired: string[] = [];
    const guarded = createPublicationPublisher({ pool: lockPool.pool as never,
      clock: { now: () => now }, idFactory: () => "unused_begin_lock_order",
      testHooks: { onLifecycleLock: (event) => {
        if (event.phase === "after") acquired.push(event.resource);
      } } });
    await expect(guarded.begin({ principal, fencingToken: claim.attempt.fencingToken,
      capability, begunAt: now.toISOString() })).resolves.toEqual({ kind: "replayed" });
    expect(acquired.slice(0, 4)).toEqual(["run", "attempt", "runner", "intent"]);
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
    const firstLockPool = createLockTestPool(true);
    const secondLockPool = createLockTestPool(true);
    const firstPublisher = createPublicationPublisher({ pool: firstLockPool.pool as never,
      clock: { now: () => now }, idFactory: () => "unused_lock_race_first",
      testHooks: { onLifecycleLock: async (event) => {
        if (event.resource === "run" && event.phase === "after") {
          firstRunLock.resolve();
          await releaseFirst.promise;
        }
      } } });
    const secondPublisher = createPublicationPublisher({ pool: secondLockPool.pool as never,
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
    await expectBackendWaitingOnLock(secondLockPool.backendPid);
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

  it("locks only bounded plausible recovery candidates across settled history", async () => {
    const settledIntentId = "publication_intent_lock_race_receipt_first";
    const pendingIntentId = "publication_intent_lock_race_reconcile_first";
    const settledSource = (await fixture.pool.query<{ capability: Record<string, unknown> }>(
      `SELECT capability FROM cp_publication_capability WHERE organization_id=$1 AND intent_id=$2
       ORDER BY attempt_number DESC LIMIT 1`, [principal.organizationId, settledIntentId],
    )).rows[0]!.capability;
    for (let attemptNumber = 3; attemptNumber <= 22; attemptNumber += 1) {
      const capability = { ...settledSource,
        capabilityId: `publication_settled_history_${attemptNumber}`,
        issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() };
      await fixture.pool.query(
        `INSERT INTO cp_publication_capability(organization_id,capability_id,intent_id,operation_id,
         idempotency_key,step,attempt_number,capability_digest,capability,issued_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [principal.organizationId, capability.capabilityId, settledIntentId, capability.operationId,
          capability.idempotencyKey, capability.step, attemptNumber,
          await computePublicationCapabilityDigestV1(capability as never), JSON.stringify(capability),
          capability.issuedAt, capability.expiresAt],
      );
      await fixture.pool.query(
        `INSERT INTO cp_publication_begin(organization_id,capability_id,operation_id,begun_at)
         VALUES($1,$2,$3,$4)`,
        [principal.organizationId, capability.capabilityId, capability.operationId, now],
      );
    }
    const pendingSource = (await fixture.pool.query<{ capability: Record<string, unknown> }>(
      `SELECT capability FROM cp_publication_capability WHERE organization_id=$1 AND intent_id=$2
       ORDER BY attempt_number DESC LIMIT 1`, [principal.organizationId, pendingIntentId],
    )).rows[0]!.capability;
    const pending = { ...pendingSource, capabilityId: "publication_bounded_pending_3",
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() };
    await fixture.pool.query(
      `INSERT INTO cp_publication_capability(organization_id,capability_id,intent_id,operation_id,
       idempotency_key,step,attempt_number,capability_digest,capability,issued_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,3,$7,$8::jsonb,$9,$10)`,
      [principal.organizationId, pending.capabilityId, pendingIntentId, pending.operationId,
        pending.idempotencyKey, pending.step, await computePublicationCapabilityDigestV1(pending as never),
        JSON.stringify(pending), pending.issuedAt, pending.expiresAt],
    );
    await fixture.pool.query(
      `INSERT INTO cp_publication_begin(organization_id,capability_id,operation_id,begun_at)
       VALUES($1,$2,$3,$4)`,
      [principal.organizationId, pending.capabilityId, pending.operationId, now],
    );
    const lockedIntentIds = new Set<string>();
    const guarded = createPublicationPublisher({ pool: fixture.pool,
      clock: { now: () => now }, idFactory: () => "unused_bounded_recovery",
      testHooks: { onLifecycleLock: (event) => {
        if (event.phase === "after" && event.resource === "run") lockedIntentIds.add(event.intentId);
      } } });
    await expect(guarded.claimNextForRunner({ principal })).resolves.toMatchObject({
      kind: "reconciliation_pending", capability: { capabilityId: pending.capabilityId },
    });
    expect([...lockedIntentIds]).toEqual([pendingIntentId]);
    await expect(publisher.reconcile({ principal, capabilityId: pending.capabilityId as string,
      operationId: pending.operationId as string, reconciliationId: "reconcile_bounded_pending_absent",
      observation: { kind: "absent" }, observedAt: now.toISOString() }))
      .resolves.toEqual({ kind: "retry_authorized" });
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
      const firstRunLock = Promise.withResolvers<void>();
      const secondRunLockRequest = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const firstLockPool = createLockTestPool(true);
      const secondLockPool = createLockTestPool(true);
      const firstPublisher = createPublicationPublisher({ pool: firstLockPool.pool as never,
        clock: { now: () => now }, idFactory: () => "unused_claim_complete_first",
        testHooks: { onLifecycleLock: async (event) => {
          if (event.runId === candidate.runId && event.resource === "run" && event.phase === "after") {
            firstRunLock.resolve();
            await releaseFirst.promise;
          }
        } } });
      const secondPublisher = createPublicationPublisher({ pool: secondLockPool.pool as never,
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
      try {
        if (secondKind !== "claim_next") await expectBackendWaitingOnLock(secondLockPool.backendPid);
      } finally {
        releaseFirst.resolve();
      }
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

  it.each(["publication", "redemption"] as const)(
    "serializes publication and authenticated stale source redemption when %s starts first",
    sourceContentPublicationRace,
  );
});
