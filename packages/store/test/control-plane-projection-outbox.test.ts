import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { RunnerReadinessReceiptEnvelopeV1Schema } from "@opentag/core";
import { describe, expect, it } from "vitest";
import { canonicalSha256Json } from "../src/canonical-json.js";
import { ControlPlaneProjectionOutboxValidationError, createPairedRunnerRepository, } from "../src/repository.js";
import { migratePairedRunnerSchema } from "../src/schema.js";
const NOW = new Date("2026-08-08T00:00:00.000Z");
function withProjectionDigests<T extends {
    payload: unknown;
    payloadDigest?: string;
    receiptDigest?: string;
}>(value: T) {
    const { payloadDigest: _payloadDigest, receiptDigest: _receiptDigest, ...base } = value;
    const withPayloadDigest = {
        ...base,
        payloadDigest: canonicalSha256Json(value.payload),
    };
    return {
        ...withPayloadDigest,
        receiptDigest: canonicalSha256Json(withPayloadDigest),
    };
}
function readiness(input: {
    suffix?: string;
    organizationId?: string;
    runnerId?: string;
    observedAt?: string;
} = {}) {
    const suffix = input.suffix ?? "1";
    const organizationId = input.organizationId ?? "org_1";
    const runnerId = input.runnerId ?? "runner_1";
    const observedAt = input.observedAt ?? NOW.toISOString();
    return RunnerReadinessReceiptEnvelopeV1Schema.parse(withProjectionDigests({
        schemaVersion: 1,
        protocolVersion: "1.0",
        receiptKind: "runner_readiness",
        receiptId: `receipt_readiness_${suffix}`,
        organizationId,
        operationId: `operation_readiness_${suffix}`,
        requiredCapabilities: ["relay.readiness.v1"],
        producer: {
            kind: "runner",
            id: runnerId,
            credentialId: "credential_ref_1",
            registrationGeneration: 1,
        },
        identity: {
            namespace: "opentag.control.receipt/runner-readiness/v1",
            parts: [organizationId, runnerId, "1", `readiness_${suffix}`],
        },
        observedAt,
        payload: {
            readinessId: `readiness_${suffix}`,
            runnerId,
            registrationGeneration: 1,
            capabilities: ["relay.readiness.v1"],
            executors: [],
            targets: [],
            observedAt,
            expiresAt: new Date(Date.parse(observedAt) + 60000).toISOString(),
        },
    }));
}
function repository(sqlite = new Database(":memory:")) {
    migratePairedRunnerSchema(sqlite);
    return { sqlite, repo: createPairedRunnerRepository(drizzle(sqlite)) };
}
describe("runner readiness outbox", () => {
    it("creates only the readiness-shaped schema and initializes idempotently", () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        migratePairedRunnerSchema(sqlite);
        const table = sqlite.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'control_plane_projection_outbox'
    `).get() as {
            sql: string;
        };
        const columns = sqlite.prepare("PRAGMA table_info(control_plane_projection_outbox)").all() as Array<{
            name: string;
        }>;
        expect(table.sql).toContain("'runner_readiness'");
        expect(table.sql).not.toContain("'completion_assessment'");
        expect(table.sql).not.toContain("'callback_provider_observation'");
        expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
            "run_id",
            "work_thread_id",
            "depends_on_receipt_id",
            "requires_lifecycle_operation_id",
        ]));
        const tables = (sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{
            name: string;
        }>).map(({ name }) => name);
        expect(tables).toEqual([
            "attempts",
            "control_plane_projection_outbox",
            "hosted_attempt_imports",
            "hosted_claim_operations",
            "hosted_lifecycle_operations",
            "hosted_run_imports",
            "opentag_paired_runner_schema",
            "opentag_schema_migrations",
            "run_events",
            "runs",
            "source_deliveries",
            "work_threads",
        ]);
        sqlite.close();
    });
    it("leaves an unmarked existing database unchanged", () => {
        const sqlite = new Database(":memory:");
        sqlite.exec("CREATE TABLE legacy_state(id TEXT PRIMARY KEY)");
        const before = sqlite.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
        expect(() => migratePairedRunnerSchema(sqlite)).toThrow("paired_runner_schema_incompatible_existing_database");
        expect(sqlite.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(before);
        sqlite.close();
    });
    it("fails closed when a ready paired schema is changed", () => {
        const sqlite = new Database(":memory:");
        migratePairedRunnerSchema(sqlite);
        sqlite.exec("CREATE TABLE unexpected_state(id TEXT PRIMARY KEY)");
        expect(() => migratePairedRunnerSchema(sqlite)).toThrow("paired_runner_schema_incompatible");
        expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'unexpected_state'").get()).toEqual({ name: "unexpected_state" });
        sqlite.close();
    });
    it("persists exact replay and rejects identity or operation reuse", async () => {
        const { sqlite, repo } = repository();
        const envelope = readiness();
        await expect(repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope,
            now: NOW,
        })).resolves.toMatchObject({ outcome: "created" });
        await expect(repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope,
            now: new Date(NOW.getTime() + 1000),
        })).resolves.toMatchObject({ outcome: "replay" });
        const identityConflict = readiness({ suffix: "2" });
        const sameIdentity = withProjectionDigests({
            ...envelope,
            receiptId: identityConflict.receiptId,
            operationId: identityConflict.operationId,
        });
        await expect(repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope: sameIdentity,
            now: NOW,
        })).resolves.toMatchObject({
            outcome: "conflict",
            conflictOn: "identity",
            existingReceiptId: envelope.receiptId,
        });
        const operationConflict = readiness({ suffix: "3" });
        const sameOperation = withProjectionDigests({
            ...operationConflict,
            operationId: envelope.operationId,
        });
        await expect(repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope: sameOperation,
            now: NOW,
        })).resolves.toMatchObject({
            outcome: "conflict",
            conflictOn: "operation",
            existingReceiptId: envelope.receiptId,
        });
        sqlite.close();
    });
    it("returns the newest readiness across every outbox state", async () => {
        const { sqlite, repo } = repository();
        const oldReadiness = readiness();
        const newerReadiness = readiness({
            suffix: "2",
            observedAt: "2026-08-08T00:00:10.000Z",
        });
        await repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope: oldReadiness,
            now: NOW,
        });
        const oldClaim = await repo.claimDueControlPlaneProjections({
            destinationId: "cloud",
            organizationId: "org_1",
            leaseOwner: "pump",
            leaseSeconds: 30,
            now: NOW,
        });
        await repo.acknowledgeControlPlaneProjection({
            destinationId: "cloud",
            organizationId: "org_1",
            receiptId: oldReadiness.receiptId,
            leaseToken: oldClaim.entries[0]!.leaseToken!,
            now: new Date("2026-08-08T00:00:01.000Z"),
        });
        await repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope: newerReadiness,
            now: new Date("2026-08-08T00:00:10.000Z"),
        });
        await expect(repo.getLatestRunnerReadinessProjection({
            destinationId: "cloud",
            organizationId: "org_1",
            runnerId: "runner_1",
        })).resolves.toMatchObject({
            receiptId: newerReadiness.receiptId,
            state: "pending",
        });
        await expect(repo.getLatestRunnerReadinessProjection({
            destinationId: "cloud",
            organizationId: "org_1",
            runnerId: "runner_other",
        })).resolves.toBeNull();
        sqlite.close();
    });
    it("isolates destinations and organizations while claiming", async () => {
        const { sqlite, repo } = repository();
        const first = readiness();
        const otherOrganization = readiness({
            suffix: "2",
            organizationId: "org_2",
        });
        await repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope: first,
            now: NOW,
        });
        await repo.enqueueControlPlaneProjection({
            destinationId: "backup",
            envelope: first,
            now: NOW,
        });
        await repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope: otherOrganization,
            now: NOW,
        });
        const claim = await repo.claimDueControlPlaneProjections({
            destinationId: "cloud",
            organizationId: "org_1",
            leaseOwner: "pump",
            leaseSeconds: 30,
            now: NOW,
        });
        expect(claim.entries).toHaveLength(1);
        expect(claim.entries[0]).toMatchObject({
            destinationId: "cloud",
            organizationId: "org_1",
            receiptId: first.receiptId,
        });
        expect(claim.rejected).toEqual([]);
        sqlite.close();
    });
    it("requires a live lease for retry, acknowledgement, and attention", async () => {
        const { sqlite, repo } = repository();
        const envelope = readiness();
        await repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope,
            now: NOW,
        });
        const firstClaim = await repo.claimDueControlPlaneProjections({
            destinationId: "cloud",
            organizationId: "org_1",
            leaseOwner: "pump",
            leaseSeconds: 30,
            now: NOW,
        });
        const firstLease = firstClaim.entries[0]!.leaseToken!;
        await expect(repo.retryControlPlaneProjection({
            destinationId: "cloud",
            organizationId: "org_1",
            receiptId: envelope.receiptId,
            leaseToken: "stale",
            nextAttemptAt: "2026-08-08T00:00:02.000Z",
            reasonCode: "transport_failed",
            now: new Date("2026-08-08T00:00:01.000Z"),
        })).resolves.toMatchObject({ outcome: "stale_lease" });
        await expect(repo.retryControlPlaneProjection({
            destinationId: "cloud",
            organizationId: "org_1",
            receiptId: envelope.receiptId,
            leaseToken: firstLease,
            nextAttemptAt: "2026-08-08T00:00:02.000Z",
            reasonCode: "transport_failed",
            now: new Date("2026-08-08T00:00:01.000Z"),
        })).resolves.toMatchObject({ outcome: "retried" });
        const secondClaim = await repo.claimDueControlPlaneProjections({
            destinationId: "cloud",
            organizationId: "org_1",
            leaseOwner: "pump",
            leaseSeconds: 30,
            now: new Date("2026-08-08T00:00:02.000Z"),
        });
        await expect(repo.acknowledgeControlPlaneProjection({
            destinationId: "cloud",
            organizationId: "org_1",
            receiptId: envelope.receiptId,
            leaseToken: secondClaim.entries[0]!.leaseToken!,
            httpStatus: 201,
            now: new Date("2026-08-08T00:00:03.000Z"),
        })).resolves.toMatchObject({
            outcome: "acknowledged",
            entry: { state: "acknowledged", lastHttpStatus: 201 },
        });
        sqlite.close();
    });
    it("recovers a lease at its exact expiry boundary", async () => {
        const { sqlite, repo } = repository();
        const envelope = readiness();
        await repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope,
            now: NOW,
        });
        await repo.claimDueControlPlaneProjections({
            destinationId: "cloud",
            organizationId: "org_1",
            leaseOwner: "pump",
            leaseSeconds: 30,
            now: NOW,
        });
        await expect(repo.recoverExpiredControlPlaneProjectionLeases({
            destinationId: "cloud",
            organizationId: "org_1",
            now: new Date("2026-08-08T00:00:30.000Z"),
        })).resolves.toMatchObject({
            recovered: 1,
            entries: [{ state: "pending", lastReasonCode: "lease_expired" }],
        });
        sqlite.close();
    });
    it("rejects obsolete receipt families and digest tampering before writing", async () => {
        const { sqlite, repo } = repository();
        const envelope = readiness();
        await expect(repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope: { ...envelope, receiptKind: "completion_assessment" },
            now: NOW,
        })).rejects.toMatchObject<Partial<ControlPlaneProjectionOutboxValidationError>>({
            code: "projection_envelope_invalid",
        });
        await expect(repo.enqueueControlPlaneProjection({
            destinationId: "cloud",
            envelope: { ...envelope, payloadDigest: `sha256:${"f".repeat(64)}` },
            now: NOW,
        })).rejects.toMatchObject<Partial<ControlPlaneProjectionOutboxValidationError>>({
            code: "projection_digest_mismatch",
        });
        expect(sqlite.prepare(
            "SELECT count(*) AS count FROM control_plane_projection_outbox",
        ).get()).toEqual({ count: 0 });
        sqlite.close();
    });
});
