import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import { isCredentialSafeText } from "./credential-safety.js";
import {
  CanonicalUtcMillisTimestampSchema,
  compareWellFormedUnicodeStrings,
} from "./completion.js";

export {
  COMPLETION_REASON_ALLOWED_GATE_STATES,
  CanonicalUtcMillisTimestampSchema,
  compareWellFormedUnicodeStrings,
  CompletionAssessmentStateSchema,
  CompletionGateResultStateSchema,
  CompletionReasonCodeSchema,
  isCanonicalUtcMillisTimestamp,
  isWellFormedUnicodeString,
  ProposalReadinessAssessmentSchema,
  reduceCompletionGateStates,
  sortWellFormedUnicodeStrings,
  WellFormedNonEmptyUnicodeStringSchema,
  WellFormedUnicodeStringSchema,
} from "./completion.js";
export { canonicalJsonStringify } from "./canonical-json.js";

export const CONTROL_SCHEMA_VERSION = 1 as const;
export const CONTROL_PROTOCOL_VERSION = "1.0" as const;
export const CONTROL_CAPABILITY_REGISTRY_VERSION = "opentag.control.capabilities/v1" as const;

export const ControlSchemaVersionSchema = z.literal(CONTROL_SCHEMA_VERSION);
export const ControlProtocolVersionSchema = z.literal(CONTROL_PROTOCOL_VERSION);
export const ControlCapabilityRegistryVersionSchema = z.literal(CONTROL_CAPABILITY_REGISTRY_VERSION);

export const RelayCapabilitySchema = z.enum([
  "relay.registration.v1",
  "relay.credential-reprovision.v1",
  "relay.credential-rotation.v1",
  "relay.readiness.v1",
  "relay.repository-binding.v1",
  "relay.hosted-admission.v1",
  "relay.hosted-claim.v1",
  "relay.source-content-redeem.v1",
  "relay.claim-fence.v1",
  "relay.lifecycle.v1",
  "relay.permission.v1",
  "relay.material-receipt.v1",
  "relay.effect-authority.v1",
  "relay.cancel-resume.v1",
  "relay.follow-up.v1",
]);

const compareUnicodeCodePoints = compareWellFormedUnicodeStrings;

function sortedUniqueArray<T extends z.ZodType<string>>(item: T) {
  return z.array(item).superRefine((values, ctx) => {
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1];
      const current = values[index];
      if (previous === undefined || current === undefined) continue;
      if (compareUnicodeCodePoints(previous, current) >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: "Values must be sorted by Unicode code point and contain no duplicates.",
        });
      }
    }
  });
}

export const RequiredRelayCapabilitiesSchema = sortedUniqueArray(RelayCapabilitySchema).min(1);
export const RelayCapabilitiesSchema = sortedUniqueArray(RelayCapabilitySchema);
export const ReceiptDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const ControlTimestampSchema = CanonicalUtcMillisTimestampSchema;
export const WorkerReleaseShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
export const WorkerReleaseIdentitySchema = z.union([z.literal("local"), WorkerReleaseShaSchema]);
export const NpmPackageVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u,
  );

const UnpaddedNonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), "Value must not contain leading or trailing whitespace.");
const NonEmptyIdSchema = UnpaddedNonEmptyStringSchema;
const DigestSetSchema = sortedUniqueArray(ReceiptDigestSchema);

export const RunnerReadinessReasonCodeV1Schema = z.enum([
  "credential_unavailable",
  "executor_unavailable",
  "registration_stale",
  "target_binding_stale",
  "target_unavailable",
]);

const GitHubTargetSegmentV1Schema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u)
  .refine(
    (value) => value !== "." && value !== "..",
    "GitHub target segment cannot be a dot segment.",
  );

export const PermissionResolutionReasonCodeV1Schema = z.enum([
  "human_approval_required",
  "human_approved",
  "human_denied",
  "attempt_stale",
  "policy_stale",
]);

export const PermissionDecisionV1Schema = z.enum(["allow_once", "deny"]);
export const PermissionResolutionStateV1Schema = z.enum([
  "waiting",
  "authorized",
  "denied",
  "stale",
]);

export const PermissionStableIdV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine(isCredentialSafeText, "Stable ID must not contain credential-like data.");

export const PermissionActionFamilyV1Schema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{0,63}$/u)
  .refine(isCredentialSafeText, "Action family must not contain credential-like data.");

export const PermissionActionDescriptorV1Schema = z.enum([
  "workspace.read", "workspace.write", "command.execute", "git.read",
  "git.push", "git.force_push", "git.target_write",
  "github.pull_request.create", "github.pull_request.update",
  "github.pull_request.merge", "github.release.create", "github.branch.delete",
]);
export const HOSTED_PUBLICATION_ACTION_CAPABILITIES_V1 = [
  "git.push", "git.force_push", "git.target_write",
  "github.pull_request.create", "github.pull_request.update",
  "github.pull_request.merge", "github.release.create", "github.branch.delete",
] as const;

export const PermissionScopeV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]{0,63}:[a-z][a-z0-9._-]{0,62}$/u)
  .refine(isCredentialSafeText, "Permission scope must not contain credential-like data.");

export const PermissionScopesV1Schema = sortedUniqueArray(PermissionScopeV1Schema).min(1).max(32);

export const MaterialActionStableIdV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine(isCredentialSafeText, "Stable ID must not contain credential-like data.");

export const MaterialActionNormalizedNameV1Schema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{0,63}$/u)
  .refine(isCredentialSafeText, "Normalized name must not contain credential-like data.");

export const EffectKindV1Schema = z.literal("github.create_draft_pull_request");
export const EffectStateV1Schema = z.enum([
  "requested",
  "authorized",
  "permit_issued",
  "observing",
  "outcome_unknown",
  "retry_eligible",
  "succeeded",
  "attention",
  "cancelled_before_permit",
]);

const EffectRunIdV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .refine((value) => value !== "." && value !== ".." && !value.endsWith(".lock"))
  .refine(isCredentialSafeText, "Effect Run ID must not contain credential-like data.");

function isConservativeGitBranchRef(value: string): boolean {
  if (value === "@" || value.startsWith("/") || value.endsWith("/")
    || value.endsWith(".") || value.includes("//") || value.includes("..")
    || value.includes("@{")) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)) return false;
  return value.split("/").every((component) => component.length > 0
    && !component.startsWith(".") && !component.endsWith(".lock"));
}

export const GitBranchRefV1Schema = z
  .string()
  .min(1)
  .max(255)
  .refine(isConservativeGitBranchRef, "Value must be a conservative Git branch ref.")
  .refine(isCredentialSafeText, "Git branch ref must not contain credential-like data.");

const GitRemoteNameV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine(isCredentialSafeText, "Git remote must not contain credential-like data.");

const EffectGitHubTargetSegmentV1Schema = GitHubTargetSegmentV1Schema.refine(
  isCredentialSafeText,
  "GitHub target segment must not contain credential-like data.",
);

export const EffectWorkAuthorityV1Schema = z.object({
  runId: EffectRunIdV1Schema,
  attemptId: MaterialActionStableIdV1Schema,
  attemptNumber: z.number().int().positive(),
  epoch: z.number().int().positive(),
  fencingToken: z.string().min(1).max(4096),
  fencingTokenDigest: ReceiptDigestSchema,
}).strict().refine((work) => work.epoch === work.attemptNumber, {
  path: ["epoch"],
  message: "Effect Work epoch must equal its Attempt number.",
});

export const GitHubDraftPullRequestEffectTargetV1Schema = z.object({
  projectTargetId: MaterialActionStableIdV1Schema,
  targetBindingDigest: ReceiptDigestSchema,
  targetBindingGeneration: z.number().int().positive(),
  provider: z.literal("github"),
  owner: EffectGitHubTargetSegmentV1Schema,
  repo: EffectGitHubTargetSegmentV1Schema,
  remote: GitRemoteNameV1Schema,
  baseBranch: GitBranchRefV1Schema,
  branch: GitBranchRefV1Schema,
  frozenBaseRevision: z.string().regex(/^[a-f0-9]{40,64}$/u),
  workspaceTreeDigest: z.string().regex(/^[a-f0-9]{40,64}$/u),
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
}).strict().refine((target) => target.branch !== target.baseBranch, {
  path: ["branch"],
  message: "Effect publication branch must not equal its base branch.",
});

export const EffectRequestAuthorityV1Schema = z.object({
  approvalPolicy: z.literal("human_approval_required"),
  policySnapshotId: MaterialActionStableIdV1Schema,
  policySnapshotDigest: ReceiptDigestSchema,
  approvalRequestId: MaterialActionStableIdV1Schema,
  approvalExpiresAt: ControlTimestampSchema,
}).strict();

const EffectRequestDigestInputV1BaseSchema = z.object({
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: z.tuple([z.literal("relay.effect-authority.v1")]),
  requestId: MaterialActionStableIdV1Schema,
  effectId: MaterialActionStableIdV1Schema,
  idempotencyKey: MaterialActionStableIdV1Schema,
  organizationId: MaterialActionStableIdV1Schema,
  runnerId: MaterialActionStableIdV1Schema,
  runnerGeneration: z.number().int().positive(),
  work: EffectWorkAuthorityV1Schema,
  effectKind: EffectKindV1Schema,
  candidate: z.object({
    candidateId: MaterialActionStableIdV1Schema,
    candidateDigest: ReceiptDigestSchema,
  }).strict(),
  authority: EffectRequestAuthorityV1Schema,
  target: GitHubDraftPullRequestEffectTargetV1Schema,
  requestedAt: ControlTimestampSchema,
}).strict();

export const EffectRequestDigestInputV1Schema =
  EffectRequestDigestInputV1BaseSchema.superRefine((request, ctx) => {
    if (request.target.branch !== `opentag/${request.work.runId}`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target", "branch"],
        message: "Effect publication branch must be deterministic for the Run.",
      });
    }
    const requestedAt = Date.parse(request.requestedAt);
    const expiresAt = Date.parse(request.authority.approvalExpiresAt);
    if (!(expiresAt > requestedAt) || expiresAt - requestedAt > 24 * 60 * 60_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authority", "approvalExpiresAt"],
        message: "Effect approval window must be positive and no longer than 24 hours.",
      });
    }
  });

export const EffectRequestV1Schema = EffectRequestDigestInputV1BaseSchema.extend({
  requestDigest: ReceiptDigestSchema,
}).strict().superRefine((request, ctx) => {
  if (request.target.branch !== `opentag/${request.work.runId}`) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target", "branch"],
      message: "Effect publication branch must be deterministic for the Run.",
    });
  }
  const requestedAt = Date.parse(request.requestedAt);
  const expiresAt = Date.parse(request.authority.approvalExpiresAt);
  if (!(expiresAt > requestedAt) || expiresAt - requestedAt > 24 * 60 * 60_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authority", "approvalExpiresAt"],
      message: "Effect approval window must be positive and no longer than 24 hours.",
    });
  }
});

const EffectExternalResourceV1Schema = z.object({
  provider: z.literal("github"),
  resourceRef: z.string().regex(/^github_pr_[1-9][0-9]*$/u),
  uri: z.string().url().max(2048).refine(isCredentialSafeText),
}).strict().superRefine((resource, ctx) => {
  const match = /^github_pr_([1-9][0-9]*)$/u.exec(resource.resourceRef);
  let url: URL;
  try {
    url = new URL(resource.uri);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username !== ""
    || url.password !== "" || url.search !== "" || url.hash !== ""
    || !match || !url.pathname.endsWith(`/pull/${match[1]}`)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["uri"],
      message: "GitHub resource URI must be canonical and match its resource reference." });
  }
});

const EffectViewV1BaseSchema = z.object({
  effectId: MaterialActionStableIdV1Schema,
  effectKind: EffectKindV1Schema,
  updatedAt: ControlTimestampSchema,
}).strict();

const EffectViewReasonCodeV1Schema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,127}$/u)
  .refine(isCredentialSafeText);

export const EffectViewV1Schema = z.discriminatedUnion("state", [
  EffectViewV1BaseSchema.extend({
    state: z.literal("requested"),
    currentAttemptNumber: z.literal(0),
  }).strict(),
  EffectViewV1BaseSchema.extend({
    state: z.literal("authorized"),
    currentAttemptNumber: z.literal(0),
  }).strict(),
  EffectViewV1BaseSchema.extend({
    state: z.literal("permit_issued"),
    currentAttemptNumber: z.number().int().positive(),
  }).strict(),
  EffectViewV1BaseSchema.extend({
    state: z.literal("observing"),
    currentAttemptNumber: z.number().int().positive(),
    currentEvidenceDigest: ReceiptDigestSchema,
    externalResource: EffectExternalResourceV1Schema,
  }).strict(),
  EffectViewV1BaseSchema.extend({
    state: z.literal("outcome_unknown"),
    currentAttemptNumber: z.number().int().positive(),
    currentEvidenceDigest: ReceiptDigestSchema,
    externalResource: EffectExternalResourceV1Schema.optional(),
    reasonCode: EffectViewReasonCodeV1Schema,
  }).strict(),
  EffectViewV1BaseSchema.extend({
    state: z.literal("retry_eligible"),
    currentAttemptNumber: z.number().int().positive(),
    currentEvidenceDigest: ReceiptDigestSchema,
    reasonCode: z.literal("local.provider_io_not_begun"),
  }).strict(),
  EffectViewV1BaseSchema.extend({
    state: z.literal("succeeded"),
    currentAttemptNumber: z.number().int().positive(),
    currentEvidenceDigest: ReceiptDigestSchema,
    externalResource: EffectExternalResourceV1Schema,
  }).strict(),
  EffectViewV1BaseSchema.extend({
    state: z.literal("attention"),
    currentAttemptNumber: z.number().int().nonnegative(),
    currentEvidenceDigest: ReceiptDigestSchema.optional(),
    externalResource: EffectExternalResourceV1Schema.optional(),
    reasonCode: EffectViewReasonCodeV1Schema,
  }).strict(),
  EffectViewV1BaseSchema.extend({
    state: z.literal("cancelled_before_permit"),
    currentAttemptNumber: z.literal(0),
    reasonCode: EffectViewReasonCodeV1Schema,
  }).strict(),
]).superRefine((view, ctx) => {
  if (view.state !== "attention") return;
  if (view.currentAttemptNumber === 0
    && (view.currentEvidenceDigest !== undefined || view.externalResource !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["currentAttemptNumber"],
      message: "Pre-permit attention cannot include Effect evidence or an external resource." });
  }
  if (view.externalResource !== undefined && view.currentEvidenceDigest === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["currentEvidenceDigest"],
      message: "An attention view with an external resource requires accepted evidence." });
  }
});

export const EffectAcquireRequestV1Schema = z.object({
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: z.tuple([z.literal("relay.effect-authority.v1")]),
  requestId: MaterialActionStableIdV1Schema,
  organizationId: MaterialActionStableIdV1Schema,
  runnerId: MaterialActionStableIdV1Schema,
  runnerGeneration: z.number().int().positive(),
  acquireJournalDigest: ReceiptDigestSchema,
}).strict();

const EffectPermitDigestInputV1BaseSchema = z.object({
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: z.tuple([z.literal("relay.effect-authority.v1")]),
  permitId: MaterialActionStableIdV1Schema,
  effectId: MaterialActionStableIdV1Schema,
  effectAttemptNumber: z.number().int().positive(),
  organizationId: MaterialActionStableIdV1Schema,
  runnerId: MaterialActionStableIdV1Schema,
  runnerGeneration: z.number().int().positive(),
  acquireRequestId: MaterialActionStableIdV1Schema,
  acquireJournalDigest: ReceiptDigestSchema,
  runId: EffectRunIdV1Schema,
  runAttemptId: MaterialActionStableIdV1Schema,
  runAttemptNumber: z.number().int().positive(),
  fencingTokenDigest: ReceiptDigestSchema,
  effectKind: EffectKindV1Schema,
  requestDigest: ReceiptDigestSchema,
  targetDigest: ReceiptDigestSchema,
  approvalDigest: ReceiptDigestSchema,
  predecessorEvidenceDigest: ReceiptDigestSchema.optional(),
  candidate: z.object({
    candidateId: MaterialActionStableIdV1Schema,
    candidateDigest: ReceiptDigestSchema,
  }).strict(),
  target: GitHubDraftPullRequestEffectTargetV1Schema,
  issuedAt: ControlTimestampSchema,
  expiresAt: ControlTimestampSchema,
}).strict();

function effectPermitWindowValid(permit: {
  issuedAt: string;
  expiresAt: string;
}): boolean {
  const issuedAt = Date.parse(permit.issuedAt);
  const expiresAt = Date.parse(permit.expiresAt);
  return expiresAt > issuedAt && expiresAt - issuedAt <= 5 * 60_000;
}

export const EffectExecutePermitDigestInputV1Schema =
  EffectPermitDigestInputV1BaseSchema.extend({
    permitKind: z.literal("execute"),
  }).strict().refine(effectPermitWindowValid, {
    path: ["expiresAt"],
    message: "Effect permit must be short-lived.",
  });

export const EffectReconciliationPermitDigestInputV1Schema =
  EffectPermitDigestInputV1BaseSchema.extend({
    permitKind: z.literal("reconcile"),
    originalExecutePermitId: MaterialActionStableIdV1Schema,
    observationPolicy: z.literal("github.exact_draft_pr.v1"),
  }).strict().refine(effectPermitWindowValid, {
    path: ["expiresAt"],
    message: "Effect reconciliation permit must be short-lived.",
  });

export const EffectPermitDigestInputV1Schema = z.discriminatedUnion("permitKind", [
  EffectExecutePermitDigestInputV1Schema,
  EffectReconciliationPermitDigestInputV1Schema,
]);

export const EffectExecutePermitV1Schema = EffectExecutePermitDigestInputV1Schema
  .safeExtend({ permitDigest: ReceiptDigestSchema });
export const EffectReconciliationPermitV1Schema = EffectReconciliationPermitDigestInputV1Schema
  .safeExtend({ permitDigest: ReceiptDigestSchema });
export const EffectPermitV1Schema = z.discriminatedUnion("permitKind", [
  EffectExecutePermitV1Schema,
  EffectReconciliationPermitV1Schema,
]);

export const GitHubDraftPullRequestAbsenceScopeV1Schema = z.object({
  provider: z.literal("github"),
  repository: z.object({
    owner: EffectGitHubTargetSegmentV1Schema,
    repo: EffectGitHubTargetSegmentV1Schema,
  }).strict(),
  baseBranch: GitBranchRefV1Schema,
  headBranch: GitBranchRefV1Schema,
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
  bindingGeneration: z.number().int().positive(),
  targetBindingDigest: ReceiptDigestSchema,
  observationPolicy: z.literal("github.exact_draft_pr.v1"),
  observedAt: ControlTimestampSchema,
}).strict();

const GitHubCheckNameV1Schema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
  .refine(isCredentialSafeText, "Check name must not contain credential-like data.");

export const GitHubDraftPullRequestObservationV1Schema = z.object({
  provider: z.literal("github"),
  repository: z.object({
    owner: EffectGitHubTargetSegmentV1Schema,
    repo: EffectGitHubTargetSegmentV1Schema,
  }).strict(),
  remote: GitRemoteNameV1Schema,
  branch: GitBranchRefV1Schema,
  baseBranch: GitBranchRefV1Schema,
  pullRequestNumber: z.number().int().positive(),
  pullRequestResourceRef: z.string().regex(/^github_pr_[1-9][0-9]*$/u),
  pullRequestUrl: z.string().url().max(2048).refine(isCredentialSafeText),
  draft: z.literal(true),
  state: z.enum(["open", "closed", "merged"]),
  headSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
  headBranch: GitBranchRefV1Schema,
  headRepository: z.object({
    owner: EffectGitHubTargetSegmentV1Schema,
    repo: EffectGitHubTargetSegmentV1Schema,
  }).strict(),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
  checks: z.record(GitHubCheckNameV1Schema, z.enum(["passed", "failed", "pending"])),
  checksComplete: z.boolean(),
  observedAt: ControlTimestampSchema,
}).strict().superRefine((observation, ctx) => {
  const expectedResourceRef = `github_pr_${observation.pullRequestNumber}`;
  const expectedUrl = `https://github.com/${observation.repository.owner}/${observation.repository.repo}/pull/${observation.pullRequestNumber}`;
  if (observation.pullRequestResourceRef !== expectedResourceRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pullRequestResourceRef"],
      message: "GitHub pull request resource reference must be canonical." });
  }
  if (observation.pullRequestUrl !== expectedUrl) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pullRequestUrl"],
      message: "GitHub pull request URL must be canonical and credential-free." });
  }
  if (observation.branch !== observation.headBranch) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headBranch"],
      message: "Observed head branch must equal the authorized publication branch." });
  }
  if (observation.repository.owner.toLowerCase() !== observation.headRepository.owner.toLowerCase()
    || observation.repository.repo.toLowerCase() !== observation.headRepository.repo.toLowerCase()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headRepository"],
      message: "Observed head repository must equal the authorized repository." });
  }
});

export const EffectEvidenceV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("not_started"),
    acquireJournalDigest: ReceiptDigestSchema,
    localJournalDigest: ReceiptDigestSchema,
    reason: z.literal("provider_io_not_begun"),
  }).strict(),
  z.object({
    kind: z.literal("present"),
    observation: GitHubDraftPullRequestObservationV1Schema,
  }).strict(),
  z.object({
    kind: z.literal("absent"),
    observationScope: GitHubDraftPullRequestAbsenceScopeV1Schema,
  }).strict(),
  z.object({
    kind: z.literal("ambiguous"),
    errorCode: z.enum([
      "transport_error",
      "provider_timeout",
      "malformed_response",
      "provider_receipt_missing",
    ]),
  }).strict(),
  z.object({
    kind: z.literal("attention"),
    reasonCode: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  }).strict(),
]);

const EffectEvidenceEnvelopeDigestInputV1BaseSchema = z.object({
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: z.tuple([z.literal("relay.effect-authority.v1")]),
  evidenceId: MaterialActionStableIdV1Schema,
  effectId: MaterialActionStableIdV1Schema,
  permitId: MaterialActionStableIdV1Schema,
  effectAttemptNumber: z.number().int().positive(),
  organizationId: MaterialActionStableIdV1Schema,
  producer: z.object({
    kind: z.literal("runner"),
    runnerId: MaterialActionStableIdV1Schema,
    runnerGeneration: z.number().int().positive(),
  }).strict(),
  predecessorEvidenceDigest: ReceiptDigestSchema.optional(),
  observedAt: ControlTimestampSchema,
  evidence: EffectEvidenceV1Schema,
  payloadDigest: ReceiptDigestSchema,
}).strict();

function effectEvidenceObservationTimeMatches(envelope: {
  observedAt: string;
  evidence: z.infer<typeof EffectEvidenceV1Schema>;
}): boolean {
  if (envelope.evidence.kind === "present") {
    return envelope.evidence.observation.observedAt === envelope.observedAt;
  }
  if (envelope.evidence.kind === "absent") {
    return envelope.evidence.observationScope.observedAt === envelope.observedAt;
  }
  return true;
}

export const EffectEvidenceEnvelopeDigestInputV1Schema =
  EffectEvidenceEnvelopeDigestInputV1BaseSchema.refine(effectEvidenceObservationTimeMatches, {
    path: ["observedAt"],
    message: "Effect evidence envelope time must equal its provider observation time.",
  });
export const EffectEvidenceEnvelopeV1Schema =
  EffectEvidenceEnvelopeDigestInputV1BaseSchema.extend({
    evidenceDigest: ReceiptDigestSchema,
  }).strict().refine(effectEvidenceObservationTimeMatches, {
    path: ["observedAt"],
    message: "Effect evidence envelope time must equal its provider observation time.",
  });

export function computeEffectRequestDigestV1(
  request: z.input<typeof EffectRequestDigestInputV1Schema>,
): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(
    EffectRequestDigestInputV1Schema.parse(request),
  ));
}

export function computeEffectFencingTokenDigestV1(rawFencingToken: string): Promise<string> {
  return sha256Utf8V1(rawFencingToken);
}

export function computeEffectTargetDigestV1(
  target: z.input<typeof GitHubDraftPullRequestEffectTargetV1Schema>,
): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(
    GitHubDraftPullRequestEffectTargetV1Schema.parse(target),
  ));
}

export async function verifyEffectRequestV1(
  request: z.input<typeof EffectRequestV1Schema>,
): Promise<boolean> {
  const parsed = EffectRequestV1Schema.parse(request);
  const { requestDigest, ...digestInput } = parsed;
  return requestDigest === await computeEffectRequestDigestV1(digestInput)
    && parsed.work.fencingTokenDigest
      === await computeEffectFencingTokenDigestV1(parsed.work.fencingToken);
}

export function computeEffectPermitDigestV1(
  permit: z.input<typeof EffectPermitDigestInputV1Schema>,
): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(
    EffectPermitDigestInputV1Schema.parse(permit),
  ));
}

export async function verifyEffectPermitV1(
  permit: z.input<typeof EffectPermitV1Schema>,
): Promise<boolean> {
  const parsed = EffectPermitV1Schema.parse(permit);
  const { permitDigest, ...digestInput } = parsed;
  return parsed.targetDigest === await computeEffectTargetDigestV1(parsed.target)
    && permitDigest === await computeEffectPermitDigestV1(digestInput);
}

export function computeEffectEvidencePayloadDigestV1(
  evidence: z.input<typeof EffectEvidenceV1Schema>,
): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(EffectEvidenceV1Schema.parse(evidence)));
}

export function computeEffectEvidenceDigestV1(
  envelope: z.input<typeof EffectEvidenceEnvelopeDigestInputV1Schema>,
): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(
    EffectEvidenceEnvelopeDigestInputV1Schema.parse(envelope),
  ));
}

export async function verifyEffectEvidenceEnvelopeV1(
  envelope: z.input<typeof EffectEvidenceEnvelopeV1Schema>,
): Promise<boolean> {
  const parsed = EffectEvidenceEnvelopeV1Schema.parse(envelope);
  const { evidenceDigest, ...digestInput } = parsed;
  return parsed.payloadDigest === await computeEffectEvidencePayloadDigestV1(parsed.evidence)
    && evidenceDigest === await computeEffectEvidenceDigestV1(digestInput);
}

export type EffectRequestV1 = z.infer<typeof EffectRequestV1Schema>;
export type EffectViewV1 = z.infer<typeof EffectViewV1Schema>;
export type EffectAcquireRequestV1 = z.infer<typeof EffectAcquireRequestV1Schema>;
export type EffectExecutePermitV1 = z.infer<typeof EffectExecutePermitV1Schema>;
export type EffectReconciliationPermitV1 = z.infer<typeof EffectReconciliationPermitV1Schema>;
export type EffectPermitV1 = z.infer<typeof EffectPermitV1Schema>;
export type EffectEvidenceV1 = z.infer<typeof EffectEvidenceV1Schema>;
export type EffectEvidenceEnvelopeV1 = z.infer<typeof EffectEvidenceEnvelopeV1Schema>;

export const MaterialActionExternalUriV1Schema = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:")
        || url.username !== ""
        || url.password !== ""
        || url.search !== ""
        || url.hash !== ""
        || url.toString() !== value
        || !isCredentialSafeText(value)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "External URI must be a canonical sanitized HTTP(S) URL.",
        });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "External URI must be a valid URL." });
    }
  });

export const MaterialActionReasonCodeV1Schema = z.enum([
  "provider_accepted",
  "provider_error",
  "provider_rejected",
  "provider_receipt_missing",
  "provider_timeout",
]);

export const MaterialActionAttemptRefV1Schema = z
  .object({
    attemptId: MaterialActionStableIdV1Schema,
    attemptNumber: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingTokenDigest: ReceiptDigestSchema,
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.epoch !== attempt.attemptNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epoch"],
        message: "Attempt epoch must equal the Run-scoped attempt number.",
      });
    }
  });

export const RunnerMaterialActionReconcileAttemptV1Schema = z
  .object({
    attemptId: MaterialActionStableIdV1Schema,
    attemptNumber: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingToken: z.string().min(1).max(4096),
    fencingTokenDigest: ReceiptDigestSchema,
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.epoch !== attempt.attemptNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epoch"],
        message: "Attempt epoch must equal the Run-scoped attempt number.",
      });
    }
  });

export const RunnerMaterialActionReconcileRequestV1Schema = z
  .object({
    schemaVersion: ControlSchemaVersionSchema,
    protocolVersion: ControlProtocolVersionSchema,
    requiredCapabilities: z.tuple([z.literal("relay.material-receipt.v1")]),
    requestId: MaterialActionStableIdV1Schema,
    organizationId: MaterialActionStableIdV1Schema,
    runnerId: MaterialActionStableIdV1Schema,
    runId: MaterialActionStableIdV1Schema,
    actionId: MaterialActionStableIdV1Schema,
    attempt: RunnerMaterialActionReconcileAttemptV1Schema,
    expectedCurrentReceiptId: MaterialActionStableIdV1Schema.optional(),
    expectedCurrentReceiptDigest: ReceiptDigestSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      (request.expectedCurrentReceiptId === undefined)
      !== (request.expectedCurrentReceiptDigest === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedCurrentReceiptId"],
        message: "Expected current receipt ID and digest must be supplied together.",
      });
    }
  });

export const MaterialActionBeginAuthorityV1Schema = z.object({
  kind: z.literal("permission_resolution"),
  permissionRequestId: PermissionStableIdV1Schema,
  permissionRequestDigest: ReceiptDigestSchema,
  resolutionReceiptId: PermissionStableIdV1Schema,
  resolutionReceiptDigest: ReceiptDigestSchema,
  workspaceAttestationDigest: ReceiptDigestSchema.optional(),
}).strict();

export const RunnerMaterialActionBeginV1Schema = z.object({
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: z.tuple([z.literal("relay.material-receipt.v1")]),
  requestId: MaterialActionStableIdV1Schema,
  operationId: MaterialActionStableIdV1Schema,
  organizationId: MaterialActionStableIdV1Schema,
  runnerId: MaterialActionStableIdV1Schema,
  runId: MaterialActionStableIdV1Schema,
  attempt: MaterialActionAttemptRefV1Schema.extend({
    fencingToken: z.string().min(1).max(4096),
  }).strict(),
  actionId: MaterialActionStableIdV1Schema,
  actionDescriptor: PermissionActionDescriptorV1Schema,
  actionDescriptorDigest: ReceiptDigestSchema,
  targetFingerprint: ReceiptDigestSchema,
  policySnapshotRef: MaterialActionStableIdV1Schema,
  policySnapshotDigest: ReceiptDigestSchema,
  workspaceAttestationDigest: ReceiptDigestSchema.optional(),
  authority: MaterialActionBeginAuthorityV1Schema,
  idempotencyKey: MaterialActionStableIdV1Schema,
  begunAt: ControlTimestampSchema,
}).strict();

export const HostedRunnerMaterialActionBeginV1Schema = RunnerMaterialActionBeginV1Schema
  .refine((request) => request.workspaceAttestationDigest !== undefined
    && request.authority.workspaceAttestationDigest !== undefined, {
    path: ["workspaceAttestationDigest"],
    message: "Hosted material begin requires accepted workspace attestation.",
  });

export const MaterialActionPayloadV1Schema = z
  .object({
    actionId: MaterialActionStableIdV1Schema,
    actionDescriptor: PermissionActionDescriptorV1Schema,
    actionDescriptorDigest: ReceiptDigestSchema,
    idempotencyKey: MaterialActionStableIdV1Schema,
    provider: MaterialActionNormalizedNameV1Schema,
    connectionRef: MaterialActionStableIdV1Schema,
    targetFingerprint: ReceiptDigestSchema,
    operationId: MaterialActionStableIdV1Schema,
    requestDigest: ReceiptDigestSchema,
    actionPayloadDigest: ReceiptDigestSchema,
    outcome: z.enum(["succeeded", "failed", "outcome_unknown"]),
    externalId: MaterialActionStableIdV1Schema.optional(),
    externalUri: MaterialActionExternalUriV1Schema.optional(),
    observedAt: ControlTimestampSchema,
    evidenceRefs: sortedUniqueArray(MaterialActionStableIdV1Schema).min(1).max(32).optional(),
    evidenceDigests: DigestSetSchema.min(1).max(32).optional(),
    reasonCode: MaterialActionReasonCodeV1Schema,
    nextAction: MaterialActionStableIdV1Schema.optional(),
    owner: MaterialActionStableIdV1Schema.optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const compatibleReasonCodes = {
      succeeded: ["provider_accepted"],
      failed: ["provider_error", "provider_rejected"],
      outcome_unknown: ["provider_receipt_missing", "provider_timeout"],
    } as const;
    if (!(compatibleReasonCodes[payload.outcome] as readonly string[]).includes(payload.reasonCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCode"],
        message: "Material action reason code is incompatible with its outcome.",
      });
    }
    if (payload.outcome === "outcome_unknown") {
      if (payload.nextAction === undefined || payload.owner === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcome"],
          message: "Unknown material action outcomes require a next action and owner.",
        });
      }
    } else if (payload.nextAction !== undefined || payload.owner !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextAction"],
        message: "Terminal material action outcomes must not include reconciliation ownership.",
      });
    }
    if ((payload.evidenceRefs === undefined) !== (payload.evidenceDigests === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceRefs"],
        message: "Evidence refs and digests must be supplied together.",
      });
    } else if (
      payload.evidenceRefs !== undefined
      && payload.evidenceDigests !== undefined
      && payload.evidenceRefs.length !== payload.evidenceDigests.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceDigests"],
        message: "Evidence refs and digests must have matching cardinality.",
      });
    }
  });

const PermissionActionSummaryV1Shape = {
  actionId: PermissionStableIdV1Schema,
  actionDescriptor: PermissionActionDescriptorV1Schema,
  actionDescriptorDigest: ReceiptDigestSchema,
  riskTier: z.enum(["low", "medium", "high", "critical"]),
  targetFingerprint: ReceiptDigestSchema,
};

const PermissionMutationRequestV1Shape = {
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: RequiredRelayCapabilitiesSchema,
  requestId: PermissionStableIdV1Schema,
  operationId: PermissionStableIdV1Schema,
};

const PermissionAttemptRefV1Schema = z
  .object({
    attemptId: PermissionStableIdV1Schema,
    attemptNumber: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingTokenDigest: ReceiptDigestSchema,
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.epoch !== attempt.attemptNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epoch"],
        message: "Attempt epoch must equal the Run-scoped attempt number.",
      });
    }
  });

export const RunnerPermissionAttemptV1Schema = z
  .object({
    attemptId: PermissionStableIdV1Schema,
    attemptNumber: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingToken: z.string().min(1).max(4096),
    fencingTokenDigest: ReceiptDigestSchema,
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.epoch !== attempt.attemptNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epoch"],
        message: "Attempt epoch must equal the Run-scoped attempt number.",
      });
    }
  });

export const RunnerPermissionRequestV1Schema = z
  .object({
    ...PermissionMutationRequestV1Shape,
    organizationId: PermissionStableIdV1Schema,
    runnerId: PermissionStableIdV1Schema,
    runId: PermissionStableIdV1Schema,
    attempt: RunnerPermissionAttemptV1Schema,
    permissionRequestId: PermissionStableIdV1Schema,
    ...PermissionActionSummaryV1Shape,
    policySnapshotRef: PermissionStableIdV1Schema,
    policySnapshotDigest: ReceiptDigestSchema,
    workspaceAttestationDigest: ReceiptDigestSchema.optional(),
    permissionRequestDigest: ReceiptDigestSchema,
    requestedAt: ControlTimestampSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    if (!request.requiredCapabilities.includes("relay.permission.v1")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredCapabilities"],
        message: "Permission capability is required.",
      });
    }
  });

export const HostedRunnerPermissionRequestV1Schema = RunnerPermissionRequestV1Schema
  .refine((request) => request.workspaceAttestationDigest !== undefined, {
    path: ["workspaceAttestationDigest"],
    message: "Hosted permission requires accepted workspace attestation.",
  });

export const PermissionRequestDigestInputV1Schema = z
  .object({
    schemaVersion: ControlSchemaVersionSchema,
    protocolVersion: ControlProtocolVersionSchema,
    requiredCapabilities: RequiredRelayCapabilitiesSchema,
    organizationId: PermissionStableIdV1Schema,
    runnerId: PermissionStableIdV1Schema,
    runId: PermissionStableIdV1Schema,
    attempt: PermissionAttemptRefV1Schema,
    permissionRequestId: PermissionStableIdV1Schema,
    ...PermissionActionSummaryV1Shape,
    policySnapshotRef: PermissionStableIdV1Schema,
    policySnapshotDigest: ReceiptDigestSchema,
    workspaceAttestationDigest: ReceiptDigestSchema.optional(),
    requestedAt: ControlTimestampSchema,
  })
  .strict();

export function buildPermissionRequestDigestInputV1(
  input: z.input<typeof PermissionRequestDigestInputV1Schema>,
): z.output<typeof PermissionRequestDigestInputV1Schema> {
  return PermissionRequestDigestInputV1Schema.parse(input);
}

async function sha256Utf8V1(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function computePermissionFencingTokenDigestV1(rawFencingToken: string): Promise<string> {
  return sha256Utf8V1(rawFencingToken);
}

export function computePermissionRequestDigestV1(
  source: z.input<typeof PermissionRequestDigestInputV1Schema>,
): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(buildPermissionRequestDigestInputV1(source)));
}

export const HumanPermissionDecisionRequestV1Schema = z
  .object({
    ...PermissionMutationRequestV1Shape,
    organizationId: PermissionStableIdV1Schema,
    runId: PermissionStableIdV1Schema,
    attempt: PermissionAttemptRefV1Schema,
    actionId: PermissionStableIdV1Schema,
    permissionRequestId: PermissionStableIdV1Schema,
    permissionRequestDigest: ReceiptDigestSchema,
    policySnapshotDigest: ReceiptDigestSchema,
    decisionId: PermissionStableIdV1Schema,
    decision: PermissionDecisionV1Schema,
    decidedAt: ControlTimestampSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    if (!request.requiredCapabilities.includes("relay.permission.v1")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredCapabilities"],
        message: "Permission capability is required.",
      });
    }
  });

export const RunnerPermissionCurrentQueryV1Schema = z
  .object({
    organizationId: PermissionStableIdV1Schema,
    runnerId: PermissionStableIdV1Schema,
    runId: PermissionStableIdV1Schema,
    attempt: PermissionAttemptRefV1Schema,
    actionId: PermissionStableIdV1Schema,
    permissionRequestId: PermissionStableIdV1Schema,
    permissionRequestDigest: ReceiptDigestSchema,
  })
  .strict();

export const ControlVersionNegotiationV1Schema = z
  .object({
    schemaVersion: ControlSchemaVersionSchema,
    protocolVersion: ControlProtocolVersionSchema,
  })
  .strict();

export const ArtifactIdentityV1Schema = z
  .object({
    packageName: UnpaddedNonEmptyStringSchema,
    packageVersion: NpmPackageVersionSchema,
  })
  .strict();

export const RelayCapabilitiesResponseV1Schema = z
  .object({
    schemaVersion: ControlSchemaVersionSchema,
    protocolVersion: ControlProtocolVersionSchema,
    registryVersion: ControlCapabilityRegistryVersionSchema,
    capabilities: RelayCapabilitiesSchema,
    minimumClient: ControlVersionNegotiationV1Schema,
    deployment: z
      .object({
        environment: UnpaddedNonEmptyStringSchema,
        releaseSha: WorkerReleaseIdentitySchema,
      })
      .strict(),
    artifact: ArtifactIdentityV1Schema.optional(),
  })
  .strict()
  .superRefine((response, ctx) => {
    if (
      response.deployment.releaseSha === "local"
      && response.deployment.environment !== "local"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deployment", "releaseSha"],
        message: "The local release identity is valid only in the local environment.",
      });
    }
  });

const CanonicalGitHubProjectTargetSegmentV1Schema = GitHubTargetSegmentV1Schema
  .refine(
    (value) => value === value.toLowerCase(),
    "GitHub Project Target owner and repository must be lowercase.",
  );

const GitHubProjectTargetDeclarationSegmentV1Schema = GitHubTargetSegmentV1Schema
  .transform((value) => value.toLowerCase());

export const GitHubProjectTargetDeclarationV1Schema = z
  .object({
    projectTargetId: NonEmptyIdSchema.max(200),
    provider: z.literal("github"),
    owner: GitHubProjectTargetDeclarationSegmentV1Schema,
    repo: GitHubProjectTargetDeclarationSegmentV1Schema,
    defaultExecutor: NonEmptyIdSchema.max(120),
    defaultBranch: NonEmptyIdSchema.max(255).nullable(),
  })
  .strict();

export const GitHubProjectTargetBindingDigestInputV1Schema = z
  .object({
    schemaVersion: ControlSchemaVersionSchema,
    protocolVersion: ControlProtocolVersionSchema,
    capability: z.literal("relay.repository-binding.v1"),
    target: GitHubProjectTargetDeclarationV1Schema,
  })
  .strict();

export function computeGitHubProjectTargetBindingDigestV1(
  target: z.input<typeof GitHubProjectTargetDeclarationV1Schema>,
): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(
    GitHubProjectTargetBindingDigestInputV1Schema.parse({
      schemaVersion: CONTROL_SCHEMA_VERSION,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      capability: "relay.repository-binding.v1",
      target,
    }),
  ));
}

const RunnerProjectTargetReadbackV1Schema = z
  .object({
    projectTargetId: NonEmptyIdSchema.max(200),
    bindingDigest: ReceiptDigestSchema,
    bindingGeneration: z.number().int().positive(),
    provider: z.literal("github"),
    owner: CanonicalGitHubProjectTargetSegmentV1Schema,
    repo: CanonicalGitHubProjectTargetSegmentV1Schema,
    defaultExecutor: NonEmptyIdSchema.max(120),
    defaultBranch: NonEmptyIdSchema.max(255).nullable(),
  })
  .strict();

export const RunnerControlContextResponseV1Schema = z
  .object({
    schemaVersion: ControlSchemaVersionSchema,
    protocolVersion: ControlProtocolVersionSchema,
    contextKind: z.literal("runner_control"),
    organizationId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    credentialId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    capabilities: RelayCapabilitiesSchema,
    targets: z.array(RunnerProjectTargetReadbackV1Schema),
    observedAt: ControlTimestampSchema,
  })
  .strict()
  .superRefine((context, ctx) => {
    for (let index = 1; index < context.targets.length; index += 1) {
      const previous = context.targets[index - 1];
      const current = context.targets[index];
      if (!previous || !current) continue;
      if (compareUnicodeCodePoints(previous.projectTargetId, current.projectTargetId) >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targets", index, "projectTargetId"],
          message: "Targets must be sorted by projectTargetId and contain no duplicates.",
        });
      }
    }
  });

export const RunnerProjectTargetUpsertResponseV1Schema =
  RunnerControlContextResponseV1Schema;

const ControlRequestV1Shape = {
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: RequiredRelayCapabilitiesSchema,
  requestId: NonEmptyIdSchema,
};

const ControlMutationRequestV1Shape = {
  ...ControlRequestV1Shape,
  operationId: NonEmptyIdSchema,
};

export const ControlMutationRequestV1Schema = z.object(ControlMutationRequestV1Shape).strict();

export const RunnerProjectTargetUpsertRequestV1Schema = z
  .object({
    ...ControlRequestV1Shape,
    requiredCapabilities: z.tuple([
      z.literal("relay.repository-binding.v1"),
    ]),
    expectedAuthority: z
      .object({
        credentialId: NonEmptyIdSchema,
        registrationGeneration: z.number().int().positive(),
        credentialGeneration: z.number().int().positive(),
      })
      .strict(),
    target: GitHubProjectTargetDeclarationV1Schema,
  })
  .strict();

const VersionedResponseShape = {
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
};

export const ControlWaitingResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    state: z.literal("waiting"),
    requestId: NonEmptyIdSchema,
    resolutionRef: NonEmptyIdSchema,
    nextAction: NonEmptyIdSchema,
  })
  .strict();

export const ControlWaitingHttpResponseV1Schema = z
  .object({ status: z.literal(202), body: ControlWaitingResponseV1Schema })
  .strict();

export const ControlInvalidRequestResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.enum(["invalid_request_body", "digest_mismatch"]),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlInvalidCredentialResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("invalid_credential"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlInsufficientScopeResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("insufficient_scope"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlConcealedNotFoundResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("missing_or_concealed"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlConflictResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.enum([
      "stale_attempt",
      "stale_registration",
      "stale_readiness",
      "target_binding_stale",
      "target_not_bound_to_slack",
      "idempotency_conflict",
      "operation_digest_conflict",
      "stale_control_authority",
      "invalid_state_transition",
    ]),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlRateLimitedResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("rate_limited"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
    retryAfterSeconds: z.number().int().positive(),
  })
  .strict();

export const ControlCapabilityRequiredResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("capability_required"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
    requiredCapabilities: RequiredRelayCapabilitiesSchema,
  })
  .strict();

export const ControlRequestBodyTooLargeResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("request_body_too_large"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlObservationPolicyMismatchResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("observation_policy_mismatch"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

export const ControlProtocolUpgradeResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("protocol_upgrade_required"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
    supported: z
      .object({
        schemaVersions: z.tuple([z.literal(1)]),
        protocolVersions: z.tuple([z.literal("1.0")]),
      })
      .strict(),
    nextAction: z.literal("upgrade_client"),
  })
  .strict();

export const ControlInternalErrorResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.literal("internal_error"),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

const ControlInvalidRequestHttpResponseV1Schema = z
  .object({ status: z.literal(400), body: ControlInvalidRequestResponseV1Schema })
  .strict();
const ControlInvalidCredentialHttpResponseV1Schema = z
  .object({ status: z.literal(401), body: ControlInvalidCredentialResponseV1Schema })
  .strict();
const ControlInsufficientScopeHttpResponseV1Schema = z
  .object({ status: z.literal(403), body: ControlInsufficientScopeResponseV1Schema })
  .strict();
const ControlConcealedNotFoundHttpResponseV1Schema = z
  .object({ status: z.literal(404), body: ControlConcealedNotFoundResponseV1Schema })
  .strict();
const ControlConflictHttpResponseV1Schema = z
  .object({ status: z.literal(409), body: ControlConflictResponseV1Schema })
  .strict();
const ControlCapabilityRequiredHttpResponseV1Schema = z
  .object({ status: z.literal(412), body: ControlCapabilityRequiredResponseV1Schema })
  .strict();
const ControlRequestBodyTooLargeHttpResponseV1Schema = z
  .object({ status: z.literal(413), body: ControlRequestBodyTooLargeResponseV1Schema })
  .strict();
const ControlObservationPolicyMismatchHttpResponseV1Schema = z
  .object({ status: z.literal(422), body: ControlObservationPolicyMismatchResponseV1Schema })
  .strict();
const ControlProtocolUpgradeHttpResponseV1Schema = z
  .object({ status: z.literal(426), body: ControlProtocolUpgradeResponseV1Schema })
  .strict();
const ControlRateLimitedHttpResponseV1Schema = z
  .object({ status: z.literal(429), body: ControlRateLimitedResponseV1Schema })
  .strict();
const ControlInternalErrorHttpResponseV1Schema = z
  .object({ status: z.literal(500), body: ControlInternalErrorResponseV1Schema })
  .strict();

export const ControlErrorHttpResponseV1Schema = z.union([
  ControlInvalidRequestHttpResponseV1Schema,
  ControlInvalidCredentialHttpResponseV1Schema,
  ControlInsufficientScopeHttpResponseV1Schema,
  ControlConcealedNotFoundHttpResponseV1Schema,
  ControlConflictHttpResponseV1Schema,
  ControlCapabilityRequiredHttpResponseV1Schema,
  ControlRequestBodyTooLargeHttpResponseV1Schema,
  ControlObservationPolicyMismatchHttpResponseV1Schema,
  ControlProtocolUpgradeHttpResponseV1Schema,
  ControlRateLimitedHttpResponseV1Schema,
  ControlInternalErrorHttpResponseV1Schema,
]);

export const RunnerRegistrationRequestV1Schema = z
  .object({
    ...ControlMutationRequestV1Shape,
    runnerId: NonEmptyIdSchema,
    displayName: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => value === value.trim(), "Display name must not contain leading or trailing whitespace.")
      .optional(),
    capabilities: RelayCapabilitiesSchema,
  })
  .strict()
  .refine((request) => request.requiredCapabilities.includes("relay.registration.v1"), {
    path: ["requiredCapabilities"],
    message: "Runner registration requires relay.registration.v1.",
  });

export const RunnerCredentialReprovisionRequestV1Schema = z
  .object({
    ...ControlMutationRequestV1Shape,
    runnerId: NonEmptyIdSchema,
    recoveryCredentialId: NonEmptyIdSchema,
    expectedRegistrationGeneration: z.number().int().positive(),
    expectedCredentialGeneration: z.number().int().positive(),
  })
  .strict()
  .refine((request) => request.requiredCapabilities.includes("relay.credential-reprovision.v1"), {
    path: ["requiredCapabilities"],
    message: "Credential re-provision requires relay.credential-reprovision.v1.",
  });

export const RunnerCredentialMetadataV1Schema = z
  .object({
    ...VersionedResponseShape,
    operationId: NonEmptyIdSchema,
    organizationId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    credentialId: NonEmptyIdSchema,
    credentialPurpose: z.literal("runtime"),
    createdAt: ControlTimestampSchema,
  })
  .strict();

export const FreshRunnerCredentialResponseV1Schema = RunnerCredentialMetadataV1Schema.extend({
  runnerToken: z.string().min(1),
  replayed: z.literal(false),
});

export const ReplayedRunnerCredentialResponseV1Schema = RunnerCredentialMetadataV1Schema.extend({
  replayed: z.literal(true),
});

export const RunnerCredentialResponseV1Schema = z.discriminatedUnion("replayed", [
  FreshRunnerCredentialResponseV1Schema,
  ReplayedRunnerCredentialResponseV1Schema,
]);
export const RunnerRegistrationResponseV1Schema = RunnerCredentialResponseV1Schema;
export const RunnerCredentialReprovisionResponseV1Schema = RunnerCredentialResponseV1Schema;
export const RunnerCredentialHttpResponseV1Schema = z.union([
  z.object({ status: z.literal(201), body: FreshRunnerCredentialResponseV1Schema }).strict(),
  z.object({ status: z.literal(200), body: ReplayedRunnerCredentialResponseV1Schema }).strict(),
  ControlErrorHttpResponseV1Schema,
]);

const RunnerCredentialMutationRequestV1Shape = {
  ...ControlMutationRequestV1Shape,
  requiredCapabilities: z.tuple([z.literal("relay.credential-rotation.v1")]),
  runnerId: NonEmptyIdSchema,
  expectedRegistrationGeneration: z.number().int().positive(),
  expectedCredentialGeneration: z.number().int().positive(),
  expectedCredentialId: NonEmptyIdSchema,
};

export const RunnerCredentialRotationRequestV1Schema = z
  .object(RunnerCredentialMutationRequestV1Shape)
  .strict();

export const RunnerCredentialRevocationRequestV1Schema = z
  .object(RunnerCredentialMutationRequestV1Shape)
  .strict();

export const RunnerCredentialRotationMetadataV1Schema = z
  .object({
    ...VersionedResponseShape,
    operationId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    replacedCredentialId: NonEmptyIdSchema,
    credentialId: NonEmptyIdSchema,
    credentialPurpose: z.literal("runtime"),
    createdAt: ControlTimestampSchema,
  })
  .strict()
  .refine((response) => response.credentialId !== response.replacedCredentialId, {
    path: ["credentialId"],
    message: "Rotated credential must have a new credential ID.",
  });

export const FreshRunnerCredentialRotationResponseV1Schema =
  RunnerCredentialRotationMetadataV1Schema.safeExtend({
    runnerToken: z.string().min(1),
    replayed: z.literal(false),
  });

export const ReplayedRunnerCredentialRotationResponseV1Schema =
  RunnerCredentialRotationMetadataV1Schema.safeExtend({
    replayed: z.literal(true),
  });

export const RunnerCredentialRotationResponseV1Schema = z.discriminatedUnion("replayed", [
  FreshRunnerCredentialRotationResponseV1Schema,
  ReplayedRunnerCredentialRotationResponseV1Schema,
]);

export const RunnerCredentialRevocationResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    operationId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    credentialState: z.literal("revoked"),
    revokedCredentialId: NonEmptyIdSchema,
    credentialPurpose: z.literal("runtime"),
    activeCredentialId: z.null(),
    revokedAt: ControlTimestampSchema,
    replayed: z.boolean(),
  })
  .strict();

const RunnerCredentialReadyCurrentStateResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    projectionStatus: z.literal("ready"),
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    activeCredentialId: NonEmptyIdSchema.nullable(),
    credentialState: z.enum(["active", "revoked"]),
    observedAt: ControlTimestampSchema,
  })
  .strict()
  .superRefine((response, context) => {
    if (response.credentialState === "active" && response.activeCredentialId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeCredentialId"],
        message: "Active credential state requires an active credential ID.",
      });
    }
    if (response.credentialState === "revoked" && response.activeCredentialId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeCredentialId"],
        message: "Revoked credential state cannot expose an active credential ID.",
      });
    }
  });

const RunnerCredentialPendingCurrentStateResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    projectionStatus: z.literal("pending"),
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.null(),
    credentialGeneration: z.null(),
    activeCredentialId: z.null(),
    credentialState: z.literal("unknown"),
    reason: z.enum([
      "legacy_projection_unbackfilled",
      "credential_projection_inconsistent",
    ]),
    nextAction: z.literal("operator_projection_migration_required"),
    observedAt: ControlTimestampSchema,
  })
  .strict();

export const RunnerCredentialCurrentStateResponseV1Schema =
  z.discriminatedUnion("projectionStatus", [
    RunnerCredentialReadyCurrentStateResponseV1Schema,
    RunnerCredentialPendingCurrentStateResponseV1Schema,
  ]);

const RunnerCredentialMutationConflictResponseV1Schema = z
  .object({
    ...VersionedResponseShape,
    error: z.enum(["stale_credential", "idempotency_conflict", "invalid_state_transition"]),
    message: z.string().min(1),
    requestId: NonEmptyIdSchema,
  })
  .strict();

const RunnerCredentialMutationErrorHttpResponseV1Schema = z.union([
  ControlInvalidRequestHttpResponseV1Schema,
  ControlInvalidCredentialHttpResponseV1Schema,
  ControlInsufficientScopeHttpResponseV1Schema,
  ControlConcealedNotFoundHttpResponseV1Schema,
  z.object({ status: z.literal(409), body: RunnerCredentialMutationConflictResponseV1Schema }).strict(),
  ControlCapabilityRequiredHttpResponseV1Schema,
  ControlRequestBodyTooLargeHttpResponseV1Schema,
  ControlProtocolUpgradeHttpResponseV1Schema,
  ControlRateLimitedHttpResponseV1Schema,
]);

export const RunnerCredentialRotationHttpResponseV1Schema = z.union([
  z.object({ status: z.literal(201), body: FreshRunnerCredentialRotationResponseV1Schema }).strict(),
  z.object({ status: z.literal(200), body: ReplayedRunnerCredentialRotationResponseV1Schema }).strict(),
  RunnerCredentialMutationErrorHttpResponseV1Schema,
]);

export const RunnerCredentialRevocationHttpResponseV1Schema = z.union([
  z.object({ status: z.literal(200), body: RunnerCredentialRevocationResponseV1Schema }).strict(),
  RunnerCredentialMutationErrorHttpResponseV1Schema,
]);

export const RunnerCredentialCurrentStateHttpResponseV1Schema = z.union([
  z.object({ status: z.literal(200), body: RunnerCredentialCurrentStateResponseV1Schema }).strict(),
  ControlInvalidCredentialHttpResponseV1Schema,
  ControlInsufficientScopeHttpResponseV1Schema,
  ControlConcealedNotFoundHttpResponseV1Schema,
  ControlRateLimitedHttpResponseV1Schema,
]);

export const ReceiptAttemptRefV1Schema = z
  .object({
    attemptId: NonEmptyIdSchema,
    attemptNumber: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingTokenDigest: ReceiptDigestSchema,
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.epoch !== attempt.attemptNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epoch"],
        message: "Attempt epoch must equal the Run-scoped attempt number.",
      });
    }
  });

export const ReceiptProducerV1Schema = z
  .object({
    kind: z.enum(["cloud", "runner", "local_opentag"]),
    id: NonEmptyIdSchema,
    credentialId: NonEmptyIdSchema.optional(),
    registrationGeneration: z.number().int().positive().optional(),
  })
  .strict();

export const RunnerReadinessProducerV1Schema = z
  .object({
    kind: z.literal("runner"),
    id: NonEmptyIdSchema,
    credentialId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
  })
  .strict();

export const ReceiptIdentityV1Schema = z
  .object({
    namespace: z.string().regex(/^opentag\.control\.receipt\/[a-z0-9-]+\/v1$/u),
    parts: z.array(NonEmptyIdSchema).min(2),
  })
  .strict();

const ReceiptEnvelopeBaseShape = {
  ...VersionedResponseShape,
  receiptId: NonEmptyIdSchema,
  organizationId: NonEmptyIdSchema,
  operationId: NonEmptyIdSchema,
  requiredCapabilities: RequiredRelayCapabilitiesSchema,
  producer: ReceiptProducerV1Schema,
  identity: ReceiptIdentityV1Schema,
  predecessorReceiptDigests: DigestSetSchema.optional(),
  observedAt: ControlTimestampSchema,
  payloadDigest: ReceiptDigestSchema,
  receiptDigest: ReceiptDigestSchema,
};

function hasExactReceiptIdentity(
  identity: z.infer<typeof ReceiptIdentityV1Schema>,
  namespace: string,
  parts: string[],
): boolean {
  return identity.namespace === namespace &&
    identity.parts.length === parts.length &&
    identity.parts.every((part, index) => part === parts[index]);
}

const MaterialActionReceiptEnvelopeBaseV1Schema = z
  .object({
    ...VersionedResponseShape,
    receiptId: MaterialActionStableIdV1Schema,
    organizationId: MaterialActionStableIdV1Schema,
    operationId: MaterialActionStableIdV1Schema,
    requiredCapabilities: z.tuple([z.literal("relay.material-receipt.v1")]),
    producer: z
      .object({
        kind: z.literal("local_opentag"),
        id: MaterialActionStableIdV1Schema,
      })
      .strict(),
    identity: z
      .object({
        namespace: z.literal("opentag.control.receipt/material-action/v1"),
        parts: z.array(MaterialActionStableIdV1Schema).length(5),
      })
      .strict(),
    predecessorReceiptDigests: DigestSetSchema.optional(),
    observedAt: ControlTimestampSchema,
    payloadDigest: ReceiptDigestSchema,
    receiptDigest: ReceiptDigestSchema,
    receiptKind: z.literal("material_action"),
    runId: MaterialActionStableIdV1Schema,
    attempt: MaterialActionAttemptRefV1Schema,
    payload: MaterialActionPayloadV1Schema,
  })
  .strict();

export const MaterialActionReceiptDigestInputV1Schema =
  MaterialActionReceiptEnvelopeBaseV1Schema.omit({ receiptDigest: true });

export const MaterialActionReceiptEnvelopeV1Schema =
  MaterialActionReceiptEnvelopeBaseV1Schema.superRefine((receipt, ctx) => {
    if (receipt.payload.operationId !== receipt.operationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "operationId"],
        message: "Material action operation identity must match the envelope.",
      });
    }
    if (receipt.payload.observedAt !== receipt.observedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "observedAt"],
        message: "Material action observation time must match the envelope.",
      });
    }
    if (!hasExactReceiptIdentity(
      receipt.identity,
      "opentag.control.receipt/material-action/v1",
      [
        receipt.organizationId,
        receipt.runId,
        receipt.attempt.attemptId,
        receipt.payload.actionId,
        receipt.receiptId,
      ],
    )) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["identity"],
        message: "Material action identity tuple is invalid.",
      });
    }
  });

const MaterialActionReconcileResolvedReceiptV1Schema =
  MaterialActionReceiptEnvelopeV1Schema.refine(
    (receipt) => receipt.payload.outcome === "succeeded" || receipt.payload.outcome === "failed",
    {
      path: ["payload", "outcome"],
      message: "HTTP 200 material reconciliation must have a terminal outcome.",
    },
  );

const MaterialActionReconcileUnknownReceiptV1Schema =
  MaterialActionReceiptEnvelopeV1Schema.refine(
    (receipt) => receipt.payload.outcome === "outcome_unknown",
    {
      path: ["payload", "outcome"],
      message: "HTTP 202 material reconciliation must remain outcome_unknown.",
    },
  );

export const MaterialActionReconcileHttpResponseV1Schema = z.union([
  z.object({ status: z.literal(200), body: MaterialActionReconcileResolvedReceiptV1Schema }).strict(),
  z.object({ status: z.literal(202), body: MaterialActionReconcileUnknownReceiptV1Schema }).strict(),
  ControlErrorHttpResponseV1Schema,
]);

export function buildMaterialActionReceiptDigestInputV1(
  input: z.input<typeof MaterialActionReceiptDigestInputV1Schema>,
): z.output<typeof MaterialActionReceiptDigestInputV1Schema> {
  return MaterialActionReceiptDigestInputV1Schema.parse(input);
}

export function computeMaterialActionPayloadDigestV1(
  payload: z.input<typeof MaterialActionPayloadV1Schema>,
): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(MaterialActionPayloadV1Schema.parse(payload)));
}

export function computeMaterialActionFencingTokenDigestV1(rawFencingToken: string): Promise<string> {
  return sha256Utf8V1(rawFencingToken);
}

export function computeMaterialActionReceiptDigestV1(
  receipt: z.input<typeof MaterialActionReceiptDigestInputV1Schema>,
): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(buildMaterialActionReceiptDigestInputV1(receipt)));
}

export async function computeControlPayloadDigestV1(payload: unknown): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(payload));
}

export async function computeControlReceiptDigestV1(
  receiptWithoutDigest: unknown,
): Promise<string> {
  return sha256Utf8V1(canonicalJsonStringify(receiptWithoutDigest));
}

export const ReadinessStateV1Schema = z.enum(["ready", "degraded", "blocked", "unknown"]);
const ReadinessReasonShape = { reasonCode: RunnerReadinessReasonCodeV1Schema.optional() };

export const RunnerReadinessPayloadV1Schema = z
  .object({
    readinessId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    capabilities: RelayCapabilitiesSchema,
    executors: z.array(
      z
        .object({
          executorId: NonEmptyIdSchema,
          adapterVersion: UnpaddedNonEmptyStringSchema,
          capabilityDigest: ReceiptDigestSchema,
          state: ReadinessStateV1Schema,
          ...ReadinessReasonShape,
        })
        .strict(),
    ),
    targets: z.array(
      z
        .object({
          projectTargetId: NonEmptyIdSchema,
          bindingDigest: ReceiptDigestSchema,
          state: ReadinessStateV1Schema,
          ...ReadinessReasonShape,
        })
        .strict(),
    ),
    observedAt: ControlTimestampSchema,
    expiresAt: ControlTimestampSchema,
  })
  .strict()
  .superRefine((readiness, ctx) => {
    if (Date.parse(readiness.expiresAt) <= Date.parse(readiness.observedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Readiness expiry must be later than its observation time.",
      });
    }
    for (const [collectionName, entries] of [
      ["executors", readiness.executors],
      ["targets", readiness.targets],
    ] as const) {
      entries.forEach((entry, index) => {
        if (entry.state === "ready" && entry.reasonCode !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [collectionName, index, "reasonCode"],
            message: "Ready attestations must not include a failure reason code.",
          });
        }
        if (entry.state !== "ready" && entry.reasonCode === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [collectionName, index, "reasonCode"],
            message: "Non-ready attestations require an allowlisted reason code.",
          });
        }
      });
    }
  });

export const RunnerReadinessReceiptEnvelopeV1Schema = z
  .object({
    ...ReceiptEnvelopeBaseShape,
    producer: RunnerReadinessProducerV1Schema,
    receiptKind: z.literal("runner_readiness"),
    payload: RunnerReadinessPayloadV1Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!receipt.requiredCapabilities.includes("relay.readiness.v1")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredCapabilities"], message: "Readiness capability is required." });
    }
    if (receipt.producer.id !== receipt.payload.runnerId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["producer", "id"], message: "Readiness producer must match the attested Runner." });
    }
    if (receipt.producer.registrationGeneration !== receipt.payload.registrationGeneration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["producer", "registrationGeneration"],
        message: "Readiness producer registration generation must match the attestation.",
      });
    }
    if (receipt.payload.observedAt !== receipt.observedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "observedAt"],
        message: "Readiness payload observation time must match the envelope.",
      });
    }
    if (!hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/runner-readiness/v1", [
      receipt.organizationId,
      receipt.payload.runnerId,
      String(receipt.payload.registrationGeneration),
      receipt.payload.readinessId,
    ])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity"], message: "Readiness identity tuple is invalid." });
    }
  });

export const PermissionResolutionPayloadV1Schema = z
  .object({
    resolutionId: PermissionStableIdV1Schema,
    permissionRequestId: PermissionStableIdV1Schema,
    permissionRequestDigest: ReceiptDigestSchema,
    ...PermissionActionSummaryV1Shape,
    policySnapshotRef: PermissionStableIdV1Schema,
    policySnapshotDigest: ReceiptDigestSchema,
    workspaceAttestationDigest: ReceiptDigestSchema.optional(),
    state: PermissionResolutionStateV1Schema,
    decision: PermissionDecisionV1Schema.optional(),
    decisionRef: PermissionStableIdV1Schema.optional(),
    decisionActorRef: PermissionStableIdV1Schema.optional(),
    reasonCode: PermissionResolutionReasonCodeV1Schema,
    requestedAt: ControlTimestampSchema,
    decidedAt: ControlTimestampSchema.optional(),
    observedAt: ControlTimestampSchema,
    nextAction: z.literal("wait_for_operator").optional(),
  })
  .strict()
  .superRefine((resolution, ctx) => {
    const humanDecisionFields = [
      resolution.decision,
      resolution.decisionRef,
      resolution.decisionActorRef,
      resolution.decidedAt,
    ];
    if (resolution.state === "waiting") {
      if (resolution.reasonCode !== "human_approval_required") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonCode"], message: "Waiting requires human_approval_required." });
      }
      if (resolution.nextAction === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nextAction"], message: "Waiting requires a safe next action." });
      }
      if (humanDecisionFields.some((value) => value !== undefined)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: "Waiting must not claim a decision." });
      }
      return;
    }
    if (resolution.nextAction !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nextAction"], message: "Terminal resolution must not include a waiting next action." });
    }
    if (resolution.state === "authorized" || resolution.state === "denied") {
      const expectedDecision = resolution.state === "authorized" ? "allow_once" : "deny";
      const expectedReason = resolution.state === "authorized" ? "human_approved" : "human_denied";
      if (resolution.decision !== expectedDecision) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: `State requires ${expectedDecision}.` });
      }
      if (resolution.reasonCode !== expectedReason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonCode"], message: `State requires ${expectedReason}.` });
      }
      for (const [field, value] of [
        ["decisionRef", resolution.decisionRef],
        ["decisionActorRef", resolution.decisionActorRef],
        ["decidedAt", resolution.decidedAt],
      ] as const) {
        if (value === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Human decision attribution is required." });
        }
      }
      return;
    }
    if (resolution.reasonCode !== "attempt_stale" && resolution.reasonCode !== "policy_stale") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonCode"], message: "Stale requires an allowlisted stale reason." });
    }
    if (humanDecisionFields.some((value) => value !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"], message: "Stale must not claim a human decision." });
    }
  });

export const PermissionResolutionReceiptEnvelopeV1Schema = z
  .object({
    ...ReceiptEnvelopeBaseShape,
    receiptId: PermissionStableIdV1Schema,
    organizationId: PermissionStableIdV1Schema,
    operationId: PermissionStableIdV1Schema,
    producer: z.object({ kind: z.literal("cloud"), id: PermissionStableIdV1Schema }).strict(),
    identity: z
      .object({
        namespace: z.literal("opentag.control.receipt/permission-resolution/v1"),
        parts: z.array(PermissionStableIdV1Schema).length(5),
      })
      .strict(),
    receiptKind: z.literal("permission_resolution"),
    runId: PermissionStableIdV1Schema,
    attempt: PermissionAttemptRefV1Schema,
    payload: PermissionResolutionPayloadV1Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (
      receipt.requiredCapabilities.length !== 1 ||
      receipt.requiredCapabilities[0] !== "relay.permission.v1"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredCapabilities"],
        message: "Permission receipts require only relay.permission.v1.",
      });
    }
    if (!hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/permission-resolution/v1", [
      receipt.organizationId,
      receipt.runId,
      receipt.attempt.attemptId,
      receipt.payload.actionId,
      receipt.payload.resolutionId,
    ])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["identity"], message: "Permission resolution identity tuple is invalid." });
    }
    if (receipt.payload.observedAt !== receipt.observedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "observedAt"], message: "Permission observation time must match the envelope." });
    }
  });

const PermissionResolutionTerminalReceiptEnvelopeV1Schema = PermissionResolutionReceiptEnvelopeV1Schema.refine(
  (receipt) => receipt.payload.state !== "waiting",
  { path: ["payload", "state"], message: "HTTP 200 permission result must be terminal." },
);
const PermissionResolutionDecisionReceiptEnvelopeV1Schema = PermissionResolutionReceiptEnvelopeV1Schema.refine(
  (receipt) => receipt.payload.state === "authorized" || receipt.payload.state === "denied",
  { path: ["payload", "state"], message: "A human decision must authorize or deny." },
);
const PermissionResolutionWaitingReceiptEnvelopeV1Schema = PermissionResolutionReceiptEnvelopeV1Schema.refine(
  (receipt) => receipt.payload.state === "waiting",
  { path: ["payload", "state"], message: "HTTP 202 permission result must be waiting." },
);

export const RunnerPermissionRequestHttpResponseV1Schema = z
  .object({ status: z.literal(202), body: PermissionResolutionWaitingReceiptEnvelopeV1Schema })
  .strict();

export const HumanPermissionDecisionHttpResponseV1Schema = z
  .object({ status: z.literal(200), body: PermissionResolutionDecisionReceiptEnvelopeV1Schema })
  .strict();

export const PermissionResolutionCurrentHttpResponseV1Schema = z.union([
  z.object({ status: z.literal(200), body: PermissionResolutionTerminalReceiptEnvelopeV1Schema }).strict(),
  z.object({ status: z.literal(202), body: PermissionResolutionWaitingReceiptEnvelopeV1Schema }).strict(),
]);

const HostedAdmissionEnvelopeDigestInputV1Shape = {
  kind: z.literal("hosted_admission"),
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: z.tuple([z.literal("relay.hosted-admission.v1")]),
  admissionId: NonEmptyIdSchema,
  operationId: NonEmptyIdSchema,
  organizationId: NonEmptyIdSchema,
  bindingId: NonEmptyIdSchema,
  bindingSecretVersion: NonEmptyIdSchema,
  provider: z.literal("slack"),
  deliveryId: NonEmptyIdSchema,
  deliveryPayloadDigest: ReceiptDigestSchema,
  sourceIdentityDigest: ReceiptDigestSchema,
  eventName: z.literal("app_mention"),
  action: z.literal("created"),
  repository: z
    .object({
      provider: z.literal("github"),
      providerRepositoryId: NonEmptyIdSchema,
      owner: NonEmptyIdSchema,
      repo: NonEmptyIdSchema,
    })
    .strict(),
  sourceThread: z
    .object({
      kind: z.literal("channel_thread"),
      providerThreadId: NonEmptyIdSchema,
      channelId: NonEmptyIdSchema,
      threadTs: NonEmptyIdSchema,
    })
    .strict(),
  sourceEvent: z
    .object({
      providerEventId: NonEmptyIdSchema,
      kind: z.literal("app_mention"),
      messageId: NonEmptyIdSchema,
    })
    .strict(),
  verifiedActor: z
    .object({
      providerUserId: NonEmptyIdSchema,
      login: NonEmptyIdSchema,
      authorization: z
        .object({
          decision: z.literal("allowed"),
          grantRef: NonEmptyIdSchema,
          grantVersion: z.number().int().positive(),
          grantDigest: ReceiptDigestSchema,
        })
        .strict(),
    })
    .strict(),
  projectTarget: z
    .object({
      projectTargetId: NonEmptyIdSchema,
      digest: ReceiptDigestSchema,
    })
    .strict(),
  runnerId: NonEmptyIdSchema,
  sourceContextEnvelope: z.object({
    contentId: NonEmptyIdSchema,
    sourceVersionRef: NonEmptyIdSchema,
    aadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    keyVersion: NonEmptyIdSchema,
    envelopeDigest: ReceiptDigestSchema,
    payloadDigest: ReceiptDigestSchema,
  }).strict(),
  queueClaimDeadline: ControlTimestampSchema,
  permissionCeiling: z.object({
    allowedActionDescriptors: sortedUniqueArray(PermissionActionDescriptorV1Schema),
    digest: ReceiptDigestSchema,
  }).strict(),
  publicationPolicy: z.object({
    mode: z.enum(["proposal_only", "pull_request"]),
    digest: ReceiptDigestSchema,
  }).strict(),
  completionContract: z.object({
    mode: z.enum(["proposal_ready", "pull_request_ready"]),
    digest: ReceiptDigestSchema,
  }).strict(),
  admissionPolicySnapshot: z
    .object({
      snapshotId: NonEmptyIdSchema,
      digest: ReceiptDigestSchema,
    })
    .strict(),
  receivedAt: ControlTimestampSchema,
};

export const HostedAdmissionEnvelopeDigestInputV1Schema = z
  .object(HostedAdmissionEnvelopeDigestInputV1Shape)
  .strict();

export const HostedAdmissionEnvelopeV1Schema = z
  .object({
    ...HostedAdmissionEnvelopeDigestInputV1Shape,
    envelopeDigest: ReceiptDigestSchema,
  })
  .strict()
  .superRefine((admission, ctx) => {
    if (new Date(admission.queueClaimDeadline).getTime()
      <= new Date(admission.receivedAt).getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["queueClaimDeadline"],
        message: "Hosted claim deadline must be finite and later than receipt." });
    }
    if ((admission.publicationPolicy.mode === "proposal_only"
        && admission.completionContract.mode !== "proposal_ready")
      || (admission.publicationPolicy.mode === "pull_request"
        && admission.completionContract.mode !== "pull_request_ready")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completionContract", "mode"],
        message: "Completion mode must match the Admission-frozen publication mode." });
    }
  });

export const SlackAppMentionSourceIdentityDigestInputV1Schema = z
  .object({
    provider: z.literal("slack"),
    repository: HostedAdmissionEnvelopeDigestInputV1Shape.repository,
    sourceThread: HostedAdmissionEnvelopeDigestInputV1Shape.sourceThread,
    sourceEvent: HostedAdmissionEnvelopeDigestInputV1Shape.sourceEvent,
    actor: z.object({ providerUserId: NonEmptyIdSchema, login: NonEmptyIdSchema }).strict(),
    executionBearingMessageBody: z.string().min(1),
  })
  .strict();

export function buildHostedAdmissionEnvelopeDigestInputV1(
  envelope: z.input<typeof HostedAdmissionEnvelopeV1Schema>,
): z.output<typeof HostedAdmissionEnvelopeDigestInputV1Schema> {
  const { envelopeDigest: _envelopeDigest, ...digestInput } =
    HostedAdmissionEnvelopeV1Schema.parse(envelope);
  return HostedAdmissionEnvelopeDigestInputV1Schema.parse(digestInput);
}

export function computeHostedAdmissionEnvelopeDigestV1(
  envelope: z.input<typeof HostedAdmissionEnvelopeV1Schema>,
): Promise<string> {
  return sha256Utf8V1(
    canonicalJsonStringify(buildHostedAdmissionEnvelopeDigestInputV1(envelope)),
  );
}

export async function verifyHostedAdmissionEnvelopeDigestV1(
  envelope: z.input<typeof HostedAdmissionEnvelopeV1Schema>,
): Promise<boolean> {
  const parsed = HostedAdmissionEnvelopeV1Schema.parse(envelope);
  return (await computeHostedAdmissionEnvelopeDigestV1(parsed)) === parsed.envelopeDigest;
}

export function computeSlackAppMentionSourceIdentityDigestV1(
  input: z.input<typeof SlackAppMentionSourceIdentityDigestInputV1Schema>,
): Promise<string> {
  return sha256Utf8V1(
    canonicalJsonStringify(SlackAppMentionSourceIdentityDigestInputV1Schema.parse(input)),
  );
}

export const AdmissionPolicySnapshotPayloadV1Schema = z
  .object({
    snapshotId: NonEmptyIdSchema,
    capturedAt: ControlTimestampSchema,
    tenant: z.object({ organizationId: NonEmptyIdSchema }).strict(),
    actor: z
      .object({
        provider: z.literal("slack"),
        providerUserId: NonEmptyIdSchema,
        login: NonEmptyIdSchema,
        authorizationRef: NonEmptyIdSchema,
      })
      .strict(),
    target: z
      .object({
        projectTargetId: NonEmptyIdSchema,
        bindingId: NonEmptyIdSchema,
        repositoryProvider: z.literal("github"),
        providerRepositoryId: NonEmptyIdSchema,
        defaultBranch: NonEmptyIdSchema,
        authorizedPublicationModes: sortedUniqueArray(
          z.enum(["proposal_only", "pull_request"]),
        ),
      })
      .strict(),
    runner: z.object({ runnerId: NonEmptyIdSchema, readinessReceiptDigest: ReceiptDigestSchema }).strict(),
    executor: z.object({ executorId: NonEmptyIdSchema, capabilityDigest: ReceiptDigestSchema }).strict(),
    requiredRelayCapabilities: RequiredRelayCapabilitiesSchema,
    admissionRules: z
      .object({
        profile: NonEmptyIdSchema,
        requiredCheckNames: sortedUniqueArray(NonEmptyIdSchema),
        mergeRequired: z.boolean(),
        humanApprovalRequiredFor: sortedUniqueArray(NonEmptyIdSchema),
      })
      .strict(),
  })
  .strict();

export const AdmissionPolicySnapshotReceiptEnvelopeV1Schema = z
  .object({
    ...ReceiptEnvelopeBaseShape,
    receiptKind: z.literal("admission_policy_snapshot"),
    runId: NonEmptyIdSchema,
    payload: AdmissionPolicySnapshotPayloadV1Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (!receipt.requiredCapabilities.includes("relay.hosted-admission.v1")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredCapabilities"], message: "Hosted admission capability is required." });
    }
    if (receipt.producer.kind !== "cloud") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["producer", "kind"], message: "Cloud is the policy snapshot authority." });
    }
    if (
      receipt.payload.tenant.organizationId !== receipt.organizationId ||
      !hasExactReceiptIdentity(receipt.identity, "opentag.control.receipt/admission-policy-snapshot/v1", [
        receipt.organizationId,
        receipt.runId,
        receipt.payload.snapshotId,
      ])
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payload", "tenant"], message: "Policy snapshot must be tenant scoped." });
    }
  });

const HostedClaimRequiredCapabilitiesV1Schema = z.tuple([
  z.literal("relay.claim-fence.v1"),
  z.literal("relay.hosted-admission.v1"),
  z.literal("relay.hosted-claim.v1"),
  z.literal("relay.lifecycle.v1"),
  z.literal("relay.readiness.v1"),
  z.literal("relay.source-content-redeem.v1"),
]);

export const HostedClaimExpectedAuthorityV1Schema = z
  .object({
    credentialId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    runnerReadinessReceiptId: NonEmptyIdSchema,
    runnerReadinessReceiptDigest: ReceiptDigestSchema,
  })
  .strict();

export const HostedClaimRequestV1Schema = z
  .object({
    ...ControlMutationRequestV1Shape,
    requiredCapabilities: HostedClaimRequiredCapabilitiesV1Schema,
    expectedAuthority: HostedClaimExpectedAuthorityV1Schema,
  })
  .strict();

const HostedClaimAttemptV1Schema = z
  .object({
    id: NonEmptyIdSchema,
    number: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingToken: z.string().min(1).max(4096),
    fencingTokenDigest: ReceiptDigestSchema,
    leaseExpiresAt: ControlTimestampSchema,
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.epoch !== attempt.number) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epoch"],
        message: "Attempt epoch must equal the Run-scoped attempt number.",
      });
    }
  });

const HostedSourceContentGrantV1Schema = z.object({
  grantId: NonEmptyIdSchema,
  token: z.string().min(1).max(4096),
  keyVersion: NonEmptyIdSchema,
  fenceDigest: ReceiptDigestSchema,
  contentIds: sortedUniqueArray(NonEmptyIdSchema).min(1),
  purpose: z.literal("source_context"),
  expiresAt: ControlTimestampSchema,
}).strict();

export const HostedSourceContentRedeemRequestV1Schema = z.object({
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: z.tuple([z.literal("relay.source-content-redeem.v1")]),
  requestId: NonEmptyIdSchema,
  operationId: NonEmptyIdSchema,
  organizationId: NonEmptyIdSchema,
  runnerId: NonEmptyIdSchema,
  runId: NonEmptyIdSchema,
  expectedAuthority: z.object({
    credentialId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
  }).strict(),
  attempt: z.object({
    attemptId: NonEmptyIdSchema,
    attemptNumber: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingTokenDigest: ReceiptDigestSchema,
    leaseExpiresAt: ControlTimestampSchema,
  }).strict(),
  grant: HostedSourceContentGrantV1Schema,
  admissionEnvelopeDigest: ReceiptDigestSchema,
  contentEnvelope: HostedAdmissionEnvelopeV1Schema.shape.sourceContextEnvelope,
}).strict().superRefine((request, ctx) => {
  if (request.attempt.epoch !== request.attempt.attemptNumber) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attempt", "epoch"],
      message: "Attempt epoch must equal attempt number." });
  }
  if (request.grant.fenceDigest !== request.attempt.fencingTokenDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["grant", "fenceDigest"],
      message: "Grant fence must match the Attempt fence." });
  }
  if (request.grant.expiresAt !== request.attempt.leaseExpiresAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["grant", "expiresAt"],
      message: "Grant expiry must match the Attempt lease." });
  }
  if (request.grant.contentIds.length !== 1
    || request.grant.contentIds[0] !== request.contentEnvelope.contentId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["grant", "contentIds"],
      message: "Grant content must match the Admission content envelope." });
  }
  if (request.grant.keyVersion !== request.contentEnvelope.keyVersion) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["grant", "keyVersion"],
      message: "Grant key version must match the Admission content envelope." });
  }
});

export const HostedSourceContentRedeemResponseV1Schema = z.object({
  kind: z.literal("hosted_source_content_redeemed"),
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requestId: NonEmptyIdSchema,
  operationId: NonEmptyIdSchema,
  organizationId: NonEmptyIdSchema,
  runnerId: NonEmptyIdSchema,
  runId: NonEmptyIdSchema,
  attempt: HostedSourceContentRedeemRequestV1Schema.shape.attempt,
  admissionEnvelopeDigest: ReceiptDigestSchema,
  contentEnvelope: HostedAdmissionEnvelopeV1Schema.shape.sourceContextEnvelope,
  content: z.object({ contentId: NonEmptyIdSchema, payload: z.unknown() }).strict(),
  payloadDigest: ReceiptDigestSchema,
  redeemedAt: ControlTimestampSchema,
}).strict().superRefine((response, ctx) => {
  if (response.content.contentId !== response.contentEnvelope.contentId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content", "contentId"],
      message: "Redeemed content must match the content envelope." });
  }
});

export async function verifyHostedSourceContentRedeemPayloadV1(
  response: z.input<typeof HostedSourceContentRedeemResponseV1Schema>,
): Promise<boolean> {
  const parsed = HostedSourceContentRedeemResponseV1Schema.parse(response);
  const computed = await computeControlPayloadDigestV1(parsed.content.payload);
  return parsed.payloadDigest === computed
    && parsed.contentEnvelope.payloadDigest === computed;
}

const HostedClaimAuthorityV1Schema = z
  .object({
    organizationId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    runId: NonEmptyIdSchema,
    credentialId: NonEmptyIdSchema,
    registrationGeneration: z.number().int().positive(),
    credentialGeneration: z.number().int().positive(),
    projectTargetId: NonEmptyIdSchema,
    bindingId: NonEmptyIdSchema,
    targetBindingDigest: ReceiptDigestSchema,
    admissionPolicyReceiptId: NonEmptyIdSchema,
    admissionPolicySnapshotId: NonEmptyIdSchema,
    admissionPolicySnapshotDigest: ReceiptDigestSchema,
    runnerReadinessReceiptId: NonEmptyIdSchema,
    runnerReadinessReceiptDigest: ReceiptDigestSchema,
    targetReadinessReceiptId: NonEmptyIdSchema,
    targetReadinessReceiptDigest: ReceiptDigestSchema,
    executorId: NonEmptyIdSchema,
    executorCapabilityDigest: ReceiptDigestSchema,
    attemptId: NonEmptyIdSchema,
    attemptNumber: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingTokenDigest: ReceiptDigestSchema,
  })
  .strict()
  .superRefine((authority, ctx) => {
    if (authority.epoch !== authority.attemptNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epoch"],
        message: "Authority epoch must equal the Run-scoped attempt number.",
      });
    }
    if (
      authority.runnerReadinessReceiptId !== authority.targetReadinessReceiptId ||
      authority.runnerReadinessReceiptDigest !== authority.targetReadinessReceiptDigest
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetReadinessReceiptId"],
        message: "Runner and target readiness must use the same receipt tuple.",
      });
    }
  });

export const HostedClaimV1Schema = z
  .object({
    kind: z.literal("hosted_claim"),
    ...VersionedResponseShape,
    requiredCapabilities: HostedClaimRequiredCapabilitiesV1Schema,
    requestId: NonEmptyIdSchema,
    operationId: NonEmptyIdSchema,
    organizationId: NonEmptyIdSchema,
    runnerId: NonEmptyIdSchema,
    runId: NonEmptyIdSchema,
    executorId: NonEmptyIdSchema,
    hostedAdmission: HostedAdmissionEnvelopeV1Schema,
    admissionPolicySnapshot: AdmissionPolicySnapshotReceiptEnvelopeV1Schema,
    attempt: HostedClaimAttemptV1Schema,
    sourceContentGrant: HostedSourceContentGrantV1Schema,
    authority: HostedClaimAuthorityV1Schema,
  })
  .strict()
  .superRefine((claim, ctx) => {
    const admission = claim.hostedAdmission;
    const policy = claim.admissionPolicySnapshot;
    const authority = claim.authority;
    const mismatches: Array<[string[], boolean, string]> = [
      [["hostedAdmission", "organizationId"], admission.organizationId !== claim.organizationId, "Admission organization must match the claim."],
      [["hostedAdmission", "runnerId"], admission.runnerId !== claim.runnerId, "Admission Runner must match the claim."],
      [["admissionPolicySnapshot", "organizationId"], policy.organizationId !== claim.organizationId, "Policy organization must match the claim."],
      [["admissionPolicySnapshot", "runId"], policy.runId !== claim.runId, "Policy Run must match the claim."],
      [["admissionPolicySnapshot", "operationId"], policy.operationId !== admission.operationId, "Policy operation must match the admission."],
      [["admissionPolicySnapshot", "payload", "tenant", "organizationId"], policy.payload.tenant.organizationId !== claim.organizationId, "Policy tenant must match the claim."],
      [["admissionPolicySnapshot", "payload", "runner", "runnerId"], policy.payload.runner.runnerId !== claim.runnerId, "Policy Runner must match the claim."],
      [["hostedAdmission", "bindingId"], admission.bindingId !== policy.payload.target.bindingId, "Admission binding must match the policy."],
      [["hostedAdmission", "projectTarget", "projectTargetId"], admission.projectTarget.projectTargetId !== policy.payload.target.projectTargetId, "Admission target must match the policy."],
      [["hostedAdmission", "repository", "providerRepositoryId"], admission.repository.providerRepositoryId !== policy.payload.target.providerRepositoryId, "Admission repository must match the policy."],
      [["hostedAdmission", "repository", "provider"], admission.repository.provider !== policy.payload.target.repositoryProvider, "Admission repository provider must match the policy."],
      [["hostedAdmission", "verifiedActor", "providerUserId"], admission.verifiedActor.providerUserId !== policy.payload.actor.providerUserId, "Admission actor ID must match the policy."],
      [["hostedAdmission", "verifiedActor", "login"], admission.verifiedActor.login !== policy.payload.actor.login, "Admission actor login must match the policy."],
      [["admissionPolicySnapshot", "payload", "actor", "provider"], policy.payload.actor.provider !== admission.provider, "Policy actor provider must match the admission."],
      [["hostedAdmission", "verifiedActor", "authorization", "grantRef"], admission.verifiedActor.authorization.grantRef !== policy.payload.actor.authorizationRef, "Admission actor grant must match the policy."],
      [["hostedAdmission", "admissionPolicySnapshot", "snapshotId"], admission.admissionPolicySnapshot.snapshotId !== policy.payload.snapshotId, "Admission policy ID must match the receipt."],
      [["hostedAdmission", "admissionPolicySnapshot", "digest"], admission.admissionPolicySnapshot.digest !== policy.receiptDigest, "Admission policy digest must match the receipt."],
      [["authority", "organizationId"], authority.organizationId !== claim.organizationId, "Authority organization must match the claim."],
      [["authority", "runnerId"], authority.runnerId !== claim.runnerId, "Authority Runner must match the claim."],
      [["authority", "runId"], authority.runId !== claim.runId, "Authority Run must match the claim."],
      [["authority", "projectTargetId"], authority.projectTargetId !== admission.projectTarget.projectTargetId, "Authority target must match the admission."],
      [["authority", "bindingId"], authority.bindingId !== admission.bindingId, "Authority binding must match the admission."],
      [["authority", "targetBindingDigest"], authority.targetBindingDigest !== admission.projectTarget.digest, "Authority target digest must match the admission."],
      [["authority", "admissionPolicyReceiptId"], authority.admissionPolicyReceiptId !== policy.receiptId, "Authority policy receipt ID must match the receipt."],
      [["authority", "admissionPolicySnapshotId"], authority.admissionPolicySnapshotId !== policy.payload.snapshotId, "Authority policy ID must match the receipt."],
      [["authority", "admissionPolicySnapshotDigest"], authority.admissionPolicySnapshotDigest !== policy.receiptDigest, "Authority policy digest must match the receipt."],
      [["authority", "runnerReadinessReceiptDigest"], authority.runnerReadinessReceiptDigest !== policy.payload.runner.readinessReceiptDigest, "Authority readiness digest must match the policy."],
      [["authority", "executorId"], authority.executorId !== claim.executorId || authority.executorId !== policy.payload.executor.executorId, "Authority executor must match the claim and policy."],
      [["authority", "executorCapabilityDigest"], authority.executorCapabilityDigest !== policy.payload.executor.capabilityDigest, "Authority executor digest must match the policy."],
      [["authority", "attemptId"], authority.attemptId !== claim.attempt.id, "Authority Attempt ID must match the claim."],
      [["authority", "attemptNumber"], authority.attemptNumber !== claim.attempt.number, "Authority Attempt number must match the claim."],
      [["authority", "epoch"], authority.epoch !== claim.attempt.epoch, "Authority Attempt epoch must match the claim."],
      [["authority", "fencingTokenDigest"], authority.fencingTokenDigest !== claim.attempt.fencingTokenDigest, "Authority fence digest must match the claim."],
      [["sourceContentGrant", "fenceDigest"], claim.sourceContentGrant.fenceDigest !== claim.attempt.fencingTokenDigest, "Source grant fence must match the Attempt."],
      [["sourceContentGrant", "contentIds"], claim.sourceContentGrant.contentIds.length !== 1 || claim.sourceContentGrant.contentIds[0] !== admission.sourceContextEnvelope.contentId, "Source grant content must match the Admission."],
      [["sourceContentGrant", "expiresAt"], claim.sourceContentGrant.expiresAt !== claim.attempt.leaseExpiresAt, "Source grant expiry must match the Attempt lease."],
    ];
    for (const [path, mismatch, message] of mismatches) {
      if (mismatch) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    }

    if (
      claim.requiredCapabilities.length !== policy.payload.requiredRelayCapabilities.length ||
      claim.requiredCapabilities.some(
        (capability, index) => capability !== policy.payload.requiredRelayCapabilities[index],
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredCapabilities"],
        message: "Claim capabilities must match the immutable policy snapshot.",
      });
    }
  });

export function verifyHostedClaimExpectedAuthorityV1(
  request: z.input<typeof HostedClaimRequestV1Schema>,
  claim: z.input<typeof HostedClaimV1Schema>,
): boolean {
  const parsedRequest = HostedClaimRequestV1Schema.parse(request);
  const parsedClaim = HostedClaimV1Schema.parse(claim);
  const expected = parsedRequest.expectedAuthority;
  const authority = parsedClaim.authority;
  return parsedRequest.requestId === parsedClaim.requestId &&
    parsedRequest.operationId === parsedClaim.operationId &&
    expected.credentialId === authority.credentialId &&
    expected.registrationGeneration === authority.registrationGeneration &&
    expected.credentialGeneration === authority.credentialGeneration &&
    expected.runnerReadinessReceiptId === authority.runnerReadinessReceiptId &&
    expected.runnerReadinessReceiptDigest === authority.runnerReadinessReceiptDigest;
}

export function computeHostedClaimFencingTokenDigestV1(
  rawFencingToken: string,
): Promise<string> {
  return sha256Utf8V1(rawFencingToken);
}

export const RunnerProposalSettlementV1Schema = z.object({
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: z.tuple([z.literal("relay.lifecycle.v1")]),
  requestId: MaterialActionStableIdV1Schema,
  organizationId: MaterialActionStableIdV1Schema,
  runnerId: MaterialActionStableIdV1Schema,
  runId: MaterialActionStableIdV1Schema,
  attempt: MaterialActionAttemptRefV1Schema.extend({
    fencingToken: z.string().min(1).max(4096),
  }).strict(),
  candidateId: MaterialActionStableIdV1Schema,
  proposalArtifact: z.unknown(),
}).strict();

export const RunnerProposalSettlementResponseV1Schema = z.object({
  outcome: z.enum(["settled", "replayed"]),
  candidateId: MaterialActionStableIdV1Schema,
  candidateDigest: ReceiptDigestSchema,
  status: z.enum(["proposal_ready", "publication_pending"]),
}).strict();

export async function verifyHostedClaimFencingTokenDigestV1(
  claim: z.input<typeof HostedClaimV1Schema>,
): Promise<boolean> {
  const parsed = HostedClaimV1Schema.parse(claim);
  const computedDigest = await computeHostedClaimFencingTokenDigestV1(
    parsed.attempt.fencingToken,
  );
  return computedDigest === parsed.attempt.fencingTokenDigest &&
    computedDigest === parsed.authority.fencingTokenDigest;
}

export const HostedLifecycleMachineRequestIdV1Schema = z
  .string()
  .regex(/^req_[0-9a-f]{64}$/u);
export const HostedLifecycleMachineOperationIdV1Schema = z
  .string()
  .regex(/^op_[0-9a-f]{64}$/u);
export const HostedLifecycleStableIdV1Schema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => isCredentialSafeText(value));
export const HostedLifecycleRequiredCapabilitiesV1Schema = z.tuple([
  z.literal("relay.lifecycle.v1"),
]);
export const AttemptWorkspaceAttestationV1Schema = z.object({
  workspaceId: HostedLifecycleStableIdV1Schema,
  workspacePathDigest: ReceiptDigestSchema,
  repositoryPathDigest: ReceiptDigestSchema,
  worktreeIdentityDigest: ReceiptDigestSchema,
  baseRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  currentRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  currentTree: z.string().regex(/^[a-f0-9]{40}$/u),
  workspaceStateDigest: ReceiptDigestSchema,
  attemptId: HostedLifecycleStableIdV1Schema,
  attemptNumber: z.number().int().positive(),
  fencingTokenDigest: ReceiptDigestSchema,
  credentialId: HostedLifecycleStableIdV1Schema,
  leaseExpiresAt: ControlTimestampSchema,
}).strict();
export const AttemptInterruptionEvidenceV1Schema = z.object({
  state: z.literal("interrupted_evidence"),
  runId: HostedLifecycleStableIdV1Schema,
  attemptId: HostedLifecycleStableIdV1Schema,
  attemptNumber: z.number().int().positive(),
  workspaceId: HostedLifecycleStableIdV1Schema,
  workspacePathDigest: ReceiptDigestSchema,
  fencingTokenDigest: ReceiptDigestSchema,
  reason: z.enum(["lease_expired", "stale_fence", "cancelled", "credential_stale"]),
  observedAt: ControlTimestampSchema,
  processStop: z.enum(["observed", "unconfirmed"]),
  materialOutcome: z.literal("outcome_unknown"),
}).strict();
export const HostedLifecycleAttemptV1Schema = z
  .object({
    attemptId: HostedLifecycleStableIdV1Schema,
    attemptNumber: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingToken: z.string().min(1).max(4096),
    fencingTokenDigest: ReceiptDigestSchema,
  })
  .strict()
  .refine((attempt) => attempt.epoch === attempt.attemptNumber, {
    path: ["epoch"],
    message: "Attempt epoch must equal attempt number.",
  });
const HostedLifecycleRequestBaseV1Schema = z.object({
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  requiredCapabilities: HostedLifecycleRequiredCapabilitiesV1Schema,
  requestId: HostedLifecycleMachineRequestIdV1Schema,
  operationId: HostedLifecycleMachineOperationIdV1Schema,
  attempt: HostedLifecycleAttemptV1Schema,
  requestDigest: ReceiptDigestSchema,
  occurredAt: ControlTimestampSchema,
  workspaceAttestation: AttemptWorkspaceAttestationV1Schema.optional(),
  interruptionEvidence: AttemptInterruptionEvidenceV1Schema.optional(),
});
export const HostedHeartbeatRequestV1Schema = HostedLifecycleRequestBaseV1Schema
  .extend({ expectedLeaseExpiresAt: ControlTimestampSchema })
  .strict();
export const HostedRunningRequestV1Schema = HostedLifecycleRequestBaseV1Schema
  .extend({
    executorId: HostedLifecycleStableIdV1Schema,
    executorCapabilityDigest: ReceiptDigestSchema,
    runTimeoutMs: z.number().int().positive().max(86_400_000).optional(),
  })
  .strict();
export const HostedRejectStartReasonCodeV1Schema = z.enum([
  "executor_incompatible",
  "executor_unavailable",
  "target_unavailable",
  "unknown_safe_failure",
]);
export const HostedRejectStartRequestV1Schema = HostedLifecycleRequestBaseV1Schema
  .extend({
    executorId: HostedLifecycleStableIdV1Schema,
    reasonCode: HostedRejectStartReasonCodeV1Schema,
  })
  .strict();
export const HostedProgressRequestV1Schema = HostedLifecycleRequestBaseV1Schema
  .extend({
    progressId: z.string().regex(/^progress_[0-9a-f]{64}$/u),
    progressDigest: ReceiptDigestSchema,
  })
  .strict();
const HostedLifecycleSortedDigestsV1Schema = sortedUniqueArray(
  ReceiptDigestSchema,
).max(64);
const HostedExecutorResultConclusionV1Schema = z.enum([
  "success",
  "failure",
  "cancelled",
  "interrupted",
  "timed_out",
  "needs_human",
]);
export const HostedExecutorResultReasonCodeV1Schema = z.enum([
  "executor_success",
  "executor_failure",
  "executor_cancelled",
  "executor_interrupted",
  "executor_timed_out",
  "executor_needs_human",
]);
const HostedBlockedPermissionRefV1Schema = z.object({
  permissionRequestId: PermissionStableIdV1Schema,
  actionDescriptorDigest: ReceiptDigestSchema,
  policySnapshotDigest: ReceiptDigestSchema,
}).strict();
const hostedExecutorResultReasonCodeV1 = (
  conclusion: z.infer<typeof HostedExecutorResultConclusionV1Schema>,
): z.infer<typeof HostedExecutorResultReasonCodeV1Schema> =>
  `executor_${conclusion}`;
export const HostedCompleteRequestV1Schema = HostedLifecycleRequestBaseV1Schema
  .extend({
    conclusion: HostedExecutorResultConclusionV1Schema,
    reasonCode: HostedExecutorResultReasonCodeV1Schema,
    resultDigest: ReceiptDigestSchema,
    artifactDigests: HostedLifecycleSortedDigestsV1Schema,
    evidenceDigests: HostedLifecycleSortedDigestsV1Schema,
    blockedPermission: HostedBlockedPermissionRefV1Schema.optional(),
  })
  .strict()
  .refine(
    (value) => value.reasonCode === hostedExecutorResultReasonCodeV1(value.conclusion)
      && (value.conclusion === "needs_human"
        ? value.blockedPermission !== undefined
        : value.blockedPermission === undefined),
    {
      path: ["reasonCode"],
      message: "Executor result reason code must match the conclusion.",
    },
  );
export const HostedLifecycleRequestV1Schema = z.union([
  HostedHeartbeatRequestV1Schema,
  HostedRunningRequestV1Schema,
  HostedRejectStartRequestV1Schema,
  HostedProgressRequestV1Schema,
  HostedCompleteRequestV1Schema,
]);
export const HostedLifecycleReceiptPayloadV1Schema = z.discriminatedUnion(
  "operation",
  [
    z.object({
      operation: z.literal("heartbeat"),
      occurredAt: ControlTimestampSchema,
      leaseExpiresAt: ControlTimestampSchema,
      workspaceAttestation: AttemptWorkspaceAttestationV1Schema.optional(),
      interruptionEvidence: AttemptInterruptionEvidenceV1Schema.optional(),
    }).strict(),
    z.object({
      operation: z.literal("running"),
      occurredAt: ControlTimestampSchema,
      executorId: HostedLifecycleStableIdV1Schema,
      executorCapabilityDigest: ReceiptDigestSchema,
      runTimeoutMs: z.number().int().positive().max(86_400_000).optional(),
      workspaceAttestation: AttemptWorkspaceAttestationV1Schema.optional(),
      interruptionEvidence: AttemptInterruptionEvidenceV1Schema.optional(),
    }).strict(),
    z.object({
      operation: z.literal("reject_start"),
      occurredAt: ControlTimestampSchema,
      executorId: HostedLifecycleStableIdV1Schema,
      reasonCode: HostedRejectStartReasonCodeV1Schema,
      workspaceAttestation: AttemptWorkspaceAttestationV1Schema.optional(),
      interruptionEvidence: AttemptInterruptionEvidenceV1Schema.optional(),
    }).strict(),
    z.object({
      operation: z.literal("progress"),
      occurredAt: ControlTimestampSchema,
      progressId: z.string().regex(/^progress_[0-9a-f]{64}$/u),
      progressDigest: ReceiptDigestSchema,
      workspaceAttestation: AttemptWorkspaceAttestationV1Schema.optional(),
      interruptionEvidence: AttemptInterruptionEvidenceV1Schema.optional(),
    }).strict(),
    z.object({
      operation: z.literal("executor_result"),
      occurredAt: ControlTimestampSchema,
      conclusion: HostedExecutorResultConclusionV1Schema,
      reasonCode: HostedExecutorResultReasonCodeV1Schema,
      resultDigest: ReceiptDigestSchema,
      artifactDigests: HostedLifecycleSortedDigestsV1Schema,
      evidenceDigests: HostedLifecycleSortedDigestsV1Schema,
      blockedPermission: HostedBlockedPermissionRefV1Schema.optional(),
      workspaceAttestation: AttemptWorkspaceAttestationV1Schema.optional(),
      interruptionEvidence: AttemptInterruptionEvidenceV1Schema.optional(),
    }).strict(),
  ],
).refine(
  (value) =>
    value.operation !== "executor_result"
    || (value.reasonCode === hostedExecutorResultReasonCodeV1(value.conclusion)
      && (value.conclusion === "needs_human"
        ? value.blockedPermission !== undefined
        : value.blockedPermission === undefined)),
  {
    path: ["reasonCode"],
    message: "Executor result reason code must match the conclusion.",
  },
);
export const HostedLifecycleReceiptEnvelopeV1Schema = z.object({
  schemaVersion: ControlSchemaVersionSchema,
  protocolVersion: ControlProtocolVersionSchema,
  receiptKind: z.literal("attempt_lifecycle"),
  receiptId: z.string().regex(/^lifecycle_[0-9a-f]{64}$/u),
  organizationId: HostedLifecycleStableIdV1Schema,
  requestId: HostedLifecycleMachineRequestIdV1Schema,
  operationId: HostedLifecycleMachineOperationIdV1Schema,
  requestDigest: ReceiptDigestSchema,
  requiredCapabilities: HostedLifecycleRequiredCapabilitiesV1Schema,
  producer: z.object({
    kind: z.literal("runner"),
    id: HostedLifecycleStableIdV1Schema,
    credentialId: HostedLifecycleStableIdV1Schema,
  }).strict(),
  identity: z.object({
    namespace: z.literal("opentag.control.receipt/attempt-lifecycle/v1"),
    parts: z.tuple([
      HostedLifecycleStableIdV1Schema,
      HostedLifecycleStableIdV1Schema,
      HostedLifecycleStableIdV1Schema,
      z.enum([
        "heartbeat",
        "running",
        "reject_start",
        "progress",
        "executor_result",
      ]),
      HostedLifecycleMachineOperationIdV1Schema,
    ]),
  }).strict(),
  observedAt: ControlTimestampSchema,
  payloadDigest: ReceiptDigestSchema,
  receiptDigest: ReceiptDigestSchema,
  runId: HostedLifecycleStableIdV1Schema,
  attempt: z.object({
    attemptId: HostedLifecycleStableIdV1Schema,
    attemptNumber: z.number().int().positive(),
    epoch: z.number().int().positive(),
    fencingTokenDigest: ReceiptDigestSchema,
  }).strict(),
  payload: HostedLifecycleReceiptPayloadV1Schema,
}).strict();

export type HostedHeartbeatRequestV1 = z.infer<typeof HostedHeartbeatRequestV1Schema>;
export type AttemptWorkspaceAttestationV1 = z.infer<typeof AttemptWorkspaceAttestationV1Schema>;
export type AttemptInterruptionEvidenceV1 = z.infer<typeof AttemptInterruptionEvidenceV1Schema>;
export type HostedRunningRequestV1 = z.infer<typeof HostedRunningRequestV1Schema>;
export type HostedRejectStartRequestV1 = z.infer<typeof HostedRejectStartRequestV1Schema>;
export type HostedProgressRequestV1 = z.infer<typeof HostedProgressRequestV1Schema>;
export type HostedCompleteRequestV1 = z.infer<typeof HostedCompleteRequestV1Schema>;
export type HostedExecutorResultReasonCodeV1 = z.infer<
  typeof HostedExecutorResultReasonCodeV1Schema
>;
export type HostedLifecycleRequestV1 = z.infer<typeof HostedLifecycleRequestV1Schema>;
export type HostedLifecycleReceiptEnvelopeV1 = z.infer<typeof HostedLifecycleReceiptEnvelopeV1Schema>;

export type HostedLifecycleActionV1 =
  | "heartbeat"
  | "running"
  | "reject-start"
  | "progress"
  | "complete";

export async function computeHostedLifecycleRequestDigestV1(input: {
  organizationId: string;
  runnerId: string;
  runId: string;
  action: HostedLifecycleActionV1;
  request: HostedLifecycleRequestV1;
}): Promise<string> {
  const { request } = input;
  const common = {
    operation: input.action,
    organizationId: input.organizationId,
    runnerId: input.runnerId,
    runId: input.runId,
    schemaVersion: request.schemaVersion,
    protocolVersion: request.protocolVersion,
    requiredCapabilities: request.requiredCapabilities,
    attempt: {
      attemptId: request.attempt.attemptId,
      attemptNumber: request.attempt.attemptNumber,
      epoch: request.attempt.epoch,
      fencingTokenDigest: request.attempt.fencingTokenDigest,
    },
    occurredAt: request.occurredAt,
    ...(request.workspaceAttestation
      ? { workspaceAttestation: request.workspaceAttestation } : {}),
    ...(request.interruptionEvidence
      ? { interruptionEvidence: request.interruptionEvidence } : {}),
  };
  const actionFields = input.action === "heartbeat"
    ? {
        expectedLeaseExpiresAt:
          HostedHeartbeatRequestV1Schema.parse(request).expectedLeaseExpiresAt,
      }
    : input.action === "running"
      ? (() => {
          const running = HostedRunningRequestV1Schema.parse(request);
          return {
            executorId: running.executorId,
            executorCapabilityDigest: running.executorCapabilityDigest,
            ...(running.runTimeoutMs ? { runTimeoutMs: running.runTimeoutMs } : {}),
          };
        })()
      : input.action === "reject-start"
        ? (() => {
            const rejected = HostedRejectStartRequestV1Schema.parse(request);
            return {
              executorId: rejected.executorId,
              reasonCode: rejected.reasonCode,
            };
          })()
        : input.action === "progress"
          ? (() => {
              const progress = HostedProgressRequestV1Schema.parse(request);
              return {
                progressId: progress.progressId,
                progressDigest: progress.progressDigest,
              };
            })()
          : (() => {
                const complete = HostedCompleteRequestV1Schema.parse(request);
                return {
                  conclusion: complete.conclusion,
                  reasonCode: complete.reasonCode,
                  resultDigest: complete.resultDigest,
                  artifactDigests: complete.artifactDigests,
                  evidenceDigests: complete.evidenceDigests,
                  ...(complete.blockedPermission
                    ? { blockedPermission: complete.blockedPermission } : {}),
                };
              })();
  return sha256Utf8V1(canonicalJsonStringify({ ...common, ...actionFields }));
}

export function computeHostedLifecycleOperationIdV1(
  requestDigest: string,
): string {
  const parsed = ReceiptDigestSchema.parse(requestDigest);
  return HostedLifecycleMachineOperationIdV1Schema.parse(
    `op_${parsed.slice("sha256:".length)}`,
  );
}

export async function computeHostedLifecycleRequestIdV1(input: {
  operationId: string;
  requestDigest: string;
}): Promise<string> {
  const digest = await sha256Utf8V1(canonicalJsonStringify({
    purpose: "opentag-hosted-lifecycle-request-id-v1",
    operationId: HostedLifecycleMachineOperationIdV1Schema.parse(
      input.operationId,
    ),
    requestDigest: ReceiptDigestSchema.parse(input.requestDigest),
  }));
  return HostedLifecycleMachineRequestIdV1Schema.parse(
    `req_${digest.slice("sha256:".length)}`,
  );
}

export async function buildHostedLifecycleRequestV1(input: {
  organizationId: string;
  runnerId: string;
  runId: string;
  attempt: z.input<typeof HostedLifecycleAttemptV1Schema>;
  occurredAt: string;
  workspaceAttestation?: z.input<typeof AttemptWorkspaceAttestationV1Schema>;
  interruptionEvidence?: z.input<typeof AttemptInterruptionEvidenceV1Schema>;
} & (
  | { action: "heartbeat"; expectedLeaseExpiresAt: string }
  | {
      action: "running";
      executorId: string;
      executorCapabilityDigest: string;
      runTimeoutMs?: number;
    }
  | {
      action: "reject-start";
      executorId: string;
      reasonCode: z.input<typeof HostedRejectStartReasonCodeV1Schema>;
    }
  | {
      action: "progress";
      progressId: string;
      progressDigest: string;
    }
  | {
      action: "complete";
      conclusion: z.input<typeof HostedCompleteRequestV1Schema>["conclusion"];
      reasonCode: z.input<typeof HostedExecutorResultReasonCodeV1Schema>;
      resultDigest: string;
      artifactDigests: string[];
      evidenceDigests: string[];
      blockedPermission?: z.input<typeof HostedBlockedPermissionRefV1Schema>;
    }
)): Promise<HostedLifecycleRequestV1> {
  const common = {
    schemaVersion: 1 as const,
    protocolVersion: "1.0" as const,
    requiredCapabilities: ["relay.lifecycle.v1"] as const,
    requestId: `req_${"0".repeat(64)}`,
    operationId: `op_${"0".repeat(64)}`,
    attempt: HostedLifecycleAttemptV1Schema.parse(input.attempt),
    requestDigest: `sha256:${"0".repeat(64)}`,
    occurredAt: ControlTimestampSchema.parse(input.occurredAt),
    ...(input.workspaceAttestation
      ? { workspaceAttestation: AttemptWorkspaceAttestationV1Schema.parse(input.workspaceAttestation) } : {}),
    ...(input.interruptionEvidence
      ? { interruptionEvidence: AttemptInterruptionEvidenceV1Schema.parse(input.interruptionEvidence) } : {}),
  };
  const actionFields = input.action === "heartbeat"
    ? { expectedLeaseExpiresAt: input.expectedLeaseExpiresAt }
    : input.action === "running"
      ? {
          executorId: input.executorId,
          executorCapabilityDigest: input.executorCapabilityDigest,
          ...(input.runTimeoutMs ? { runTimeoutMs: input.runTimeoutMs } : {}),
        }
      : input.action === "reject-start"
        ? { executorId: input.executorId, reasonCode: input.reasonCode }
        : input.action === "progress"
          ? {
              progressId: input.progressId,
              progressDigest: input.progressDigest,
            }
          : {
                conclusion: input.conclusion,
                reasonCode: input.reasonCode,
                resultDigest: input.resultDigest,
                artifactDigests: input.artifactDigests,
                evidenceDigests: input.evidenceDigests,
                ...(input.blockedPermission
                  ? { blockedPermission: input.blockedPermission }
                  : {}),
              };
  const requestSeed = HostedLifecycleRequestV1Schema.parse({
    ...common,
    ...actionFields,
  });
  const requestDigest = await computeHostedLifecycleRequestDigestV1({
    organizationId: input.organizationId,
    runnerId: input.runnerId,
    runId: input.runId,
    action: input.action,
    request: requestSeed,
  });
  const operationId = computeHostedLifecycleOperationIdV1(requestDigest);
  return HostedLifecycleRequestV1Schema.parse({
    ...requestSeed,
    requestDigest,
    operationId,
    requestId: await computeHostedLifecycleRequestIdV1({
      operationId,
      requestDigest,
    }),
  });
}

function hostedLifecycleReceiptOperationV1(
  action: HostedLifecycleActionV1,
): HostedLifecycleReceiptEnvelopeV1["payload"]["operation"] {
  if (action === "reject-start") return "reject_start";
  if (action === "complete") return "executor_result";
  return action;
}

export async function verifyHostedLifecycleReceiptV1(input: {
  receipt: HostedLifecycleReceiptEnvelopeV1;
  request: HostedLifecycleRequestV1;
  action: HostedLifecycleActionV1;
  organizationId: string;
  runnerId: string;
  runId: string;
  credentialId: string;
}): Promise<boolean> {
  const receipt = HostedLifecycleReceiptEnvelopeV1Schema.parse(input.receipt);
  const request = HostedLifecycleRequestV1Schema.parse(input.request);
  const operation = hostedLifecycleReceiptOperationV1(input.action);
  const expectedRequestDigest = await computeHostedLifecycleRequestDigestV1({
    organizationId: input.organizationId,
    runnerId: input.runnerId,
    runId: input.runId,
    action: input.action,
    request,
  });
  const expectedRequestId = await computeHostedLifecycleRequestIdV1({
    operationId: request.operationId,
    requestDigest: request.requestDigest,
  });
  const expectedPayload = input.action === "heartbeat"
    ? receipt.payload.operation === "heartbeat"
      ? {
          operation,
          occurredAt: request.occurredAt,
          leaseExpiresAt: receipt.payload.leaseExpiresAt,
        }
      : null
    : input.action === "running"
      ? (() => {
          const value = HostedRunningRequestV1Schema.parse(request);
          return {
            operation,
            occurredAt: value.occurredAt,
            executorId: value.executorId,
            executorCapabilityDigest: value.executorCapabilityDigest,
            ...(value.runTimeoutMs ? { runTimeoutMs: value.runTimeoutMs } : {}),
          };
        })()
      : input.action === "reject-start"
        ? (() => {
            const value = HostedRejectStartRequestV1Schema.parse(request);
            return {
              operation,
              occurredAt: value.occurredAt,
              executorId: value.executorId,
              reasonCode: value.reasonCode,
            };
          })()
          : input.action === "progress"
          ? (() => {
              const value = HostedProgressRequestV1Schema.parse(request);
              return {
                operation,
                occurredAt: value.occurredAt,
                progressId: value.progressId,
                progressDigest: value.progressDigest,
              };
            })()
          : (() => {
                const value = HostedCompleteRequestV1Schema.parse(request);
                return {
                  operation,
                  occurredAt: value.occurredAt,
                  conclusion: value.conclusion,
                  reasonCode: value.reasonCode,
                  resultDigest: value.resultDigest,
                  artifactDigests: value.artifactDigests,
                  evidenceDigests: value.evidenceDigests,
                  ...(value.blockedPermission
                    ? { blockedPermission: value.blockedPermission } : {}),
                };
              })();
  if (!expectedPayload) return false;
  const expectedPayloadWithEvidence = {
    ...expectedPayload,
    ...(request.workspaceAttestation
      ? { workspaceAttestation: request.workspaceAttestation } : {}),
    ...(request.interruptionEvidence
      ? { interruptionEvidence: request.interruptionEvidence } : {}),
  };
  const { receiptDigest: _receiptDigest, ...receiptDigestInput } = receipt;
  return request.requestDigest === expectedRequestDigest
    && request.requestId === expectedRequestId
    && receipt.organizationId === input.organizationId
    && receipt.runId === input.runId
    && receipt.requestId === request.requestId
    && receipt.operationId === request.operationId
    && receipt.requestDigest === request.requestDigest
    && receipt.producer.id === input.runnerId
    && receipt.producer.credentialId === input.credentialId
    && receipt.attempt.attemptId === request.attempt.attemptId
    && receipt.attempt.attemptNumber === request.attempt.attemptNumber
    && receipt.attempt.epoch === request.attempt.epoch
    && receipt.attempt.fencingTokenDigest
      === request.attempt.fencingTokenDigest
    && receipt.identity.namespace
      === "opentag.control.receipt/attempt-lifecycle/v1"
    && canonicalJsonStringify(receipt.identity.parts)
      === canonicalJsonStringify([
        input.organizationId,
        input.runId,
        request.attempt.attemptId,
        operation,
        request.operationId,
      ])
    && receipt.payload.operation === operation
    && canonicalJsonStringify(receipt.payload)
      === canonicalJsonStringify(expectedPayloadWithEvidence)
    && receipt.payloadDigest
      === await computeControlPayloadDigestV1(receipt.payload)
    && receipt.receiptDigest
      === await computeControlReceiptDigestV1(receiptDigestInput)
    && (
      receipt.payload.operation !== "heartbeat"
      || (
        Date.parse(receipt.payload.leaseExpiresAt)
        > Date.parse(HostedHeartbeatRequestV1Schema.parse(request)
          .expectedLeaseExpiresAt)
      )
  );
}

export async function computeHostedLifecycleReceiptIdV1(input: {
  organizationId: string;
  operationId: string;
}): Promise<string> {
  const organizationId = HostedLifecycleStableIdV1Schema.parse(
    input.organizationId,
  );
  const operationId = HostedLifecycleMachineOperationIdV1Schema.parse(
    input.operationId,
  );
  const digest = await computeControlPayloadDigestV1({
    organizationId,
    operationId,
  });
  return `lifecycle_${digest.slice("sha256:".length)}`;
}

export type RelayCapability = z.infer<typeof RelayCapabilitySchema>;
export type ControlMutationRequestV1 = z.infer<typeof ControlMutationRequestV1Schema>;
export type RunnerRegistrationRequestV1 = z.infer<typeof RunnerRegistrationRequestV1Schema>;
export type RunnerCredentialReprovisionRequestV1 = z.infer<typeof RunnerCredentialReprovisionRequestV1Schema>;
export type RunnerCredentialMetadataV1 = z.infer<typeof RunnerCredentialMetadataV1Schema>;
export type RunnerCredentialResponseV1 = z.infer<typeof RunnerCredentialResponseV1Schema>;
export type RunnerCredentialRotationRequestV1 = z.infer<typeof RunnerCredentialRotationRequestV1Schema>;
export type RunnerCredentialRevocationRequestV1 = z.infer<typeof RunnerCredentialRevocationRequestV1Schema>;
export type RunnerCredentialRotationResponseV1 = z.infer<typeof RunnerCredentialRotationResponseV1Schema>;
export type RunnerCredentialRevocationResponseV1 = z.infer<typeof RunnerCredentialRevocationResponseV1Schema>;
export type RunnerCredentialCurrentStateResponseV1 = z.infer<
  typeof RunnerCredentialCurrentStateResponseV1Schema
>;
export type RunnerReadinessReceiptEnvelopeV1 = z.infer<typeof RunnerReadinessReceiptEnvelopeV1Schema>;
export type GitHubProjectTargetDeclarationV1 = z.infer<
  typeof GitHubProjectTargetDeclarationV1Schema
>;
export type GitHubProjectTargetBindingDigestInputV1 = z.infer<
  typeof GitHubProjectTargetBindingDigestInputV1Schema
>;
export type RunnerControlContextResponseV1 = z.infer<typeof RunnerControlContextResponseV1Schema>;
export type RunnerProjectTargetUpsertRequestV1 = z.infer<
  typeof RunnerProjectTargetUpsertRequestV1Schema
>;
export type RunnerProjectTargetUpsertResponseV1 = z.infer<
  typeof RunnerProjectTargetUpsertResponseV1Schema
>;
export type RunnerProposalSettlementV1 = z.infer<typeof RunnerProposalSettlementV1Schema>;
export type RunnerProposalSettlementResponseV1 = z.infer<
  typeof RunnerProposalSettlementResponseV1Schema
>;
export type MaterialActionAttemptRefV1 = z.infer<typeof MaterialActionAttemptRefV1Schema>;
export type RunnerMaterialActionReconcileAttemptV1 = z.infer<
  typeof RunnerMaterialActionReconcileAttemptV1Schema
>;
export type RunnerMaterialActionReconcileRequestV1 = z.infer<
  typeof RunnerMaterialActionReconcileRequestV1Schema
>;
export type MaterialActionBeginAuthorityV1 = z.infer<
  typeof MaterialActionBeginAuthorityV1Schema
>;
export type RunnerMaterialActionBeginV1 = z.infer<
  typeof RunnerMaterialActionBeginV1Schema
>;
export type MaterialActionPayloadV1 = z.infer<typeof MaterialActionPayloadV1Schema>;
export type MaterialActionReceiptDigestInputV1 = z.infer<
  typeof MaterialActionReceiptDigestInputV1Schema
>;
export type MaterialActionReceiptEnvelopeV1 = z.infer<
  typeof MaterialActionReceiptEnvelopeV1Schema
>;
export type MaterialActionReconcileHttpResponseV1 = z.infer<
  typeof MaterialActionReconcileHttpResponseV1Schema
>;
export type RunnerPermissionRequestV1 = z.infer<typeof RunnerPermissionRequestV1Schema>;
export type PermissionRequestDigestInputV1 = z.infer<typeof PermissionRequestDigestInputV1Schema>;
export type HumanPermissionDecisionRequestV1 = z.infer<typeof HumanPermissionDecisionRequestV1Schema>;
export type RunnerPermissionCurrentQueryV1 = z.infer<typeof RunnerPermissionCurrentQueryV1Schema>;
export type PermissionResolutionReceiptEnvelopeV1 = z.infer<
  typeof PermissionResolutionReceiptEnvelopeV1Schema
>;
export type RunnerPermissionRequestHttpResponseV1 = z.infer<
  typeof RunnerPermissionRequestHttpResponseV1Schema
>;
export type HumanPermissionDecisionHttpResponseV1 = z.infer<
  typeof HumanPermissionDecisionHttpResponseV1Schema
>;
export type PermissionResolutionCurrentHttpResponseV1 = z.infer<
  typeof PermissionResolutionCurrentHttpResponseV1Schema
>;
export type HostedAdmissionEnvelopeDigestInputV1 = z.infer<
  typeof HostedAdmissionEnvelopeDigestInputV1Schema
>;
export type HostedAdmissionEnvelopeV1 = z.infer<typeof HostedAdmissionEnvelopeV1Schema>;
export type HostedClaimRequestV1 = z.infer<typeof HostedClaimRequestV1Schema>;
export type HostedClaimExpectedAuthorityV1 = z.infer<
  typeof HostedClaimExpectedAuthorityV1Schema
>;
export type HostedClaimV1 = z.infer<typeof HostedClaimV1Schema>;
export type HostedSourceContentRedeemRequestV1 = z.infer<
  typeof HostedSourceContentRedeemRequestV1Schema
>;
export type HostedSourceContentRedeemResponseV1 = z.infer<
  typeof HostedSourceContentRedeemResponseV1Schema
>;
export type AdmissionPolicySnapshotReceiptEnvelopeV1 = z.infer<typeof AdmissionPolicySnapshotReceiptEnvelopeV1Schema>;
