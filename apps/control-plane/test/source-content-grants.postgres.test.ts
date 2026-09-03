import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { deriveSourceContentGrantToken } from "../src/modules/source-content/crypto.js";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
import { createMaterialActionCoordinator } from "../src/modules/hosted-runs/material-actions.js";
import { createRunnerDirectory } from "../src/modules/runners/index.js";
import { HOSTED_CAPABILITIES, hostedAdmissionFixture, hostedClaimRequest,
  recordHostedReadiness } from "./control-fixtures.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("one-time source content grants", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let now = new Date("2026-08-28T00:00:00.000Z");
  beforeEach(async () => {
    now = new Date("2026-08-28T00:00:00.000Z");
    fixture = await createIsolatedPostgres(); await fixture.migrate();
    await fixture.pool.query("INSERT INTO cp_organization VALUES($1,$2,$3)", ["org_a", "A", now]);
  });
  afterEach(async () => fixture.close());

  it("catches token persistence, replay, stale fence, wrong Attempt, wrong content, and expiry", async () => {
    const custody = createRelayContentCustody({ pool: fixture.pool,
      clock: { now: () => now }, key: { key: randomBytes(32), keyVersion: "v1" } });
    for (const contentId of ["content_1", "content_2"]) {
      await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
        sourceDeliveryId: "d", sourceMessageId: "m", sourceVersionRef: "s:v1",
        purpose: "source_context", contentId, payload: { text: contentId },
        expiresAt: new Date("2026-09-01T00:00:00Z") });
    }
    const grant = await custody.issueReadGrant({ organizationId: "org_a", runId: "run_1",
      attemptId: "attempt_1", fenceDigest: "fence_1", contentIds: ["content_1"],
      purpose: "source_context", expiresAt: new Date("2026-08-28T00:01:00Z") });
    const exact = { ...grant, organizationId: "org_a", runId: "run_1", attemptId: "attempt_1",
      fenceDigest: "fence_1", contentIds: ["content_1"], purpose: "source_context" as const };
    for (const mutation of [
      { ...exact, attemptId: "attempt_other" },
      { ...exact, fenceDigest: "fence_stale" },
      { ...exact, contentIds: ["content_2"] },
    ]) await expect(custody.read(mutation)).rejects.toThrow("source_content_grant_invalid");
    await expect(custody.read(exact)).resolves.toHaveLength(1);
    await expect(custody.read(exact)).rejects.toThrow("source_content_grant_consumed");
    const row = await fixture.pool.query("SELECT token_hash, to_jsonb(g)::text AS body FROM cp_source_content_read_grant g");
    expect(row.rows[0]?.token_hash).not.toBe(grant.token);
    expect(row.rows[0]?.body).not.toContain(grant.token);

    const expired = await custody.issueReadGrant({ organizationId: "org_a", runId: "run_2",
      attemptId: "attempt_2", fenceDigest: "fence_2", contentIds: ["content_2"],
      purpose: "source_context", expiresAt: new Date("2026-08-28T00:02:00Z") });
    now = new Date("2026-08-28T00:03:00Z");
    await expect(custody.read({ ...expired, organizationId: "org_a", runId: "run_2",
      attemptId: "attempt_2", fenceDigest: "fence_2", contentIds: ["content_2"],
      purpose: "source_context" })).rejects.toThrow("source_content_grant_expired");
  });

  it("derives grant tokens with purpose and key-version separation", () => {
    const keyBytes = Buffer.alloc(32, 4);
    const command = { organizationId: "org", runId: "run", attemptId: "attempt",
      fenceDigest: `sha256:${"1".repeat(64)}`, contentIds: ["content"],
      purpose: "source_context", expiresAt: new Date("2030-01-01T00:00:00.000Z") };
    const first = deriveSourceContentGrantToken({ key: { key: keyBytes, keyVersion: "v1" },
      ...command });
    expect(deriveSourceContentGrantToken({ key: { key: keyBytes, keyVersion: "v1" },
      ...command })).toBe(first);
    expect(deriveSourceContentGrantToken({ key: { key: keyBytes, keyVersion: "v2" },
      ...command })).not.toBe(first);
    expect(first).not.toContain(keyBytes.toString("base64"));
  });

  it("validates current Runner generation and Attempt authority inside grant consumption", async () => {
    const custody = createRelayContentCustody({ pool: fixture.pool,
      clock: { now: () => now }, key: { key: randomBytes(32), keyVersion: "v1" } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "github",
      sourceDeliveryId: "d", sourceMessageId: "m", sourceVersionRef: "s:v1",
      purpose: "source_context", contentId: "content_atomic", payload: { text: "private" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    const grant = await custody.issueReadGrant({ organizationId: "org_a", runId: "run_atomic",
      attemptId: "attempt_atomic", fenceDigest: "fence_atomic", contentIds: ["content_atomic"],
      purpose: "source_context", expiresAt: new Date("2026-08-28T00:01:00Z") });
    const command = { ...grant, organizationId: "org_a", runId: "run_atomic",
      attemptId: "attempt_atomic", fenceDigest: "fence_atomic", contentIds: ["content_atomic"],
      purpose: "source_context" as const };
    let authorizations = 0;
    await expect(custody.read({ ...command, authorizeInTransaction: async () => {
      authorizations += 1;
      return false;
    } } as never)).rejects.toThrow("source_content_grant_stale");
    expect(authorizations).toBe(1);
    await expect(custody.read({ ...command, authorizeInTransaction: async () => true } as never))
      .resolves.toEqual([{ contentId: "content_atomic", payload: { text: "private" },
        payloadDigest: "sha256:282ae7754c324606c1bc679b45b0429b475518dd51732d7787b83c0c1b714f3e" }]);
  });

  it("denies a new grant after the source retention deadline elapses", async () => {
    const custody = createRelayContentCustody({ pool: fixture.pool,
      clock: { now: () => now }, key: { key: randomBytes(32), keyVersion: "v1" } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d", sourceMessageId: "m", sourceVersionRef: "s:live:v1",
      purpose: "source_context", contentId: "content_live", payload: { text: "still required" },
      expiresAt: new Date("2026-08-28T00:01:00Z") });
    await custody.addDependency({ organizationId: "org_a", contentId: "content_live",
      sourceVersionRef: "s:live:v1", dependencyId: "run_live", terminal: false });
    now = new Date("2026-08-28T00:02:00Z");
    await expect(custody.issueReadGrant({ organizationId: "org_a", runId: "run_live",
      attemptId: "attempt_live", fenceDigest: "fence_live", contentIds: ["content_live"],
      purpose: "source_context", expiresAt: new Date("2026-08-28T00:03:00Z") }))
      .rejects.toThrow("source_content_unavailable");
  });

  it("atomically creates exactly one Attempt-bound grant and rolls it back with a failed claim", async () => {
    const runners = createRunnerDirectory({ pool: fixture.pool, clock: { now: () => now },
      idFactory: () => "credential_grant", tokenFactory: () => "runtime_grant_secret" });
    const registered = await runners.register({ organizationId: "org_grant",
      organizationName: "Grant", request: { schemaVersion: 1, protocolVersion: "1.0",
        requiredCapabilities: ["relay.registration.v1"], requestId: "request_register_grant",
        operationId: "operation_register_grant", runnerId: "runner_grant",
        capabilities: [...HOSTED_CAPABILITIES] } });
    if (registered.kind !== "created") throw new Error("registration failed");
    const authenticated = await runners.authenticate("runtime_grant_secret");
    if (authenticated.kind !== "authenticated") throw new Error("authentication failed");
    await recordHostedReadiness({ pool: fixture.pool, organizationId: "org_grant",
      runnerId: "runner_grant" });
    const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" } });
    const admission = await hostedAdmissionFixture({ runId: "run_grant", suffix: "agrant",
      organizationId: "org_grant", runnerId: "runner_grant", contentId: "content_grant" });
    await custody.store({ organizationId: "org_grant", installationId: "installation_grant",
      sourceAppId: "source_app", sourceDeliveryId: "delivery_grant",
      sourceMessageId: "message_grant",
      sourceVersionRef: admission.admission.sourceContextEnvelope.sourceVersionRef,
      purpose: "source_context", contentId: "content_grant", payload: { text: "bounded" },
      expiresAt: new Date("2026-09-01T00:00:00.000Z") });
    let attempt = 0;
    const hosted = createHostedRunCoordinator({ pool: fixture.pool, clock: { now: () => now },
      leaseDurationMs: 60_000, idFactory: () => `attempt_grant_${++attempt}`,
      tokenFactory: (context) => `fence_${context.attemptId}`,
      issueSourceContentGrantInTransaction: custody.issueReadGrantInTransaction });
    await hosted.admit({ runId: "run_grant", admission: admission.admission,
      policy: admission.policy });
    const request = hostedClaimRequest({ operationId: "operation_claim_grant",
      requestId: "request_claim_grant", credentialId: "credential_grant" });
    const claim = await hosted.claim({ principal: authenticated.principal, request });
    expect(claim.kind).toBe("claimed");
    const replay = await hosted.claim({ principal: authenticated.principal, request });
    expect(replay).toEqual(claim.kind === "claimed" ? { kind: "replayed", claim: claim.claim } : claim);
    const grants = await fixture.pool.query(
      `SELECT run_id, attempt_id, fence_digest FROM cp_source_content_read_grant
       WHERE organization_id = $1`, ["org_grant"]);
    expect(grants.rows).toHaveLength(1);
    if (claim.kind === "claimed") expect(grants.rows[0]).toMatchObject({ run_id: "run_grant",
      attempt_id: claim.claim.attempt.id, fence_digest: claim.claim.attempt.fencingTokenDigest });
    const persisted = await fixture.pool.query<{ claim_version: number;
      claim: unknown; grant: unknown }>(
      `SELECT claim_record.claim_version, claim, to_jsonb(grant_record) AS grant FROM cp_hosted_claim claim_record
       JOIN cp_source_content_read_grant grant_record
         ON grant_record.organization_id = claim_record.organization_id
        AND grant_record.run_id = claim_record.run_id
       WHERE claim_record.organization_id = $1 AND claim_record.run_id = $2`,
      ["org_grant", "run_grant"],
    );
    if (claim.kind === "claimed") {
      expect(persisted.rows[0]?.claim_version).toBe(2);
      expect(JSON.stringify(persisted.rows[0])).not.toContain(claim.claim.sourceContentGrant.token);
      expect(claim.claim.sourceContentGrant).toMatchObject({
        fenceDigest: claim.claim.attempt.fencingTokenDigest,
        contentIds: ["content_grant"], purpose: "source_context", keyVersion: "v1",
      });

      const proof = createMaterialActionCoordinator({ pool: fixture.pool,
        clock: { now: () => now } });
      await expect(proof.recordNotStarted({ principal: authenticated.principal,
        fencingToken: claim.claim.attempt.fencingToken, runId: claim.claim.runId,
        attemptId: claim.claim.attempt.id, attemptNumber: claim.claim.attempt.number,
        proofId: "proof_grant_future_lease",
        proofDigest: `sha256:${"8".repeat(64)}` })).resolves.toEqual({ kind: "recorded" });

      await fixture.pool.query(
        `UPDATE cp_hosted_attempt SET state = 'claimed', lease_expires_at = $4
         WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3`,
        ["org_grant", claim.claim.runId, claim.claim.attempt.id,
          new Date(now.getTime() + 60_000)],
      );
      await fixture.pool.query(
        `UPDATE cp_source_content_read_grant SET revoked_at = NULL
         WHERE organization_id = $1 AND run_id = $2 AND attempt_id = $3`,
        ["org_grant", claim.claim.runId, claim.claim.attempt.id],
      );
      await expect(custody.read({ ...claim.claim.sourceContentGrant,
        organizationId: "org_grant", runId: claim.claim.runId,
        attemptId: claim.claim.attempt.id,
        fenceDigest: claim.claim.attempt.fencingTokenDigest,
        contentIds: ["content_grant"], purpose: "source_context" }))
        .rejects.toThrow("source_content_grant_stale");

      await expect(proof.recordNotStarted({ principal: authenticated.principal,
        fencingToken: claim.claim.attempt.fencingToken, runId: claim.claim.runId,
        attemptId: claim.claim.attempt.id, attemptNumber: claim.claim.attempt.number,
        proofId: "proof_grant_future_lease",
        proofDigest: `sha256:${"8".repeat(64)}` })).resolves.toEqual({ kind: "replayed" });
      expect((await fixture.pool.query<{ state: string; lease_open: boolean;
        revoked_at: Date | null }>(
        `SELECT attempt.state, attempt.lease_expires_at > $4 AS lease_open,
                grant_record.revoked_at
         FROM cp_hosted_attempt attempt
         JOIN cp_source_content_read_grant grant_record
           ON grant_record.organization_id = attempt.organization_id
          AND grant_record.run_id = attempt.run_id
          AND grant_record.attempt_id = attempt.attempt_id
         WHERE attempt.organization_id = $1 AND attempt.run_id = $2
           AND attempt.attempt_id = $3`,
        ["org_grant", claim.claim.runId, claim.claim.attempt.id, now],
      )).rows).toEqual([{ state: "expired", lease_open: false,
        revoked_at: expect.any(Date) }]);
      await expect(hosted.cancelRun({ organizationId: "org_grant",
        runId: claim.claim.runId, reason: "proof_gate_test_complete" }))
        .resolves.toEqual({ kind: "cancelled" });
    }

    const missing = await hostedAdmissionFixture({ runId: "run_grant_missing",
      suffix: "bgrant", organizationId: "org_grant", runnerId: "runner_grant",
      contentId: "content_missing" });
    await hosted.admit({ runId: "run_grant_missing", admission: missing.admission,
      policy: missing.policy });
    await expect(hosted.claim({ principal: authenticated.principal,
      request: hostedClaimRequest({ operationId: "operation_claim_grant_missing",
        requestId: "request_claim_grant_missing", credentialId: "credential_grant" }) }))
      .rejects.toThrow("source_content_unavailable");
    await expect(hosted.inspect({ organizationId: "org_grant", runId: "run_grant_missing" }))
      .resolves.toMatchObject({ canonicalStatus: "queued" });
    const attempts = await fixture.pool.query(
      "SELECT 1 FROM cp_hosted_attempt WHERE organization_id = $1 AND run_id = $2",
      ["org_grant", "run_grant_missing"]);
    expect(attempts.rowCount).toBe(0);
    await hosted.cancelRun({ organizationId: "org_grant", runId: "run_grant_missing",
      reason: "test_cleanup" });

    const unavailable = createHostedRunCoordinator({ pool: fixture.pool,
      clock: { now: () => now }, leaseDurationMs: 60_000,
      idFactory: () => "attempt_custody_unavailable",
      tokenFactory: () => "fence_custody_unavailable",
      async issueSourceContentGrantInTransaction() {
        throw new Error("source_content_unavailable");
      } });
    const unavailableAdmission = await hostedAdmissionFixture({
      runId: "run_custody_unavailable", suffix: "custody_unavailable",
      organizationId: "org_grant", runnerId: "runner_grant",
      contentId: "content_grant" });
    await unavailable.admit({ runId: "run_custody_unavailable",
      admission: unavailableAdmission.admission, policy: unavailableAdmission.policy });
    await expect(unavailable.claim({ principal: authenticated.principal,
      request: hostedClaimRequest({ operationId: "operation_claim_custody_unavailable",
        requestId: "request_claim_custody_unavailable", credentialId: "credential_grant" }) }))
      .rejects.toThrow("source_content_unavailable");
    expect((await fixture.pool.query(
      "SELECT 1 FROM cp_hosted_attempt WHERE run_id = $1", ["run_custody_unavailable"])
    ).rowCount).toBe(0);
  });
});
