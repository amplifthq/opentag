import { z } from "zod";
import type { DurableJobQueue } from "../jobs/index.js";
import type {
  SourceIngressService,
  SourceResolution,
} from "./index.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const hexDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.string().min(1).max(512);
const JobPayloadSchema = z.object({
  reservationId: identity,
  rawDigest: digest,
  contentRef: z.object({
    contentId: identity,
    sourceVersionRef: identity,
    aadDigest: hexDigest,
    keyVersion: identity,
  }).strict(),
}).strict();

export interface SourceResolutionPort {
  resolve(input: {
    reservation: NonNullable<Awaited<ReturnType<SourceIngressService["readReservation"]>>>;
    sourceContext: unknown;
  }): Promise<SourceResolution>;
}

const poisonResolution = (error: unknown): SourceResolution => ({
  kind: error instanceof Error && error.message === "source_content_deleted"
    ? "source_content_deleted"
    : "temporarily_unavailable",
  code: error instanceof Error && error.message === "source_content_deleted"
    ? "source_content_deleted"
    : "source_ingress_processing_poisoned",
});

export function createSourceIngressWorker(input: {
  ingress: SourceIngressService;
  queue: DurableJobQueue;
  resolver: SourceResolutionPort;
  workerId: string;
  retryDelayMs: number;
  clock: { now(): Date };
}) {
  return {
    async processNext() {
      const claim = await input.queue.claim(input.workerId, ["source_ingress.process"]);
      if (claim.kind === "empty") return { kind: "empty" } as const;
      const { job } = claim;
      let reservation: NonNullable<Awaited<ReturnType<SourceIngressService["readReservation"]>>> | null = null;
      try {
        const payload = JobPayloadSchema.parse(job.payload);
        reservation = await input.ingress.readReservation(payload.reservationId);
        if (!reservation || reservation.organizationId !== job.organizationId
          || reservation.rawDigest !== payload.rawDigest
          || reservation.contentRef.contentId !== payload.contentRef.contentId
          || reservation.contentRef.sourceVersionRef !== payload.contentRef.sourceVersionRef
          || reservation.contentRef.aadDigest !== payload.contentRef.aadDigest
          || reservation.contentRef.keyVersion !== payload.contentRef.keyVersion) {
          throw new Error("source_ingress_job_context_mismatch");
        }
        const existing = await input.ingress.readResolution(reservation);
        const resolution = existing ?? await (async () => {
          const sourceContext = await input.ingress.readSourceContext({
            reservation: reservation!, jobId: job.jobId, leaseToken: job.leaseToken,
            expiresAt: new Date(job.leaseExpiresAt),
          });
          const resolved = await input.resolver.resolve({ reservation: reservation!, sourceContext });
          return input.ingress.recordResolution({ reservation: reservation!, resolution: resolved,
            jobId: job.jobId, leaseToken: job.leaseToken });
        })();
        const settlement = await input.queue.succeed({
          jobId: job.jobId, leaseToken: job.leaseToken, outcome: resolution,
        });
        return settlement.kind === "settled" || settlement.kind === "replayed"
          ? { kind: "settled", jobId: job.jobId, resolution } as const
          : { kind: "stale_lease", jobId: job.jobId } as const;
      } catch (error) {
        if (error instanceof Error && error.message === "source_ingress_stale_lease") {
          return { kind: "stale_lease", jobId: job.jobId } as const;
        }
        if (reservation && job.attemptCount >= job.maxAttempts) {
          const resolution = await input.ingress.recordResolution({
            reservation, resolution: poisonResolution(error), jobId: job.jobId,
            leaseToken: job.leaseToken, operatorAttention: true,
          });
          const settlement = await input.queue.succeed({
            jobId: job.jobId, leaseToken: job.leaseToken, outcome: resolution,
          });
          return settlement.kind === "settled" || settlement.kind === "replayed"
            ? { kind: "settled", jobId: job.jobId, resolution } as const
            : { kind: "stale_lease", jobId: job.jobId } as const;
        }
        const failure = await input.queue.fail({
          jobId: job.jobId, leaseToken: job.leaseToken,
          errorCode: "source_ingress_processing_failed",
          ...(job.attemptCount < job.maxAttempts
            ? { retryAt: new Date(input.clock.now().getTime() + input.retryDelayMs) }
            : {}),
        });
        return failure.kind === "retry_scheduled"
          ? { kind: "retry_scheduled", jobId: job.jobId } as const
          : failure.kind === "stale_lease"
            ? { kind: "stale_lease", jobId: job.jobId } as const
          : { kind: "failed", jobId: job.jobId } as const;
      }
    },
  };
}

export type SourceIngressWorker = ReturnType<typeof createSourceIngressWorker>;
