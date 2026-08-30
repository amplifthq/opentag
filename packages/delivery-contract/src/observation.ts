import { z } from "zod";

const DeliveryEvidenceDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const DELIVERY_ERROR_CODES = ["provider_adapter_not_registered",
  "delivery_request_preparation_failed", "delivery_request_digest_mismatch",
  "delivery_payload_custody_unavailable", "provider_binding_mismatch",
  "invalid_delivery_shape", "provider_5xx", "malformed_response", "slack_rejected",
  "ambiguous_response", "deadline_exceeded", "transport_error",
  "provider_delivery_timeout", "provider_delivery_exception", "provider_result_invalid",
  "delivery_settlement_stale", "delivery_restart_after_begin",
  "delivery_deadline_exceeded", "delivery_superseded"] as const;
export type DeliveryErrorCode = typeof DELIVERY_ERROR_CODES[number];
export type DeliveryOutcome = "accepted" | "rejected" | "outcome_unknown" | "attention";
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
export type ExternalResourceObservation = { outcome: "none" | "ambiguous" }
  | { outcome: "exact"; externalResourceId: string; externalResourceDigest: string };
export type StoredDeliveryIntent = { outcome: "hydrated"; intent: import("./contracts.js").DeliveryIntentV2;
  journalIntentDigest: string; persistedPayload: unknown }
  | { outcome: "custody_unavailable"; journalIntentDigest: string };
export type DeliveryPayloadEnvelope<Request = unknown> = { envelopeVersion: 1;
  providerRequest: Request; phase: "received" | "running" | "terminal";
  frozenDeadline: string; currentTruth: { runId: string; scopeKind: string; scopeId: string;
    targetDigest: string; providerInstanceId: string; statusMessageId: string | null;
    runtimeOwnerId: string; runtimeGeneration: number; schemaGeneration: number;
    providerConfigGeneration: number; providerConfigGenerationDigest: string } };

export const ProviderDeliveryResultSchema = z
  .object({
    outcome: z.enum(["accepted", "rejected", "outcome_unknown", "attention"]),
    evidenceDigest: DeliveryEvidenceDigestSchema,
    externalResourceId: z.string().trim().min(1).optional(),
    externalResourceDigest: DeliveryEvidenceDigestSchema.optional(),
    errorCode: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.externalResourceId === undefined) !== (value.externalResourceDigest === undefined)
      || (value.externalResourceId !== undefined && value.outcome !== "accepted")) {
      context.addIssue({ code: "custom", message: "external resource identity requires an accepted id/digest pair" });
    }
  });

export type ProviderDeliveryResult = z.infer<typeof ProviderDeliveryResultSchema>;
