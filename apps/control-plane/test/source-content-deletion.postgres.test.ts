import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createSourceContentJobHandlers } from "../src/modules/source-content/worker.js";
import { createDurableJobQueue } from "../src/modules/jobs/index.js";
import { runOneJob } from "../src/modules/jobs/worker.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("authenticated source withdrawal", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const now = new Date("2026-08-28T00:00:00Z");
  beforeEach(async () => { fixture = await createIsolatedPostgres(); await fixture.migrate();
    await fixture.pool.query("INSERT INTO cp_organization VALUES($1,$2,$3)", ["org_a", "A", now]); });
  afterEach(async () => fixture.close());

  const verifiedWithdrawal = (commandId: string, sourceVersionRef = "s:v1",
    sourceDeliveryId = "d") => ({
    schemaVersion: 1 as const,
    kind: "verified_source_withdrawal" as const,
    commandId,
    organizationId: "org_a",
    sourceVersionRef,
    verification: {
      installationId: "i",
      sourceAppId: "slack",
      sourceDeliveryId,
      verifiedAt: "2026-08-28T00:00:00.000Z",
      evidenceDigest: `sha256:${"b".repeat(64)}`,
    },
  });
  const invalidationReceipt = (commandId: string, sourceVersionRef = "s:v1") => ({
    commandId,
    organizationId: "org_a",
    sourceVersionRef,
    reason: "source_content_deleted" as const,
    recordedAt: "2026-08-28T00:00:00.000Z",
    authorityReceiptDigest: `sha256:${"a".repeat(64)}`,
  });
  const createQueue = (clock = { now: () => now }) => createDurableJobQueue({
    pool: fixture.pool, clock, leaseDurationMs: 30_000,
    tokenFactory: () => `lease_${randomBytes(16).toString("hex")}`,
  });
  const enqueueWithdrawal = async (queue: ReturnType<typeof createQueue>,
    jobId: string, payload: unknown) => queue.enqueue({ jobId, organizationId: "org_a",
      kind: "source-content-withdrawal", payload, maxAttempts: 2 });
  const runWithdrawalJob = async (queue: ReturnType<typeof createQueue>,
    custody: ReturnType<typeof createRelayContentCustody>) => runOneJob({ queue,
      workerId: "source_worker", handlers: createSourceContentJobHandlers(custody),
      retryDelayMs: 30_000, clock: { now: () => now } });

  it("catches unauthenticated deletion, plaintext retention, and duplicate invalidation after replay", async () => {
    const calls: unknown[] = [];
    const receipt = invalidationReceipt("withdraw_1");
    const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" }, invalidationAuthority: {
        async invalidate(input) { calls.push(input); return receipt; },
      } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d", sourceMessageId: "m", sourceVersionRef: "s:v1",
      purpose: "source_context", contentId: "content_1", payload: { text: "erase me" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    await custody.addDependency({ organizationId: "org_a", contentId: "content_1",
      sourceVersionRef: "s:v1", dependencyId: "intent_1", terminal: false });
    await expect(custody.withdraw({ commandId: "withdraw_1", organizationId: "org_a",
      sourceVersionRef: "s:v1" } as never)).rejects.toThrow("source_withdrawal_verification_invalid");
    const storedReceipt = await custody.withdraw(verifiedWithdrawal("withdraw_1"));
    expect(storedReceipt).toEqual(receipt);
    expect(Object.isFrozen(storedReceipt)).toBe(true);
    const replayedReceipt = await custody.withdraw(verifiedWithdrawal("withdraw_1"));
    expect(replayedReceipt).toEqual(storedReceipt);
    expect(Object.isFrozen(replayedReceipt)).toBe(true);
    await expect(custody.withdraw(verifiedWithdrawal("withdraw_2"))).rejects
      .toThrow("source_withdrawal_conflict");
    expect(calls).toHaveLength(1);
    const content = await fixture.pool.query("SELECT ciphertext, wrapped_dek, deleted_at FROM cp_source_content");
    expect(content.rows[0]).toMatchObject({ ciphertext: null, wrapped_dek: null });
    expect(content.rows[0]?.deleted_at).toBeInstanceOf(Date);
    expect(JSON.stringify(calls)).not.toContain("erase me");
  });

  it("catches a withdrawal winner releasing plaintext through a concurrent grant read", async () => {
    const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" }, invalidationAuthority: {
        async invalidate(input) { return invalidationReceipt(input.commandId); },
      } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d", sourceMessageId: "m", sourceVersionRef: "s:v1",
      purpose: "source_context", contentId: "content_1", payload: { text: "secret" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    const grant = await custody.issueReadGrant({ organizationId: "org_a", runId: "run",
      attemptId: "attempt", fenceDigest: "fence", contentIds: ["content_1"], purpose: "source_context",
      expiresAt: new Date("2026-08-28T00:01:00Z") });
    await custody.withdraw(verifiedWithdrawal("withdraw"));
    await expect(custody.read({ ...grant, organizationId: "org_a", runId: "run",
      attemptId: "attempt", fenceDigest: "fence", contentIds: ["content_1"],
      purpose: "source_context" })).rejects.toThrow("source_content_deleted");
  });

  it("catches persisting mismatched, oversized, nonserializable, or content-bearing receipts", async () => {
    const invalidReceipts: unknown[] = [
      { ...invalidationReceipt("withdraw_bad_1", "s:bad:1"), commandId: "other" },
      { ...invalidationReceipt("withdraw_bad_2", "s:bad:2"), organizationId: "org_other" },
      { ...invalidationReceipt("withdraw_bad_3", "s:bad:3"), sourceVersionRef: "other" },
      { ...invalidationReceipt("withdraw_bad_4", "s:bad:4"), reason: "operator_cancelled" },
      { ...invalidationReceipt("withdraw_bad_5", "s:bad:5"), plaintext: "erase me" },
      { ...invalidationReceipt("withdraw_bad_6", "s:bad:6"), recordedAt: "not-a-date" },
      { ...invalidationReceipt("withdraw_bad_7", "s:bad:7"), authorityReceiptDigest: "sha256:ABC" },
      { ...invalidationReceipt("withdraw_bad_8", "s:bad:8"), sourceVersionRef: "x".repeat(513) },
      { ...invalidationReceipt("withdraw_bad_9", "s:bad:9"), authorityReceiptDigest: 1n },
    ];
    for (const [index, invalidReceipt] of invalidReceipts.entries()) {
      const sourceVersionRef = `s:bad:${index + 1}`;
      const commandId = `withdraw_bad_${index + 1}`;
      const contentId = `content_bad_${index + 1}`;
      const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
        key: { key: randomBytes(32), keyVersion: "v1" }, invalidationAuthority: {
          async invalidate() { return invalidReceipt as never; },
        } });
      await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
        sourceDeliveryId: `d_${index}`, sourceMessageId: `m_${index}`, sourceVersionRef,
        purpose: "source_context", contentId, payload: { text: "must remain" },
        expiresAt: new Date("2026-09-01T00:00:00Z") });
      await expect(custody.withdraw(verifiedWithdrawal(commandId, sourceVersionRef, `d_${index}`)))
        .rejects.toThrow("source_invalidation_receipt_invalid");
      const state = await fixture.pool.query(
        `SELECT ciphertext IS NOT NULL AS readable, deleted_at,
          (SELECT count(*)::int FROM cp_source_replay_tombstone
           WHERE organization_id = $1 AND command_id = $2) AS receipts
         FROM cp_source_content WHERE organization_id = $1 AND content_id = $3`,
        ["org_a", commandId, contentId],
      );
      expect(state.rows[0]).toMatchObject({ readable: true, deleted_at: null, receipts: 0 });
    }
  });

  it("catches source-version races allowing different command IDs to call authority twice", async () => {
    let calls = 0;
    const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" }, invalidationAuthority: {
        async invalidate(input) {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 25));
          return invalidationReceipt(input.commandId, input.sourceVersionRef);
        },
      } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d_race", sourceMessageId: "m_race", sourceVersionRef: "s:race:v1",
      purpose: "source_context", contentId: "content_race", payload: { text: "race" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    const outcomes = await Promise.allSettled([
      custody.withdraw(verifiedWithdrawal("withdraw_race_1", "s:race:v1", "d_race")),
      custody.withdraw(verifiedWithdrawal("withdraw_race_2", "s:race:v1", "d_race")),
    ]);
    expect(calls).toBe(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected",
      reason: expect.objectContaining({ message: "source_withdrawal_conflict" }) });
    expect((await fixture.pool.query(
      "SELECT count(*)::int AS count FROM cp_source_replay_tombstone WHERE command_id IS NOT NULL",
    )).rows[0]?.count).toBe(1);
  });

  it("catches a syntactically valid but unverified withdrawal job manufacturing authentication", async () => {
    let authorityCalls = 0;
    const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" }, invalidationAuthority: {
        async invalidate(input) { authorityCalls += 1; return invalidationReceipt(input.commandId); },
      } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d_job_unverified", sourceMessageId: "m_job_unverified",
      sourceVersionRef: "s:job:unverified", purpose: "source_context",
      contentId: "content_job_unverified", payload: { text: "keep" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    const queue = createQueue();
    await enqueueWithdrawal(queue, "job_unverified", {
      schemaVersion: 1, kind: "verified_source_withdrawal", commandId: "withdraw_unverified",
      organizationId: "org_a", sourceVersionRef: "s:job:unverified",
    });
    expect(await runWithdrawalJob(queue, custody)).toEqual({ kind: "failed", jobId: "job_unverified" });
    expect(authorityCalls).toBe(0);
    expect((await fixture.pool.query(
      "SELECT state, last_error_code FROM cp_job WHERE job_id = $1", ["job_unverified"],
    )).rows[0]).toEqual({ state: "failed", last_error_code: "source_withdrawal_verification_invalid" });
    expect((await fixture.pool.query(
      "SELECT ciphertext IS NOT NULL AS readable, deleted_at FROM cp_source_content WHERE content_id = $1",
      ["content_job_unverified"],
    )).rows[0]).toEqual({ readable: true, deleted_at: null });
  });

  it("catches retrying permanent withdrawal conflict, unavailable content, or missing authority", async () => {
    let authorityCalls = 0;
    const authority = { async invalidate(input: { commandId: string; sourceVersionRef: string }) {
      authorityCalls += 1; return invalidationReceipt(input.commandId, input.sourceVersionRef);
    } };
    const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" }, invalidationAuthority: authority });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d_job_conflict", sourceMessageId: "m_job_conflict",
      sourceVersionRef: "s:job:conflict", purpose: "source_context",
      contentId: "content_job_conflict", payload: { text: "withdraw" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    const queue = createQueue();
    await enqueueWithdrawal(queue, "job_first", verifiedWithdrawal(
      "withdraw_job_first", "s:job:conflict", "d_job_conflict"));
    expect((await runWithdrawalJob(queue, custody)).kind).toBe("settled");
    await enqueueWithdrawal(queue, "job_conflict", verifiedWithdrawal(
      "withdraw_job_second", "s:job:conflict", "d_job_conflict"));
    expect(await runWithdrawalJob(queue, custody)).toEqual({ kind: "failed", jobId: "job_conflict" });
    await enqueueWithdrawal(queue, "job_missing", verifiedWithdrawal("withdraw_job_missing", "s:job:missing"));
    expect(await runWithdrawalJob(queue, custody)).toEqual({ kind: "failed", jobId: "job_missing" });

    const noAuthority = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" } });
    await noAuthority.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d_job_no_authority", sourceMessageId: "m_job_no_authority",
      sourceVersionRef: "s:job:no-authority", purpose: "source_context",
      contentId: "content_job_no_authority", payload: { text: "keep" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    await enqueueWithdrawal(queue, "job_no_authority",
      verifiedWithdrawal("withdraw_job_no_authority", "s:job:no-authority", "d_job_no_authority"));
    expect(await runWithdrawalJob(queue, noAuthority)).toEqual({ kind: "failed", jobId: "job_no_authority" });
    const failures = await fixture.pool.query(
      "SELECT job_id, state, last_error_code FROM cp_job WHERE job_id = ANY($1::text[]) ORDER BY job_id",
      [["job_conflict", "job_missing", "job_no_authority"]],
    );
    expect(failures.rows).toEqual([
      { job_id: "job_conflict", state: "failed", last_error_code: "source_withdrawal_conflict" },
      { job_id: "job_missing", state: "failed", last_error_code: "source_content_unavailable" },
      { job_id: "job_no_authority", state: "failed", last_error_code: "source_invalidation_unavailable" },
    ]);
    expect(authorityCalls).toBe(1);
  });

  it("catches settling transient authority failure or retrying immutable same-command replay", async () => {
    let authorityCalls = 0;
    let failAuthority = true;
    const custody = createRelayContentCustody({ pool: fixture.pool, clock: { now: () => now },
      key: { key: randomBytes(32), keyVersion: "v1" }, invalidationAuthority: {
        async invalidate(input) {
          authorityCalls += 1;
          if (failAuthority) throw new Error("provider-secret-canary");
          return invalidationReceipt(input.commandId, input.sourceVersionRef);
        },
      } });
    await custody.store({ organizationId: "org_a", installationId: "i", sourceAppId: "slack",
      sourceDeliveryId: "d_job_retry", sourceMessageId: "m_job_retry",
      sourceVersionRef: "s:job:retry", purpose: "source_context",
      contentId: "content_job_retry", payload: { text: "retry" },
      expiresAt: new Date("2026-09-01T00:00:00Z") });
    const queue = createQueue();
    const command = verifiedWithdrawal("withdraw_job_retry", "s:job:retry", "d_job_retry");
    await enqueueWithdrawal(queue, "job_retry", command);
    expect(await runWithdrawalJob(queue, custody)).toEqual({ kind: "retry_scheduled", jobId: "job_retry" });
    expect((await fixture.pool.query(
      "SELECT state, last_error_code FROM cp_job WHERE job_id = $1", ["job_retry"],
    )).rows[0]).toEqual({ state: "pending", last_error_code: "source_invalidation_transient" });
    expect((await fixture.pool.query(
      "SELECT ciphertext IS NOT NULL AS readable FROM cp_source_content WHERE content_id = $1",
      ["content_job_retry"],
    )).rows[0]?.readable).toBe(true);

    await fixture.pool.query("UPDATE cp_job SET available_at = $2 WHERE job_id = $1", ["job_retry", now]);
    failAuthority = false;
    expect((await runWithdrawalJob(queue, custody)).kind).toBe("settled");
    await enqueueWithdrawal(queue, "job_replay", command);
    expect((await runWithdrawalJob(queue, custody)).kind).toBe("settled");
    expect(authorityCalls).toBe(2);
    expect(JSON.stringify((await fixture.pool.query(
      "SELECT last_error_code FROM cp_job WHERE job_id = $1", ["job_retry"],
    )).rows)).not.toContain("provider-secret-canary");
  });
});
