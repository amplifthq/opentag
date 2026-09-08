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

export const SOURCE_INGRESS_WAIT_LIMIT_MS = 8 * 60 * 60 * 1_000;

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
  ...(["setup_required", "not_authorized", "invalid_request",
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
  content_payload_digest: string;
  resolution_request_digest: string | null;
  resolution_run_id: string | null;
  resolution: SourceResolution | null;
  resolved_at: Date | null;
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
    payloadDigest: row.content_payload_digest,
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
      const parsed = z.object({ organizationId: identity, installationId: identity,
        sourceAppId: identity, sourceVersionRef: identity }).strict().safeParse(inputValue);
      if (!parsed.success) return { kind: "not_found" } as const;
      const value = parsed.data;
      const result = await input.pool.query<{ source_delivery_id: string; source_message_id: string }>(
        `SELECT source_delivery_id, source_message_id FROM cp_ingress_reservation
         WHERE organization_id = $1 AND installation_id = $2 AND source_app_id = $3
           AND source_version_ref = $4 ORDER BY created_at LIMIT 2`,
        [value.organizationId, value.installationId, value.sourceAppId, value.sourceVersionRef],
      );
      if (result.rows.length === 0) return { kind: "not_found" } as const;
      if (result.rows.length > 1) return { kind: "ambiguous" } as const;
      return { kind: "found", sourceDeliveryId: result.rows[0]!.source_delivery_id,
        sourceMessageId: result.rows[0]!.source_message_id } as const;
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
            installation_id: string; binding_digest: string;
            credential_generation: number; credential_generation_digest: string;
          }>(
            `SELECT installation_id,binding_digest,credential_generation,
                    credential_generation_digest
             FROM cp_slack_binding
             WHERE organization_id=$1 AND installation_id=$2 AND binding_id=$3
               AND state='active'
             FOR UPDATE`,
            [command.organizationId, command.installationId, command.bindingId],
          );
          const row = authority.rows[0];
          const installation = command.sourceApp.installation;
          if (!row || command.sourceApp.appId !== "slack"
            || row.installation_id !== installation.appInstanceId
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
              content_id, content_aad_digest, content_key_version, content_payload_digest,
              state, created_at, updated_at
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$9,'pending',$13,$13)`,
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
             SET content_aad_digest = $2, content_key_version = $3,
                 content_payload_digest = $4
             WHERE reservation_id = $1`,
            [reservationId, contentRef.aadDigest, contentRef.keyVersion,
              contentRef.payloadDigest],
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
        `SELECT resolution FROM cp_ingress_reservation
         WHERE organization_id = $1 AND reservation_id = $2
           AND state = 'resolved'`,
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

    // Readiness is an expected dependency wait, not a failed processing attempt.
    // Keep the original custody obligation and release only this worker's lease.
    async deferUntilReadiness(command: { reservation: IngressReservation;
      jobId: string; leaseToken: string; retryAt: Date }) {
      const result = await input.pool.query(
        `UPDATE cp_job job
         SET state='pending', available_at=$4, attempt_count=attempt_count-1,
             lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
             last_error_code='runner_not_ready', updated_at=$5
         WHERE job_id=$1 AND organization_id=$2 AND job_kind='source_ingress.process'
           AND state='claimed' AND lease_token=$3 AND lease_expires_at>$5
           AND payload->>'reservationId'=$6
           AND EXISTS (SELECT 1 FROM cp_ingress_reservation reservation
             WHERE reservation.organization_id=job.organization_id
               AND reservation.reservation_id=$6 AND reservation.state='pending')
         RETURNING job_id`,
        [command.jobId, command.reservation.organizationId, command.leaseToken,
          command.retryAt, input.clock.now(), command.reservation.reservationId],
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
        const resolution = row.resolution ?? poisonedResolution;
        await client.query(
          `UPDATE cp_ingress_reservation
           SET state = 'resolved', resolution = $2,
               resolved_at = COALESCE(resolved_at, $3), updated_at = $3
           WHERE reservation_id = $1`,
          [row.reservation_id, resolution, input.clock.now()],
        );
        await client.query(
          `UPDATE cp_job SET state = 'succeeded', lease_owner = NULL,
             lease_token = NULL, lease_expires_at = NULL,
             last_error_code = 'lease_expired',
             settlement_lease_token = $3, settlement_outcome = $4,
             settled_at = $2, updated_at = $2
           WHERE job_id = $1`,
          [row.job_id, input.clock.now(), row.lease_token, resolution],
        );
        return { jobId: row.job_id, resolution } as const;
      });
    },

    async recordResolution(command: { reservation: IngressReservation;
      resolution: SourceResolution; jobId: string; leaseToken: string }) {
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
        const existing = await client.query<{ resolution: SourceResolution | null }>(
          `SELECT resolution FROM cp_ingress_reservation
           WHERE organization_id = $1 AND reservation_id = $2 FOR UPDATE`,
          [command.reservation.organizationId, command.reservation.reservationId],
        );
        if (!existing.rows[0]) throw new Error("source_ingress_reservation_missing");
        if (existing.rows[0].resolution) return existing.rows[0].resolution;
        await client.query(
          `UPDATE cp_ingress_reservation
           SET state = 'resolved', resolution = $2, resolved_at = $3, updated_at = $3
           WHERE reservation_id = $1 AND state = 'pending'`,
          [command.reservation.reservationId, resolution, input.clock.now()],
        );
        return resolution;
      });
    },
  };
}

export type SourceIngressService = ReturnType<typeof createSourceIngressService>;
