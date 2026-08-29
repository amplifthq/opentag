import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceAppDefinition } from "@opentag/source-app-runtime";
import { createRelayContentCustody } from "../src/modules/source-content/index.js";
import { createDurableJobQueue } from "../src/modules/jobs/index.js";
import { createSourceIngressWorker } from "../src/modules/source-ingress/worker.js";
import {
  createSourceIngressService,
  type SourceIngressCommand,
} from "../src/modules/source-ingress/index.js";
import { createIsolatedPostgres, TEST_DATABASE_URL } from "./postgres-fixture.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const bindingDigest = digest("binding_1");
const generationDigest = digest("generation_1");

function sourceApp(): SourceAppDefinition<unknown, unknown, unknown> {
  return {
    appId: "fixture-source",
    protocol: "opentag.channel.v1",
    capabilities: {
      threads: true, messageUpdate: true, reactions: false,
      interactiveActions: false, attachments: "metadata",
      authenticatedDeletion: true, stableSourceVersions: true,
    },
    installation: {
      appInstanceId: "instance_1", bindingDigest,
      credentialGeneration: 1, credentialGenerationDigest: generationDigest,
    },
    ingress: { verify: async (input) => input, normalize: () => null },
    context: { readThread: async () => ({ messages: [], truncated: false, decodedBytes: 0 }) },
    presentation: { render: () => ({}) },
    delivery: {
      prepare: () => ({}),
      deliver: async () => ({ status: "failed", error: { code: "unused", retryable: false } }),
      reconcile: async () => ({ status: "failed", error: { code: "unused", retryable: false } }),
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)("generic durable Source App ingress", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;
  const now = new Date("2026-08-28T00:00:00.000Z");

  beforeEach(async () => {
    fixture = await createIsolatedPostgres();
    await fixture.migrate();
    await fixture.pool.query(
      "INSERT INTO cp_organization(organization_id, display_name) VALUES($1, $2)",
      ["org_a", "A"],
    );
    await fixture.pool.query(
      `INSERT INTO cp_source_app_installation(
         organization_id, installation_id, source_app_id, app_instance_id,
         binding_digest, credential_generation, credential_generation_digest,
         state, created_at, updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$8)`,
      ["org_a", "install_1", "fixture-source", "instance_1", bindingDigest,
        1, generationDigest, now],
    );
    await fixture.pool.query(
      `INSERT INTO cp_source_binding(
         organization_id, binding_id, installation_id, binding_digest,
         state, created_at, updated_at
       ) VALUES($1,$2,$3,$4,'active',$5,$5)`,
      ["org_a", "binding_1", "install_1", bindingDigest, now],
    );
  });

  afterEach(async () => fixture.close());

  const command = (deliveryId = "evt_1", rawDigest = digest("raw_a")): SourceIngressCommand => ({
    organizationId: "org_a", installationId: "install_1", bindingId: "binding_1",
    sourceApp: sourceApp(), sourceDeliveryId: deliveryId,
    sourceMessageId: "message_1", sourceVersionRef: "fixture:message_1:v1",
    rawDigest, normalizedContent: { text: "fix the private regression", private: true },
    expiresAt: new Date("2026-09-04T00:00:00.000Z"),
  });

  const components = (clock = { now: () => now }) => {
    const jobs = createDurableJobQueue({ pool: fixture.pool, clock,
      leaseDurationMs: 30_000, tokenFactory: () => `lease_${randomBytes(8).toString("hex")}` });
    const custody = createRelayContentCustody({
      pool: fixture.pool, clock,
      key: { key: randomBytes(32), keyVersion: "v1" },
    });
    const ingress = createSourceIngressService({
    pool: fixture.pool, clock,
    custody,
    jobs,
  });
    return { custody, ingress, jobs };
  };

  it("commits reservation, encrypted reference, and processing obligation before provider ack", async () => {
    const result = await components().ingress.reserve(command());
    expect(result).toMatchObject({ outcome: "reserved", mayAcknowledge: true });

    const reservation = await fixture.pool.query(
      `SELECT source_delivery_id, raw_digest, content_id, state
       FROM cp_ingress_reservation WHERE organization_id = $1`, ["org_a"],
    );
    expect(reservation.rows).toEqual([expect.objectContaining({
      source_delivery_id: "evt_1", raw_digest: digest("raw_a"), state: "pending",
    })]);
    const jobs = await fixture.pool.query(
      "SELECT job_kind, payload, state FROM cp_job WHERE organization_id = $1", ["org_a"],
    );
    expect(jobs.rows).toEqual([expect.objectContaining({
      job_kind: "source_ingress.process", state: "pending",
      payload: expect.objectContaining({ rawDigest: digest("raw_a") }),
    })]);
    const serialized = JSON.stringify({ reservation: reservation.rows, jobs: jobs.rows });
    expect(serialized).not.toContain("fix the private regression");
    expect(serialized).not.toContain('"private":true');
  });

  it("replays the original reservation for the same delivery id and digest", async () => {
    const { ingress } = components();
    const first = await ingress.reserve(command());
    const second = await ingress.reserve(command());
    expect(second).toEqual({ ...first, outcome: "replayed" });
    const counts = await fixture.pool.query(
      `SELECT (SELECT count(*)::int FROM cp_ingress_reservation) AS reservations,
              (SELECT count(*)::int FROM cp_source_content) AS contents,
              (SELECT count(*)::int FROM cp_job) AS jobs`,
    );
    expect(counts.rows[0]).toEqual({ reservations: 1, contents: 1, jobs: 1 });
  });

  it("returns a stable conflict without mutation for the same id and a different digest", async () => {
    const { ingress } = components();
    await ingress.reserve(command());
    await expect(ingress.reserve(command("evt_1", digest("raw_b"))))
      .resolves.toEqual({ outcome: "conflict", mayAcknowledge: false });
    const stored = await fixture.pool.query(
      "SELECT raw_digest FROM cp_ingress_reservation WHERE organization_id = $1", ["org_a"],
    );
    expect(stored.rows).toEqual([{ raw_digest: digest("raw_a") }]);
  });

  it("scopes delivery replay identity to tenant and installation", async () => {
    await fixture.pool.query(
      "INSERT INTO cp_organization(organization_id, display_name) VALUES($1, $2)",
      ["org_b", "B"],
    );
    await fixture.pool.query(
      `INSERT INTO cp_source_app_installation(
         organization_id, installation_id, source_app_id, app_instance_id,
         binding_digest, credential_generation, credential_generation_digest,
         state, created_at, updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$8)`,
      ["org_b", "install_1", "fixture-source", "instance_1", bindingDigest,
        1, generationDigest, now],
    );
    await fixture.pool.query(
      `INSERT INTO cp_source_binding(
         organization_id, binding_id, installation_id, binding_digest,
         state, created_at, updated_at
       ) VALUES($1,$2,$3,$4,'active',$5,$5)`,
      ["org_b", "binding_1", "install_1", bindingDigest, now],
    );
    const { ingress } = components();
    const first = await ingress.reserve(command());
    const second = await ingress.reserve({ ...command(), organizationId: "org_b" });
    expect(first.outcome).toBe("reserved");
    expect(second.outcome).toBe("reserved");
  });

  it("leases processing, reads exact-purpose ciphertext, and closes an accepted resolution", async () => {
    const { ingress, jobs } = components();
    await ingress.reserve(command());
    const worker = createSourceIngressWorker({ ingress, queue: jobs,
      workerId: "source-worker-1", retryDelayMs: 10_000, clock: { now: () => now },
      resolver: { async resolve(input) {
        expect(input.sourceContext).toEqual({ text: "fix the private regression", private: true });
        return { kind: "accepted" as const, runId: "run_1" };
      } } });
    await expect(worker.processNext()).resolves.toEqual(expect.objectContaining({ kind: "settled" }));

    const resolution = await fixture.pool.query(
      `SELECT resolution, operator_attention FROM cp_source_resolution`,
    );
    expect(resolution.rows).toEqual([{
      resolution: { kind: "accepted", runId: "run_1" }, operator_attention: false,
    }]);
    const job = await fixture.pool.query("SELECT state, payload FROM cp_job");
    expect(job.rows[0]?.state).toBe("succeeded");
    expect(JSON.stringify({ resolution: resolution.rows, job: job.rows }))
      .not.toContain("fix the private regression");
  });

  it("reclaims an expired processing lease and fences the abandoned worker", async () => {
    let current = now;
    const clock = { now: () => current };
    const { ingress, jobs } = components(clock);
    await ingress.reserve(command());
    const abandoned = await jobs.claim("abandoned", ["source_ingress.process"]);
    expect(abandoned.kind).toBe("claimed");
    current = new Date(now.getTime() + 30_001);
    const worker = createSourceIngressWorker({ ingress, queue: jobs,
      workerId: "recovery", retryDelayMs: 10_000, clock,
      resolver: { resolve: async () => ({ kind: "waiting_for_runner", runId: "run_recovered" }) } });
    await expect(worker.processNext()).resolves.toEqual(expect.objectContaining({ kind: "settled" }));
    const row = await fixture.pool.query("SELECT state, attempt_count FROM cp_job");
    expect(row.rows).toEqual([{ state: "succeeded", attempt_count: 2 }]);
  });

  it("prevents a worker whose lease expires inside resolution from closing the reservation", async () => {
    let current = now;
    const clock = { now: () => current };
    const { ingress, jobs } = components(clock);
    await ingress.reserve(command());
    const stale = createSourceIngressWorker({ ingress, queue: jobs,
      workerId: "stale", retryDelayMs: 10_000, clock,
      resolver: { resolve: async () => {
        current = new Date(now.getTime() + 30_001);
        return { kind: "accepted", runId: "run_stale" };
      } } });
    await expect(stale.processNext()).resolves.toEqual(expect.objectContaining({
      kind: "stale_lease",
    }));
    expect((await fixture.pool.query("SELECT * FROM cp_source_resolution")).rows).toEqual([]);

    const recovered = createSourceIngressWorker({ ingress, queue: jobs,
      workerId: "recovered", retryDelayMs: 10_000, clock,
      resolver: { resolve: async () => ({ kind: "accepted", runId: "run_current" }) } });
    await expect(recovered.processNext()).resolves.toEqual(expect.objectContaining({
      kind: "settled",
    }));
    const resolution = await fixture.pool.query("SELECT resolution FROM cp_source_resolution");
    expect(resolution.rows).toEqual([{ resolution: { kind: "accepted", runId: "run_current" } }]);
  });

  it("closes poisoned work with operator attention instead of leaving processing state", async () => {
    const { ingress, jobs } = components();
    await ingress.reserve(command());
    await fixture.pool.query("UPDATE cp_job SET max_attempts = 1");
    const worker = createSourceIngressWorker({ ingress, queue: jobs,
      workerId: "source-worker-poison", retryDelayMs: 10_000, clock: { now: () => now },
      resolver: { resolve: async () => { throw new Error("plaintext from provider must not persist"); } } });
    await expect(worker.processNext()).resolves.toEqual(expect.objectContaining({ kind: "settled" }));
    const state = await fixture.pool.query(
      `SELECT reservation.state, resolution.resolution, resolution.operator_attention,
              job.state AS job_state
       FROM cp_ingress_reservation reservation
       JOIN cp_source_resolution resolution USING (organization_id, reservation_id)
       JOIN cp_job job ON job.organization_id = reservation.organization_id`,
    );
    expect(state.rows).toEqual([{
      state: "resolved", resolution: { kind: "temporarily_unavailable",
        code: "source_ingress_processing_poisoned" },
      operator_attention: true, job_state: "succeeded",
    }]);
    expect(JSON.stringify(state.rows)).not.toContain("plaintext from provider");
  });

  it("rejects free-form provider text from closed resolution metadata", async () => {
    const { ingress, jobs } = components();
    await ingress.reserve(command());
    await fixture.pool.query("UPDATE cp_job SET max_attempts = 1");
    const worker = createSourceIngressWorker({ ingress, queue: jobs,
      workerId: "source-worker-redaction", retryDelayMs: 10_000, clock: { now: () => now },
      resolver: { resolve: async () => ({ kind: "invalid_request" as const,
        code: "private provider message must never persist" }) } });
    await worker.processNext();
    const resolution = await fixture.pool.query(
      "SELECT resolution, operator_attention FROM cp_source_resolution",
    );
    expect(resolution.rows).toEqual([{
      resolution: { kind: "temporarily_unavailable",
        code: "source_ingress_processing_poisoned" },
      operator_attention: true,
    }]);
    expect(JSON.stringify(resolution.rows)).not.toContain("private provider message");
  });
});
