import { createHash } from "node:crypto";
import {
  assertSourceAppDefinition,
  type SourceAppDefinition,
} from "@opentag/source-app-runtime";
import type { Pool } from "pg";
import { z } from "zod";
import { withPostgresTransaction } from "../../database/postgres.js";
import type { DurableJobQueue } from "../jobs/index.js";
import type {
  RelayContentCustody,
  SourceContextEnvelopeRef,
} from "../source-content/index.js";

const identity = z.string().min(1).max(512).refine((value) => value === value.trim());
const sha256Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const closedCode = z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u);
const opaqueIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

const SourceIngressCommandSchema = z.object({
  organizationId: identity,
  installationId: identity,
  bindingId: identity,
  sourceDeliveryId: identity,
  sourceMessageId: identity,
  sourceVersionRef: identity,
  rawDigest: sha256Digest,
  expiresAt: z.date(),
}).passthrough();

export type SourceIngressCommand = {
  organizationId: string;
  installationId: string;
  bindingId: string;
  sourceApp: SourceAppDefinition<unknown, unknown, unknown>;
  sourceDeliveryId: string;
  sourceMessageId: string;
  sourceVersionRef: string;
  rawDigest: string;
  normalizedContent: unknown;
  expiresAt: Date;
};

export type IngressReservation = Readonly<{
  reservationId: string;
  organizationId: string;
  installationId: string;
  bindingId: string;
  sourceAppId: string;
  sourceDeliveryId: string;
  sourceMessageId: string;
  sourceVersionRef: string;
  rawDigest: string;
  contentRef: SourceContextEnvelopeRef;
  state: "pending" | "resolved";
  createdAt: string;
}>;

export type SourceResolution =
  | { kind: "accepted"; runId: string }
  | { kind: "waiting_for_runner"; runId: string }
  | { kind: "follow_up_queued"; followUpId: string }
  | { kind: "binding_change_pending"; code: string }
  | { kind: "setup_required"; code: string }
  | { kind: "not_authorized"; code: string }
  | { kind: "invalid_request"; code: string }
  | { kind: "rate_limited"; retryAt: string }
  | { kind: "queue_full"; code: string }
  | { kind: "storage_quota_exceeded"; code: string }
  | { kind: "source_content_deleted"; code: string }
  | { kind: "temporarily_unavailable"; code: string };

const SourceResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), runId: opaqueIdentifier }).strict(),
  z.object({ kind: z.literal("waiting_for_runner"), runId: opaqueIdentifier }).strict(),
  z.object({ kind: z.literal("follow_up_queued"), followUpId: opaqueIdentifier }).strict(),
  ...(["binding_change_pending", "setup_required", "not_authorized", "invalid_request",
    "queue_full", "storage_quota_exceeded", "source_content_deleted",
    "temporarily_unavailable"] as const).map((kind) => z.object({
      kind: z.literal(kind), code: closedCode,
    }).strict()),
  z.object({ kind: z.literal("rate_limited"), retryAt: z.iso.datetime({ offset: true }) }).strict(),
]);

type ReservationRow = {
  reservation_id: string;
  organization_id: string;
  installation_id: string;
  binding_id: string;
  source_app_id: string;
  source_delivery_id: string;
  source_message_id: string;
  source_version_ref: string;
  raw_digest: string;
  content_id: string;
  content_aad_digest: string;
  content_key_version: string;
  state: "pending" | "resolved";
  created_at: Date;
};

const reservationFromRow = (row: ReservationRow): IngressReservation => Object.freeze({
  reservationId: row.reservation_id,
  organizationId: row.organization_id,
  installationId: row.installation_id,
  bindingId: row.binding_id,
  sourceAppId: row.source_app_id,
  sourceDeliveryId: row.source_delivery_id,
  sourceMessageId: row.source_message_id,
  sourceVersionRef: row.source_version_ref,
  rawDigest: row.raw_digest,
  contentRef: Object.freeze({
    contentId: row.content_id,
    sourceVersionRef: row.source_version_ref,
    aadDigest: row.content_aad_digest,
    keyVersion: row.content_key_version,
  }),
  state: row.state,
  createdAt: row.created_at.toISOString(),
});

const stableId = (prefix: string, values: readonly string[]) => `${prefix}_${createHash("sha256")
  .update(JSON.stringify(values)).digest("hex")}`;

export function createSourceIngressService(input: {
  pool: Pool;
  clock: { now(): Date };
  custody: Pick<RelayContentCustody, "storeInTransaction" | "issueReadGrant" | "read">;
  jobs: Pick<DurableJobQueue, "enqueueInTransaction">;
}) {
  const jobs = input.jobs;
  const poisonedResolution = {
    kind: "temporarily_unavailable",
    code: "source_ingress_processing_poisoned",
  } as const satisfies SourceResolution;
  return {
    async findSourceIdentity(inputValue: { organizationId: string; installationId: string;
      sourceAppId: string; sourceVersionRef: string }) {
      try {
        const value = z.object({ organizationId: identity, installationId: identity,
          sourceAppId: identity, sourceVersionRef: identity }).strict().parse(inputValue);
        const result = await input.pool.query<{ source_delivery_id: string; source_message_id: string }>(
          `SELECT source_delivery_id, source_message_id FROM cp_ingress_reservation
           WHERE organization_id = $1 AND installation_id = $2 AND source_app_id = $3
             AND source_version_ref = $4 ORDER BY created_at LIMIT 2`,
          [value.organizationId, value.installationId, value.sourceAppId, value.sourceVersionRef],
        );
        return result.rows.length === 1 ? { sourceDeliveryId: result.rows[0]!.source_delivery_id,
          sourceMessageId: result.rows[0]!.source_message_id } : null;
      } catch { return null; }
    },
    async reserve(candidate: SourceIngressCommand) {
      let command: SourceIngressCommand;
      try {
        SourceIngressCommandSchema.parse(candidate);
        assertSourceAppDefinition(candidate.sourceApp);
        command = candidate;
      } catch {
        return { outcome: "unavailable", mayAcknowledge: false } as const;
      }
      const reservationId = stableId("ingress", [command.organizationId,
        command.installationId, command.sourceDeliveryId]);
      const contentId = stableId("content", [command.organizationId,
        command.installationId, command.sourceDeliveryId, command.rawDigest]);
      try {
        return await withPostgresTransaction(input.pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            JSON.stringify([
              command.organizationId,
              command.installationId,
              command.sourceDeliveryId,
            ]),
          ]);
          const existing = await client.query<ReservationRow>(
            `SELECT * FROM cp_ingress_reservation
             WHERE organization_id = $1 AND installation_id = $2
               AND source_delivery_id = $3 FOR UPDATE`,
            [command.organizationId, command.installationId, command.sourceDeliveryId],
          );
          if (existing.rows[0]) {
            return existing.rows[0].raw_digest === command.rawDigest
              ? { outcome: "replayed", mayAcknowledge: true,
                  reservation: reservationFromRow(existing.rows[0]) } as const
              : { outcome: "conflict", mayAcknowledge: false } as const;
          }
          const authority = await client.query<{
            source_app_id: string; app_instance_id: string; binding_digest: string;
            credential_generation: number; credential_generation_digest: string;
          }>(
            `SELECT installation.source_app_id, installation.app_instance_id,
                    installation.binding_digest, installation.credential_generation,
                    installation.credential_generation_digest
             FROM cp_source_app_installation installation
             JOIN cp_source_binding binding
               ON binding.organization_id = installation.organization_id
              AND binding.installation_id = installation.installation_id
             WHERE installation.organization_id = $1 AND installation.installation_id = $2
               AND binding.binding_id = $3 AND installation.state = 'active'
               AND binding.state = 'active' AND binding.binding_digest = installation.binding_digest
             FOR UPDATE OF installation, binding`,
            [command.organizationId, command.installationId, command.bindingId],
          );
          const row = authority.rows[0];
          const installation = command.sourceApp.installation;
          if (!row || row.source_app_id !== command.sourceApp.appId
            || row.app_instance_id !== installation.appInstanceId
            || row.binding_digest !== installation.bindingDigest
            || row.credential_generation !== installation.credentialGeneration
            || row.credential_generation_digest !== installation.credentialGenerationDigest) {
            throw new Error("source_ingress_authority_invalid");
          }
          const now = input.clock.now();
          await client.query(
            `INSERT INTO cp_ingress_reservation(
              reservation_id, organization_id, installation_id, binding_id, source_app_id,
              source_delivery_id, source_message_id, source_version_ref, raw_digest,
              content_id, content_aad_digest, content_key_version, state, created_at, updated_at
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,$13)`,
            [reservationId, command.organizationId, command.installationId, command.bindingId,
              command.sourceApp.appId, command.sourceDeliveryId, command.sourceMessageId,
              command.sourceVersionRef, command.rawDigest, contentId, "pending", "pending", now],
          );
          const contentRef = await input.custody.storeInTransaction(client, {
            organizationId: command.organizationId, installationId: command.installationId,
            sourceAppId: command.sourceApp.appId, sourceDeliveryId: command.sourceDeliveryId,
            sourceMessageId: command.sourceMessageId, sourceVersionRef: command.sourceVersionRef,
            purpose: "source_context", contentId, payload: command.normalizedContent,
            expiresAt: command.expiresAt,
          });
          await client.query(
            `UPDATE cp_ingress_reservation
             SET content_aad_digest = $2, content_key_version = $3
             WHERE reservation_id = $1`,
            [reservationId, contentRef.aadDigest, contentRef.keyVersion],
          );
          const payload = { reservationId, rawDigest: command.rawDigest, contentRef };
          const enqueue = await jobs.enqueueInTransaction(client, {
            jobId: `source-ingress:${reservationId}`, organizationId: command.organizationId,
            kind: "source_ingress.process", payload, maxAttempts: 5,
          });
          if (enqueue.kind === "conflict") throw new Error("source_ingress_job_conflict");
          const stored = await client.query<ReservationRow>(
            "SELECT * FROM cp_ingress_reservation WHERE reservation_id = $1", [reservationId],
          );
          return { outcome: "reserved", mayAcknowledge: true,
            reservation: reservationFromRow(stored.rows[0]!) } as const;
        });
      } catch {
        return { outcome: "unavailable", mayAcknowledge: false } as const;
      }
    },

    async readReservation(reservationId: string) {
      const result = await input.pool.query<ReservationRow>(
        "SELECT * FROM cp_ingress_reservation WHERE reservation_id = $1", [reservationId],
      );
      return result.rows[0] ? reservationFromRow(result.rows[0]) : null;
    },

    async readResolution(reservation: IngressReservation) {
      const result = await input.pool.query<{ resolution: SourceResolution }>(
        `SELECT resolution FROM cp_source_resolution
         WHERE organization_id = $1 AND reservation_id = $2`,
        [reservation.organizationId, reservation.reservationId],
      );
      return result.rows[0]?.resolution ?? null;
    },

    async readSourceContext(command: { reservation: IngressReservation; jobId: string;
      leaseToken: string; expiresAt: Date }) {
      const attemptId = stableId("source_ingress_attempt", [command.jobId, command.leaseToken]);
      const grant = await input.custody.issueReadGrant({
        organizationId: command.reservation.organizationId,
        runId: "source_ingress.process", attemptId,
        fenceDigest: command.leaseToken,
        contentIds: [command.reservation.contentRef.contentId], purpose: "source_context",
        expiresAt: command.expiresAt,
      });
      const rows = await input.custody.read({ ...grant,
        organizationId: command.reservation.organizationId,
        runId: "source_ingress.process", attemptId,
        fenceDigest: command.leaseToken,
        contentIds: [command.reservation.contentRef.contentId], purpose: "source_context" });
      return rows[0]?.payload;
    },

    async assertProcessingLease(command: { reservation: IngressReservation;
      jobId: string; leaseToken: string }) {
      const result = await input.pool.query(
        `SELECT 1 FROM cp_job
         WHERE job_id = $1 AND organization_id = $2
           AND job_kind = 'source_ingress.process' AND state = 'claimed'
           AND lease_token = $3 AND lease_expires_at > $4
           AND payload->>'reservationId' = $5`,
        [command.jobId, command.reservation.organizationId, command.leaseToken,
          input.clock.now(), command.reservation.reservationId],
      );
      if (!result.rows[0]) throw new Error("source_ingress_stale_lease");
    },

    async finalizeExpiredProcessing() {
      return withPostgresTransaction(input.pool, async (client) => {
        const exhausted = await client.query<ReservationRow & {
          job_id: string; lease_token: string;
        }>(
          `SELECT reservation.*, job.job_id, job.lease_token
           FROM cp_job job
           JOIN cp_ingress_reservation reservation
             ON reservation.organization_id = job.organization_id
            AND reservation.reservation_id = job.payload->>'reservationId'
           WHERE job.job_kind = 'source_ingress.process' AND job.state = 'claimed'
             AND job.lease_expires_at <= $1 AND job.attempt_count >= job.max_attempts
           ORDER BY job.available_at, job.created_at, job.job_id
           FOR UPDATE OF job, reservation SKIP LOCKED
           LIMIT 1`,
          [input.clock.now()],
        );
        const row = exhausted.rows[0];
        if (!row) return null;
        const existing = await client.query<{ resolution: SourceResolution }>(
          `SELECT resolution FROM cp_source_resolution
           WHERE organization_id = $1 AND reservation_id = $2 FOR UPDATE`,
          [row.organization_id, row.reservation_id],
        );
        const resolution = existing.rows[0]?.resolution ?? poisonedResolution;
        if (!existing.rows[0]) {
          await client.query(
            `INSERT INTO cp_source_resolution(resolution_id, organization_id, reservation_id,
               resolution, operator_attention, created_at) VALUES($1,$2,$3,$4,true,$5)`,
            [stableId("resolution", [row.organization_id, row.reservation_id]),
              row.organization_id, row.reservation_id, resolution, input.clock.now()],
          );
        }
        await client.query(
          `UPDATE cp_ingress_reservation SET state = 'resolved', updated_at = $2
           WHERE reservation_id = $1`,
          [row.reservation_id, input.clock.now()],
        );
        await client.query(
          `UPDATE cp_job SET state = 'succeeded', lease_owner = NULL,
             lease_token = NULL, lease_expires_at = NULL,
             last_error_code = 'lease_expired', updated_at = $2
           WHERE job_id = $1`,
          [row.job_id, input.clock.now()],
        );
        await client.query(
          `INSERT INTO cp_job_settlement(job_id, lease_token, outcome, settled_at)
           VALUES($1,$2,$3,$4)`,
          [row.job_id, row.lease_token, resolution, input.clock.now()],
        );
        return { jobId: row.job_id, resolution } as const;
      });
    },

    async recordResolution(command: { reservation: IngressReservation;
      resolution: SourceResolution; jobId: string; leaseToken: string;
      operatorAttention?: boolean }) {
      const resolution = SourceResolutionSchema.parse(command.resolution) as SourceResolution;
      return withPostgresTransaction(input.pool, async (client) => {
        const lease = await client.query(
          `SELECT 1 FROM cp_job
           WHERE job_id = $1 AND organization_id = $2
             AND job_kind = 'source_ingress.process' AND state = 'claimed'
             AND lease_token = $3 AND lease_expires_at > $4
             AND payload->>'reservationId' = $5
           FOR UPDATE`,
          [command.jobId, command.reservation.organizationId, command.leaseToken,
            input.clock.now(), command.reservation.reservationId],
        );
        if (!lease.rows[0]) throw new Error("source_ingress_stale_lease");
        const existing = await client.query<{ resolution: SourceResolution }>(
          `SELECT resolution FROM cp_source_resolution
           WHERE organization_id = $1 AND reservation_id = $2 FOR UPDATE`,
          [command.reservation.organizationId, command.reservation.reservationId],
        );
        if (existing.rows[0]) return existing.rows[0].resolution;
        const resolutionId = stableId("resolution", [command.reservation.organizationId,
          command.reservation.reservationId]);
        await client.query(
          `INSERT INTO cp_source_resolution(resolution_id, organization_id, reservation_id,
             resolution, operator_attention, created_at) VALUES($1,$2,$3,$4,$5,$6)`,
          [resolutionId, command.reservation.organizationId, command.reservation.reservationId,
            resolution, command.operatorAttention ?? false, input.clock.now()],
        );
        await client.query(
          "UPDATE cp_ingress_reservation SET state = 'resolved', updated_at = $2 WHERE reservation_id = $1",
          [command.reservation.reservationId, input.clock.now()],
        );
        return resolution;
      });
    },
  };
}

export type SourceIngressService = ReturnType<typeof createSourceIngressService>;
