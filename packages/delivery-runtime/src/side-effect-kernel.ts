import { createHash } from "node:crypto";
import { DELIVERY_ERROR_CODES, domainSeparatedCanonicalBytes, type DeliveryBegin,
  type DeliveryClaim, type DeliveryErrorCode, type DeliveryIntentV2,
  type DeliverySettlement } from "@opentag/delivery-contract";
import { ProviderAdapterRegistry, type ProviderDeliveryResult } from "./provider-registry.js";
import type { DeliveryKernelRepository } from "./repository.js";

const ATTENTION_EVIDENCE = {
  provider_adapter_not_registered: "sha256:f443f5a15f8ed4f358b38012507180672bf19df21b93c872091e323c4331716e",
  delivery_request_preparation_failed: "sha256:bb0ff0ba276c9f25b1925a185265bf6e109dd09ee980f17c2b665c63e204177b",
  delivery_request_digest_mismatch: "sha256:59f366cd52fd4090782e4834974d46ae0ec94572a65826756201ca4d93e0c7a3",
  delivery_payload_custody_unavailable: "sha256:8c8d4868e7599cffde0dbceda47cf8c3f6b1d8f7a17c404cc707bd0839b43f01",
  provider_binding_mismatch: "sha256:3c09161f1680468648da69d87961d9379ef0087db4ed8f1a9aba6cc042905704",
} as const;
type AttentionReason = keyof typeof ATTENTION_EVIDENCE;
type DeliveryBlocked = { outcome: "blocked"; reason: AttentionReason | "delivery_begin_stale" };
type Begun = DeliveryBegin;
type Options<Request extends object> = { repository: DeliveryKernelRepository;
  registry: ProviderAdapterRegistry<Request>; prepareRequest(intent: DeliveryIntentV2, payload: unknown): {
    request: Request; operation: DeliveryIntentV2["operation"];
    presentationDigest: string; targetDigest: string } | Promise<{
    request: Request; operation: DeliveryIntentV2["operation"];
    presentationDigest: string; targetDigest: string }>; timeoutMs?: number };

export class ProviderSideEffectKernel<Request extends object> {
  readonly #options: Options<Request>;
  constructor(options: Options<Request>) { this.#options = { ...options, timeoutMs: options.timeoutMs ?? 30_000 }; }
  async enqueue(intent: DeliveryIntentV2, payload: unknown) {
    await this.#options.repository.recordIntent(intent, payload); return { outcome: "queued" as const };
  }
  async deliverNext(): Promise<DeliverySettlement | DeliveryBlocked | null> {
    const { repository, registry, prepareRequest } = this.#options;
    const claimed = await repository.claimNext(); if (!claimed) return null;
    const claim = await repository.renewLease(claimed);
    if (!claim) return { outcome: "blocked", reason: "delivery_begin_stale" };
    let stored;
    try { stored = await repository.getIntent(claim); }
    catch { return this.#attention(claim, undefined, "delivery_request_preparation_failed"); }
    if (!stored) return this.#attention(claim, undefined, "delivery_request_preparation_failed");
    if (stored.outcome === "custody_unavailable") return this.#attention(claim, undefined, "delivery_payload_custody_unavailable");
    const binding = stored.intent.providerBinding;
    if (stored.journalIntentDigest !== claim.journalIntentDigest)
      return this.#attention(claim, stored.intent, "delivery_request_digest_mismatch");
    if (stored.intent.organizationId !== claim.organizationId
      || binding.providerId !== claim.providerId || binding.providerInstanceId !== claim.providerInstanceId
      || binding.bindingDigest !== claim.providerBindingDigest
      || binding.providerConfigGeneration !== claim.providerConfigGeneration
      || binding.providerConfigGenerationDigest !== claim.providerConfigGenerationDigest
      || stored.intent.authoritySnapshotDigest !== claim.authoritySnapshotDigest)
      return this.#attention(claim, stored.intent, "provider_binding_mismatch");
    const adapter = registry.resolve({ organizationId: stored.intent.organizationId, binding });
    if (!adapter) return this.#attention(claim, stored.intent, "provider_adapter_not_registered");
    let prepared: Awaited<ReturnType<Options<Request>["prepareRequest"]>>;
    try { prepared = await prepareRequest(stored.intent, stored.persistedPayload); }
    catch { return this.#attention(claim, stored.intent, "delivery_request_preparation_failed"); }
    if (prepared.operation !== stored.intent.operation
      || prepared.presentationDigest !== stored.intent.presentationDigest
      || prepared.targetDigest !== stored.intent.targetDigest)
      return this.#attention(claim, stored.intent, "delivery_request_digest_mismatch");
    const begun = await this.#begin(claim, stored.intent);
    if (!begun) return { outcome: "blocked", reason: "delivery_begin_stale" };
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new DeliveryTimeoutError()); }, this.#options.timeoutMs); });
      const result = await Promise.race([adapter.deliver({ request: prepared.request,
        intent: stored.intent, signal: controller.signal }), timeout]);
      if (result.outcome !== "outcome_unknown") return this.#settle(begun, result);
      const reconciled = await this.#reconcile(adapter, stored.intent, prepared.request);
      return this.#settle(begun, reconciled?.outcome === "accepted" ? reconciled : result);
    } catch (error) {
      const ambiguous = { outcome: "outcome_unknown" as const,
        evidenceDigest: error instanceof DeliveryTimeoutError
          ? "sha256:eb73b0d832e8a2f9c8224e4203725d771be8aae6407b5a2a30ff552ad384fb81"
          : "sha256:288f18790debd9a2eb07dd54196c2f80ef1ddacc43df02ee1d3a3893bed30ab6",
        errorCode: error instanceof DeliveryTimeoutError
          ? "provider_delivery_timeout" as const : "provider_delivery_exception" as const };
      const reconciled = await this.#reconcile(adapter, stored.intent, prepared.request);
      return this.#settle(begun, reconciled?.outcome === "accepted" ? reconciled : ambiguous);
    } finally { if (timer) clearTimeout(timer); }
  }
  async recoverStrandedBegun(input: { before: string; evidenceDigest: string; outcomeRecordedAt?: string }) {
    return this.#options.repository.finalizeStrandedBegun(input);
  }
  async #attention(claim: DeliveryClaim, intent: DeliveryIntentV2 | undefined, reason: AttentionReason) {
    const begun = await this.#begin(claim, intent);
    if (!begun) return { outcome: "blocked", reason: "delivery_begin_stale" } as const;
    const settled = await this.#settle(begun, { outcome: "attention",
      evidenceDigest: ATTENTION_EVIDENCE[reason], errorCode: reason });
    return settled.outcome === "attention" ? { outcome: "blocked", reason } as const : settled;
  }
  #begin(claim: DeliveryClaim, intent?: DeliveryIntentV2) {
    return this.#options.repository.markBegin({ ...claim, ...deriveBeginMarkers(claim, intent) });
  }
  #settle(claim: Begun, result: ProviderDeliveryResult) {
    return this.#options.repository.settleOrReadTerminal({ ...claim,
      ...normalizeProviderResult(claim.providerId, claim.providerInstanceId, result) });
  }
  async #reconcile(adapter: ReturnType<ProviderAdapterRegistry<Request>["resolve"]>,
    intent: DeliveryIntentV2, request: Request): Promise<ProviderDeliveryResult | null> {
    if (!adapter) return null;
    try { return await adapter.reconcile({ intent, request }); } catch { return null; }
  }
}

class DeliveryTimeoutError extends Error {}
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ERROR_CODES = new Set<string>(DELIVERY_ERROR_CODES);
function normalizeProviderResult(_providerId: string, _providerInstanceId: string,
  result: ProviderDeliveryResult): Pick<DeliverySettlement, "outcome" | "evidenceDigest" | "errorCode" | "externalResourceDigest" | "externalResourceId"> {
  if (!SHA256.test(result.evidenceDigest)) return invalidProviderResult();
  const errorCode = result.errorCode && ERROR_CODES.has(result.errorCode)
    ? result.errorCode as DeliveryErrorCode : undefined;
  if (result.errorCode && !errorCode) return invalidProviderResult();
  if (result.outcome !== "accepted") return errorCode
    ? { outcome: result.outcome, evidenceDigest: result.evidenceDigest, errorCode }
    : invalidProviderResult();
  if (errorCode) return invalidProviderResult();
  if (!result.externalResourceId && !("externalResourceDigest" in result))
    return { outcome: "accepted", evidenceDigest: result.evidenceDigest };
  const externalResourceDigest = "externalResourceDigest" in result
    && typeof result.externalResourceDigest === "string" && SHA256.test(result.externalResourceDigest)
    ? result.externalResourceDigest : undefined;
  if (!result.externalResourceId || !externalResourceDigest) return invalidProviderResult();
  return { outcome: "accepted", evidenceDigest: result.evidenceDigest,
    externalResourceId: result.externalResourceId, externalResourceDigest };
}
function deriveBeginMarkers(claim: DeliveryClaim, intent?: DeliveryIntentV2) {
  const tuple = { ...claim, sideEffectIntentId: intent?.sideEffectIntentId ?? claim.intentId,
    scope: intent?.scope ?? { kind: "journal_unavailable", id: claim.intentId },
    installationId: intent && "installationId" in intent ? intent.installationId : claim.runtimeOwnerId,
    ...(intent ? { providerBinding: intent.providerBinding } : {}) };
  const installationBeginMarkerDigest = digest(domainSeparatedCanonicalBytes("opentag.delivery.begin.installation.v1", tuple));
  const scopeBeginMarkerDigest = digest(domainSeparatedCanonicalBytes("opentag.delivery.begin.scope.v1", tuple));
  return { installationBeginMarkerId: `installation_begin_${installationBeginMarkerDigest.slice(7, 39)}`,
    installationBeginMarkerDigest, scopeBeginMarkerId: `scope_begin_${scopeBeginMarkerDigest.slice(7, 39)}`,
    scopeBeginMarkerDigest };
}
function digest(bytes: string | Uint8Array) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function invalidProviderResult() { return { outcome: "outcome_unknown" as const,
  evidenceDigest: "sha256:f88c1a5749548ef9462fe990a59c02db0d11c1494c5ea58a89fd46808ceee79b",
  errorCode: "provider_result_invalid" as const }; }
