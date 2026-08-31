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
export type ExpectedDeliveryOwner = { organizationId: string; providerId: string; providerInstanceId: string;
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
export type DeliveryExternalResourceLookupDescriptor = {
  organizationId: string; operation: "create"; runId: string;
  scopeKind: string; scopeId: string; statusMessageId: string; targetDigest: string;
  providerId: string; providerInstanceId: string; providerBindingDigest: string;
  providerPrincipalDigest: string; principalAssurance: "provider_verified" | "configured_declared";
  providerConfigGeneration: number; providerConfigGenerationDigest: string;
  authoritySnapshotDigest: string; authorityLineageDigest: string;
  repositoryIdentityDigest: string; connectionId: string | null; connectionIdDigest: string | null;
  runtimeOwnerId: string; runtimeGeneration: number; schemaGeneration: number;
};
export type DeliveryCurrentTruthDescriptor = Omit<DeliveryExternalResourceLookupDescriptor,
  "operation" | "statusMessageId" | "authorityLineageDigest" | "repositoryIdentityDigest"> & {
    operation: "create" | "update" | "control_reply"; statusMessageId: string | null;
    authorityLineageDigest: string | null; repositoryIdentityDigest: string | null;
    projectionRevision: number | null; projectionEventSequence:number };
export type DeliveryPayloadEnvelope<Request = unknown> = { envelopeVersion: 1;
  providerRequest: Request; phase: "received" | "running" | "terminal";
  frozenDeadline: string; currentTruth: DeliveryCurrentTruthDescriptor };

export function deliveryCurrentTruthDescriptor(input: {
  intent: import("./contracts.js").DeliveryIntentV2; owner: ExpectedDeliveryOwner;
}): DeliveryCurrentTruthDescriptor {
  const { intent, owner } = input; const binding = intent.providerBinding;
  if (owner.organizationId !== intent.organizationId || owner.providerId !== binding.providerId
    || owner.providerInstanceId !== binding.providerInstanceId
    || owner.providerBindingDigest !== binding.bindingDigest
    || owner.providerConfigGeneration !== binding.providerConfigGeneration
    || owner.providerConfigGenerationDigest !== binding.providerConfigGenerationDigest)
    throw new Error("delivery current-truth owner mismatch");
  return { organizationId: intent.organizationId, operation: intent.operation,
    runId: intent.provenance.kind === "business" ? intent.provenance.runId : "",
    scopeKind: intent.scope.kind, scopeId: intent.scope.id,
    statusMessageId: "statusMessageId" in intent ? intent.statusMessageId ?? null : null,
    targetDigest: intent.targetDigest, providerId: binding.providerId,
    providerInstanceId: binding.providerInstanceId, providerBindingDigest: binding.bindingDigest,
    providerPrincipalDigest: binding.providerPrincipalDigest,
    principalAssurance: binding.principalAssurance,
    providerConfigGeneration: binding.providerConfigGeneration,
    providerConfigGenerationDigest: binding.providerConfigGenerationDigest,
    authoritySnapshotDigest: intent.authoritySnapshotDigest,
    authorityLineageDigest: intent.provenance.kind === "business"
      ? intent.provenance.authorityLineageDigest : null,
    repositoryIdentityDigest: intent.provenance.kind === "business"
      ? intent.provenance.repositoryIdentityDigest : null,
    connectionId: binding.connectionId ?? null, connectionIdDigest: binding.connectionIdDigest ?? null,
    runtimeOwnerId: owner.runtimeOwnerId, runtimeGeneration: owner.runtimeGeneration,
    schemaGeneration: owner.schemaGeneration,
    projectionRevision: "projectionRevision" in intent ? intent.projectionRevision ?? null : null,
    projectionEventSequence:"projectionEventSequence" in intent ? intent.projectionEventSequence??0:0 };
}

export function deliveryExternalResourceLookupDescriptor(input: {
  intent: import("./contracts.js").DeliveryIntentV2; statusMessageId: string;
  owner: ExpectedDeliveryOwner;
}): DeliveryExternalResourceLookupDescriptor {
  const current = deliveryCurrentTruthDescriptor(input);
  if (input.intent.provenance.kind !== "business" || input.intent.operation !== "create")
    throw new Error("external resource lookup requires business create intent");
  return { ...current, operation: "create", statusMessageId: input.statusMessageId,
    authorityLineageDigest: input.intent.provenance.authorityLineageDigest,
    repositoryIdentityDigest: input.intent.provenance.repositoryIdentityDigest };
}

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
