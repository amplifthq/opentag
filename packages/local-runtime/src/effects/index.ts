import { randomUUID } from "node:crypto";
import type { OpenTagClient } from "@opentag/client";
import type {
  EffectEvidenceV1,
  EffectExecutePermitV1,
  EffectPermitV1,
  EffectViewV1,
} from "@opentag/control-protocol";
import type {
  ClaimedLocalEffectAttempt,
  LocalEffectAttempt,
  LocalEffectJournalRepository,
} from "@opentag/store";

export type GitHubDraftPullRequestEffectEvidence = Exclude<
  EffectEvidenceV1,
  { kind: "not_started" }
>;

/**
 * The credential-bearing adapter stays Runner-local. Its mutation method is
 * available only for a fresh execute permit; all recovery enters observe.
 */
export type GitHubDraftPullRequestEffectAdapter = {
  createDraftPullRequest(
    permit: EffectExecutePermitV1,
    signal: AbortSignal,
  ): Promise<GitHubDraftPullRequestEffectEvidence>;
  observeDraftPullRequest(
    permit: EffectPermitV1,
    signal: AbortSignal,
  ): Promise<GitHubDraftPullRequestEffectEvidence>;
};

export class LocalEffectOutcomeUnknownError extends Error {
  override readonly name = "LocalEffectOutcomeUnknownError";

  constructor(readonly errorCode:
    | "transport_error"
    | "provider_timeout"
    | "malformed_response"
    | "provider_receipt_missing") {
    super(errorCode);
  }
}

export type LocalEffectAuthorityClient = Pick<
  OpenTagClient,
  "acquireEffectControlV1" | "recordEffectEvidenceControlV1"
>;

export type LocalEffectExecutorResult =
  | { outcome: "idle" }
  | { outcome: "acknowledged"; view: EffectViewV1 }
  | { outcome: "attention"; view: EffectViewV1 };

export type LocalEffectExecutorOptions = {
  organizationId: string;
  runnerId: string;
  runnerGeneration: number;
  repository: LocalEffectJournalRepository;
  client: LocalEffectAuthorityClient;
  adapter: GitHubDraftPullRequestEffectAdapter;
  isWorkAuthorityCurrent(permit: EffectPermitV1): Promise<boolean>;
  now?: () => Date;
  acquireRequestId?: () => string;
  leaseOwner?: string;
  leaseSeconds?: number;
  providerTimeoutMs?: number;
};

const DEFAULT_LOCAL_EFFECT_LEASE_SECONDS = 60;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

export class LocalEffectExecutor {
  readonly #now: () => Date;
  readonly #acquireRequestId: () => string;
  readonly #leaseOwner: string;
  readonly #leaseSeconds: number;
  readonly #providerTimeoutMs: number;
  #running = false;

  constructor(private readonly options: LocalEffectExecutorOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#acquireRequestId = options.acquireRequestId
      ?? (() => `effect_acquire_${randomUUID()}`);
    this.#leaseOwner = options.leaseOwner ?? `effect_executor_${randomUUID()}`;
    this.#leaseSeconds = options.leaseSeconds ?? DEFAULT_LOCAL_EFFECT_LEASE_SECONDS;
    this.#providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    if (!Number.isFinite(this.#providerTimeoutMs) || this.#providerTimeoutMs <= 0
      || !Number.isFinite(this.#leaseSeconds)
      || this.#leaseSeconds * 1_000 <= this.#providerTimeoutMs + 1_000) {
      throw new Error("local_effect_executor_lease_window_invalid");
    }
  }

  async runOnce(): Promise<LocalEffectExecutorResult> {
    if (this.#running) throw new Error("local_effect_executor_reentrant");
    this.#running = true;
    try {
      return await this.#runOnceExclusive();
    } finally {
      this.#running = false;
    }
  }

  async #runOnceExclusive(): Promise<LocalEffectExecutorResult> {
    await this.options.repository.pruneAcknowledgedLocalEffectAttempts({ now: this.#now() });
    let pending = await this.#claimNext();
    if (pending) return this.#resume(pending);

    await this.options.repository.createLocalEffectAcquire({
      requestId: this.#acquireRequestId(),
      organizationId: this.options.organizationId,
      runnerId: this.options.runnerId,
      runnerGeneration: this.options.runnerGeneration,
      now: this.#now(),
    });
    pending = await this.#claimNext();
    return pending ? this.#resume(pending) : { outcome: "idle" };
  }

  #claimNext(): Promise<ClaimedLocalEffectAttempt | null> {
    return this.options.repository.claimNextRecoverableLocalEffectAttempt({
      organizationId: this.options.organizationId,
      runnerId: this.options.runnerId,
      runnerGeneration: this.options.runnerGeneration,
      leaseOwner: this.#leaseOwner,
      leaseSeconds: this.#leaseSeconds,
      now: this.#now(),
    });
  }

  async #resume(claimed: ClaimedLocalEffectAttempt): Promise<LocalEffectExecutorResult> {
    const attempt = claimed.attempt;
    switch (attempt.state) {
      case "acquire_pending":
        return this.#acquire(claimed);
      case "permit_accepted": {
        const permit = this.#requiredPermit(attempt);
        return permit.permitKind === "execute"
          ? this.#sealAndUpload(claimed, {
              kind: "not_started",
              acquireJournalDigest: attempt.acquireJournalDigest,
              localJournalDigest: this.#requiredJournalDigest(attempt),
              reason: "provider_io_not_begun",
            })
          : this.#startFreshPermit(claimed);
      }
      case "provider_io_begun":
        return this.#observeAndUpload(claimed);
      case "evidence_pending":
        return this.#upload(claimed);
      case "acknowledged":
      case "attention":
        return { outcome: "idle" };
    }
    throw new Error("local_effect_state_invalid");
  }

  async #acquire(claimed: ClaimedLocalEffectAttempt): Promise<LocalEffectExecutorResult> {
    const attempt = claimed.attempt;
    const permit = await this.options.client.acquireEffectControlV1(attempt.acquireRequest);
    if (permit === null) {
      const discarded = await this.options.repository.discardEmptyLocalEffectAcquire({
        acquireRequestId: attempt.acquireRequestId,
        acquireJournalDigest: attempt.acquireJournalDigest,
        leaseToken: claimed.leaseToken,
        now: this.#now(),
      });
      if (discarded !== "discarded" && discarded !== "not_found") {
        throw new Error("local_effect_empty_acquire_state_conflict");
      }
      return { outcome: "idle" };
    }

    const accepted = await this.options.repository.acceptLocalEffectPermit({
      acquireRequestId: attempt.acquireRequestId,
      permit,
      leaseToken: claimed.leaseToken,
      now: this.#now(),
    });
    return this.#startFreshPermit({ ...claimed, attempt: accepted.attempt });
  }

  async #startFreshPermit(
    claimed: ClaimedLocalEffectAttempt,
  ): Promise<LocalEffectExecutorResult> {
    const attempt = claimed.attempt;
    const permit = this.#requiredPermit(attempt);
    if (
      permit.permitKind === "execute"
      && !await this.options.isWorkAuthorityCurrent(permit)
    ) {
      return this.#sealAndUpload(claimed, {
        kind: "not_started",
        acquireJournalDigest: attempt.acquireJournalDigest,
        localJournalDigest: this.#requiredJournalDigest(attempt),
        reason: "provider_io_not_begun",
      });
    }
    const begun = await this.options.repository.markLocalEffectProviderIoBegun({
      acquireRequestId: attempt.acquireRequestId,
      permitId: permit.permitId,
      leaseToken: claimed.leaseToken,
      leaseSeconds: this.#leaseSeconds,
      now: this.#now(),
    });
    if (begun === "not_current") {
      return permit.permitKind === "execute"
        ? this.#sealAndUpload(claimed, {
            kind: "not_started",
            acquireJournalDigest: attempt.acquireJournalDigest,
            localJournalDigest: this.#requiredJournalDigest(attempt),
            reason: "provider_io_not_begun",
          })
        : this.#sealAndUpload(claimed, {
            kind: "attention",
            reasonCode: "local.reconciliation-permit-expired-before-observation",
          });
    }
    if (begun !== "begun") {
      const current = await this.options.repository.getLocalEffectAttempt(attempt.acquireRequestId);
      if (!current) throw new Error("local_effect_journal_missing_before_provider_io");
      return this.#observeAndUpload({ ...claimed, attempt: current });
    }

    const evidence = await this.#invokeProvider((signal) => permit.permitKind === "execute"
      ? this.options.adapter.createDraftPullRequest(permit, signal)
      : this.options.adapter.observeDraftPullRequest(permit, signal));
    const current = await this.options.repository.getLocalEffectAttempt(attempt.acquireRequestId);
    if (!current || current.state !== "provider_io_begun") {
      throw new Error("local_effect_journal_missing_after_provider_io");
    }
    return this.#sealAndUpload(
      { ...claimed, attempt: current },
      this.#normalizeEvidence(permit, evidence),
    );
  }

  async #observeAndUpload(
    claimed: ClaimedLocalEffectAttempt,
  ): Promise<LocalEffectExecutorResult> {
    const attempt = claimed.attempt;
    const permit = this.#requiredPermit(attempt);
    const evidence = await this.#invokeProvider((signal) =>
      this.options.adapter.observeDraftPullRequest(permit, signal));
    return this.#sealAndUpload(claimed, this.#normalizeEvidence(permit, evidence));
  }

  async #sealAndUpload(
    claimed: ClaimedLocalEffectAttempt,
    evidence: EffectEvidenceV1,
  ): Promise<LocalEffectExecutorResult> {
    const attempt = claimed.attempt;
    const sealed = await this.options.repository.sealLocalEffectEvidence({
      acquireRequestId: attempt.acquireRequestId,
      evidence,
      leaseToken: claimed.leaseToken,
      observedAt: this.#now(),
    });
    return this.#upload({ ...claimed, attempt: sealed.attempt });
  }

  async #upload(claimed: ClaimedLocalEffectAttempt): Promise<LocalEffectExecutorResult> {
    const attempt = claimed.attempt;
    if (!attempt.evidence) throw new Error("local_effect_evidence_missing");
    const view = await this.options.client.recordEffectEvidenceControlV1(attempt.evidence);
    const acknowledged = await this.options.repository.acknowledgeLocalEffectEvidence({
      acquireRequestId: attempt.acquireRequestId,
      view,
      leaseToken: claimed.leaseToken,
      now: this.#now(),
    });
    return acknowledged.outcome === "attention"
      ? { outcome: "attention", view }
      : { outcome: "acknowledged", view };
  }

  #requiredPermit(attempt: LocalEffectAttempt): EffectPermitV1 {
    if (!attempt.permit) throw new Error("local_effect_permit_missing");
    return attempt.permit;
  }

  #requiredJournalDigest(attempt: LocalEffectAttempt): string {
    if (!attempt.localJournalDigest) throw new Error("local_effect_journal_digest_missing");
    return attempt.localJournalDigest;
  }

  #normalizeEvidence(
    permit: EffectPermitV1,
    evidence: GitHubDraftPullRequestEffectEvidence,
  ): GitHubDraftPullRequestEffectEvidence {
    // Exact absence is retry authority only when observed under the scoped
    // reconciliation permit. Under an execute permit it remains ambiguous.
    return permit.permitKind === "execute" && evidence.kind === "absent"
      ? { kind: "ambiguous", errorCode: "provider_receipt_missing" }
      : evidence;
  }

  async #invokeProvider(
    call: (signal: AbortSignal) => Promise<GitHubDraftPullRequestEffectEvidence>,
  ): Promise<GitHubDraftPullRequestEffectEvidence> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call(controller.signal),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new LocalEffectOutcomeUnknownError("provider_timeout"));
          }, this.#providerTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof LocalEffectOutcomeUnknownError) {
        return { kind: "ambiguous", errorCode: error.errorCode };
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export async function runLocalEffectExecutorIteration(
  options: LocalEffectExecutorOptions,
): Promise<LocalEffectExecutorResult> {
  return new LocalEffectExecutor(options).runOnce();
}
