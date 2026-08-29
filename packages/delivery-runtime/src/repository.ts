import type { DeliveryIntentV2 } from "@opentag/delivery-contract";

export type Awaitable<T> = T | Promise<T>;
export type DeliveryOutcome = "accepted" | "rejected" | "outcome_unknown" | "attention";
export type DeliveryErrorCode =
  | "provider_adapter_not_registered" | "delivery_request_preparation_failed"
  | "delivery_request_digest_mismatch" | "delivery_payload_custody_unavailable"
  | "provider_binding_mismatch" | "invalid_delivery_shape" | "provider_5xx"
  | "malformed_response" | "slack_rejected" | "provider_delivery_timeout"
  | "provider_delivery_exception" | "provider_result_invalid"
  | "delivery_settlement_stale" | "delivery_restart_after_begin"
  | "delivery_deadline_exceeded" | "delivery_superseded";

export const DELIVERY_ERROR_CODES: readonly DeliveryErrorCode[] = [
  "provider_adapter_not_registered", "delivery_request_preparation_failed",
  "delivery_request_digest_mismatch", "delivery_payload_custody_unavailable",
  "provider_binding_mismatch", "invalid_delivery_shape", "provider_5xx",
  "malformed_response", "slack_rejected", "provider_delivery_timeout",
  "provider_delivery_exception", "provider_result_invalid", "delivery_settlement_stale",
  "delivery_restart_after_begin", "delivery_deadline_exceeded", "delivery_superseded",
];

export type ExpectedDeliveryOwner = { providerId: string; providerInstanceId: string;
  providerBindingDigest: string; providerConfigGeneration: number;
  providerConfigGenerationDigest: string; runtimeOwnerId: string;
  runtimeGeneration: number; schemaGeneration: number };
export type DeliveryClaim = ExpectedDeliveryOwner & { attemptId: string; intentId: string;
  sequence: number; leaseFence: string; revision: number;
  authoritySnapshotDigest: string; journalIntentDigest: string };
export type DeliveryBegin = DeliveryClaim & { installationBeginMarkerId: string;
  installationBeginMarkerDigest: string; scopeBeginMarkerId: string; scopeBeginMarkerDigest: string };
export type DeliverySettlementInput = DeliveryBegin & { outcome: DeliveryOutcome;
  evidenceDigest: string; errorCode?: DeliveryErrorCode; externalResourceDigest?: string;
  externalResourceId?: string; outcomeRecordedAt?: string };
export type DeliverySettlement = Omit<DeliverySettlementInput, "outcomeRecordedAt">;
export type StoredDeliveryIntent = { outcome: "hydrated"; intent: DeliveryIntentV2;
  journalIntentDigest: string; persistedPayload: unknown }
  | { outcome: "custody_unavailable"; journalIntentDigest: string };

export interface DeliveryKernelRepository {
  recordIntent(intent: DeliveryIntentV2, payload: unknown): Awaitable<void>;
  claimNext(): Awaitable<DeliveryClaim | null>;
  renewLease(claim: DeliveryClaim): Awaitable<DeliveryClaim | null>;
  getIntent(claim: DeliveryClaim): Awaitable<StoredDeliveryIntent | null>;
  releaseUnusedClaim(claim: DeliveryClaim): Awaitable<boolean>;
  markBegin(input: DeliveryBegin): Awaitable<DeliveryBegin | null>;
  settleOrReadTerminal(input: DeliverySettlementInput): Awaitable<DeliverySettlement>;
  finalizeStrandedBegun(input: { before: string; evidenceDigest: string;
    outcomeRecordedAt?: string }): Awaitable<number>;
  findAcceptedExternalResource(input: { intent: DeliveryIntentV2; statusMessageId: string }): Awaitable<
    { outcome: "none" | "ambiguous" } |
    { outcome: "exact"; externalResourceId: string; externalResourceDigest: string }>;
}
