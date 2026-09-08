import {
  EffectAcquireRequestV1Schema,
  EffectEvidenceEnvelopeV1Schema,
  EffectEvidenceV1Schema,
  EffectPermitV1Schema,
  EffectViewV1Schema,
  canonicalJsonStringify,
  computeEffectEvidenceDigestV1,
  computeEffectEvidencePayloadDigestV1,
  verifyEffectEvidenceEnvelopeV1,
  verifyEffectPermitV1,
  type EffectAcquireRequestV1,
  type EffectEvidenceEnvelopeV1,
  type EffectEvidenceV1,
  type EffectPermitV1,
  type EffectViewV1,
} from "@opentag/core";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { canonicalSha256Json } from "./canonical-json.js";
import { localEffectAttempts } from "./schema.js";

export const LOCAL_EFFECT_ATTEMPT_STATES = [
  "acquire_pending",
  "permit_accepted",
  "provider_io_begun",
  "evidence_pending",
  "acknowledged",
  "attention",
] as const;

export const LOCAL_EFFECT_ACKNOWLEDGED_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type LocalEffectAttemptState = (typeof LOCAL_EFFECT_ATTEMPT_STATES)[number];

export type LocalEffectAttempt = {
  acquireRequestId: string;
  organizationId: string;
  runnerId: string;
  runnerGeneration: number;
  acquireJournalDigest: string;
  acquireRequest: EffectAcquireRequestV1;
  state: LocalEffectAttemptState;
  permit?: EffectPermitV1;
  localJournalDigest?: string;
  providerIoBegunAt?: string;
  evidence?: EffectEvidenceEnvelopeV1;
  acknowledgement?: EffectViewV1;
  acknowledgementDigest?: string;
  attentionReasonCode?: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
};

export type ClaimedLocalEffectAttempt = {
  attempt: LocalEffectAttempt;
  leaseToken: string;
  leaseExpiresAt: string;
};

export class LocalEffectJournalError extends Error {
  override readonly name = "LocalEffectJournalError";

  constructor(readonly code:
    | "LOCAL_EFFECT_ACQUIRE_CONFLICT"
    | "LOCAL_EFFECT_JOURNAL_MISSING"
    | "LOCAL_EFFECT_PERMIT_INVALID"
    | "LOCAL_EFFECT_STATE_CONFLICT"
    | "LOCAL_EFFECT_EVIDENCE_INVALID"
    | "LOCAL_EFFECT_ACKNOWLEDGEMENT_INVALID"
    | "LOCAL_EFFECT_STORED_ROW_INVALID") {
    super(code);
  }
}

type LocalEffectAttemptRow = typeof localEffectAttempts.$inferSelect;

function isExpectedUniquenessConflict(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = String((error as Error & { code?: unknown }).code);
  return code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE";
}

function hasCurrentLease(row: LocalEffectAttemptRow, leaseToken: string, at: string): boolean {
  return row.executorLeaseToken === leaseToken
    && row.executorLeaseExpiresAt !== null
    && row.executorLeaseExpiresAt > at;
}

function timestamp(now: Date): string {
  const value = now.toISOString();
  if (Number.isNaN(Date.parse(value))) {
    throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
  }
  return value;
}

function acquireJournalDigest(input: {
  requestId: string;
  organizationId: string;
  runnerId: string;
  runnerGeneration: number;
  createdAt: string;
}): string {
  return canonicalSha256Json({
    purpose: "opentag-local-effect-acquire-journal-v1",
    ...input,
  });
}

function acceptedPermitJournalDigest(input: {
  acquireJournalDigest: string;
  permit: EffectPermitV1;
}): string {
  return canonicalSha256Json({
    purpose: "opentag-local-effect-permit-journal-v1",
    acquireJournalDigest: input.acquireJournalDigest,
    permitId: input.permit.permitId,
    permitDigest: input.permit.permitDigest,
    effectId: input.permit.effectId,
    effectAttemptNumber: input.permit.effectAttemptNumber,
    effectRequestDigest: input.permit.requestDigest,
    targetDigest: input.permit.targetDigest,
  });
}

function assertPermitMatchesAcquire(
  request: EffectAcquireRequestV1,
  permit: EffectPermitV1,
): void {
  if (
    permit.acquireRequestId !== request.requestId
    || permit.acquireJournalDigest !== request.acquireJournalDigest
    || permit.organizationId !== request.organizationId
    || permit.runnerId !== request.runnerId
    || permit.runnerGeneration !== request.runnerGeneration
  ) {
    throw new LocalEffectJournalError("LOCAL_EFFECT_PERMIT_INVALID");
  }
}

function sameRepository(
  left: { owner: string; repo: string },
  right: { owner: string; repo: string },
): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.repo.toLowerCase() === right.repo.toLowerCase();
}

function assertEvidenceMatchesPermit(
  evidence: EffectEvidenceV1,
  permit: EffectPermitV1,
  localJournalDigest: string,
  providerIoBegunAt?: string,
  sealedAt?: string,
): void {
  if (evidence.kind === "not_started") {
    if (
      evidence.acquireJournalDigest !== permit.acquireJournalDigest
      || evidence.localJournalDigest !== localJournalDigest
    ) {
      throw new LocalEffectJournalError("LOCAL_EFFECT_EVIDENCE_INVALID");
    }
    return;
  }
  if (evidence.kind === "present") {
    const observation = evidence.observation;
    if (
      !sameRepository(observation.repository, permit.target)
      || !sameRepository(observation.headRepository, permit.target)
      || observation.remote !== permit.target.remote
      || observation.branch !== permit.target.branch
      || observation.headBranch !== permit.target.branch
      || observation.baseBranch !== permit.target.baseBranch
      || observation.headSha !== permit.target.expectedHeadSha
      || !providerIoBegunAt
      || !sealedAt
      || observation.observedAt < providerIoBegunAt
      || observation.observedAt > sealedAt
    ) {
      throw new LocalEffectJournalError("LOCAL_EFFECT_EVIDENCE_INVALID");
    }
    return;
  }
  if (evidence.kind === "absent") {
    const scope = evidence.observationScope;
    if (
      !sameRepository(scope.repository, permit.target)
      || scope.baseBranch !== permit.target.baseBranch
      || scope.headBranch !== permit.target.branch
      || scope.expectedHeadSha !== permit.target.expectedHeadSha
      || scope.bindingGeneration !== permit.target.targetBindingGeneration
      || scope.targetBindingDigest !== permit.target.targetBindingDigest
      || !providerIoBegunAt
      || !sealedAt
      || scope.observedAt < providerIoBegunAt
      || scope.observedAt > sealedAt
    ) {
      throw new LocalEffectJournalError("LOCAL_EFFECT_EVIDENCE_INVALID");
    }
  }
}

function assertAcknowledgementMatchesEvidence(
  view: EffectViewV1,
  row: LocalEffectAttemptRow,
): void {
  const permitResult = EffectPermitV1Schema.safeParse(
    row.permitJson ? JSON.parse(row.permitJson) : null,
  );
  if (!permitResult.success) {
    throw new LocalEffectJournalError("LOCAL_EFFECT_STORED_ROW_INVALID");
  }
  const permit = permitResult.data;
  const evidenceAccepted = ![
    "requested",
    "authorized",
    "permit_issued",
    "cancelled_before_permit",
  ].includes(view.state)
    && "currentEvidenceDigest" in view
    && view.currentEvidenceDigest === row.evidenceDigest;
  if (
    view.effectId !== row.effectId
    || view.effectKind !== permit.effectKind
    || view.currentAttemptNumber !== row.effectAttemptNumber
    || !evidenceAccepted
  ) {
    throw new LocalEffectJournalError("LOCAL_EFFECT_ACKNOWLEDGEMENT_INVALID");
  }
}

async function localEffectAttemptFromRow(row: LocalEffectAttemptRow): Promise<LocalEffectAttempt> {
  try {
    const acquireRequest = EffectAcquireRequestV1Schema.parse(JSON.parse(row.acquireRequestJson));
    if (
      !LOCAL_EFFECT_ATTEMPT_STATES.includes(row.state as LocalEffectAttemptState)
      || acquireRequest.requestId !== row.acquireRequestId
      || acquireRequest.organizationId !== row.organizationId
      || acquireRequest.runnerId !== row.runnerId
      || acquireRequest.runnerGeneration !== row.runnerGeneration
      || acquireRequest.acquireJournalDigest !== row.acquireJournalDigest
      || row.acquireRequestJson !== canonicalJsonStringify(acquireRequest)
      || row.acquireJournalDigest !== acquireJournalDigest({
        requestId: row.acquireRequestId,
        organizationId: row.organizationId,
        runnerId: row.runnerId,
        runnerGeneration: row.runnerGeneration,
        createdAt: row.createdAt,
      })
    ) {
      throw new Error("acquire mismatch");
    }

    const result: LocalEffectAttempt = {
      acquireRequestId: row.acquireRequestId,
      organizationId: row.organizationId,
      runnerId: row.runnerId,
      runnerGeneration: row.runnerGeneration,
      acquireJournalDigest: row.acquireJournalDigest,
      acquireRequest,
      state: row.state as LocalEffectAttemptState,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.providerIoBegunAt ? { providerIoBegunAt: row.providerIoBegunAt } : {}),
      ...(row.acknowledgedAt ? { acknowledgedAt: row.acknowledgedAt } : {}),
      ...(row.attentionReasonCode
        ? { attentionReasonCode: row.attentionReasonCode }
        : {}),
    };

    if (row.permitJson !== null) {
      const permit = EffectPermitV1Schema.parse(JSON.parse(row.permitJson));
      assertPermitMatchesAcquire(acquireRequest, permit);
      if (
        !await verifyEffectPermitV1(permit)
        || row.permitJson !== canonicalJsonStringify(permit)
        || row.permitKind !== permit.permitKind
        || row.permitId !== permit.permitId
        || row.effectId !== permit.effectId
        || row.effectAttemptNumber !== permit.effectAttemptNumber
        || row.localJournalDigest !== acceptedPermitJournalDigest({
          acquireJournalDigest: row.acquireJournalDigest,
          permit,
        })
      ) {
        throw new Error("permit mismatch");
      }
      result.permit = permit;
      result.localJournalDigest = row.localJournalDigest;
    } else if (row.state !== "acquire_pending") {
      throw new Error("missing permit");
    } else if (
      row.permitKind !== null
      || row.permitId !== null
      || row.effectId !== null
      || row.effectAttemptNumber !== null
      || row.localJournalDigest !== null
    ) {
      throw new Error("partial permit");
    }

    if (row.evidenceJson !== null) {
      const evidence = EffectEvidenceEnvelopeV1Schema.parse(JSON.parse(row.evidenceJson));
      if (
        !result.permit
        || !result.localJournalDigest
        || !await verifyEffectEvidenceEnvelopeV1(evidence)
        || row.evidenceJson !== canonicalJsonStringify(evidence)
        || row.evidenceId !== evidence.evidenceId
        || row.evidenceDigest !== evidence.evidenceDigest
        || evidence.effectId !== result.permit.effectId
        || evidence.permitId !== result.permit.permitId
        || evidence.effectAttemptNumber !== result.permit.effectAttemptNumber
        || evidence.organizationId !== result.permit.organizationId
        || evidence.producer.runnerId !== result.permit.runnerId
        || evidence.producer.runnerGeneration !== result.permit.runnerGeneration
        || evidence.predecessorEvidenceDigest !== result.permit.predecessorEvidenceDigest
      ) {
        throw new Error("evidence mismatch");
      }
      assertEvidenceMatchesPermit(
        evidence.evidence,
        result.permit,
        result.localJournalDigest,
        row.providerIoBegunAt ?? undefined,
        evidence.observedAt,
      );
      result.evidence = evidence;
    } else if (["evidence_pending", "acknowledged", "attention"].includes(row.state)) {
      throw new Error("missing evidence");
    }

    if (row.acknowledgementJson !== null) {
      const acknowledgement = EffectViewV1Schema.parse(JSON.parse(row.acknowledgementJson));
      assertAcknowledgementMatchesEvidence(acknowledgement, row);
      if (
        row.acknowledgementJson !== canonicalJsonStringify(acknowledgement)
        || row.acknowledgementDigest !== canonicalSha256Json(acknowledgement)
      ) {
        throw new Error("acknowledgement mismatch");
      }
      result.acknowledgement = acknowledgement;
      result.acknowledgementDigest = row.acknowledgementDigest;
    } else if (["acknowledged", "attention"].includes(row.state)) {
      throw new Error("missing acknowledgement");
    }

    return result;
  } catch (error) {
    if (error instanceof LocalEffectJournalError) throw error;
    throw new LocalEffectJournalError("LOCAL_EFFECT_STORED_ROW_INVALID");
  }
}

export function createLocalEffectJournalRepository(db: BetterSQLite3Database) {
  return {
    async createLocalEffectAcquire(input: {
      requestId: string;
      organizationId: string;
      runnerId: string;
      runnerGeneration: number;
      now?: Date;
    }): Promise<{
      outcome: "created" | "replayed" | "active";
      attempt: LocalEffectAttempt;
    }> {
      const existing = await db.select().from(localEffectAttempts)
        .where(eq(localEffectAttempts.acquireRequestId, input.requestId)).limit(1).get();
      if (existing) {
        const attempt = await localEffectAttemptFromRow(existing);
        if (
          attempt.organizationId !== input.organizationId
          || attempt.runnerId !== input.runnerId
          || attempt.runnerGeneration !== input.runnerGeneration
        ) {
          throw new LocalEffectJournalError("LOCAL_EFFECT_ACQUIRE_CONFLICT");
        }
        return { outcome: "replayed", attempt };
      }
      const createdAt = timestamp(input.now ?? new Date());
      const digest = acquireJournalDigest({
        requestId: input.requestId,
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        runnerGeneration: input.runnerGeneration,
        createdAt,
      });
      const request = EffectAcquireRequestV1Schema.parse({
        schemaVersion: 1,
        protocolVersion: "1.0",
        requiredCapabilities: ["relay.effect-authority.v1"],
        requestId: input.requestId,
        organizationId: input.organizationId,
        runnerId: input.runnerId,
        runnerGeneration: input.runnerGeneration,
        acquireJournalDigest: digest,
      });
      try {
        const created = db.transaction((tx) => {
          const active = tx.select().from(localEffectAttempts).where(and(
            eq(localEffectAttempts.organizationId, request.organizationId),
            eq(localEffectAttempts.runnerId, request.runnerId),
            eq(localEffectAttempts.runnerGeneration, request.runnerGeneration),
            inArray(localEffectAttempts.state, [
              "acquire_pending",
              "permit_accepted",
              "provider_io_begun",
              "evidence_pending",
            ]),
          )).orderBy(asc(localEffectAttempts.createdAt), asc(localEffectAttempts.acquireRequestId))
            .limit(1).get();
          if (active) return { outcome: "active" as const, row: active };
          tx.insert(localEffectAttempts).values({
            acquireRequestId: request.requestId,
            organizationId: request.organizationId,
            runnerId: request.runnerId,
            runnerGeneration: request.runnerGeneration,
            acquireJournalDigest: digest,
            acquireRequestJson: canonicalJsonStringify(request),
            state: "acquire_pending",
            createdAt,
            updatedAt: createdAt,
          }).run();
          const row = tx.select().from(localEffectAttempts).where(eq(
            localEffectAttempts.acquireRequestId,
            request.requestId,
          )).limit(1).get();
          if (!row) throw new LocalEffectJournalError("LOCAL_EFFECT_JOURNAL_MISSING");
          return { outcome: "created" as const, row };
        }, { behavior: "immediate" });
        return { outcome: created.outcome, attempt: await localEffectAttemptFromRow(created.row) };
      } catch (error) {
        if (error instanceof LocalEffectJournalError) throw error;
        if (!isExpectedUniquenessConflict(error)) throw error;
        const raced = await db.select().from(localEffectAttempts).where(eq(
          localEffectAttempts.acquireRequestId,
          request.requestId,
        )).limit(1).get();
        if (raced) {
          const attempt = await localEffectAttemptFromRow(raced);
          if (
            attempt.organizationId === input.organizationId
            && attempt.runnerId === input.runnerId
            && attempt.runnerGeneration === input.runnerGeneration
          ) {
            return { outcome: "replayed", attempt };
          }
        }
        throw new LocalEffectJournalError("LOCAL_EFFECT_ACQUIRE_CONFLICT");
      }
    },

    async getLocalEffectAttempt(acquireRequestId: string): Promise<LocalEffectAttempt | null> {
      const row = await db.select().from(localEffectAttempts)
        .where(eq(localEffectAttempts.acquireRequestId, acquireRequestId)).limit(1).get();
      return row ? localEffectAttemptFromRow(row) : null;
    },

    async claimNextRecoverableLocalEffectAttempt(input: {
      organizationId: string;
      runnerId: string;
      runnerGeneration: number;
      leaseOwner: string;
      leaseSeconds: number;
      now?: Date;
    }): Promise<ClaimedLocalEffectAttempt | null> {
      if (!input.leaseOwner || !Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      const now = input.now ?? new Date();
      const at = timestamp(now);
      const leaseExpiresAt = timestamp(new Date(now.getTime() + input.leaseSeconds * 1_000));
      const claimed = db.transaction((tx) => {
        const row = tx.select().from(localEffectAttempts).where(and(
          eq(localEffectAttempts.organizationId, input.organizationId),
          eq(localEffectAttempts.runnerId, input.runnerId),
          eq(localEffectAttempts.runnerGeneration, input.runnerGeneration),
          inArray(localEffectAttempts.state, [
            "acquire_pending",
            "permit_accepted",
            "provider_io_begun",
            "evidence_pending",
          ]),
          or(
            isNull(localEffectAttempts.executorLeaseToken),
            lte(localEffectAttempts.executorLeaseExpiresAt, at),
          ),
        )).orderBy(asc(localEffectAttempts.createdAt), asc(localEffectAttempts.acquireRequestId))
          .limit(1).get();
        if (!row) return null;
        const leaseToken = randomUUID();
        const updated = tx.update(localEffectAttempts).set({
          executorLeaseOwner: input.leaseOwner,
          executorLeaseToken: leaseToken,
          executorLeaseExpiresAt: leaseExpiresAt,
          updatedAt: at,
        }).where(and(
          eq(localEffectAttempts.acquireRequestId, row.acquireRequestId),
          eq(localEffectAttempts.state, row.state),
          or(
            isNull(localEffectAttempts.executorLeaseToken),
            lte(localEffectAttempts.executorLeaseExpiresAt, at),
          ),
        )).run();
        if (updated.changes !== 1) return null;
        const result = tx.select().from(localEffectAttempts).where(and(
          eq(localEffectAttempts.acquireRequestId, row.acquireRequestId),
          eq(localEffectAttempts.executorLeaseToken, leaseToken),
        )).limit(1).get();
        return result ? { row: result, leaseToken, leaseExpiresAt } : null;
      }, { behavior: "immediate" });
      return claimed
        ? { attempt: await localEffectAttemptFromRow(claimed.row),
            leaseToken: claimed.leaseToken, leaseExpiresAt: claimed.leaseExpiresAt }
        : null;
    },

    async discardEmptyLocalEffectAcquire(input: {
      acquireRequestId: string;
      acquireJournalDigest: string;
      leaseToken: string;
      now?: Date;
    }): Promise<"discarded" | "not_found" | "state_conflict"> {
      const at = timestamp(input.now ?? new Date());
      const row = await db.select().from(localEffectAttempts).where(eq(
        localEffectAttempts.acquireRequestId,
        input.acquireRequestId,
      )).limit(1).get();
      if (!row) return "not_found";
      if (row.state !== "acquire_pending"
        || row.acquireJournalDigest !== input.acquireJournalDigest
        || !hasCurrentLease(row, input.leaseToken, at)) {
        return "state_conflict";
      }
      const deleted = await db.delete(localEffectAttempts).where(and(
        eq(localEffectAttempts.acquireRequestId, input.acquireRequestId),
        eq(localEffectAttempts.acquireJournalDigest, input.acquireJournalDigest),
        eq(localEffectAttempts.state, "acquire_pending"),
        eq(localEffectAttempts.executorLeaseToken, input.leaseToken),
        gt(localEffectAttempts.executorLeaseExpiresAt, at),
      ));
      return deleted.changes === 1 ? "discarded" : "state_conflict";
    },

    async acceptLocalEffectPermit(input: {
      acquireRequestId: string;
      permit: EffectPermitV1;
      leaseToken: string;
      now?: Date;
    }): Promise<{ outcome: "accepted" | "replayed"; attempt: LocalEffectAttempt }> {
      const permit = EffectPermitV1Schema.parse(input.permit);
      if (!await verifyEffectPermitV1(permit)) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_PERMIT_INVALID");
      }
      const row = await db.select().from(localEffectAttempts).where(eq(
        localEffectAttempts.acquireRequestId,
        input.acquireRequestId,
      )).limit(1).get();
      if (!row) throw new LocalEffectJournalError("LOCAL_EFFECT_JOURNAL_MISSING");
      const updatedAt = timestamp(input.now ?? new Date());
      if (!hasCurrentLease(row, input.leaseToken, updatedAt)) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      const request = EffectAcquireRequestV1Schema.parse(JSON.parse(row.acquireRequestJson));
      assertPermitMatchesAcquire(request, permit);
      const permitJson = canonicalJsonStringify(permit);
      if (row.state !== "acquire_pending") {
        if (row.permitJson !== permitJson) {
          throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
        }
        return { outcome: "replayed", attempt: await localEffectAttemptFromRow(row) };
      }
      const localJournalDigest = acceptedPermitJournalDigest({
        acquireJournalDigest: row.acquireJournalDigest,
        permit,
      });
      let updated: { changes: number };
      try {
        updated = await db.update(localEffectAttempts).set({
          state: "permit_accepted",
          permitKind: permit.permitKind,
          permitId: permit.permitId,
          effectId: permit.effectId,
          effectAttemptNumber: permit.effectAttemptNumber,
          localJournalDigest,
          permitJson,
          updatedAt,
        }).where(and(
          eq(localEffectAttempts.acquireRequestId, input.acquireRequestId),
          eq(localEffectAttempts.state, "acquire_pending"),
          eq(localEffectAttempts.executorLeaseToken, input.leaseToken),
          gt(localEffectAttempts.executorLeaseExpiresAt, updatedAt),
        ));
      } catch (error) {
        if (!isExpectedUniquenessConflict(error)) throw error;
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      if (updated.changes !== 1) {
        const raced = await db.select().from(localEffectAttempts).where(eq(
          localEffectAttempts.acquireRequestId,
          input.acquireRequestId,
        )).limit(1).get();
        if (raced?.permitJson === permitJson) {
          return { outcome: "replayed", attempt: await localEffectAttemptFromRow(raced) };
        }
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      const accepted = await db.select().from(localEffectAttempts).where(eq(
        localEffectAttempts.acquireRequestId,
        input.acquireRequestId,
      )).limit(1).get();
      if (!accepted) throw new LocalEffectJournalError("LOCAL_EFFECT_JOURNAL_MISSING");
      return { outcome: "accepted", attempt: await localEffectAttemptFromRow(accepted) };
    },

    async markLocalEffectProviderIoBegun(input: {
      acquireRequestId: string;
      permitId: string;
      leaseToken: string;
      leaseSeconds: number;
      now?: Date;
    }): Promise<"begun" | "already_begun" | "not_current"> {
      const at = timestamp(input.now ?? new Date());
      const row = await db.select().from(localEffectAttempts).where(eq(
        localEffectAttempts.acquireRequestId,
        input.acquireRequestId,
      )).limit(1).get();
      if (!row) throw new LocalEffectJournalError("LOCAL_EFFECT_JOURNAL_MISSING");
      if (!Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0
        || !hasCurrentLease(row, input.leaseToken, at)) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      if (row.permitId !== input.permitId || row.permitJson === null) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      if (row.state !== "permit_accepted") return "already_begun";
      const permit = EffectPermitV1Schema.parse(JSON.parse(row.permitJson));
      if (at < permit.issuedAt || at >= permit.expiresAt) return "not_current";
      const renewedLeaseExpiresAt = timestamp(new Date(Math.max(
        Date.parse(row.executorLeaseExpiresAt!) + 1,
        Date.parse(at) + input.leaseSeconds * 1_000,
      )));
      const updated = await db.update(localEffectAttempts).set({
        state: "provider_io_begun",
        providerIoBegunAt: at,
        executorLeaseExpiresAt: renewedLeaseExpiresAt,
        updatedAt: at,
      }).where(and(
        eq(localEffectAttempts.acquireRequestId, input.acquireRequestId),
        eq(localEffectAttempts.permitId, input.permitId),
        eq(localEffectAttempts.state, "permit_accepted"),
        eq(localEffectAttempts.executorLeaseToken, input.leaseToken),
        gt(localEffectAttempts.executorLeaseExpiresAt, at),
      ));
      return updated.changes === 1 ? "begun" : "already_begun";
    },

    async sealLocalEffectEvidence(input: {
      acquireRequestId: string;
      evidence: EffectEvidenceV1;
      leaseToken: string;
      observedAt?: Date;
    }): Promise<{ outcome: "sealed" | "replayed"; attempt: LocalEffectAttempt }> {
      const evidence = EffectEvidenceV1Schema.parse(input.evidence);
      const row = await db.select().from(localEffectAttempts).where(eq(
        localEffectAttempts.acquireRequestId,
        input.acquireRequestId,
      )).limit(1).get();
      if (!row) throw new LocalEffectJournalError("LOCAL_EFFECT_JOURNAL_MISSING");
      const sealedAt = timestamp(input.observedAt ?? new Date());
      if (!hasCurrentLease(row, input.leaseToken, sealedAt)) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      if (!row.permitJson || !row.localJournalDigest) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      const permit = EffectPermitV1Schema.parse(JSON.parse(row.permitJson));
      const innerObservedAt = evidence.kind === "present"
        ? evidence.observation.observedAt
        : evidence.kind === "absent"
          ? evidence.observationScope.observedAt
          : null;
      if (innerObservedAt !== null && innerObservedAt < row.updatedAt) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_EVIDENCE_INVALID");
      }
      assertEvidenceMatchesPermit(
        evidence,
        permit,
        row.localJournalDigest,
        row.providerIoBegunAt ?? undefined,
        sealedAt,
      );
      const payloadDigest = await computeEffectEvidencePayloadDigestV1(evidence);
      const evidenceId = `evidence_${canonicalSha256Json({
        effectId: permit.effectId,
        effectAttemptNumber: permit.effectAttemptNumber,
        permitId: permit.permitId,
        payloadDigest,
      }).slice("sha256:".length)}`;
      const observedAt = innerObservedAt ?? sealedAt;
      const digestInput = {
        schemaVersion: 1 as const,
        protocolVersion: "1.0" as const,
        requiredCapabilities: ["relay.effect-authority.v1"] as ["relay.effect-authority.v1"],
        evidenceId,
        effectId: permit.effectId,
        permitId: permit.permitId,
        effectAttemptNumber: permit.effectAttemptNumber,
        organizationId: permit.organizationId,
        producer: {
          kind: "runner" as const,
          runnerId: permit.runnerId,
          runnerGeneration: permit.runnerGeneration,
        },
        ...(permit.predecessorEvidenceDigest
          ? { predecessorEvidenceDigest: permit.predecessorEvidenceDigest }
          : {}),
        observedAt,
        evidence,
        payloadDigest,
      };
      const envelope = EffectEvidenceEnvelopeV1Schema.parse({
        ...digestInput,
        evidenceDigest: await computeEffectEvidenceDigestV1(digestInput),
      });
      const evidenceJson = canonicalJsonStringify(envelope);
      if (row.evidenceJson !== null) {
        if (row.evidenceJson !== evidenceJson) {
          throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
        }
        return { outcome: "replayed", attempt: await localEffectAttemptFromRow(row) };
      }
      const beforeProviderIoAttention = evidence.kind === "attention"
        && permit.permitKind === "reconcile"
        && evidence.reasonCode === "local.reconciliation-permit-expired-before-observation";
      const expectedState = evidence.kind === "not_started" || beforeProviderIoAttention
        ? "permit_accepted"
        : "provider_io_begun";
      if (row.state !== expectedState) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      const updated = await db.update(localEffectAttempts).set({
        state: "evidence_pending",
        evidenceId: envelope.evidenceId,
        evidenceDigest: envelope.evidenceDigest,
        evidenceJson,
        updatedAt: observedAt,
      }).where(and(
        eq(localEffectAttempts.acquireRequestId, input.acquireRequestId),
        eq(localEffectAttempts.state, expectedState),
        eq(localEffectAttempts.executorLeaseToken, input.leaseToken),
        gt(localEffectAttempts.executorLeaseExpiresAt, sealedAt),
      ));
      if (updated.changes !== 1) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      const sealed = await db.select().from(localEffectAttempts).where(eq(
        localEffectAttempts.acquireRequestId,
        input.acquireRequestId,
      )).limit(1).get();
      if (!sealed) throw new LocalEffectJournalError("LOCAL_EFFECT_JOURNAL_MISSING");
      return { outcome: "sealed", attempt: await localEffectAttemptFromRow(sealed) };
    },

    async acknowledgeLocalEffectEvidence(input: {
      acquireRequestId: string;
      view: EffectViewV1;
      leaseToken: string;
      now?: Date;
    }): Promise<{ outcome: "acknowledged" | "attention" | "replayed"; attempt: LocalEffectAttempt }> {
      const view = EffectViewV1Schema.parse(input.view);
      const row = await db.select().from(localEffectAttempts).where(eq(
        localEffectAttempts.acquireRequestId,
        input.acquireRequestId,
      )).limit(1).get();
      if (!row) throw new LocalEffectJournalError("LOCAL_EFFECT_JOURNAL_MISSING");
      assertAcknowledgementMatchesEvidence(view, row);
      const acknowledgementJson = canonicalJsonStringify(view);
      const acknowledgementDigest = canonicalSha256Json(view);
      if (row.acknowledgementJson !== null) {
        if (
          row.acknowledgementJson !== acknowledgementJson
          || row.acknowledgementDigest !== acknowledgementDigest
        ) {
          throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
        }
        return { outcome: "replayed", attempt: await localEffectAttemptFromRow(row) };
      }
      if (row.state !== "evidence_pending") {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      const at = timestamp(input.now ?? new Date());
      if (!hasCurrentLease(row, input.leaseToken, at)) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      const needsAttention = view.state === "outcome_unknown" || view.state === "attention";
      const attentionReasonCode = needsAttention
        ? `control.${view.state}.${view.reasonCode}`
        : null;
      const updated = await db.update(localEffectAttempts).set({
        state: needsAttention ? "attention" : "acknowledged",
        acknowledgementDigest,
        acknowledgementJson,
        attentionReasonCode,
        executorLeaseOwner: null,
        executorLeaseToken: null,
        executorLeaseExpiresAt: null,
        acknowledgedAt: at,
        updatedAt: at,
      }).where(and(
        eq(localEffectAttempts.acquireRequestId, input.acquireRequestId),
        eq(localEffectAttempts.state, "evidence_pending"),
        eq(localEffectAttempts.executorLeaseToken, input.leaseToken),
        gt(localEffectAttempts.executorLeaseExpiresAt, at),
      ));
      if (updated.changes !== 1) {
        throw new LocalEffectJournalError("LOCAL_EFFECT_STATE_CONFLICT");
      }
      const acknowledged = await db.select().from(localEffectAttempts).where(eq(
        localEffectAttempts.acquireRequestId,
        input.acquireRequestId,
      )).limit(1).get();
      if (!acknowledged) throw new LocalEffectJournalError("LOCAL_EFFECT_JOURNAL_MISSING");
      return {
        outcome: needsAttention ? "attention" : "acknowledged",
        attempt: await localEffectAttemptFromRow(acknowledged),
      };
    },

    async pruneAcknowledgedLocalEffectAttempts(input: {
      now?: Date;
      limit?: number;
    }): Promise<{ pruned: number; acquireRequestIds: string[] }> {
      const now = input.now ?? new Date();
      const acknowledgedBefore = timestamp(new Date(
        now.getTime() - LOCAL_EFFECT_ACKNOWLEDGED_RETENTION_MS,
      ));
      const limit = Math.min(1_000, Math.max(1, Math.trunc(input.limit ?? 100)));
      const candidates = await db.select({
        acquireRequestId: localEffectAttempts.acquireRequestId,
      }).from(localEffectAttempts).where(and(
        eq(localEffectAttempts.state, "acknowledged"),
        lt(localEffectAttempts.acknowledgedAt, acknowledgedBefore),
      )).orderBy(asc(localEffectAttempts.acknowledgedAt), asc(localEffectAttempts.acquireRequestId))
        .limit(limit);
      const acquireRequestIds = candidates.map((candidate) => candidate.acquireRequestId);
      if (acquireRequestIds.length === 0) return { pruned: 0, acquireRequestIds: [] };
      const deleted = await db.delete(localEffectAttempts).where(and(
        eq(localEffectAttempts.state, "acknowledged"),
        inArray(localEffectAttempts.acquireRequestId, acquireRequestIds),
      ));
      return { pruned: deleted.changes, acquireRequestIds };
    },
  };
}

export type LocalEffectJournalRepository = ReturnType<typeof createLocalEffectJournalRepository>;
