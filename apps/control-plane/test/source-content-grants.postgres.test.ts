import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createHostedRunCoordinator } from "../src/modules/hosted-runs/index.js";
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

  it("catches denying nonterminal content only because its source retention hint elapsed", async () => {
    const custody = createRelayContentCustody({ pool: fixture.pool,
      clock: { now: () => now }, key: { key: randomBytes(32), keyVersion: "v1" } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d", sourceMessageId: "m", sourceVersionRef: "s:live:v1",
      purpose: "source_context", contentId: "content_live", payload: { text: "still required" },
      expiresAt: new Date("2026-08-28T00:01:00Z") });
    await custody.addDependency({ organizationId: "org_a", contentId: "content_live",
      sourceVersionRef: "s:live:v1", dependencyId: "run_live", terminal: false });
    now = new Date("2026-08-28T00:02:00Z");
    const grant = await custody.issueReadGrant({ organizationId: "org_a", runId: "run_live",
      attemptId: "attempt_live", fenceDigest: "fence_live", contentIds: ["content_live"],
      purpose: "source_context", expiresAt: new Date("2026-08-28T00:03:00Z") });
    await expect(custody.read({ ...grant, organizationId: "org_a", runId: "run_live",
      attemptId: "attempt_live", fenceDigest: "fence_live", contentIds: ["content_live"],
      purpose: "source_context" })).resolves.toEqual([
        { contentId: "content_live", payload: { text: "still required" } },
      ]);
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
      key: { key: randomBytes(32), keyVersion: "v1" }, tokenFactory: () => "grant_token" });
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
    await expect(hosted.claim({ principal: authenticated.principal, request }))
      .resolves.toMatchObject({ kind: "replayed" });
    const grants = await fixture.pool.query(
      `SELECT run_id, attempt_id, fence_digest FROM cp_source_content_read_grant
       WHERE organization_id = $1`, ["org_grant"]);
    expect(grants.rows).toHaveLength(1);
    if (claim.kind === "claimed") expect(grants.rows[0]).toMatchObject({ run_id: "run_grant",
      attempt_id: claim.claim.attempt.id, fence_digest: claim.claim.attempt.fencingTokenDigest });

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
  });
});
