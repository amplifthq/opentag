import type { DeliveryIntentV2, DeliveryBegin, DeliveryClaim,
  DeliveryExternalResourceLookupDescriptor, DeliverySettlement, DeliverySettlementInput, ExternalResourceObservation,
  StoredDeliveryIntent } from "@opentag/delivery-contract";
export { DELIVERY_ERROR_CODES } from "@opentag/delivery-contract";
export type { DeliveryBegin, DeliveryClaim, DeliveryErrorCode, DeliveryOutcome,
  DeliverySettlement, DeliverySettlementInput, ExpectedDeliveryOwner,
  ExternalResourceObservation, StoredDeliveryIntent } from "@opentag/delivery-contract";

export type Awaitable<T> = T | Promise<T>;
export type DeliveryClaimAuthority = { organizationId: string; appId: string;
  appInstanceId: string; bindingDigest: string; credentialGeneration: number;
  credentialGenerationDigest: string };
export interface DeliveryKernelRepository {
  recordIntent(intent: DeliveryIntentV2, payload: unknown): Awaitable<void>;
  claimNext(input?: { authorities?: readonly DeliveryClaimAuthority[] }): Awaitable<DeliveryClaim | null>;
  renewLease(claim: DeliveryClaim): Awaitable<DeliveryClaim | null>;
  getIntent(claim: DeliveryClaim): Awaitable<StoredDeliveryIntent | null>;
  releaseUnusedClaim(claim: DeliveryClaim): Awaitable<boolean>;
  markBegin(input: DeliveryBegin): Awaitable<DeliveryBegin | null>;
  settleOrReadTerminal(input: DeliverySettlementInput): Awaitable<DeliverySettlement>;
  finalizeStrandedBegun(input: { before: string; evidenceDigest: string;
    outcomeRecordedAt?: string }): Awaitable<number>;
  findAcceptedExternalResource(input: DeliveryExternalResourceLookupDescriptor): Awaitable<ExternalResourceObservation>;
}
