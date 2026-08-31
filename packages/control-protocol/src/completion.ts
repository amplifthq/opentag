import { z } from "zod";

const CANONICAL_UTC_MILLIS_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u;

/** Reject UTF-16 surrogate code units that cannot be encoded as UTF-8. */
export function isWellFormedUnicodeString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export const WellFormedUnicodeStringSchema = z.string().refine(isWellFormedUnicodeString, {
  message: "Value must be a well-formed Unicode string.",
});

export const WellFormedNonEmptyUnicodeStringSchema = z.string().min(1).refine(isWellFormedUnicodeString, {
  message: "Value must be a well-formed Unicode string.",
});

/** Unicode scalar lexicographic order, equivalent to UTF-8 `COLLATE \"C\"`. */
export function compareWellFormedUnicodeStrings(left: string, right: string): number {
  if (!isWellFormedUnicodeString(left) || !isWellFormedUnicodeString(right)) {
    throw new TypeError("Canonical Unicode ordering requires well-formed strings.");
  }
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export function sortWellFormedUnicodeStrings(values: readonly string[]): string[] {
  if (values.some((value) => !isWellFormedUnicodeString(value))) {
    throw new TypeError("Canonical Unicode ordering requires well-formed strings.");
  }
  return [...values].sort(compareWellFormedUnicodeStrings);
}

export function isCanonicalUtcMillisTimestamp(value: string): boolean {
  const match = CANONICAL_UTC_MILLIS_PATTERN.exec(value);
  if (!match || match[1]! < "0001") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export const CanonicalUtcMillisTimestampSchema = z.string().refine(isCanonicalUtcMillisTimestamp, {
  message: "Timestamp must be a real canonical UTC instant with exactly millisecond precision.",
});

export const CompletionAssessmentStateSchema = z.enum([
  "pending",
  "satisfied",
  "unsatisfied",
  "blocked",
  "waived",
]);

export const CompletionGateResultStateSchema = z.enum([
  "passed",
  "failed",
  "missing",
  "unknown",
  "waived",
]);

export const CompletionReasonCodeSchema = z.enum([
  "artifact_requirement_satisfied",
  "artifact_missing",
  "artifact_ambiguous",
  "verification_passed",
  "verification_failed",
  "verification_missing",
  "verification_assurance_insufficient",
  "verification_subject_mismatch",
  "verification_stale",
  "external_state_satisfied",
  "external_state_mismatch",
  "external_state_missing",
  "external_state_assurance_insufficient",
  "external_state_subject_mismatch",
  "external_state_stale",
  "material_action_succeeded",
  "material_action_failed",
  "material_action_unknown",
  "material_action_missing",
  "human_acceptance_recorded",
  "human_acceptance_missing",
  "gate_waived",
  "waiver_invalid",
  "execution_succeeded",
  "execution_incomplete",
  "execution_not_succeeded",
]);

export const ProposalReadinessStateSchema = z.enum([
  "pending",
  "blocked",
  "proposal_ready",
  "publication_pending",
]);

export const ProposalReadinessReasonCodeSchema = z.enum([
  "execution_not_succeeded",
  "publication_candidate_missing",
  "verification_missing",
  "publication_policy_mismatch",
  "completion_contract_mismatch",
  "material_action_unknown",
  "proposal_ready",
  "publication_evidence_missing",
]);

export const ProposalReadinessAssessmentSchema = z.object({
  state: ProposalReadinessStateSchema,
  accepted: z.boolean(),
  candidateId: WellFormedNonEmptyUnicodeStringSchema.optional(),
  reasonCodes: z.array(ProposalReadinessReasonCodeSchema).min(1),
  assessedAt: CanonicalUtcMillisTimestampSchema,
}).strict().superRefine((assessment, ctx) => {
  if (assessment.accepted !== (assessment.state === "proposal_ready")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["accepted"],
      message: "Only proposal_ready is an accepted proposal assessment." });
  }
  if ((assessment.state === "proposal_ready" || assessment.state === "publication_pending")
    !== Boolean(assessment.candidateId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["candidateId"],
      message: "Candidate identity is required exactly for candidate-backed projections." });
  }
});

export type ProposalReadinessAssessment = z.infer<typeof ProposalReadinessAssessmentSchema>;
export type ProposalReadinessReasonCode = z.infer<typeof ProposalReadinessReasonCodeSchema>;

type CompletionGateResultState = z.infer<typeof CompletionGateResultStateSchema>;
type CompletionAssessmentState = z.infer<typeof CompletionAssessmentStateSchema>;
type CompletionReasonCode = z.infer<typeof CompletionReasonCodeSchema>;

export const COMPLETION_REASON_ALLOWED_GATE_STATES = Object.freeze({
  artifact_requirement_satisfied: ["passed"],
  artifact_missing: ["missing"],
  artifact_ambiguous: ["unknown"],
  verification_passed: ["passed"],
  verification_failed: ["failed"],
  verification_missing: ["missing"],
  verification_assurance_insufficient: ["unknown"],
  verification_subject_mismatch: ["unknown"],
  verification_stale: ["missing"],
  external_state_satisfied: ["passed"],
  external_state_mismatch: ["failed"],
  external_state_missing: ["missing"],
  external_state_assurance_insufficient: ["unknown"],
  external_state_subject_mismatch: ["unknown"],
  external_state_stale: ["missing"],
  material_action_succeeded: ["passed"],
  material_action_failed: ["failed"],
  material_action_unknown: ["unknown"],
  material_action_missing: ["missing"],
  human_acceptance_recorded: ["passed"],
  human_acceptance_missing: ["missing", "unknown"],
  gate_waived: ["waived"],
  waiver_invalid: ["unknown"],
  execution_succeeded: ["passed"],
  execution_incomplete: ["missing"],
  execution_not_succeeded: ["failed"],
} as const satisfies Record<CompletionReasonCode, readonly CompletionGateResultState[]>);

export function reduceCompletionGateStates(
  states: readonly (CompletionGateResultState | CompletionAssessmentState)[],
): CompletionAssessmentState {
  if (states.some((state) => state === "unknown" || state === "blocked")) return "blocked";
  if (states.some((state) => state === "failed" || state === "unsatisfied")) return "unsatisfied";
  if (states.some((state) => state === "missing" || state === "pending")) return "pending";
  if (states.some((state) => state === "waived")) return "waived";
  return "satisfied";
}
