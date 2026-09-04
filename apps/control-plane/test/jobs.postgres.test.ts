import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDurableJobQueue } from "../src/modules/jobs/index.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("durable PostgreSQL jobs", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  let now = new Date("2026-08-15T12:00:00.000Z");
  let leaseNumber = 0;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
  });

  beforeEach(async () => {
    now = new Date("2026-08-15T12:00:00.000Z");
    leaseNumber = 0;
    await fixture.pool.query("TRUNCATE cp_job");
  });

  afterAll(async () => {
    await fixture.close();
  });

  const queue = () => createDurableJobQueue({
    pool: fixture.pool,
    clock: { now: () => now },
    leaseDurationMs: 30_000,
    tokenFactory: () => `lease_${++leaseNumber}`,
  });

  it("persists an idempotent intent and rejects a conflicting reuse", async () => {
    const jobs = queue();
    const command = {
      jobId: "job_idempotent",
      organizationId: null,
      kind: "retention",
      payload: { before: "2026-01-01" },
      maxAttempts: 3,
    };
    await expect(jobs.enqueue(command)).resolves.toMatchObject({ kind: "created" });
    await expect(jobs.enqueue(command)).resolves.toMatchObject({ kind: "replayed" });
    await expect(jobs.enqueue({ ...command, payload: { before: "2025-01-01" } }))
      .resolves.toEqual({ kind: "conflict" });
  });

  it("allows exactly one winner under competing workers", async () => {
    const jobs = queue();
    await jobs.enqueue({
      jobId: "job_competing",
      organizationId: null,
      kind: "reconcile",
      payload: {},
      maxAttempts: 2,
    });
    const claims = await Promise.all([
      jobs.claim("worker_a"),
      jobs.claim("worker_b"),
    ]);
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "empty")).toHaveLength(1);
  });

  it("reclaims an expired lease and fences the old worker", async () => {
    const jobs = queue();
    await jobs.enqueue({
      jobId: "job_reclaim",
      organizationId: null,
      kind: "reconcile",
      payload: {},
      maxAttempts: 3,
    });
    const first = await jobs.claim("worker_old");
    if (first.kind !== "claimed") throw new Error("first claim missing");
    now = new Date(now.getTime() + 31_000);
    const second = await jobs.claim("worker_new");
    if (second.kind !== "claimed") throw new Error("reclaim missing");
    expect(second.job.attemptCount).toBe(2);
    await expect(jobs.succeed({
      jobId: first.job.jobId,
      leaseToken: first.job.leaseToken,
      outcome: { worker: "old" },
    })).resolves.toEqual({ kind: "stale_lease" });
    await expect(jobs.succeed({
      jobId: second.job.jobId,
      leaseToken: second.job.leaseToken,
      outcome: { worker: "new" },
    })).resolves.toEqual({ kind: "settled" });
  });

  it("records retry state and settles once after a later claim", async () => {
    const jobs = queue();
    await jobs.enqueue({
      jobId: "job_retry",
      organizationId: null,
      kind: "delivery-observation",
      payload: { receiptId: "receipt-1" },
      maxAttempts: 2,
    });
    const first = await jobs.claim("worker_retry");
    if (first.kind !== "claimed") throw new Error("claim missing");
    await expect(jobs.fail({
      jobId: first.job.jobId,
      leaseToken: first.job.leaseToken,
      errorCode: "provider_unavailable",
      retryAt: new Date(now.getTime() + 5_000),
    })).resolves.toEqual({ kind: "retry_scheduled" });
    await expect(jobs.claim("worker_early")).resolves.toEqual({ kind: "empty" });
    now = new Date(now.getTime() + 5_001);
    const second = await jobs.claim("worker_retry");
    if (second.kind !== "claimed") throw new Error("retry claim missing");
    await expect(jobs.succeed({
      jobId: second.job.jobId,
      leaseToken: second.job.leaseToken,
      outcome: { delivered: true },
    })).resolves.toEqual({ kind: "settled" });
    await expect(jobs.succeed({
      jobId: second.job.jobId,
      leaseToken: second.job.leaseToken,
      outcome: { delivered: true },
    })).resolves.toEqual({ kind: "replayed" });
    await expect(jobs.succeed({
      jobId: second.job.jobId,
      leaseToken: second.job.leaseToken,
      outcome: { delivered: false },
    })).resolves.toEqual({ kind: "stale_lease" });
    const terminal = await fixture.pool.query(
      `SELECT state, lease_owner, lease_token, lease_expires_at,
              settlement_lease_token, settlement_outcome, settled_at
       FROM cp_job WHERE job_id = $1`,
      [second.job.jobId],
    );
    expect(terminal.rows[0]).toMatchObject({
      state: "succeeded",
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
      settlement_lease_token: second.job.leaseToken,
      settlement_outcome: { delivered: true },
      settled_at: now,
    });
    await expect(fixture.pool.query(
      "UPDATE cp_job SET payload='{}'::jsonb WHERE job_id=$1",
      [second.job.jobId],
    )).rejects.toThrow(/terminal_job_immutable/iu);
  });

  it("stores terminal failure and exhausted-lease evidence on the job", async () => {
    const jobs = queue();
    await jobs.enqueue({
      jobId: "job_failed",
      organizationId: null,
      kind: "reconcile",
      payload: {},
      maxAttempts: 1,
    });
    const failedClaim = await jobs.claim("worker_failed");
    if (failedClaim.kind !== "claimed") throw new Error("failure claim missing");
    await expect(jobs.fail({
      jobId: failedClaim.job.jobId,
      leaseToken: failedClaim.job.leaseToken,
      errorCode: "provider_rejected",
    })).resolves.toEqual({ kind: "failed" });
    expect((await fixture.pool.query(
      `SELECT state, last_error_code, settlement_lease_token,
              settlement_outcome, settled_at
       FROM cp_job WHERE job_id=$1`,
      [failedClaim.job.jobId],
    )).rows[0]).toMatchObject({
      state: "failed",
      last_error_code: "provider_rejected",
      settlement_lease_token: failedClaim.job.leaseToken,
      settlement_outcome: { errorCode: "provider_rejected" },
      settled_at: now,
    });

    await jobs.enqueue({
      jobId: "job_exhausted",
      organizationId: null,
      kind: "reconcile",
      payload: {},
      maxAttempts: 1,
    });
    const exhaustedClaim = await jobs.claim("worker_exhausted");
    if (exhaustedClaim.kind !== "claimed") throw new Error("exhausted claim missing");
    now = new Date(now.getTime() + 30_001);
    await expect(jobs.claim("worker_recovery")).resolves.toEqual({ kind: "empty" });
    expect((await fixture.pool.query(
      `SELECT state, last_error_code, settlement_lease_token,
              settlement_outcome, settled_at
       FROM cp_job WHERE job_id=$1`,
      [exhaustedClaim.job.jobId],
    )).rows[0]).toMatchObject({
      state: "failed",
      last_error_code: "lease_expired",
      settlement_lease_token: exhaustedClaim.job.leaseToken,
      settlement_outcome: { errorCode: "lease_expired" },
      settled_at: now,
    });
  });
});
