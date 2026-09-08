import { createHash } from "node:crypto";
import {
  canonicalJsonStringify,
  computeEffectEvidenceDigestV1,
  computeEffectEvidencePayloadDigestV1,
  computeEffectRequestDigestV1,
  type EffectEvidenceV1,
  type EffectPermitV1,
  type EffectRequestV1,
} from "@opentag/control-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeTeamRelayThreadProjection } from "@opentag/core";
import {
  EffectAuthorityStoredStateError,
  createEffectAuthority,
  readRunPublicationEffect,
} from "../src/modules/effects/index.js";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createRunnerDirectory, type RuntimePrincipal } from "../src/modules/runners/index.js";
import { hostedAdmissionFixture, hostedClaimRequest, hostedGrantIssuerFixture,
  recordHostedReadiness } from "./control-fixtures.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const hash = (value: unknown) => `sha256:${createHash("sha256")
  .update(canonicalJsonStringify(value)).digest("hex")}`;

describe.skipIf(!TEST_DATABASE_URL)("EffectAuthority PostgreSQL policy", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let principal: RuntimePrincipal;
  let now = new Date("2026-08-15T07:00:00.000Z");
  let permitSequence = 0;
  let authority: ReturnType<typeof createEffectAuthority>;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    const runners = createRunnerDirectory({
      pool: fixture.pool,
      clock: { now: () => now },
      idFactory: () => "credential_effects",
      tokenFactory: () => "runtime_effects_secret",
    });
    const registration = await runners.register({
      organizationId: "org_effects",
      organizationName: "Effects",
      request: {
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"],
        requestId: "request_register_effects",
        operationId: "operation_register_effects",
        runnerId: "runner_effects",
        capabilities: [
          "relay.claim-fence.v1",
          "relay.effect-authority.v1",
          "relay.hosted-admission.v1",
          "relay.hosted-claim.v1",
          "relay.lifecycle.v1",
          "relay.readiness.v1",
          "relay.source-content-redeem.v1",
        ],
      },
    });
    if (registration.kind !== "created") throw new Error("effect runner registration failed");
    const authenticated = await runners.authenticate("runtime_effects_secret");
    if (authenticated.kind !== "authenticated") throw new Error("effect runner authentication failed");
    principal = authenticated.principal;
    await recordHostedReadiness({ pool: fixture.pool, organizationId: principal.organizationId,
      runnerId: principal.runnerId });
    authority = createEffectAuthority({ pool: fixture.pool, clock: { now: () => now },
      idFactory: () => `permit_effect_${++permitSequence}`, permitTtlMs: 60_000 });
  });

  afterAll(async () => fixture.close());

  async function setup(suffix: string) {
    const runId = `run_effect_${suffix}`;
    const attemptId = `attempt_effect_${suffix}`;
    const candidateId = `candidate_effect_${suffix}`;
    const projectTargetId = `target_${suffix}`;
    const targetBindingDigest = `sha256:${"e".repeat(64)}`;
    const hosted = createHostedRunCoordinator({
      pool: fixture.pool,
      clock: { now: () => now },
      leaseDurationMs: 60_000,
      idFactory: () => attemptId,
      tokenFactory: () => `fence_effect_${suffix}`,
      issueSourceContentGrantInTransaction: hostedGrantIssuerFixture,
    });
    const admission = await hostedAdmissionFixture({ runId, suffix,
      organizationId: principal.organizationId, runnerId: principal.runnerId,
      publicationMode: "pull_request",
      queueClaimDeadline: new Date(now.getTime() + 60 * 60_000).toISOString() });
    await hosted.admit({ runId, admission: admission.admission, policy: admission.policy });
    const claimed = await hosted.claim({ principal, request: hostedClaimRequest({
      operationId: `operation_claim_effect_${suffix}`,
      requestId: `request_claim_effect_${suffix}`,
      credentialId: principal.credentialId,
    }) });
    if (claimed.kind !== "claimed") throw new Error(`effect claim failed: ${suffix}`);
    const target = {
      projectTargetId,
      targetBindingDigest,
      targetBindingGeneration: 1,
      provider: "github" as const,
      owner: "acme",
      repo: "demo",
      remote: "origin",
      baseBranch: "main",
      branch: `opentag/${runId}`,
      frozenBaseRevision: "a".repeat(40),
      workspaceTreeDigest: "b".repeat(40),
      expectedHeadSha: "c".repeat(40),
    };
    const workspaceAttestation = {
      workspaceId: `workspace_effect_${suffix}`,
      workspacePathDigest: hash(`workspace_path_${suffix}`),
      repositoryPathDigest: hash(`repository_path_${suffix}`),
      worktreeIdentityDigest: hash(`worktree_${suffix}`),
      baseRevision: target.frozenBaseRevision,
      currentRevision: target.expectedHeadSha,
      currentTree: target.workspaceTreeDigest,
      workspaceStateDigest: hash(`workspace_state_${suffix}`),
      attemptId: claimed.claim.attempt.id,
      attemptNumber: claimed.claim.attempt.number,
      fencingTokenDigest: claimed.claim.attempt.fencingTokenDigest,
      credentialId: principal.credentialId,
      leaseExpiresAt: claimed.claim.attempt.leaseExpiresAt,
    };
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt SET state='succeeded',workspace_attestation=$4::jsonb
       WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3`,
      [principal.organizationId, runId, claimed.claim.attempt.id,
        JSON.stringify(workspaceAttestation)],
    );
    await fixture.pool.query(
      `INSERT INTO cp_project_target(organization_id,project_target_id,runner_id,binding_digest,
         provider,owner,repo,default_executor,default_branch,updated_at,binding_generation)
       VALUES($1,$2,$3,$4,'github','acme','demo','executor_acp','main',$5,1)`,
      [principal.organizationId, projectTargetId, principal.runnerId,
        targetBindingDigest, now],
    );
    const candidate = {
      candidateId,
      runId,
      attemptId: claimed.claim.attempt.id,
      projectTargetId,
      frozenBaseRevision: target.frozenBaseRevision,
      workspaceTreeDigest: target.workspaceTreeDigest,
      patchDigest: hash(`patch_${suffix}`),
      changedFiles: ["packages/local-runtime/src/effects/index.ts"],
      verificationEvidenceIds: [hash(`verification_${suffix}`)],
      publicationPolicyDigest: admission.admission.publicationPolicy.digest,
      createdAt: now.toISOString(),
    };
    const candidateDigest = hash(candidate);
    await fixture.pool.query(
      `INSERT INTO cp_publication_candidate(organization_id,candidate_id,run_id,attempt_id,
         attempt_number,project_target_id,frozen_base_revision,workspace_tree_digest,patch_digest,
         changed_files,verification_evidence_ids,publication_policy_digest,candidate,
         completion_assessment,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,
      [principal.organizationId, candidateId, runId, claimed.claim.attempt.id,
        claimed.claim.attempt.number, projectTargetId, target.frozenBaseRevision,
        target.workspaceTreeDigest, candidate.patchDigest, candidate.changedFiles,
        candidate.verificationEvidenceIds, candidate.publicationPolicyDigest,
        JSON.stringify(candidate), JSON.stringify({ state: "proposal_ready", accepted: false,
          candidateId, reasonCodes: ["publication_pending"], assessedAt: now.toISOString() }), now],
    );
    const requestSeed = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
      requestId: `request_effect_${suffix}`,
      effectId: `effect_${suffix}`,
      idempotencyKey: `effect:${runId}:draft-pr`,
      organizationId: principal.organizationId,
      runnerId: principal.runnerId,
      runnerGeneration: principal.credentialGeneration,
      work: {
        runId,
        attemptId: claimed.claim.attempt.id,
        attemptNumber: claimed.claim.attempt.number,
        epoch: claimed.claim.attempt.number,
        fencingToken: claimed.claim.attempt.fencingToken,
        fencingTokenDigest: claimed.claim.attempt.fencingTokenDigest,
      },
      effectKind: "github.create_draft_pull_request" as const,
      candidate: { candidateId, candidateDigest },
      authority: {
        approvalPolicy: "human_approval_required" as const,
        policySnapshotId: admission.policy.payload.snapshotId,
        policySnapshotDigest: admission.policy.receiptDigest,
        approvalRequestId: `approval_request_effect_${suffix}`,
        approvalExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      },
      target,
      requestedAt: now.toISOString(),
    };
    const request = { ...requestSeed,
      requestDigest: await computeEffectRequestDigestV1(requestSeed) } as EffectRequestV1;
    return { request, runId, target, candidate, claimed: claimed.claim };
  }

  async function requestAndApprove(context: Awaited<ReturnType<typeof setup>>) {
    const requested = await authority.request({ principal, request: context.request });
    if (requested.kind === "conflict") throw new Error(requested.reason);
    const approved = await authority.approve({
      organizationId: principal.organizationId,
      effectId: context.request.effectId,
      approvalRequestId: context.request.authority.approvalRequestId,
      approvalRequestDigest: requested.approvalRequestDigest,
      approvalId: `approval_${context.request.effectId}`,
      approvedBy: "human_approver",
      approvedAt: now.toISOString(),
    });
    if (approved.kind === "rejected") throw new Error(approved.reason);
    return { requested, approved };
  }

  const acquireRequest = (requestId: string, journal = hash(`journal:${requestId}`)) => ({
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
    requestId,
    organizationId: principal.organizationId,
    runnerId: principal.runnerId,
    runnerGeneration: principal.credentialGeneration,
    acquireJournalDigest: journal,
  });

  async function requestVariant(request: EffectRequestV1, suffix: string) {
    const { requestDigest: _requestDigest, ...base } = request;
    const seed = {
      ...base,
      requestId: `${request.requestId}_${suffix}`,
      effectId: `${request.effectId}_${suffix}`,
      idempotencyKey: `${request.idempotencyKey}:${suffix}`,
      authority: { ...request.authority,
        approvalRequestId: `${request.authority.approvalRequestId}_${suffix}` },
    };
    return { ...seed, requestDigest: await computeEffectRequestDigestV1(seed) };
  }

  async function evidenceEnvelope(input: {
    permit: EffectPermitV1;
    evidenceId: string;
    evidence: EffectEvidenceV1;
    predecessorEvidenceDigest?: string;
  }) {
    const seed = {
      schemaVersion: 1 as const,
      protocolVersion: "1.0" as const,
      requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
      evidenceId: input.evidenceId,
      effectId: input.permit.effectId,
      permitId: input.permit.permitId,
      effectAttemptNumber: input.permit.effectAttemptNumber,
      organizationId: input.permit.organizationId,
      producer: { kind: "runner" as const, runnerId: principal.runnerId,
        runnerGeneration: principal.credentialGeneration },
      ...(input.predecessorEvidenceDigest
        ? { predecessorEvidenceDigest: input.predecessorEvidenceDigest } : {}),
      observedAt: now.toISOString(),
      evidence: input.evidence,
      payloadDigest: await computeEffectEvidencePayloadDigestV1(input.evidence),
    };
    return { ...seed, evidenceDigest: await computeEffectEvidenceDigestV1(seed) };
  }

  function present(context: Awaited<ReturnType<typeof setup>>, checks: "pending" | "passed") {
    return {
      kind: "present" as const,
      observation: {
        provider: "github" as const,
        repository: { owner: "acme", repo: "demo" },
        remote: "origin",
        branch: context.target.branch,
        baseBranch: "main",
        pullRequestNumber: 7,
        pullRequestResourceRef: "github_pr_7",
        pullRequestUrl: "https://github.com/acme/demo/pull/7",
        draft: true as const,
        state: "open" as const,
        headSha: context.target.expectedHeadSha,
        headBranch: context.target.branch,
        headRepository: { owner: "AcMe", repo: "DeMo" },
        baseSha: "d".repeat(40),
        checks: { test: checks },
        checksComplete: checks === "passed",
        observedAt: now.toISOString(),
      },
    };
  }

  function absent(context: Awaited<ReturnType<typeof setup>>) {
    return {
      kind: "absent" as const,
      observationScope: {
        provider: "github" as const,
        repository: { owner: "acme", repo: "demo" },
        baseBranch: "main",
        headBranch: context.target.branch,
        expectedHeadSha: context.target.expectedHeadSha,
        bindingGeneration: context.target.targetBindingGeneration,
        targetBindingDigest: context.target.targetBindingDigest,
        observationPolicy: "github.exact_draft_pr.v1" as const,
        observedAt: now.toISOString(),
      },
    };
  }

  it("commits immediately due approval feedback without any Runner acquisition", async () => {
    const context = await setup("approval_feedback");
    await requestAndApprove(context);
    const publication = await readRunPublicationEffect(fixture.pool, {
      organizationId: principal.organizationId, runId: context.runId, attemptNumber: 1 });
    expect(publication).toMatchObject({state:"authorized",currentAttemptNumber:0});
    const view = composeTeamRelayThreadProjection({runId:context.runId,generation:1,
      state:"publication_pending",controls:[],publication});
    expect(view.title).toBe("Publication approved");
    expect(view.summary).toContain("Waiting for the paired Runner");
    const jobs = await fixture.pool.query(`SELECT job_id,state,available_at<=clock_timestamp() AS due
      FROM cp_job WHERE job_kind='team-relay.project.v2' AND payload->>'runId'=$1
        AND (payload->>'projectionRevision')::integer=(SELECT projection_revision FROM cp_hosted_run
          WHERE organization_id=$2 AND run_id=$1)`,[context.runId,principal.organizationId]);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({state:"pending",due:true});
    expect((await fixture.pool.query("SELECT count(*)::integer AS count FROM cp_effect_attempt WHERE effect_id=$1",
      [context.request.effectId])).rows).toEqual([{count:0}]);
    await requestAndApprove(context);
    expect((await fixture.pool.query("SELECT job_id FROM cp_job WHERE job_id=$1",[jobs.rows[0].job_id])).rows)
      .toEqual([{job_id:jobs.rows[0].job_id}]);
    // Keep this test's approved work out of later acquisition tests.
    await fixture.pool.query("UPDATE cp_effect SET state='cancelled_before_permit',reason_code='test_cleanup' WHERE effect_id=$1",
      [context.request.effectId]);
  });

  it("rejects stale fences, target generations, and corrupted request digests", async () => {
    const context = await setup("stale");
    await expect(authority.request({ principal, request: { ...context.request,
      requestDigest: hash("corrupted") } })).resolves.toEqual({
        kind: "conflict", reason: "request_digest_mismatch" });
    const staleTargetSeed = { ...context.request,
      target: { ...context.request.target, targetBindingGeneration: 2 } };
    const { requestDigest: _digest, ...staleDigestInput } = staleTargetSeed;
    const staleTarget = { ...staleTargetSeed,
      requestDigest: await computeEffectRequestDigestV1(staleDigestInput) };
    await expect(authority.request({ principal, request: staleTarget }))
      .resolves.toEqual({ kind: "conflict", reason: "stale_effect_authority" });
  });

  it("surfaces malformed stored authority instead of concealing it as stale", async () => {
    const context = await setup("stored_authority_invalid");
    await fixture.pool.query(
      `UPDATE cp_hosted_attempt
       SET workspace_attestation=jsonb_set(
         workspace_attestation,'{attemptNumber}',$4::jsonb
       )
       WHERE organization_id=$1 AND run_id=$2 AND attempt_id=$3`,
      [principal.organizationId, context.runId, context.claimed.attempt.id,
        JSON.stringify("invalid")],
    );

    await expect(authority.request({ principal, request: context.request }))
      .rejects.toEqual(new EffectAuthorityStoredStateError(
        "EFFECT_AUTHORITY_STORED_WORKSPACE_INVALID",
      ));
    expect((await fixture.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM cp_effect
       WHERE organization_id=$1 AND effect_id=$2`,
      [principal.organizationId, context.request.effectId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("makes request and approval replay exact and rejects self-approval or payload drift", async () => {
    const context = await setup("replay");
    const first = await authority.request({ principal, request: context.request });
    if (first.kind === "conflict") throw new Error(first.reason);
    const durable = await fixture.pool.query<{ serialized: string }>(
      `SELECT to_jsonb(effect)::text AS serialized FROM cp_effect effect
       WHERE organization_id=$1 AND effect_id=$2`,
      [principal.organizationId, context.request.effectId],
    );
    expect(durable.rows[0]!.serialized).not.toContain(context.request.work.fencingToken);
    expect(durable.rows[0]!.serialized).not.toContain('"request"');
    await expect(authority.request({ principal, request: context.request }))
      .resolves.toMatchObject({ kind: "replayed", approvalRequestDigest: first.approvalRequestDigest });
    await expect(authority.approve({ organizationId: principal.organizationId,
      effectId: context.request.effectId,
      approvalRequestId: context.request.authority.approvalRequestId,
      approvalRequestDigest: first.approvalRequestDigest,
      approvalId: "approval_self", approvedBy: principal.runnerId,
      approvedAt: now.toISOString() })).resolves.toMatchObject({
        kind: "rejected", reason: "self_approval_prohibited" });
    const approved = await authority.approve({ organizationId: principal.organizationId,
      effectId: context.request.effectId,
      approvalRequestId: context.request.authority.approvalRequestId,
      approvalRequestDigest: first.approvalRequestDigest,
      approvalId: "approval_replay", approvedBy: "human_approver",
      approvedAt: now.toISOString() });
    expect(approved.kind).toBe("approved");
    await expect(authority.approve({ organizationId: principal.organizationId,
      effectId: context.request.effectId,
      approvalRequestId: context.request.authority.approvalRequestId,
      approvalRequestDigest: first.approvalRequestDigest,
      approvalId: "approval_replay", approvedBy: "different_human",
      approvedAt: now.toISOString() })).resolves.toMatchObject({
        kind: "rejected", reason: "approval_replay_conflict" });
    await fixture.pool.query(
      `UPDATE cp_effect SET state='cancelled_before_permit',
         reason_code='test.fixture_closed',updated_at=$3
       WHERE organization_id=$1 AND effect_id=$2`,
      [principal.organizationId, context.request.effectId, now],
    );
  });

  it("serializes the server-owned logical Effect key across caller-selected identities", async () => {
    const context = await setup("logical_key");
    const alternate = await requestVariant(context.request, "alternate");
    const outcomes = await Promise.all([
      authority.request({ principal, request: context.request }),
      authority.request({ principal, request: alternate }),
    ]);
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual(["conflict", "requested"]);
    const third = await requestVariant(context.request, "third");
    await expect(authority.request({ principal, request: third }))
      .resolves.toEqual({ kind: "conflict", reason: "request_replay_conflict" });
    expect((await fixture.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM cp_effect
       WHERE organization_id=$1 AND effect_kind='github.create_draft_pull_request'
         AND candidate_id=$2`,
      [principal.organizationId, context.request.candidate.candidateId])).rows[0])
      .toEqual({ count: 1 });
  });

  it("commits approval issuance with Effect request creation and replays without reissuing", async () => {
    const context = await setup("approval_hook");
    await fixture.pool.query(
      "CREATE TABLE test_effect_approval_hook(effect_id text PRIMARY KEY, payload jsonb NOT NULL)",
    );
    let fail = true;
    let calls = 0;
    const initialRevision = (await fixture.pool.query<{ projection_revision: number }>(
      `SELECT projection_revision FROM cp_hosted_run
       WHERE organization_id=$1 AND run_id=$2`,
      [principal.organizationId, context.runId])).rows[0]!.projection_revision;
    const hooked = createEffectAuthority({ pool: fixture.pool, clock: { now: () => now },
      idFactory: () => `permit_hook_${++permitSequence}`,
      issueApprovalInTransaction: async (client, issue) => {
        calls += 1;
        const serialized = JSON.stringify(issue);
        expect(serialized).not.toContain(context.request.work.fencingToken);
        expect(issue.work).not.toHaveProperty("fencingToken");
        await client.query(
          "INSERT INTO test_effect_approval_hook(effect_id,payload) VALUES($1,$2::jsonb)",
          [issue.effectId, serialized],
        );
        if (fail) throw new Error("approval_hook_failed");
      } });
    await expect(hooked.request({ principal, request: context.request }))
      .rejects.toThrow("approval_hook_failed");
    expect((await fixture.pool.query<{ effects: number; approvals: number }>(
      `SELECT (SELECT count(*)::int FROM cp_effect WHERE effect_id=$1) AS effects,
              (SELECT count(*)::int FROM test_effect_approval_hook WHERE effect_id=$1) AS approvals`,
      [context.request.effectId])).rows[0]).toEqual({ effects: 0, approvals: 0 });
    expect((await fixture.pool.query<{ projection_revision: number }>(
      `SELECT projection_revision FROM cp_hosted_run
       WHERE organization_id=$1 AND run_id=$2`,
      [principal.organizationId, context.runId])).rows[0]!.projection_revision)
      .toBe(initialRevision);
    fail = false;
    const requested = await hooked.request({ principal, request: context.request });
    expect(requested.kind).toBe("requested");
    await expect(hooked.request({ principal, request: context.request }))
      .resolves.toMatchObject({ kind: "replayed" });
    expect(calls).toBe(2);
    expect((await fixture.pool.query<{ effects: number; approvals: number }>(
      `SELECT (SELECT count(*)::int FROM cp_effect WHERE effect_id=$1) AS effects,
              (SELECT count(*)::int FROM test_effect_approval_hook WHERE effect_id=$1) AS approvals`,
      [context.request.effectId])).rows[0]).toEqual({ effects: 1, approvals: 1 });
    expect((await fixture.pool.query<{ projection_revision: number }>(
      `SELECT projection_revision FROM cp_hosted_run
       WHERE organization_id=$1 AND run_id=$2`,
      [principal.organizationId, context.runId])).rows[0]!.projection_revision)
      .toBe(initialRevision + 1);
    await fixture.pool.query("DROP TABLE test_effect_approval_hook");
  });

  it("commits an acquire-bound execute permit and recovers response loss by reconciliation only", async () => {
    const context = await setup("response_loss");
    await requestAndApprove(context);
    const request = acquireRequest("acquire_response_loss");
    const acquired = await authority.acquire({ principal, request });
    if (acquired.kind !== "issued") throw new Error(`unexpected acquire ${acquired.kind}`);
    expect(acquired.permit).toMatchObject({ permitKind: "execute",
      acquireRequestId: request.requestId, acquireJournalDigest: request.acquireJournalDigest });
    expect((await fixture.pool.query(
      "SELECT permit_digest FROM cp_effect_attempt WHERE organization_id=$1 AND permit_id=$2",
      [principal.organizationId, acquired.permit.permitId])).rowCount).toBe(1);
    await expect(authority.acquire({ principal, request }))
      .resolves.toMatchObject({ kind: "replayed", permit: { permitId: acquired.permit.permitId } });
    await expect(authority.acquire({ principal,
      request: acquireRequest(request.requestId, hash("different_journal")) }))
      .resolves.toEqual({ kind: "conflict", reason: "acquire_replay_conflict" });
    const reconcile = await authority.acquire({ principal,
      request: acquireRequest("acquire_reconcile_response_loss") });
    expect(reconcile).toMatchObject({ kind: "issued", permit: { permitKind: "reconcile",
      originalExecutePermitId: acquired.permit.permitId } });
    if (reconcile.kind !== "issued") throw new Error("response-loss reconciliation missing");
    await expect(authority.acquire({ principal, request }))
      .resolves.toEqual({ kind: "conflict", reason: "acquire_replay_conflict" });
    const recovered = await evidenceEnvelope({ permit: reconcile.permit,
      evidenceId: "evidence_response_loss_recovered", evidence: present(context, "passed") });
    await expect(authority.record({ principal, evidence: recovered }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "succeeded" } });
  });

  it("keeps ambiguous outcomes unknown and sends even exact later absence to attention", async () => {
    const context = await setup("unknown");
    await requestAndApprove(context);
    const execute = await authority.acquire({ principal,
      request: acquireRequest("acquire_unknown_execute") });
    if (execute.kind !== "issued") throw new Error("execute permit missing");
    const ambiguous = await evidenceEnvelope({ permit: execute.permit,
      evidenceId: "evidence_unknown", evidence: { kind: "ambiguous",
        errorCode: "provider_timeout" } });
    await expect(authority.record({ principal, evidence: { ...ambiguous,
      evidenceDigest: hash("corrupted_evidence") } })).resolves.toEqual({
        kind: "conflict", reason: "evidence_authority_mismatch" });
    await expect(authority.record({ principal, evidence: ambiguous }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "outcome_unknown" } });
    const reconcile = await authority.acquire({ principal,
      request: acquireRequest("acquire_unknown_reconcile") });
    if (reconcile.kind !== "issued") throw new Error("reconciliation permit missing");
    expect(reconcile.permit).toMatchObject({ permitKind: "reconcile",
      predecessorEvidenceDigest: ambiguous.evidenceDigest });
    const badAbsence = await evidenceEnvelope({ permit: reconcile.permit,
      evidenceId: "evidence_bad_absence", predecessorEvidenceDigest: ambiguous.evidenceDigest,
      evidence: { ...absent(context), observationScope: { ...absent(context).observationScope,
        headBranch: "opentag/other" } } });
    await expect(authority.record({ principal, evidence: badAbsence }))
      .resolves.toEqual({ kind: "conflict", reason: "absence_scope_mismatch" });
    const exactAbsence = await evidenceEnvelope({ permit: reconcile.permit,
      evidenceId: "evidence_exact_absence", predecessorEvidenceDigest: ambiguous.evidenceDigest,
      evidence: absent(context) });
    await expect(authority.record({ principal, evidence: exactAbsence }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "attention",
        reasonCode: "github.provider_absence_requires_attention" } });
    expect((await fixture.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM cp_effect_attempt
       WHERE organization_id=$1 AND effect_id=$2 AND permit_kind='execute'`,
      [principal.organizationId, context.request.effectId])).rows[0]).toEqual({ count: 1 });
    const observeAgain = await authority.acquire({ principal,
      request: acquireRequest("acquire_attention_reconcile") });
    expect(observeAgain).toMatchObject({ kind: "issued", permit: {
      permitKind: "reconcile", predecessorEvidenceDigest: exactAbsence.evidenceDigest,
    } });
    if (observeAgain.kind !== "issued") throw new Error("attention reconciliation missing");
    const lateSuccess = await evidenceEnvelope({ permit: observeAgain.permit,
      evidenceId: "evidence_attention_late_success",
      predecessorEvidenceDigest: observeAgain.permit.predecessorEvidenceDigest,
      evidence: present(context, "passed") });
    await expect(authority.record({ principal, evidence: lateSuccess }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "succeeded" } });
  });

  it("requires an admissible not_started fact before a second execute permit", async () => {
    const context = await setup("not_started");
    await requestAndApprove(context);
    const first = await authority.acquire({ principal,
      request: acquireRequest("acquire_not_started_first") });
    if (first.kind !== "issued") throw new Error("first permit missing");
    const proof = await evidenceEnvelope({ permit: first.permit,
      evidenceId: "evidence_not_started", evidence: { kind: "not_started",
        acquireJournalDigest: first.permit.acquireJournalDigest,
        localJournalDigest: hash("local_not_started"), reason: "provider_io_not_begun" } });
    await expect(authority.record({ principal, evidence: proof }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "retry_eligible",
        reasonCode: "local.provider_io_not_begun" } });
    const successor = await authority.acquire({ principal,
      request: acquireRequest("acquire_not_started_successor") });
    expect(successor).toMatchObject({ kind: "issued", permit: { permitKind: "execute",
      effectAttemptNumber: first.permit.effectAttemptNumber + 1,
      predecessorEvidenceDigest: proof.evidenceDigest } });
    if (successor.kind !== "issued") throw new Error("not-started successor missing");
    const completed = await evidenceEnvelope({ permit: successor.permit,
      evidenceId: "evidence_not_started_completed",
      predecessorEvidenceDigest: successor.permit.predecessorEvidenceDigest,
      evidence: present(context, "passed") });
    await expect(authority.record({ principal, evidence: completed }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "succeeded" } });
  });

  it("accepts late exact evidence after Work cancellation without reviving the Run", async () => {
    const context = await setup("cancelled");
    await requestAndApprove(context);
    const executeRequest = acquireRequest("acquire_cancelled");
    const execute = await authority.acquire({ principal, request: executeRequest });
    if (execute.kind !== "issued") throw new Error("cancelled permit missing");
    await fixture.pool.query(
      `UPDATE cp_hosted_run SET state='cancelled',terminal_kind='cancelled',
         terminal_receipt=$3::jsonb WHERE organization_id=$1 AND run_id=$2`,
      [principal.organizationId, context.runId, JSON.stringify({ kind: "cancelled" })],
    );
    await expect(authority.acquire({ principal, request: executeRequest }))
      .resolves.toEqual({ kind: "conflict", reason: "acquire_replay_conflict" });
    const late = await evidenceEnvelope({ permit: execute.permit,
      evidenceId: "evidence_cancelled_late", evidence: present(context, "passed") });
    await expect(authority.record({ principal, evidence: late }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "succeeded" } });
    expect((await fixture.pool.query(
      "SELECT state,terminal_kind FROM cp_hosted_run WHERE organization_id=$1 AND run_id=$2",
      [principal.organizationId, context.runId])).rows).toEqual([
        { state: "cancelled", terminal_kind: "cancelled" },
      ]);
  });

  it("rejects terminal evidence from a principal revoked after authentication", async () => {
    const context = await setup("stale_principal");
    await requestAndApprove(context);
    const executeRequest = acquireRequest("acquire_stale_principal");
    const execute = await authority.acquire({ principal, request: executeRequest });
    if (execute.kind !== "issued") throw new Error("stale principal permit missing");
    const terminalEvidence = await evidenceEnvelope({ permit: execute.permit,
      evidenceId: "evidence_stale_principal", evidence: present(context, "passed") });
    await fixture.pool.query(
      `UPDATE cp_runner SET current_credential_id='credential_effects_rotated',
         credential_generation=2 WHERE organization_id=$1 AND runner_id=$2`,
      [principal.organizationId, principal.runnerId],
    );
    try {
      await expect(authority.acquire({ principal, request: executeRequest }))
        .resolves.toEqual({ kind: "conflict", reason: "acquire_replay_conflict" });
      await expect(authority.record({ principal, evidence: terminalEvidence }))
        .resolves.toEqual({ kind: "conflict", reason: "stale_runner_authority" });
      expect((await fixture.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM cp_effect_evidence
         WHERE organization_id=$1 AND evidence_id=$2`,
        [principal.organizationId, terminalEvidence.evidenceId])).rows[0]).toEqual({ count: 0 });
      const rotatedPrincipal = { ...principal, credentialId: "credential_effects_rotated",
        credentialGeneration: 2 };
      const rotatedAcquire = { ...acquireRequest("acquire_rotated_reconcile"),
        runnerGeneration: 2 };
      await expect(authority.acquire({ principal: rotatedPrincipal, request: rotatedAcquire }))
        .resolves.toMatchObject({ kind: "issued", permit: { permitKind: "reconcile",
          originalExecutePermitId: execute.permit.permitId, runnerGeneration: 2 } });
    } finally {
      await fixture.pool.query(
        `UPDATE cp_runner SET current_credential_id=$3,credential_generation=$4
         WHERE organization_id=$1 AND runner_id=$2`,
        [principal.organizationId, principal.runnerId, principal.credentialId,
          principal.credentialGeneration],
      );
    }
    await expect(authority.record({ principal, evidence: terminalEvidence }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "succeeded" } });
  });

  it("cancels approved Effects atomically when Work ends before any permit", async () => {
    const context = await setup("cancelled_before_permit");
    await requestAndApprove(context);
    await fixture.pool.query(
      `UPDATE cp_hosted_run SET state='cancelled',terminal_kind='cancelled',
         terminal_receipt=$3::jsonb WHERE organization_id=$1 AND run_id=$2`,
      [principal.organizationId, context.runId, JSON.stringify({ kind: "cancelled" })],
    );
    expect((await fixture.pool.query(
      `SELECT state,current_attempt_number,reason_code FROM cp_effect
       WHERE organization_id=$1 AND effect_id=$2`,
      [principal.organizationId, context.request.effectId])).rows).toEqual([{
        state: "cancelled_before_permit",
        current_attempt_number: 0,
        reason_code: "work.cancelled_before_permit",
      }]);
    expect((await fixture.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM cp_effect_attempt
       WHERE organization_id=$1 AND effect_id=$2`,
      [principal.organizationId, context.request.effectId])).rows[0]).toEqual({ count: 0 });
  });

  it("projects an expired pre-permit approval to attention", async () => {
    const context = await setup("approval_expired");
    await requestAndApprove(context);
    const previousNow = now;
    now = new Date(now.getTime() + 31 * 60_000);
    try {
      await expect(authority.acquire({ principal,
        request: acquireRequest("acquire_approval_expired") })).resolves.toEqual({
          kind: "blocked", reason: "approval_expired_before_permit" });
      expect((await fixture.pool.query(
        `SELECT state,reason_code FROM cp_effect
         WHERE organization_id=$1 AND effect_id=$2`,
        [principal.organizationId, context.request.effectId])).rows).toEqual([{
          state: "attention", reason_code: "approval_expired_before_permit",
        }]);
    } finally {
      now = previousNow;
    }
  });

  it("projects exact PR checks from observing to succeeded and completes active Work", async () => {
    const context = await setup("completion");
    await requestAndApprove(context);
    const execute = await authority.acquire({ principal,
      request: acquireRequest("acquire_completion") });
    if (execute.kind !== "issued") throw new Error("completion permit missing");
    const pending = await evidenceEnvelope({ permit: execute.permit,
      evidenceId: "evidence_completion_pending", evidence: present(context, "pending") });
    await expect(authority.record({ principal, evidence: pending }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "observing" } });
    await expect(authority.record({ principal, evidence: pending }))
      .resolves.toMatchObject({ kind: "replayed", effect: { state: "observing" } });
    const evidenceCollision = await evidenceEnvelope({ permit: execute.permit,
      evidenceId: pending.evidenceId, evidence: { kind: "ambiguous",
        errorCode: "transport_error" } });
    await expect(authority.record({ principal, evidence: evidenceCollision }))
      .resolves.toEqual({ kind: "conflict", reason: "evidence_replay_conflict" });
    const reconciliation = await authority.acquire({ principal,
      request: acquireRequest("acquire_completion_reconcile") });
    if (reconciliation.kind !== "issued") throw new Error("check reconciliation permit missing");
    expect(reconciliation.permit).toMatchObject({ permitKind: "reconcile",
      predecessorEvidenceDigest: pending.evidenceDigest });
    const uncertain = await evidenceEnvelope({ permit: reconciliation.permit,
      evidenceId: "evidence_completion_uncertain",
      predecessorEvidenceDigest: reconciliation.permit.predecessorEvidenceDigest,
      evidence: { kind: "ambiguous", errorCode: "provider_timeout" } });
    await expect(authority.record({ principal, evidence: uncertain }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "outcome_unknown",
        externalResource: { resourceRef: "github_pr_7" } } });
    const reconciliationAgain = await authority.acquire({ principal,
      request: acquireRequest("acquire_completion_reconcile_again") });
    if (reconciliationAgain.kind !== "issued") throw new Error("second check reconciliation missing");
    expect(reconciliationAgain.permit).toMatchObject({ permitKind: "reconcile",
      predecessorEvidenceDigest: uncertain.evidenceDigest });
    const passed = await evidenceEnvelope({ permit: reconciliationAgain.permit,
      evidenceId: "evidence_completion_passed",
      predecessorEvidenceDigest: reconciliationAgain.permit.predecessorEvidenceDigest,
      evidence: present(context, "passed") });
    await expect(authority.record({ principal, evidence: passed }))
      .resolves.toMatchObject({ kind: "recorded", effect: { state: "succeeded" } });
    expect((await fixture.pool.query(
      "SELECT state,terminal_kind,terminal_receipt->>'effectId' effect_id FROM cp_hosted_run WHERE organization_id=$1 AND run_id=$2",
      [principal.organizationId, context.runId])).rows).toEqual([
        { state: "succeeded", terminal_kind: "succeeded", effect_id: context.request.effectId },
      ]);
    await expect(fixture.pool.query(
      "UPDATE cp_effect_evidence SET sequence=99 WHERE organization_id=$1 AND evidence_id=$2",
      [principal.organizationId, passed.evidenceId])).rejects.toThrow("effect_authority_immutable");
  });
});
