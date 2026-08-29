import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneRuntime } from "../src/runtime.js";
import { HOSTED_CAPABILITIES, hostedAdmissionFixture } from "./control-fixtures.js";
import {
  createIsolatedPostgres,
  TEST_DATABASE_URL,
} from "./postgres-fixture.js";

describe.skipIf(!TEST_DATABASE_URL)("Control Plane runtime composition", () => {
  let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>;

  beforeAll(async () => {
    fixture = await createIsolatedPostgres();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("keeps readiness closed until the reviewed migration set is current", async () => {
    let closes = 0;
    const runtime = createControlPlaneRuntime({
      config: {
        bootstrapOrganizationId: "org_runtime",
        bootstrapOrganizationName: "Runtime",
        bootstrapPairingToken: "bootstrap_runtime_secret",
        databaseUrl: TEST_DATABASE_URL!,
        environment: "local",
        fencingTokenSecret: "f".repeat(32),
        githubIngressMasterSecret: null,
        host: "127.0.0.1",
        jobLeaseDurationMs: 30_000,
        jobPollIntervalMs: 1_000,
        jobRetryDelayMs: 30_000,
        loginRateLimit: {
          secret: "l".repeat(32),
          networkMode: "direct-peer",
          maxFailures: 5,
          networkMaxFailures: 50,
          windowMs: 300_000,
          lockoutMs: 900_000,
        },
        poolMax: 4,
        port: 3000,
        publicOrigin: "http://127.0.0.1:3000",
        recoveryPairingToken: null,
        releaseSha: "local",
      },
      postgres: {
        pool: fixture.pool,
        async close() {
          closes += 1;
        },
      },
      migrations: fixture.migrations,
    });

    const before = await runtime.application.fetch(
      new Request("http://control.test/readyz"),
    );
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({
      status: "not_ready",
      reason: "migrations_pending",
    });

    await fixture.migrate();
    const after = await runtime.application.fetch(
      new Request("http://control.test/readyz"),
    );
    expect(after.status).toBe(200);
    await runtime.close();
    expect(closes).toBe(1);
  });

  it("wires the restart-safe Source worker to the coordinator resolver by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opentag-relay-key-"));
    const keyFile = join(directory, "relay.key");
    await writeFile(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    await fixture.migrate();
    const runtime = createControlPlaneRuntime({
      config: {
        bootstrapOrganizationId: "org_runtime_source",
        bootstrapOrganizationName: "Runtime Source",
        bootstrapPairingToken: "bootstrap_runtime_source_secret",
        databaseUrl: TEST_DATABASE_URL!, environment: "local",
        fencingTokenSecret: "f".repeat(32), githubIngressMasterSecret: null,
        host: "127.0.0.1", jobLeaseDurationMs: 30_000, jobPollIntervalMs: 1_000,
        jobRetryDelayMs: 30_000, loginRateLimit: { secret: "l".repeat(32),
          networkMode: "direct-peer", maxFailures: 5, networkMaxFailures: 50,
          windowMs: 300_000, lockoutMs: 900_000 }, poolMax: 4, port: 3000,
        publicOrigin: "http://127.0.0.1:3000", recoveryPairingToken: null,
        releaseSha: "local", relayContentKey: { file: keyFile, keyVersion: "v1" },
      },
      postgres: { pool: fixture.pool, async close() {} },
      migrations: fixture.migrations,
    });
    try {
      expect(runtime.sourceIngress).not.toBeNull();
      expect(runtime.sourceIngressWorker).not.toBeNull();
      await expect(runtime.sourceIngressWorker!.processNext()).resolves.toEqual({ kind: "empty" });
      const registered = await runtime.runners.register({
        organizationId: "org_runtime_source", organizationName: "Runtime Source",
        request: { schemaVersion: 1, protocolVersion: "1.0",
          requiredCapabilities: ["relay.registration.v1"],
          requestId: "request_register_runtime_source",
          operationId: "operation_register_runtime_source",
          runnerId: "runner_runtime_source", capabilities: [...HOSTED_CAPABILITIES] },
      });
      expect(registered.kind).toBe("created");
      const admission = await hostedAdmissionFixture({ runId: "run_runtime_source",
        suffix: "fruntimesource", organizationId: "org_runtime_source",
        runnerId: "runner_runtime_source",
        queueClaimDeadline: "2030-08-29T00:00:00.000Z" });
      const resolve = () => runtime.sourceResolutionPort.resolve({
        idempotencyKey: "source-ingress:reservation_runtime_source",
        reservation: {} as never,
        sourceContext: { runId: "run_runtime_source", hostedAdmission: admission.admission,
          admissionPolicySnapshot: admission.policy },
        job: {} as never,
      });
      await expect(resolve()).resolves.toEqual({ kind: "waiting_for_runner",
        runId: "run_runtime_source" });
      await expect(resolve()).resolves.toEqual({ kind: "waiting_for_runner",
        runId: "run_runtime_source" });
      const durable = await fixture.pool.query(
        "SELECT run_id FROM cp_hosted_run WHERE organization_id = $1",
        ["org_runtime_source"],
      );
      expect(durable.rows).toEqual([{ run_id: "run_runtime_source" }]);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
