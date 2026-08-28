import { z } from "zod";

const DeliveryEvidenceDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const ProviderDeliveryResultSchema = z
  .object({
    outcome: z.enum(["accepted", "rejected", "outcome_unknown", "attention"]),
    evidenceDigest: DeliveryEvidenceDigestSchema,
    externalResourceId: z.string().trim().min(1).optional(),
    errorCode: z.string().trim().min(1).optional()
  })
  .strict();

export type ProviderDeliveryResult = z.infer<typeof ProviderDeliveryResultSchema>;
