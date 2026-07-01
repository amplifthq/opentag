import { createHash, randomUUID } from "node:crypto";
import {
  AdapterMutationMappingSchema,
  ActorIdentitySchema,
  ActionHintSchema,
  capabilityForMutationIntent,
  conversationKeysFromEvent,
  parseThreadActionCommand,
  permissionScopesAllowCapability,
  projectTargetRefFromEvent,
  suggestedActionCandidatesFromSnapshots,
  type ActorIdentity,
  type ActionReceiptCapability,
  type ActionReceiptContext,
  type ApplyIntentOutcome,
  type ApplyPlan,
  type MutationIntent,
  type OpenTagEvent,
  type OpenTagRunResult,
  type OpenTagRun,
  type PermissionGrant,
  type SuggestedChangesSnapshot,
  type SuggestedActionCandidate,
  type ThreadActionCommand,
  createAdapterMutationCompilerRegistry,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  PolicyRuleSchema,
  RunEventImportanceSchema,
  RunEventVisibilitySchema,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  platformCapabilityForProvider,
  readRequestTextWithLimit,
  shouldDeliverSourceReceipt
} from "@opentag/core";
import {
  applyGitHubIssueMutationOperation,
  createGitHubIssueMutationCompiler,
  type FetchLike as GitHubFetchLike
} from "@opentag/github";
import type { GitHubIssueMutationOperation } from "@opentag/github";
import type { SlackBlock } from "@opentag/slack";
import { createOpenTagRepository, migrateSchema } from "@opentag/store";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

/**
 * Parse and validate a request body, mapping ONLY request-body parse failures to
 * HTTP client errors. Oversized bodies return 413, malformed JSON returns 400,
 * and request-schema validation failures return 400 so the global onError
 * handler can return them to the client without masking unrelated internal
 * ZodError/SyntaxError as 400s. Any other error is rethrown unchanged and falls
 * through to a 500.
 */
export type DispatcherRateLimitOptions = {
  windowMs: number;
  maxRequests: number;
  now?(): number;
};

type DispatcherRateLimitBucket = {
  count: number;
  resetAt: number;
};

class RequestBodyRejectedError extends Error {
  readonly reason: "invalid_json_body" | "invalid_request_body";
  readonly publicError: string;

  constructor(input: { reason: "invalid_json_body" | "invalid_request_body"; publicError?: string }) {
    super(input.reason);
    this.name = "RequestBodyRejectedError";
    this.reason = input.reason;
    this.publicError = input.publicError ?? input.reason;
  }
}

function requestBodyTooLarge(c: Context, maxBytes: number): HTTPException {
  return new HTTPException(413, {
    res: c.json({ error: "request_body_too_large", maxBytes }, 413)
  });
}

async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
  options: { maxBytes?: number; invalidBodyError?: string } = {}
): Promise<z.infer<S>> {
  let json: unknown;
  try {
    const rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes: options.maxBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES });
    json = JSON.parse(rawBody);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) throw requestBodyTooLarge(c, err.maxBytes);
    if (err instanceof HTTPException) throw err;
    if (err instanceof SyntaxError) {
      throw new HTTPException(400, {
        res: c.json({ error: "invalid_json_body" }, 400),
        cause: new RequestBodyRejectedError({ reason: "invalid_json_body" })
      });
    }
    throw err;
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    const publicError = options.invalidBodyError ?? "invalid_request_body";
    throw new HTTPException(400, {
      res: c.json({ error: publicError, issues: result.error.issues }, 400),
      cause: new RequestBodyRejectedError({ reason: "invalid_request_body", publicError })
    });
  }
  return result.data;
}

function normalizeRateLimitedEndpoint(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
    .replace(/^([A-Z]+) \/v1\/runners\/[^/]+\/runs\/[^/]+/, "$1 /v1/runners/:runnerId/runs/:runId")
    .replace(/^([A-Z]+) \/v1\/runners\/[^/]+/, "$1 /v1/runners/:runnerId")
    .replace(/^([A-Z]+) \/v1\/repo-bindings\/[^/]+\/[^/]+\/[^/]+/, "$1 /v1/repo-bindings/:provider/:owner/:repo")
    .replace(/^([A-Z]+) \/v1\/channel-bindings\/[^/]+\/[^/]+\/[^/]+/, "$1 /v1/channel-bindings/:provider/:accountId/:conversationId")
    .replace(/^([A-Z]+) \/v1\/slack-channel-bindings\/[^/]+\/[^/]+/, "$1 /v1/slack-channel-bindings/:teamId/:channelId")
    .replace(/^([A-Z]+) \/v1\/follow-up-requests\/[^/]+/, "$1 /v1/follow-up-requests/:id")
    .replace(/^([A-Z]+) \/v1\/proposals\/[^/]+/, "$1 /v1/proposals/:proposalId")
    .replace(/^([A-Z]+) \/v1\/approvals\/[^/]+/, "$1 /v1/approvals/:approvalDecisionId")
    .replace(/^([A-Z]+) \/v1\/apply-plans\/[^/]+/, "$1 /v1/apply-plans/:applyPlanId")
    .replace(/^([A-Z]+) \/v1\/runs\/[^/]+/, "$1 /v1/runs/:runId");
}

function rateLimitRunnerId(path: string): string {
  return path.match(/^\/v1\/runners\/([^/]+)/)?.[1] ?? "none";
}

function rateLimitSourcePlatform(path: string): string {
  const channelProvider = path.match(/^\/v1\/channel-bindings\/([^/]+)/)?.[1];
  if (channelProvider) return channelProvider;
  const repoProvider = path.match(/^\/v1\/repo-bindings\/([^/]+)/)?.[1];
  if (repoProvider) return repoProvider;
  if (path.startsWith("/v1/slack-channel-bindings/")) return "slack";
  return "unknown";
}

function safeDecodeRateLimitSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function rateLimitTenant(path: string): string {
  const channel = path.match(/^\/v1\/channel-bindings\/([^/]+)\/([^/]+)/);
  if (channel) {
    const provider = safeDecodeRateLimitSegment(channel[1]) ?? "unknown";
    const accountId = safeDecodeRateLimitSegment(channel[2]) ?? "unknown";
    return `${provider}:${accountId}`;
  }

  const legacySlack = path.match(/^\/v1\/slack-channel-bindings\/([^/]+)/);
  if (legacySlack) return `slack:${safeDecodeRateLimitSegment(legacySlack[1]) ?? "unknown"}`;

  const repo = path.match(/^\/v1\/repo-bindings\/([^/]+)\/([^/]+)/);
  if (repo) {
    const provider = safeDecodeRateLimitSegment(repo[1]) ?? "unknown";
    const owner = safeDecodeRateLimitSegment(repo[2]) ?? "unknown";
    return `${provider}:${owner}`;
  }

  return "unknown";
}

function rateLimitTokenFingerprint(authorization: string | null): string {
  if (!authorization) return "none";
  return createHash("sha256").update(authorization).digest("hex").slice(0, 16);
}

function rawTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function rateLimitKey(c: Context): string {
  const path = new URL(c.req.url).pathname;
  return [
    `token=${rateLimitTokenFingerprint(c.req.raw.headers.get("authorization"))}`,
    `runner=${rateLimitRunnerId(path)}`,
    `source=${rateLimitSourcePlatform(path)}`,
    `tenant=${rateLimitTenant(path)}`,
    `endpoint=${normalizeRateLimitedEndpoint(c.req.method, path)}`
  ].join("|");
}

function createDispatcherRateLimitMiddleware(options: DispatcherRateLimitOptions) {
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new Error("rateLimit.windowMs must be a positive number.");
  }
  if (!Number.isFinite(options.maxRequests) || options.maxRequests <= 0) {
    throw new Error("rateLimit.maxRequests must be a positive number.");
  }

  const buckets = new Map<string, DispatcherRateLimitBucket>();
  const now = options.now ?? (() => Date.now());

  return async (c: Context, next: () => Promise<void>) => {
    const currentTime = now();
    const key = rateLimitKey(c);
    const existing = buckets.get(key);
    const bucket =
      existing && existing.resetAt > currentTime
        ? existing
        : { count: 0, resetAt: currentTime + options.windowMs };

    if (bucket.count >= options.maxRequests) {
      const retryAfterMs = Math.max(0, bucket.resetAt - currentTime);
      c.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
      return c.json(
        {
          error: "rate_limited",
          retryAfterMs,
          maxRequests: options.maxRequests,
          windowMs: options.windowMs
        },
        429
      );
    }

    bucket.count += 1;
    buckets.set(key, bucket);
    await next();
  };
}
import { createAdmissionRuntime, type AgentAccessProfileCheck } from "./admission.js";
import { createDefaultCallbackPresentation, type CallbackPresentation } from "./presentation.js";

type CallbackRunStatusState = Parameters<CallbackPresentation["runStatusPresentation"]>[0]["state"];

function shouldDeliverRunStatusUpdate(
  presentation: CallbackPresentation,
  input: { provider: string; state: CallbackRunStatusState }
): boolean {
  return presentation.shouldDeliverRunStatusUpdate?.(input) ?? presentation.shouldDeliverStatusUpdate(input.provider);
}

function larkLifecycleStatusMessageKey(input: { provider: string; runId: string }): string | undefined {
  return input.provider === "lark" ? `${input.runId}:status` : undefined;
}

const CreateRunnerSchema = z.object({
  runnerId: z.string().min(1),
  name: z.string().min(1)
});

const CreateRepoBindingSchema = z.object({
  provider: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  runnerId: z.string().min(1),
  workspacePath: z.string().min(1).optional(),
  defaultExecutor: z.string().min(1).optional(),
  allowedActors: z.array(z.string().min(1)).optional()
});

const CreateSlackChannelBindingSchema = z.object({
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  repoProvider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1)
});

const CreateChannelBindingSchema = z.object({
  provider: z.string().min(1),
  accountId: z.string().min(1),
  conversationId: z.string().min(1),
  repoProvider: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const UpsertPolicyRuleSchema = z.object({
  rule: PolicyRuleSchema
});

const UpsertMutationMappingSchema = z.object({
  mapping: AdapterMutationMappingSchema
});

const CreateRunSchema = z.object({
  runId: z.string().min(1),
  event: OpenTagEventSchema
});

const RecordControlPlaneEventSchema = z.object({
  type: z.string().min(1),
  severity: z.enum(["info", "warn", "error"]).optional(),
  subject: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime().optional()
});

const PruneSourceDeliveriesSchema = z.object({
  olderThan: z.string().datetime(),
  limit: z.number().int().positive().max(100_000).optional()
});

const PromoteFollowUpRequestSchema = z.object({
  runId: z.string().min(1)
});

const CompleteRunSchema = z.object({
  result: OpenTagRunResultSchema,
  idempotencyKey: z.string().min(1).max(256).optional()
});

const MarkRunningSchema = z.object({
  executor: z.string().min(1),
  runTimeoutMs: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).max(256).optional()
});

const CancelRunSchema = z.object({
  reason: z.string().min(1).optional(),
  requestedBy: z.string().min(1).optional()
});

const ApprovalDecisionInputSchema = z.object({
  id: z.string().min(1).optional(),
  approvedIntentIds: z.array(z.string().min(1)),
  rejectedIntentIds: z.array(z.string().min(1)).optional(),
  approvedBy: ActorIdentitySchema,
  approvedAt: z.string().datetime().optional(),
  scope: z.enum(["manual", "policy"]).default("manual"),
  reason: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
}).refine((value) => {
  const rejected = new Set(value.rejectedIntentIds ?? []);
  return value.approvedIntentIds.every((intentId) => !rejected.has(intentId));
}, {
  message: "approvedIntentIds and rejectedIntentIds must not overlap"
});

const ApplyPlanInputSchema = z.object({
  id: z.string().min(1).optional(),
  approvalDecisionId: z.string().min(1),
  selectedIntentIds: z.array(z.string().min(1)).optional(),
  adapter: z.string().min(1).optional(),
  execute: z.boolean().optional()
});

const ThreadActionInputSchema = z.object({
  id: z.string().min(1).optional(),
  rawText: z.string().min(1),
  actor: ActorIdentitySchema,
  callback: z.object({
    provider: z.string().min(1),
    uri: z.string().min(1),
    threadKey: z.string().min(1).optional()
  }),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const ChildRunInputSchema = z.object({
  runId: z.string().min(1),
  action: ActionHintSchema,
  commandText: z.string().min(1).optional(),
  sourceProposalId: z.string().min(1).optional(),
  sourceApplyPlanId: z.string().min(1).optional()
});

const CHILD_EVENT_METADATA_REPLAY_KEYS = [
  "sourceDeliveryId",
  "webhookDeliveryId",
  "deliveryId",
  "githubDeliveryId",
  "githubDeliveryGuid",
  "slackEventId",
  "larkEventId",
  "signatureState",
  "signatureVerified",
  "verifiedSignature",
  "webhookSignatureVerified",
  "githubSignatureVerified"
] as const;

const ProgressSchema = z.object({
  type: z.string().min(1).optional(),
  message: z.string().min(1),
  at: z.string().datetime().optional(),
  visibility: RunEventVisibilitySchema.optional(),
  importance: RunEventImportanceSchema.optional(),
  idempotencyKey: z.string().min(1).max(256).optional()
});

function childEventMetadata(parentMetadata: OpenTagEvent["metadata"], metadata?: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...parentMetadata };
  for (const key of CHILD_EVENT_METADATA_REPLAY_KEYS) {
    delete sanitized[key];
  }
  return {
    ...sanitized,
    ...(metadata ?? {})
  };
}

function childEventFromParent(input: {
  parentEvent: OpenTagEvent;
  childRunId: string;
  commandText?: string;
  actionKind: string;
  receivedAt: string;
  extraContext?: OpenTagEvent["context"];
  metadata?: Record<string, unknown>;
  permissions?: PermissionGrant[];
}): OpenTagEvent {
  return {
    ...input.parentEvent,
    id: `evt_${input.childRunId}`,
    sourceEventId: `${input.parentEvent.sourceEventId}:${input.childRunId}`,
    receivedAt: input.receivedAt,
    context: [...input.parentEvent.context, ...(input.extraContext ?? [])],
    command: {
      rawText: input.commandText ?? `Execute next action: ${input.actionKind}`,
      intent: "run",
      args: {
        parentSourceEventId: input.parentEvent.sourceEventId,
        actionKind: input.actionKind
      }
    },
    metadata: childEventMetadata(input.parentEvent.metadata, input.metadata),
    permissions: input.permissions ?? input.parentEvent.permissions
  };
}

function mappingsFromAdapterPlan(adapterPlan: unknown) {
  if (!adapterPlan || typeof adapterPlan !== "object" || Array.isArray(adapterPlan)) return [];
  const mappings = (adapterPlan as { mappings?: unknown }).mappings;
  if (!Array.isArray(mappings)) return [];
  return mappings.map((mapping) => AdapterMutationMappingSchema.parse(mapping));
}

function conversationKeyFromCallback(input: { provider: string; uri: string; threadKey?: string | undefined }): string {
  return `${input.provider}:${input.threadKey ?? input.uri}`;
}

function metadataIssueNumber(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.["issueNumber"];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sourceContainerMetadata(input: { provider: string; accountId: string; conversationId: string }): Record<string, string> {
  if (input.provider === "lark") {
    return { tenantKey: input.accountId, chatId: input.conversationId };
  }
  if (input.provider === "slack") {
    return { teamId: input.accountId, channelId: input.conversationId };
  }
  if (input.provider === "telegram") {
    return { botId: input.accountId, chatId: input.conversationId };
  }
  return { accountId: input.accountId, conversationId: input.conversationId };
}

function latestRunTimeoutMs(events: Array<{ type: string; payload: unknown }>): number | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "run.running" || !event.payload || typeof event.payload !== "object") continue;
    const runTimeoutMs = (event.payload as { runTimeoutMs?: unknown }).runTimeoutMs;
    if (typeof runTimeoutMs === "number" && Number.isInteger(runTimeoutMs) && runTimeoutMs > 0) {
      return runTimeoutMs;
    }
  }
  return undefined;
}

function githubIssueWorkItemExternalId(metadata: Record<string, unknown> | undefined): string | undefined {
  const owner = metadataString(metadata, "owner");
  const repo = metadataString(metadata, "repo");
  const issueNumber = metadataIssueNumber(metadata);
  if (!owner || !repo || !issueNumber) return undefined;
  return `${owner}/${repo}#${issueNumber}`;
}

function conversationKeysFromThreadAction(input: {
  callback: { provider: string; uri: string; threadKey?: string | undefined };
  metadata?: Record<string, unknown> | undefined;
}): string[] {
  const primary = conversationKeyFromCallback(input.callback);
  const keys = [primary];
  const issueNumber = metadataIssueNumber(input.metadata);
  if (input.callback.provider === "github" && input.callback.threadKey && issueNumber) {
    const suffix = `#${issueNumber}`;
    if (input.callback.threadKey.endsWith(suffix)) {
      keys.push(`github:${input.callback.threadKey.slice(0, -suffix.length)}`);
    }
  }
  return [...new Set(keys)];
}

function proposalMatchesWorkItem(proposal: ActionProposal, externalId: string): boolean {
  return proposal.snapshot.workThread?.workItemReference.externalId === externalId || proposal.event.workItem?.externalId === externalId;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stableId(prefix: string, parts: unknown[]): string {
  return `${prefix}_${stableHash(JSON.stringify(parts))}`;
}

function actorKeys(actor: ActorIdentity): string[] {
  return [
    actor.providerUserId,
    actor.handle,
    `${actor.provider}:${actor.providerUserId}`,
    actor.handle ? `${actor.provider}:${actor.handle}` : undefined
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function actorAllowedByList(actor: ActorIdentity, allowedActors: string[] | undefined): boolean {
  if (!allowedActors?.length) return true;
  const keys = new Set(actorKeys(actor));
  return allowedActors.some((allowedActor) => keys.has(allowedActor));
}

type ActionProposal = {
  runId: string;
  run: OpenTagRun;
  event: OpenTagEvent;
  snapshot: SuggestedChangesSnapshot;
};

type ResolvedThreadAction = {
  proposal: ActionProposal;
  selectedIntentIds: string[];
  selectedCandidates: Array<SuggestedActionCandidate & { proposal: ActionProposal }>;
};

type ResolveThreadActionResult =
  | { ok: true; resolved: ResolvedThreadAction }
  | { ok: false; reason: "no_proposal" | "no_match" | "ambiguous"; message: string; runId?: string | undefined };

function actionCandidatesFor(proposals: ActionProposal[]): Array<SuggestedActionCandidate & { proposal: ActionProposal }> {
  const candidates: Array<SuggestedActionCandidate & { proposal: ActionProposal }> = [];
  let startIndex = 1;
  for (const proposal of proposals) {
    const proposalCandidates = suggestedActionCandidatesFromSnapshots([proposal.snapshot], startIndex).map((candidate) => ({
      ...candidate,
      proposal
    }));
    candidates.push(...proposalCandidates);
    startIndex += proposalCandidates.length;
  }
  return candidates;
}

function resolveCandidateSelection(input: {
  command: ThreadActionCommand;
  proposals: ActionProposal[];
}): ResolveThreadActionResult {
  const candidates = actionCandidatesFor(input.proposals);
  if (candidates.length === 0) {
    return { ok: false, reason: "no_proposal", message: "I could not find any suggested actions for this thread." };
  }

  let selected: Array<SuggestedActionCandidate & { proposal: ActionProposal }> = [];
  const selection = input.command.selection;
  if (selection.kind === "all") {
    selected = candidates;
  } else if (selection.kind === "index") {
    selected = candidates.filter((candidate) => candidate.index === selection.index);
  } else if (selection.kind === "proposal") {
    selected = candidates.filter((candidate) => candidate.proposalId === selection.proposalId);
  } else if (selection.kind === "intent") {
    selected = candidates.filter((candidate) => candidate.intent.intentId === selection.intentId);
  } else if (selection.kind === "domain") {
    selected = candidates.filter((candidate) => candidate.intent.domain === selection.domain);
  } else if (candidates.length === 1) {
    selected = candidates;
  } else {
    return {
      ok: false,
      reason: "ambiguous",
      runId: candidates[0]?.proposal.runId,
      message: `I found ${candidates.length} suggested actions. Please reply with ${candidates
        .map((candidate) => `\`${input.command.verb} ${candidate.index}\``)
        .join(", ")} or \`${input.command.verb} all\`.`
    };
  }

  if (selected.length === 0) {
    return {
      ok: false,
      reason: "no_match",
      runId: candidates[0]?.proposal.runId,
      message: "I could not match that reply to a suggested action. Please use an action number like `apply 1`."
    };
  }

  const proposalIds = new Set(selected.map((candidate) => candidate.proposalId));
  if (proposalIds.size !== 1) {
    return {
      ok: false,
      reason: "ambiguous",
      runId: selected[0]?.proposal.runId,
      message: "That selection spans multiple proposals. Please apply or approve one proposal at a time using its action number."
    };
  }

  return {
    ok: true,
    resolved: {
      proposal: selected[0]!.proposal,
      selectedIntentIds: selected.map((candidate) => candidate.intent.intentId),
      selectedCandidates: selected
    }
  };
}

async function resolveThreadAction(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  command: ThreadActionCommand;
  callback: { provider: string; uri: string; threadKey?: string | undefined };
  metadata?: Record<string, unknown> | undefined;
}): Promise<ResolveThreadActionResult> {
  const conversationKeys = conversationKeysFromThreadAction({
    callback: input.callback,
    ...(input.metadata ? { metadata: input.metadata } : {})
  });
  const primaryConversationKey = conversationKeys[0];
  const targetWorkItemExternalId = githubIssueWorkItemExternalId(input.metadata);
  const metadataProposalId = metadataString(input.metadata, "proposalId");
  const metadataIntentId = metadataString(input.metadata, "intentId");
  if (
    metadataProposalId &&
    (input.command.selection.kind === "index" || input.command.selection.kind === "latest")
  ) {
    const stored = await input.repo.getSuggestedChanges({ proposalId: metadataProposalId });
    if (!stored) {
      return { ok: false, reason: "no_proposal", message: `I could not find proposal \`${metadataProposalId}\`.` };
    }
    const claimed = await input.repo.getRun({ runId: stored.runId });
    if (!claimed) {
      return { ok: false, reason: "no_proposal", message: "I found the proposal but not its source run." };
    }
    const proposalConversationKeys = conversationKeysFromEvent(claimed.event);
    if (!proposalConversationKeys.some((key) => conversationKeys.includes(key))) {
      return { ok: false, reason: "no_match", runId: stored.runId, message: "That proposal does not belong to this source thread." };
    }
    const proposal = { runId: stored.runId, run: claimed.run, event: claimed.event, snapshot: stored.snapshot };
    if (targetWorkItemExternalId && !proposalMatchesWorkItem(proposal, targetWorkItemExternalId)) {
      return { ok: false, reason: "no_match", runId: stored.runId, message: "That proposal does not belong to this source thread." };
    }
    return resolveCandidateSelection({
      command: metadataIntentId
        ? { ...input.command, selection: { kind: "intent", intentId: metadataIntentId } }
        : { ...input.command, selection: { kind: "proposal", proposalId: metadataProposalId } },
      proposals: [proposal]
    });
  }
  if (input.command.selection.kind === "proposal") {
    const stored = await input.repo.getSuggestedChanges({ proposalId: input.command.selection.proposalId });
    if (!stored) {
      return { ok: false, reason: "no_proposal", message: `I could not find proposal \`${input.command.selection.proposalId}\`.` };
    }
    const claimed = await input.repo.getRun({ runId: stored.runId });
    if (!claimed) {
      return { ok: false, reason: "no_proposal", message: `I found the proposal but not its source run.` };
    }
    const proposalConversationKeys = conversationKeysFromEvent(claimed.event);
    if (!proposalConversationKeys.some((key) => conversationKeys.includes(key))) {
      return { ok: false, reason: "no_match", runId: stored.runId, message: "That proposal does not belong to this source thread." };
    }
    const proposal = { runId: stored.runId, run: claimed.run, event: claimed.event, snapshot: stored.snapshot };
    if (targetWorkItemExternalId && !proposalMatchesWorkItem(proposal, targetWorkItemExternalId)) {
      return { ok: false, reason: "no_match", runId: stored.runId, message: "That proposal does not belong to this source thread." };
    }
    return resolveCandidateSelection({
      command: input.command,
      proposals: [proposal]
    });
  }

  for (const conversationKey of conversationKeys) {
    const proposals = await input.repo.listLatestSuggestedChangesForConversation({ conversationKey });
    const scopedProposals =
      conversationKey !== primaryConversationKey && targetWorkItemExternalId
        ? proposals.filter((proposal) => proposalMatchesWorkItem(proposal, targetWorkItemExternalId))
        : proposals;
    if (scopedProposals.length > 0) return resolveCandidateSelection({ command: input.command, proposals: scopedProposals });
  }
  return resolveCandidateSelection({ command: input.command, proposals: [] });
}

function isGitHubRepoEvent(event: OpenTagEvent): boolean {
  const repoProvider = event.metadata["repoProvider"];
  return repoProvider === "github" || (event.source === "github" && repoProvider === undefined);
}

function hasGitHubRepoTarget(event: OpenTagEvent): boolean {
  return isGitHubRepoEvent(event) && typeof event.metadata["owner"] === "string" && typeof event.metadata["repo"] === "string";
}

function hasGitHubIssueOrPullTarget(event: OpenTagEvent): boolean {
  return typeof event.metadata["issueNumber"] === "number" || typeof event.metadata["pullRequestNumber"] === "number";
}

function isRepoLevelGitHubIntent(intent: MutationIntent): boolean {
  return intent.action === "create_pull_request";
}

function adapterForAction(input: { event: OpenTagEvent; callbackProvider: string; selectedIntents: MutationIntent[] }): string {
  return hasGitHubRepoTarget(input.event) &&
    (hasGitHubIssueOrPullTarget(input.event) ||
      (input.selectedIntents.length > 0 && input.selectedIntents.every((intent) => isRepoLevelGitHubIntent(intent))))
    ? "github"
    : input.callbackProvider;
}

function executorConditionsFromIntent(intent: { params?: Record<string, unknown> | undefined }): string[] {
  const value = intent.params?.["executorConditions"];
  if (!Array.isArray(value)) return [];
  return value.filter((condition): condition is string => typeof condition === "string" && condition.length > 0);
}

const GITHUB_PREFLIGHT_TIMEOUT_MS = 5_000;

type GitHubPreflightCache = Map<string, Promise<ActionReceiptCapability | null>>;

function githubPreflightCacheKey(input: { owner: string; repo: string; path: string }): string {
  return `${input.owner}/${input.repo}${input.path}`;
}

function createGitHubPreflightDeadline(timeoutMs: number): { signal?: AbortSignal; clear: () => void; didTimeout: () => boolean } {
  if (typeof AbortController === "undefined") return { clear: () => {}, didTimeout: () => false };
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
    didTimeout: () => didTimeout
  };
}

type GitHubPreflightInput = {
  githubApply: GitHubApplyOptions;
  owner: string;
  repo: string;
  path: string;
  description: string;
  notFoundReason: string;
  cache?: GitHubPreflightCache;
};

async function githubPreflight(input: GitHubPreflightInput): Promise<ActionReceiptCapability | null> {
  if (input.cache) {
    const cacheKey = githubPreflightCacheKey(input);
    const cached = input.cache.get(cacheKey);
    if (cached) return await cached;
    const pending = githubPreflightUncached(input);
    input.cache.set(cacheKey, pending);
    return await pending;
  }
  return await githubPreflightUncached(input);
}

async function githubPreflightUncached(input: Omit<GitHubPreflightInput, "cache">): Promise<ActionReceiptCapability | null> {
  let response: Response;
  const deadline = createGitHubPreflightDeadline(GITHUB_PREFLIGHT_TIMEOUT_MS);
  try {
    response = await (input.githubApply.fetchImpl ?? fetch)(`https://api.github.com/repos/${input.owner}/${input.repo}${input.path}`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.githubApply.token}`,
        "x-github-api-version": "2022-11-28"
      },
      ...(deadline.signal ? { signal: deadline.signal } : {})
    });
  } catch (error) {
    if (deadline.didTimeout()) {
      return {
        state: "needs_setup",
        setupReason: `GitHub preflight timed out for ${input.description} after ${GITHUB_PREFLIGHT_TIMEOUT_MS}ms.`
      };
    }
    return {
      state: "needs_setup",
      setupReason: `GitHub preflight failed for ${input.description}: ${error instanceof Error ? error.message : String(error)}.`
    };
  } finally {
    deadline.clear();
  }

  if (response.ok) return null;

  if (response.status === 401 || response.status === 403) {
    return {
      state: "needs_setup",
      setupReason: `GitHub apply token cannot access ${input.description}. Check repository permissions and token scopes.`
    };
  }
  if (response.status === 404) {
    return {
      state: "needs_setup",
      setupReason: input.notFoundReason
    };
  }
  return {
    state: "needs_setup",
    setupReason: `GitHub preflight failed for ${input.description}: HTTP ${response.status}.`
  };
}

async function preflightGitHubOperation(input: {
  githubApply: GitHubApplyOptions;
  target: NonNullable<ReturnType<typeof githubTargetFromEvent>>;
  operation: GitHubIssueMutationOperation;
  preflightCache?: GitHubPreflightCache;
}): Promise<ActionReceiptCapability | null> {
  const base = {
    githubApply: input.githubApply,
    owner: input.target.owner,
    repo: input.target.repoName,
    ...(input.preflightCache ? { cache: input.preflightCache } : {})
  };

  if (input.operation.kind === "create_pull_request") {
    const head = encodeURIComponent(input.operation.head);
    const baseBranch = encodeURIComponent(input.operation.base);
    return (
      (await githubPreflight({
        ...base,
        path: `/branches/${head}`,
        description: `GitHub branch ${input.operation.head}`,
        notFoundReason: `GitHub branch ${input.operation.head} was not found.`
      })) ??
      (await githubPreflight({
        ...base,
        path: `/branches/${baseBranch}`,
        description: `GitHub base branch ${input.operation.base}`,
        notFoundReason: `GitHub base branch ${input.operation.base} was not found.`
      }))
    );
  }

  if (input.operation.kind === "request_review") {
    if (typeof input.target.pullRequestNumber !== "number") {
      return {
        state: "needs_setup",
        setupReason: "The source thread does not include a GitHub pull request target."
      };
    }
    return await githubPreflight({
      ...base,
      path: `/pulls/${input.target.pullRequestNumber}`,
      description: `GitHub pull request #${input.target.pullRequestNumber}`,
      notFoundReason: `GitHub pull request #${input.target.pullRequestNumber} was not found.`
    });
  }

  if (typeof input.target.issueNumber !== "number") {
    return {
      state: "needs_setup",
      setupReason: "The source thread does not include a GitHub issue or pull request target."
    };
  }
  return await githubPreflight({
    ...base,
    path: `/issues/${input.target.issueNumber}`,
    description: `GitHub issue or pull request #${input.target.issueNumber}`,
    notFoundReason: `GitHub issue or pull request #${input.target.issueNumber} was not found.`
  });
}

async function directApplyReceiptCapability(input: {
  event: OpenTagEvent;
  callbackProvider: string;
  intent: MutationIntent;
  githubApply?: GitHubApplyOptions;
  preflightCache?: GitHubPreflightCache;
}): Promise<ActionReceiptCapability> {
  const capability = capabilityForMutationIntent(input.intent);
  if (!capability) {
    return {
      state: "unsupported",
      setupReason: `No source-thread apply capability is registered for ${input.intent.action}.`
    };
  }
  if (capability.capabilityClass !== "external_write") {
    return {
      state: "unsupported",
      setupReason: "This action is audit-only for now; continue if a follow-up run should handle it."
    };
  }

  const adapter = adapterForAction({
    event: input.event,
    callbackProvider: input.callbackProvider,
    selectedIntents: [input.intent]
  });
  if (adapter !== "github") {
    return {
      state: "needs_setup",
      setupReason: `Direct apply for ${adapter} actions is not configured on this dispatcher.`
    };
  }
  if (!input.githubApply) {
    return {
      state: "needs_setup",
      setupReason: "GitHub apply is not configured on this dispatcher."
    };
  }
  if (!hasGitHubRepoTarget(input.event)) {
    return {
      state: "needs_setup",
      setupReason: "The source thread does not include a GitHub repository target."
    };
  }
  if (!isRepoLevelGitHubIntent(input.intent) && !hasGitHubIssueOrPullTarget(input.event)) {
    return {
      state: "needs_setup",
      setupReason: "The source thread does not include a GitHub issue or pull request target."
    };
  }
  if (!permissionScopesAllowCapability(input.event.permissions ?? [], capability)) {
    return {
      state: "needs_setup",
      setupReason: `Missing platform permission for ${capability.id}.`
    };
  }

  const missingExecutorConditions = (capability.requiredExecutorConditions ?? []).filter(
    (condition) => !executorConditionsFromIntent(input.intent).includes(condition)
  );
  if (missingExecutorConditions.length > 0) {
    return {
      state: "needs_setup",
      setupReason: `Missing executor condition: ${missingExecutorConditions.join(", ")}.`
    };
  }

  const githubTarget = githubTargetFromEvent(input.event);
  if (!githubTarget) {
    return {
      state: "needs_setup",
      setupReason: "The source thread does not include a GitHub repository target."
    };
  }
  const compilation = createGitHubIssueMutationCompiler({
    ...(githubTarget?.targetKind ? { targetKind: githubTarget.targetKind } : {})
  }).compile(input.intent);
  if (!compilation.ok) {
    return {
      state: compilation.outcome.outcome === "unsupported" ? "unsupported" : "needs_setup",
      setupReason: compilation.outcome.message ?? "GitHub cannot apply this action from the current source thread."
    };
  }

  const preflight = await preflightGitHubOperation({
    githubApply: input.githubApply,
    target: githubTarget,
    operation: compilation.operation as GitHubIssueMutationOperation,
    ...(input.preflightCache ? { preflightCache: input.preflightCache } : {})
  });
  if (preflight) return preflight;

  return { state: "ready_to_apply" };
}

async function actionReceiptContextForFinal(input: {
  event: OpenTagEvent;
  result: OpenTagRunResult;
  githubApply?: GitHubApplyOptions;
}): Promise<ActionReceiptContext> {
  const preflightCache: GitHubPreflightCache = new Map();
  const capabilityEntries = await Promise.all(
    (input.result.suggestedChanges ?? []).flatMap((snapshot) =>
      snapshot.intents.map(async (intent) => {
        const capability = await directApplyReceiptCapability({
          event: input.event,
          callbackProvider: input.event.callback.provider,
          intent,
          ...(input.githubApply ? { githubApply: input.githubApply } : {}),
          preflightCache
        });
        return [intent.intentId, capability] as const;
      })
    )
  );
  return { capabilityByIntentId: Object.fromEntries(capabilityEntries) };
}

async function authorizeThreadAction(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  resolved: ResolvedThreadAction;
  actor: ActorIdentity;
}): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  const repoKey = projectTargetRefFromEvent(input.resolved.proposal.event);
  if (!repoKey) {
    return { ok: false, reason: "repo_context_missing", message: "The proposal does not resolve to a repository binding." };
  }

  const binding = await input.repo.getRepoBinding(repoKey);
  if (!binding) {
    return { ok: false, reason: "repo_binding_not_found", message: "No repository binding is configured for this proposal." };
  }

  if (!actorAllowedByList(input.actor, binding.allowedActors)) {
    return {
      ok: false,
      reason: "actor_not_allowed",
      message: "This actor is not allowed to approve or apply actions for the bound repository."
    };
  }

  if (input.resolved.proposal.event.source === "slack") {
    const teamId = input.resolved.proposal.event.metadata["teamId"];
    const channelId = input.resolved.proposal.event.metadata["channelId"];
    if (typeof teamId === "string" && typeof channelId === "string") {
      const channelBinding = await input.repo.getChannelBinding({
        provider: "slack",
        accountId: teamId,
        conversationId: channelId
      });
      if (
        !channelBinding ||
        channelBinding.repoProvider !== repoKey.provider ||
        channelBinding.owner !== repoKey.owner ||
        channelBinding.repo !== repoKey.repo
      ) {
        return {
          ok: false,
          reason: "channel_binding_mismatch",
          message: "The source channel binding is missing or no longer points at the proposal repository."
        };
      }
    }
  }

  return { ok: true };
}

function stableApprovalId(input: {
  providedId?: string;
  command: ThreadActionCommand;
  resolved: ResolvedThreadAction;
  actor: ActorIdentity;
}): string {
  return input.providedId ?? stableId("approval", [
    input.resolved.proposal.snapshot.proposalId,
    input.command.verb,
    [...input.resolved.selectedIntentIds].sort(),
    actorKeys(input.actor).sort()
  ]);
}

function sortedValues(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

function sameStringSet(left: string[] | undefined, right: string[] | undefined): boolean {
  return JSON.stringify(sortedValues(left)) === JSON.stringify(sortedValues(right));
}

function sameActor(left: ActorIdentity, right: ActorIdentity): boolean {
  return left.provider === right.provider &&
    left.providerUserId === right.providerUserId &&
    (left.handle ?? "") === (right.handle ?? "") &&
    (left.organizationId ?? "") === (right.organizationId ?? "");
}

function approvalDecisionMatchesThreadAction(input: {
  decision: NonNullable<Awaited<ReturnType<ReturnType<typeof createOpenTagRepository>["getApprovalDecision"]>>>;
  command: ThreadActionCommand;
  resolved: ResolvedThreadAction;
  actor: ActorIdentity;
}): boolean {
  const approvedIntentIds = input.command.verb === "reject" ? [] : input.resolved.selectedIntentIds;
  const rejectedIntentIds = input.command.verb === "reject" ? input.resolved.selectedIntentIds : [];
  const metadata = input.decision.metadata;
  const verb = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata["verb"] : undefined;
  return input.decision.proposalId === input.resolved.proposal.snapshot.proposalId &&
    sameStringSet(input.decision.approvedIntentIds, approvedIntentIds) &&
    sameStringSet(input.decision.rejectedIntentIds, rejectedIntentIds) &&
    sameActor(input.decision.approvedBy, input.actor) &&
    verb === input.command.verb;
}

function stableApplyPlanId(input: { resolved: ResolvedThreadAction; adapter: string }): string {
  return stableId("apply", [
    input.resolved.proposal.snapshot.proposalId,
    input.adapter,
    [...input.resolved.selectedIntentIds].sort()
  ]);
}

function stableChildRunId(input: {
  command: ThreadActionCommand;
  resolved: ResolvedThreadAction;
  sourceApplyPlanId?: string;
  fallbackReason?: string;
}): string {
  return stableId("run_child", [
    input.resolved.proposal.runId,
    input.resolved.proposal.snapshot.proposalId,
    input.command.verb,
    [...input.resolved.selectedIntentIds].sort(),
    input.sourceApplyPlanId ?? "",
    input.fallbackReason ?? ""
  ]);
}

function selectedIntentsAlreadyApplied(input: { plan: ApplyPlan; selectedIntentIds: string[] }): boolean {
  return input.selectedIntentIds.every((intentId) =>
    input.plan.outcomes?.some((outcome) => outcome.intentId === intentId && outcome.outcome === "applied")
  );
}

function selectedPlanOutcomes(input: { plan: ApplyPlan; selectedIntentIds: string[] }): ApplyIntentOutcome[] {
  return (input.plan.outcomes ?? []).filter((outcome) => input.selectedIntentIds.includes(outcome.intentId));
}

function selectedIntentsHaveStaleOutcome(input: { plan: ApplyPlan; selectedIntentIds: string[] }): boolean {
  const outcomes = selectedPlanOutcomes(input);
  return outcomes.some((outcome) => outcome.outcome === "stale") && outcomes.every((outcome) => outcome.outcome !== "applied");
}

function githubTargetFromEvent(event: OpenTagEvent):
  | {
      owner: string;
      repoName: string;
      issueNumber?: number;
      pullRequestNumber?: number;
      targetKind?: "issue" | "pull_request";
    }
  | null {
  const owner = event.metadata["owner"];
  const repoName = event.metadata["repo"];
  const issueNumber = event.metadata["issueNumber"];
  const pullRequestNumber = event.metadata["pullRequestNumber"];
  if (!hasGitHubRepoTarget(event)) return null;
  if (typeof owner !== "string" || typeof repoName !== "string") return null;
  if (typeof pullRequestNumber === "number") {
    return { owner, repoName, issueNumber: pullRequestNumber, pullRequestNumber, targetKind: "pull_request" };
  }
  if (typeof issueNumber === "number") {
    return { owner, repoName, issueNumber, targetKind: "issue" };
  }
  return { owner, repoName };
}

function selectedActionSummary(candidates: ResolvedThreadAction["selectedCandidates"]): string {
  return candidates.map((candidate) => `${candidate.index}. ${candidate.intent.summary}`).join("; ");
}

function selectedActionReceiptTitle(selectionText: string): string {
  return selectionText
    .split(";")
    .map((part) => part.trim().replace(/^\d+\.\s*/, ""))
    .filter(Boolean)
    .join("; ");
}

function sentenceWithTerminalPunctuation(value: string): string {
  return /[.!?。！？]$/u.test(value) ? value : `${value}.`;
}

function addPermissionGrant(permissions: PermissionGrant[], grant: PermissionGrant): PermissionGrant[] {
  if (permissions.some((permission) => permission.scope === grant.scope)) return permissions;
  return [...permissions, grant];
}

function childRunPermissionsForThreadAction(input: { resolved: ResolvedThreadAction; command: ThreadActionCommand }): PermissionGrant[] {
  let permissions = [...(input.resolved.proposal.event.permissions ?? [])];
  if (input.command.verb === "apply" || input.command.verb === "continue") {
    permissions = addPermissionGrant(permissions, {
      scope: "repo:read",
      reason: "inspect the repository while continuing an approved source-thread action"
    });
    permissions = addPermissionGrant(permissions, {
      scope: "repo:write",
      reason: "apply an approved source-thread mutation on a run branch"
    });
  }
  if (input.resolved.selectedCandidates.some((candidate) => candidate.intent.action === "create_pull_request")) {
    permissions = addPermissionGrant(permissions, {
      scope: "pr:create",
      reason: "create the pull request approved in the source thread"
    });
  }
  return permissions;
}

function renderChildRunCreatedBody(input: {
  lead: string;
  resolved: ResolvedThreadAction;
  childRun: OpenTagRun;
  provider?: string;
  selectionText?: string;
  approvalDecisionId?: string;
  sourceApplyPlanId?: string;
  fallbackReason?: string;
}): string {
  const title = selectedActionReceiptTitle(input.selectionText ?? selectedActionSummary(input.resolved.selectedCandidates));
  if (input.provider === "slack") {
    return [
      input.lead,
      `Action: ${title}`,
      ...(input.fallbackReason ? [`Reason: ${input.fallbackReason}`] : [])
    ].join("\n");
  }
  return [
    input.lead,
    "",
    `Action: ${title}`,
    "",
    `Child run: \`${input.childRun.id}\``,
    "",
    ...(input.fallbackReason ? [`Reason: ${input.fallbackReason}`, ""] : []),
    `Audit: run \`opentag status --run ${input.childRun.id}\` locally.`
  ].join("\n");
}

function applyOutcomeSummary(outcome: ApplyIntentOutcome): string {
  if (outcome.externalUri) return `${outcome.outcome}: ${outcome.externalUri}`;
  if (outcome.message) return `${outcome.outcome}: ${outcome.message}`;
  return `${outcome.outcome}.`;
}

function applyOutcomeReceiptLines(outcomes: ApplyIntentOutcome[]): string[] {
  if (outcomes.length === 0) return ["Result: applied."];
  if (outcomes.length === 1) {
    const outcome = outcomes[0]!;
    if (outcome.externalUri) return [`Result: ${outcome.externalUri}`];
    if (outcome.message) return [`Result: ${outcome.outcome}. ${outcome.message}`];
    return [`Result: ${outcome.outcome}.`];
  }
  return ["Results:", ...outcomes.map((outcome) => `- ${applyOutcomeSummary(outcome)}`)];
}

function renderAppliedThreadActionBody(input: {
  selectionText: string;
  selectedIntentIds: string[];
  outcomes: ApplyIntentOutcome[];
}): string {
  const selectedOutcomes = input.outcomes.filter((outcome) => input.selectedIntentIds.includes(outcome.intentId));
  return [`Applied: ${sentenceWithTerminalPunctuation(selectedActionReceiptTitle(input.selectionText))}`, ...applyOutcomeReceiptLines(selectedOutcomes)].join("\n");
}

function renderAlreadyAppliedThreadActionBody(input: { selectionText: string }): string {
  return [`Already applied: ${sentenceWithTerminalPunctuation(selectedActionReceiptTitle(input.selectionText))}`, "No external write was repeated."].join("\n");
}

function renderAlreadyPlannedThreadActionBody(input: { selectionText: string }): string {
  return [`Already planned: ${sentenceWithTerminalPunctuation(selectedActionReceiptTitle(input.selectionText))}`, "OpenTag did not execute this repeated reply."].join("\n");
}

function renderStaleThreadActionBody(input: { selectionText: string; continueIndex: number }): string {
  return [
    `Stale: ${sentenceWithTerminalPunctuation(selectedActionReceiptTitle(input.selectionText))}`,
    "The target changed since this action was proposed.",
    `Reply \`continue ${input.continueIndex}\` to refresh from the current thread state.`
  ].join("\n");
}

function renderThreadActionRecordedBody(input: {
  verb: "approve" | "reject";
  selectionText: string;
  applyIndex?: number;
  directApply?: { ready: boolean; reason?: string };
}): string {
  const title = selectedActionReceiptTitle(input.selectionText);
  if (input.verb === "approve") {
    const index = input.applyIndex ?? 1;
    const nextLines = input.directApply?.ready
      ? [`Next: reply \`apply ${index}\` to write it to the system of record, or \`continue ${index}\` to continue in OpenTag.`]
      : [
          ...(input.directApply?.reason
            ? [`Direct apply is not available yet: ${sentenceWithTerminalPunctuation(input.directApply.reason)}`]
            : ["Direct apply is not available yet."]),
          `Next: reply \`continue ${index}\` to continue in OpenTag.`
        ];
    return [
      `Approved only: ${sentenceWithTerminalPunctuation(title)}`,
      "No external write was performed.",
      ...nextLines
    ].join("\n");
  }
  return [`Rejected: ${sentenceWithTerminalPunctuation(title)}`, "No external write will be performed for this action."].join("\n");
}

async function selectedDirectApplyStatus(input: {
  event: OpenTagEvent;
  callbackProvider: string;
  candidates: ResolvedThreadAction["selectedCandidates"];
  githubApply?: GitHubApplyOptions;
}): Promise<{ ready: boolean; reason?: string }> {
  if (input.candidates.length === 0) return { ready: false, reason: "No selected action was found." };
  const preflightCache: GitHubPreflightCache = new Map();
  for (const candidate of input.candidates) {
    const capability = await directApplyReceiptCapability({
      event: input.event,
      callbackProvider: input.callbackProvider,
      intent: candidate.intent,
      ...(input.githubApply ? { githubApply: input.githubApply } : {}),
      preflightCache
    });
    if (capability.state !== "ready_to_apply") {
      return {
        ready: false,
        reason: capability.setupReason ?? `Receipt state is ${capability.state}.`
      };
    }
  }
  return { ready: true };
}

function actionContextPointer(input: {
  command: ThreadActionCommand;
  resolved: ResolvedThreadAction;
  approvalDecisionId?: string;
  applyPlanId?: string;
  fallbackReason?: string;
}): OpenTagEvent["context"][number] {
  const lines = [
    "OpenTag thread action continuation.",
    `User reply: ${input.command.rawText}`,
    `Action: ${input.command.verb}`,
    `Proposal: ${input.resolved.proposal.snapshot.proposalId}`,
    `Proposal summary: ${input.resolved.proposal.snapshot.summary}`,
    `Selected actions: ${selectedActionSummary(input.resolved.selectedCandidates)}`,
    `Selected intents: ${input.resolved.selectedIntentIds.join(", ")}`,
    `Previous run: ${input.resolved.proposal.runId}`,
    `Previous summary: ${input.resolved.proposal.run.result?.summary ?? input.resolved.proposal.snapshot.summary}`
  ];
  if (input.approvalDecisionId) lines.push(`Approval decision: ${input.approvalDecisionId}`);
  if (input.applyPlanId) lines.push(`Apply plan: ${input.applyPlanId}`);
  if (input.fallbackReason) lines.push(`Fallback reason: ${input.fallbackReason}`);
  return {
    kind: "text",
    uri: lines.join("\n"),
    visibility: input.resolved.proposal.event.source === "github" ? "public" : "organization",
    title: "OpenTag approved action context"
  };
}

async function createChildRunForThreadAction(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  command: ThreadActionCommand;
  resolved: ResolvedThreadAction;
  runId?: string;
  approvalDecisionId?: string;
  sourceApplyPlanId?: string;
  fallbackReason?: string;
}): Promise<OpenTagRun> {
  const runId = input.runId ?? stableChildRunId(input);
  const action = ActionHintSchema.parse({
    kind: "apply_suggested_changes",
    targetId: input.resolved.proposal.snapshot.proposalId,
    selectedIntentIds: input.resolved.selectedIntentIds,
    metadata: {
      threadActionVerb: input.command.verb,
      rawText: input.command.rawText,
      ...(input.command.reason ? { reason: input.command.reason } : {}),
      ...(input.approvalDecisionId ? { approvalDecisionId: input.approvalDecisionId } : {}),
      ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {})
    }
  });
  const previousRunSummary = input.resolved.proposal.run.result?.summary ?? input.resolved.proposal.snapshot.summary;
  const commandText =
    input.command.verb === "continue"
      ? `Continue approved OpenTag action: ${selectedActionSummary(input.resolved.selectedCandidates)}`
      : `Continue because OpenTag could not directly apply approved action: ${selectedActionSummary(input.resolved.selectedCandidates)}`;
  const { run } = await input.repo.createRun({
    id: runId,
    event: childEventFromParent({
      parentEvent: input.resolved.proposal.event,
      childRunId: runId,
      actionKind: action.kind,
      commandText,
      receivedAt: new Date().toISOString(),
      extraContext: [
        actionContextPointer({
          command: input.command,
          resolved: input.resolved,
          ...(input.approvalDecisionId ? { approvalDecisionId: input.approvalDecisionId } : {}),
          ...(input.sourceApplyPlanId ? { applyPlanId: input.sourceApplyPlanId } : {}),
          ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {})
        })
      ],
      metadata: {
        parentRunId: input.resolved.proposal.runId,
        sourceProposalId: input.resolved.proposal.snapshot.proposalId,
        selectedIntentIds: input.resolved.selectedIntentIds,
        threadActionVerb: input.command.verb,
        previousRunSummary,
        ...(input.approvalDecisionId ? { approvalDecisionId: input.approvalDecisionId } : {}),
        ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {}),
        ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {})
      },
      permissions: childRunPermissionsForThreadAction({ resolved: input.resolved, command: input.command })
    }),
    parentRunId: input.resolved.proposal.runId,
    triggeredByAction: action,
    sourceProposalId: input.resolved.proposal.snapshot.proposalId,
    ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {})
  });
  return run;
}

export type CallbackMessage = {
  runId: string;
  kind: "acknowledgement" | "progress" | "final";
  provider: string;
  uri: string;
  body: string;
  agentId?: string;
  threadKey?: string;
  statusMessageKey?: string;
  externalMessageId?: string;
  blocks?: SlackBlock[];
  rich?: {
    provider: string;
    payload: unknown;
  };
};

export type CallbackDeliveryResult = {
  externalMessageId?: string;
};

export type CallbackSink = {
  deliver(message: CallbackMessage): Promise<void | CallbackDeliveryResult>;
};

export type SourceReceiptState = "received" | "running";

export type SourceReceiptDelivery = {
  delivered: boolean;
};

export type SourceReceipt = {
  runId: string;
  provider: string;
  state: SourceReceiptState;
  event: OpenTagEvent;
  agentId?: string;
};

export type SourceReceiptSink = {
  deliver(receipt: SourceReceipt): Promise<SourceReceiptDelivery>;
};

export type CallbackRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: Date;
};

export type GitHubApplyOptions = {
  token: string;
  fetchImpl?: GitHubFetchLike;
};

async function executeGitHubApplyPlan(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  plan: ApplyPlan;
  resolved: ResolvedThreadAction;
  githubApply?: GitHubApplyOptions;
}): Promise<{ plan: ApplyPlan; executed: boolean; fallbackReason?: string }> {
  if (input.plan.adapter !== "github") {
    return { plan: input.plan, executed: false, fallbackReason: `Adapter ${input.plan.adapter ?? "unknown"} is not directly executable yet.` };
  }
  if (!input.githubApply) {
    return { plan: input.plan, executed: false, fallbackReason: "GitHub apply is not configured on this dispatcher." };
  }

  const target = githubTargetFromEvent(input.resolved.proposal.event);
  if (!target) {
    return { plan: input.plan, executed: false, fallbackReason: "The source run does not include a GitHub issue or pull request target." };
  }

  const preflightOutcomeByIntentId = new Map((input.plan.outcomes ?? []).map((outcome) => [outcome.intentId, outcome]));
  const executableIntents = input.resolved.proposal.snapshot.intents.filter((intent) => {
    if (!input.resolved.selectedIntentIds.includes(intent.intentId)) return false;
    const outcome = preflightOutcomeByIntentId.get(intent.intentId);
    return outcome?.outcome === "skipped" && outcome.message?.startsWith("Preflight passed");
  });
  if (executableIntents.length === 0) {
    return { plan: input.plan, executed: false, fallbackReason: "No selected intent has a direct adapter execution path." };
  }

  const executedOutcomes: ApplyIntentOutcome[] = [];
  const compilerRegistry = createAdapterMutationCompilerRegistry([
    createGitHubIssueMutationCompiler({
      mappings: mappingsFromAdapterPlan(input.plan.adapterPlan),
      ...(target.targetKind ? { targetKind: target.targetKind } : {})
    })
  ]);
  for (const compilation of compilerRegistry.compile("github", executableIntents)) {
    if (!compilation.ok) {
      executedOutcomes.push(compilation.outcome);
      continue;
    }
    executedOutcomes.push(
      await applyGitHubIssueMutationOperation({
        target: {
          token: input.githubApply.token,
          owner: target.owner,
          repo: target.repoName,
          ...(typeof target.issueNumber === "number" ? { issueNumber: target.issueNumber } : {}),
          ...(target.pullRequestNumber ? { pullRequestNumber: target.pullRequestNumber } : {})
        },
        operation: compilation.operation as GitHubIssueMutationOperation,
        ...(input.githubApply.fetchImpl ? { fetchImpl: input.githubApply.fetchImpl } : {})
      })
    );
  }

  const executedOutcomeByIntentId = new Map(executedOutcomes.map((outcome) => [outcome.intentId, outcome]));
  const mergedOutcomes = (input.plan.outcomes ?? []).map((outcome) => executedOutcomeByIntentId.get(outcome.intentId) ?? outcome);
  const updated = await input.repo.updateApplyPlanOutcomes({
    id: input.plan.id,
    outcomes: mergedOutcomes,
    externalWritesExecuted: true
  });
  const plan = updated ?? input.plan;
  const allSelectedApplied = input.resolved.selectedIntentIds.every((intentId) =>
    plan.outcomes?.some((outcome) => outcome.intentId === intentId && outcome.outcome === "applied")
  );
  return {
    plan,
    executed: allSelectedApplied,
    ...(allSelectedApplied ? {} : { fallbackReason: "Some selected intents were not directly applied." })
  };
}

const noopCallbackSink: CallbackSink = {
  async deliver() {
    return;
  }
};

const noopSourceReceiptSink: SourceReceiptSink = {
  async deliver() {
    return { delivered: false };
  }
};

function nextCallbackAttemptAt(input: { attempts: number } & CallbackRetryOptions): string | undefined {
  const maxAttempts = input.maxAttempts ?? 5;
  const nextAttempt = input.attempts + 1;
  if (nextAttempt >= maxAttempts) return undefined;

  const baseDelayMs = input.baseDelayMs ?? 5_000;
  const maxDelayMs = input.maxDelayMs ?? 300_000;
  const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, input.attempts));
  return new Date((input.now ?? new Date()).getTime() + delayMs).toISOString();
}

async function deliverCallbackDelivery(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: CallbackSink;
  delivery: import("@opentag/store").CallbackDelivery;
  retry?: CallbackRetryOptions;
}): Promise<boolean> {
  try {
    const externalMessageId =
      input.delivery.externalMessageId ??
      (input.delivery.statusMessageKey
        ? await input.repo.findCallbackExternalMessageId({
            runId: input.delivery.runId,
            provider: input.delivery.provider,
            ...(input.delivery.threadKey ? { threadKey: input.delivery.threadKey } : {}),
            statusMessageKey: input.delivery.statusMessageKey
          })
        : undefined);
    const deliveryResult = await input.sink.deliver({
      runId: input.delivery.runId,
      kind: input.delivery.kind,
      provider: input.delivery.provider,
      uri: input.delivery.uri,
      body: input.delivery.body,
      ...(input.delivery.threadKey ? { threadKey: input.delivery.threadKey } : {}),
      ...(input.delivery.agentId ? { agentId: input.delivery.agentId } : {}),
      ...(input.delivery.statusMessageKey ? { statusMessageKey: input.delivery.statusMessageKey } : {}),
      ...(externalMessageId ? { externalMessageId } : {}),
      ...(input.delivery.blocks ? { blocks: input.delivery.blocks as SlackBlock[] } : {}),
      ...(input.delivery.rich ? { rich: input.delivery.rich as NonNullable<CallbackMessage["rich"]> } : {})
    });
    const deliveredExternalMessageId = deliveryResult?.externalMessageId ?? externalMessageId;
    await input.repo.markCallbackDelivered({
      deliveryId: input.delivery.id,
      ...(deliveredExternalMessageId ? { externalMessageId: deliveredExternalMessageId } : {})
    });
    return true;
  } catch (error) {
    const maxAttempts = input.retry?.maxAttempts ?? 5;
    const nextAttemptAt = nextCallbackAttemptAt({ attempts: input.delivery.attempts, ...(input.retry ?? {}) });
    await input.repo.markCallbackFailed({
      deliveryId: input.delivery.id,
      error: error instanceof Error ? error.message : String(error),
      maxAttempts,
      ...(nextAttemptAt ? { nextAttemptAt } : {})
    });
    return false;
  }
}

export async function processPendingCallbacks(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: CallbackSink;
  limit?: number;
  retry?: CallbackRetryOptions;
}): Promise<{ processed: number; delivered: number; failed: number }> {
  const maxAttempts = input.retry?.maxAttempts ?? 5;
  const deliveries = await input.repo.claimPendingCallbackDeliveries({
    limit: input.limit ?? 20,
    ...(input.retry?.now ? { now: input.retry.now } : {}),
    maxAttempts
  });
  const result = { processed: 0, delivered: 0, failed: 0 };
  for (const delivery of deliveries) {
    result.processed += 1;
    const delivered = await deliverCallbackDelivery({
      repo: input.repo,
      sink: input.sink,
      delivery,
      ...(input.retry ? { retry: input.retry } : {})
    });
    if (delivered) {
      result.delivered += 1;
    } else {
      result.failed += 1;
    }
  }
  return result;
}

async function deliverAndAudit(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: CallbackSink;
  message: CallbackMessage;
  retry?: CallbackRetryOptions;
}): Promise<void> {
  const delivery = await input.repo.enqueueCallbackDelivery({
    runId: input.message.runId,
    kind: input.message.kind,
    provider: input.message.provider,
    uri: input.message.uri,
    body: input.message.body,
    ...(input.message.threadKey ? { threadKey: input.message.threadKey } : {}),
    ...(input.message.agentId ? { agentId: input.message.agentId } : {}),
    ...(input.message.statusMessageKey ? { statusMessageKey: input.message.statusMessageKey } : {}),
    ...(input.message.blocks ? { blocks: input.message.blocks } : {}),
    ...(input.message.rich ? { rich: input.message.rich } : {})
  });
  await deliverCallbackDelivery({
    repo: input.repo,
    sink: input.sink,
    delivery,
    ...(input.retry ? { retry: input.retry } : {})
  });
}

async function deliverSourceReceiptBestEffort(input: {
  repo: ReturnType<typeof createOpenTagRepository>;
  sink: SourceReceiptSink;
  receipt: SourceReceipt;
}): Promise<SourceReceiptDelivery> {
  try {
    const result = await input.sink.deliver(input.receipt);
    if (!result.delivered) return result;
    await input.repo.appendRunEvent({
      runId: input.receipt.runId,
      type: "source_receipt.delivered",
      payload: {
        provider: input.receipt.provider,
        state: input.receipt.state
      },
      visibility: "audit",
      importance: "low",
      message: `Source ${input.receipt.state} receipt delivered.`
    });
    return result;
  } catch (error) {
    await input.repo.appendRunEvent({
      runId: input.receipt.runId,
      type: "source_receipt.failed",
      payload: {
        provider: input.receipt.provider,
        state: input.receipt.state,
        error: error instanceof Error ? error.message : String(error)
      },
      visibility: "audit",
      importance: "low",
      message: `Source ${input.receipt.state} receipt failed.`
    });
    return { delivered: false };
  }
}

type DispatcherAuthScope = "pairing" | "runner_runtime" | "runner_operator";
type DispatcherAuthResult =
  | { ok: true }
  | {
      ok: false;
      reason: "invalid_pairing_token" | "invalid_runner_token" | "invalid_dispatcher_token" | "runner_token_revoked";
      message?: string;
    };

function isRunnerRuntimeEndpoint(method: string, path: string): boolean {
  if (method !== "POST") return false;
  if (/^\/v1\/runners\/[^/]+\/claim$/.test(path)) return true;
  if (/^\/v1\/runners\/[^/]+\/runs\/[^/]+\/(running|heartbeat|progress|complete)$/.test(path)) return true;
  return /^\/v1\/runs\/[^/]+\/(running|progress|complete)$/.test(path);
}

function isRunnerOperatorEndpoint(method: string, path: string): boolean {
  if (method === "GET") {
    if (path === "/v1/control-plane-alerts") return true;
    if (/^\/v1\/runners\/[^/]+$/.test(path)) return true;
    if (/^\/v1\/repo-bindings\/[^/]+\/[^/]+\/[^/]+$/.test(path)) return true;
    if (/^\/v1\/channel-bindings\/[^/]+\/[^/]+\/[^/]+(?:\/status)?$/.test(path)) return true;
    return /^\/v1\/runs\/[^/]+(?:\/events|\/metrics)?$/.test(path);
  }
  if (method !== "POST") return false;
  if (path === "/v1/source-deliveries/prune") return true;
  if (/^\/v1\/runs\/[^/]+\/cancel$/.test(path)) return true;
  return /^\/v1\/channel-bindings\/[^/]+\/[^/]+\/[^/]+\/cancel-active-run$/.test(path);
}

function dispatcherAuthScope(request: Request): DispatcherAuthScope {
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  if (isRunnerRuntimeEndpoint(method, path)) return "runner_runtime";
  if (isRunnerOperatorEndpoint(method, path)) return "runner_operator";
  return "pairing";
}

function authMatches(request: Request, token: string | undefined): boolean {
  return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length);
}

function configuredRunnerTokens(input: { runnerToken?: string; runnerTokens?: string[] }): string[] {
  return [...new Set([input.runnerToken, ...(input.runnerTokens ?? [])].map((token) => token?.trim()).filter((token): token is string => Boolean(token)))];
}

function normalizeRevokedRunnerTokenFingerprints(fingerprints: string[] | undefined): Set<string> {
  return new Set((fingerprints ?? []).map((fingerprint) => fingerprint.trim().toLowerCase()).filter(Boolean));
}

function authMatchesAny(request: Request, tokens: string[]): boolean {
  return tokens.some((token) => authMatches(request, token));
}

function requestUsesRevokedRunnerToken(input: { request: Request; revokedRunnerTokenFingerprints: Set<string> }): boolean {
  const token = bearerToken(input.request);
  if (!token) return false;
  return input.revokedRunnerTokenFingerprints.has(rawTokenFingerprint(token).toLowerCase());
}

function revokedRunnerTokenResult(): DispatcherAuthResult {
  return {
    ok: false,
    reason: "runner_token_revoked",
    message: "Runner token has been revoked or expired. Pair again or update daemon.runnerToken before retrying."
  };
}

function authorizeDispatcherRequest(input: {
  request: Request;
  pairingToken: string | undefined;
  runnerTokens: string[];
  revokedRunnerTokenFingerprints: Set<string>;
}): DispatcherAuthResult {
  if (!input.pairingToken && input.runnerTokens.length === 0) return { ok: true };

  const revokedRunnerToken = requestUsesRevokedRunnerToken({
    request: input.request,
    revokedRunnerTokenFingerprints: input.revokedRunnerTokenFingerprints
  });
  if (revokedRunnerToken) return revokedRunnerTokenResult();

  const scope = dispatcherAuthScope(input.request);
  const pairingMatches = authMatches(input.request, input.pairingToken);
  const runnerMatches = authMatchesAny(input.request, input.runnerTokens);

  if (scope === "pairing") {
    return pairingMatches ? { ok: true } : { ok: false, reason: "invalid_pairing_token" };
  }

  if (scope === "runner_runtime") {
    if (input.runnerTokens.length > 0) {
      return runnerMatches ? { ok: true } : { ok: false, reason: "invalid_runner_token" };
    }
    return pairingMatches ? { ok: true } : { ok: false, reason: "invalid_pairing_token" };
  }

  return runnerMatches || pairingMatches ? { ok: true } : { ok: false, reason: "invalid_dispatcher_token" };
}

export function createDispatcherApp(input: {
  databasePath: string;
  callbackSink?: CallbackSink;
  sourceReceiptSink?: SourceReceiptSink;
  pairingToken?: string;
  runnerToken?: string;
  runnerTokens?: string[];
  revokedRunnerTokenFingerprints?: string[];
  presentation?: CallbackPresentation;
  githubApply?: GitHubApplyOptions;
  callbackRetry?: CallbackRetryOptions;
  agentAccessProfileCheck?: AgentAccessProfileCheck;
  maxRequestBodyBytes?: number;
  rateLimit?: DispatcherRateLimitOptions | false;
}) {
  const sqlite = new Database(input.databasePath);
  migrateSchema(sqlite);
  const repo = createOpenTagRepository(drizzle(sqlite));
  const app = new Hono();
  const callbackSink = input.callbackSink ?? noopCallbackSink;
  const sourceReceiptSink = input.sourceReceiptSink ?? noopSourceReceiptSink;
  const presentation = input.presentation ?? createDefaultCallbackPresentation();
  const callbackRetry = input.callbackRetry ?? {};
  const maxRequestBodyBytes = input.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  const runnerTokens = configuredRunnerTokens(input);
  const revokedRunnerTokenFingerprints = normalizeRevokedRunnerTokenFingerprints(input.revokedRunnerTokenFingerprints);
  const requestEndpoint = (c: Context) => normalizeRateLimitedEndpoint(c.req.method, new URL(c.req.url).pathname);
  const recordControlPlaneEvent = async (input: {
    type: string;
    severity?: "info" | "warn" | "error" | undefined;
    subject?: string | undefined;
    payload?: Record<string, unknown> | undefined;
    createdAt?: string | undefined;
  }) => {
    await repo.appendControlPlaneEvent({
      type: input.type,
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {})
    });
  };
  const parseDispatcherBody = async <S extends z.ZodTypeAny>(
    c: Context,
    schema: S,
    options: { invalidBodyError?: string } = {}
  ): Promise<z.infer<S>> => {
    try {
      return await parseBody(c, schema, { maxBytes: maxRequestBodyBytes, ...options });
    } catch (err) {
      if (err instanceof HTTPException && err.status === 413) {
        await recordControlPlaneEvent({
          type: "security.request_body_rejected",
          severity: "warn",
          subject: requestEndpoint(c),
          payload: {
            reason: "request_body_too_large",
            endpoint: requestEndpoint(c),
            maxBytes: maxRequestBodyBytes,
            contentLength: c.req.raw.headers.get("content-length") ?? null
          }
        });
      }
      if (err instanceof HTTPException && err.status === 400 && err.cause instanceof RequestBodyRejectedError) {
        await recordControlPlaneEvent({
          type: "security.request_body_rejected",
          severity: "warn",
          subject: requestEndpoint(c),
          payload: {
            reason: err.cause.reason,
            error: err.cause.publicError,
            endpoint: requestEndpoint(c),
            contentLength: c.req.raw.headers.get("content-length") ?? null
          }
        });
      }
      throw err;
    }
  };

  const appendSuppressedRunStatusCallback = async (input: {
    runId: string;
    provider: string;
    state: CallbackRunStatusState;
  }): Promise<void> => {
    const capability = platformCapabilityForProvider(input.provider);
    await repo.appendRunEvent({
      runId: input.runId,
      type: "callback.progress.suppressed",
      payload: {
        provider: input.provider,
        reason: "platform_liveness_strategy",
        requestedStatus: input.state,
        livenessStrategy: capability?.livenessStrategy ?? "unknown"
      },
      visibility: "audit",
      importance: "low",
      message: "Run status callback suppressed by platform liveness strategy; use status or audit for details."
    });
  };

  async function deliverPromotedFollowUpAcknowledgement(input: {
    run: OpenTagRun;
    event: OpenTagEvent;
  }): Promise<void> {
    if (!presentation.shouldDeliverAcknowledgement(input.event.callback.provider)) return;
    const acknowledgementPresentation = presentation.acknowledgementPresentation({ runId: input.run.id });
    const acknowledgement = presentation.render({
      provider: input.event.callback.provider,
      presentation: acknowledgementPresentation
    });
    const statusMessageKey = larkLifecycleStatusMessageKey({ provider: input.event.callback.provider, runId: input.run.id });
    await deliverAndAudit({
      repo,
      sink: callbackSink,
      retry: callbackRetry,
      message: {
        runId: input.run.id,
        kind: "acknowledgement",
        provider: input.event.callback.provider,
        uri: input.event.callback.uri,
        body: acknowledgement.body,
        ...(input.event.target.agentId ? { agentId: input.event.target.agentId } : {}),
        ...(input.event.callback.threadKey ? { threadKey: input.event.callback.threadKey } : {}),
        ...(statusMessageKey ? { statusMessageKey } : {}),
        ...(acknowledgement.blocks?.length ? { blocks: acknowledgement.blocks } : {}),
        ...(acknowledgement.rich ? { rich: acknowledgement.rich } : {})
      }
    });
  }

  async function promoteFollowUpRequest(input: {
    followUpRequestId: string;
    runId: string;
  }): Promise<{ followUpRequest: import("@opentag/core").FollowUpRequest; run: OpenTagRun }> {
    const promoted = await repo.createRunFromFollowUpRequest(input);
    await deliverPromotedFollowUpAcknowledgement({
      run: promoted.run,
      event: promoted.followUpRequest.event
    });
    return promoted;
  }

  async function promoteNextFollowUpAfterTerminalRun(input: {
    activeRunId: string;
  }): Promise<{ followUpRequest: import("@opentag/core").FollowUpRequest; run: OpenTagRun } | null> {
    const [next] = await repo.listQueuedFollowUpsForActiveRun({ activeRunId: input.activeRunId });
    if (!next) return null;

    try {
      const promoted = await promoteFollowUpRequest({
        followUpRequestId: next.id,
        runId: `run_${randomUUID()}`
      });
      await repo.appendRunEvent({
        runId: input.activeRunId,
        type: "follow_up_request.auto_promoted",
        payload: {
          followUpRequestId: promoted.followUpRequest.id,
          createdRunId: promoted.run.id
        },
        visibility: "audit",
        importance: "normal",
        message: `Promoted queued follow-up ${promoted.followUpRequest.id} into run ${promoted.run.id}.`
      });
      return promoted;
    } catch (error) {
      await repo.appendRunEvent({
        runId: input.activeRunId,
        type: "follow_up_request.auto_promote_failed",
        payload: {
          followUpRequestId: next.id,
          error: error instanceof Error ? error.message : String(error)
        },
        visibility: "audit",
        importance: "high",
        message: `Could not auto-promote queued follow-up ${next.id}.`
      });
      return null;
    }
  }
  const admission = createAdmissionRuntime({
    repo,
    ...(input.agentAccessProfileCheck ? { agentAccessProfileCheck: input.agentAccessProfileCheck } : {})
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  if (input.rateLimit) {
    app.use("/v1/*", createDispatcherRateLimitMiddleware(input.rateLimit));
  }

  app.use("/v1/*", async (c, next) => {
    const authorization = authorizeDispatcherRequest({
      request: c.req.raw,
      pairingToken: input.pairingToken,
      runnerTokens,
      revokedRunnerTokenFingerprints
    });
    if (!authorization.ok) {
      await recordControlPlaneEvent({
        type: "security.auth_failed",
        severity: "warn",
        subject: requestEndpoint(c),
        payload: {
          reason: authorization.reason,
          endpoint: requestEndpoint(c),
          hasAuthorization: Boolean(c.req.raw.headers.get("authorization")),
          tokenFingerprint: rateLimitTokenFingerprint(c.req.raw.headers.get("authorization"))
        }
      });
      return c.json(
        {
          error: "unauthorized",
          reason: authorization.reason,
          ...(authorization.message ? { message: authorization.message } : {})
        },
        401
      );
    }
    await next();
  });

  app.get("/v1/control-plane-events", async (c) => {
    const limitValue = Number(c.req.query("limit") ?? 100);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, Math.floor(limitValue))) : 100;
    const eventQuery: { limit: number; type?: string; severity?: "info" | "warn" | "error" } = { limit };
    const type = c.req.query("type");
    const severity = c.req.query("severity");
    if (type) eventQuery.type = type;
    if (severity === "info" || severity === "warn" || severity === "error") eventQuery.severity = severity;
    const events = await repo.listControlPlaneEvents(eventQuery);
    return c.json({ events });
  });

  app.post("/v1/control-plane-events", async (c) => {
    const parsed = await parseDispatcherBody(c, RecordControlPlaneEventSchema);
    await recordControlPlaneEvent(parsed);
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/control-plane-alerts", async (c) => {
    const limitValue = Number(c.req.query("limit") ?? 5_000);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(10_000, Math.floor(limitValue))) : 5_000;
    const since = c.req.query("since");
    const alerts = await repo.summarizeControlPlaneAlerts({
      limit,
      ...(since ? { since } : {})
    });
    return c.json({ alerts });
  });

  app.post("/v1/source-deliveries/prune", async (c) => {
    const parsed = await parseDispatcherBody(c, PruneSourceDeliveriesSchema);
    const pruneInput = {
      olderThan: parsed.olderThan,
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {})
    };
    const result = await repo.pruneSourceDeliveries(pruneInput);
    await recordControlPlaneEvent({
      type: "maintenance.source_deliveries_pruned",
      severity: "info",
      subject: "source_deliveries",
      payload: {
        olderThan: parsed.olderThan,
        limit: parsed.limit ?? null,
        scanned: result.scanned,
        pruned: result.pruned,
        retainedActive: result.retainedActive
      }
    });
    return c.json({ result });
  });

  app.post("/v1/runners", async (c) => {
    const parsed = await parseDispatcherBody(c, CreateRunnerSchema);
    await repo.registerRunner(parsed);
    await recordControlPlaneEvent({
      type: "runner.registered",
      severity: "info",
      subject: parsed.runnerId,
      payload: {
        runnerId: parsed.runnerId,
        name: parsed.name
      }
    });
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/runners/:runnerId", async (c) => {
    const runner = await repo.getRunner({ runnerId: c.req.param("runnerId") });
    if (!runner) return c.json({ error: "runner_not_found" }, 404);
    return c.json({ runner });
  });

  app.post("/v1/repo-bindings", async (c) => {
    const parsed = await parseDispatcherBody(c, CreateRepoBindingSchema);
    await repo.createRepoBinding({
      provider: parsed.provider,
      owner: parsed.owner,
      repo: parsed.repo,
      runnerId: parsed.runnerId,
      ...(parsed.workspacePath ? { workspacePath: parsed.workspacePath } : {}),
      ...(parsed.defaultExecutor ? { defaultExecutor: parsed.defaultExecutor } : {}),
      ...(parsed.allowedActors?.length ? { allowedActors: parsed.allowedActors } : {})
    });
    await recordControlPlaneEvent({
      type: "binding.repository.upserted",
      severity: "info",
      subject: `${parsed.provider}:${parsed.owner}/${parsed.repo}`,
      payload: {
        provider: parsed.provider,
        owner: parsed.owner,
        repo: parsed.repo,
        runnerId: parsed.runnerId,
        hasWorkspacePath: Boolean(parsed.workspacePath),
        ...(parsed.defaultExecutor ? { defaultExecutor: parsed.defaultExecutor } : {}),
        allowedActorsCount: parsed.allowedActors?.length ?? 0
      }
    });
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo", async (c) => {
    const binding = await repo.getRepoBinding({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    if (!binding) return c.json({ error: "repo_binding_not_found" }, 404);
    return c.json({ binding });
  });

  app.post("/v1/repo-bindings/:provider/:owner/:repo/policy-rules", async (c) => {
    const parsed = await parseDispatcherBody(c, UpsertPolicyRuleSchema);
    const provider = c.req.param("provider");
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const rule = await repo.upsertRepoPolicyRule({
      provider,
      owner,
      repo: repoName,
      rule: parsed.rule
    });
    await recordControlPlaneEvent({
      type: "binding.repository.policy_rule.upserted",
      severity: "info",
      subject: `${provider}:${owner}/${repoName}:${rule.id}`,
      payload: {
        provider,
        owner,
        repo: repoName,
        ruleId: rule.id,
        scope: rule.scope,
        effect: rule.effect,
        ...(rule.capabilityId ? { capabilityId: rule.capabilityId } : {}),
        ...(rule.mutationDomain ? { mutationDomain: rule.mutationDomain } : {}),
        hasReason: Boolean(rule.reason)
      }
    });
    return c.json({ rule }, 201);
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo/policy-rules", async (c) => {
    const rules = await repo.listRepoPolicyRules({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    return c.json({ rules });
  });

  app.post("/v1/repo-bindings/:provider/:owner/:repo/mutation-mappings", async (c) => {
    const parsed = await parseDispatcherBody(c, UpsertMutationMappingSchema);
    const provider = c.req.param("provider");
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const mapping = await repo.upsertRepoMutationMapping({
      provider,
      owner,
      repo: repoName,
      mapping: parsed.mapping
    });
    await recordControlPlaneEvent({
      type: "binding.repository.mutation_mapping.upserted",
      severity: "info",
      subject: `${provider}:${owner}/${repoName}:${mapping.id}`,
      payload: {
        provider,
        owner,
        repo: repoName,
        mappingId: mapping.id,
        adapter: mapping.adapter,
        domain: mapping.domain,
        strategy: mapping.strategy,
        valueCount: Object.keys(mapping.values).length,
        hasDescription: Boolean(mapping.description)
      }
    });
    return c.json({ mapping }, 201);
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo/mutation-mappings", async (c) => {
    const mappings = await repo.listRepoMutationMappings({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    return c.json({ mappings });
  });

  app.get("/v1/repo-bindings/:provider/:owner/:repo/metrics", async (c) => {
    const metrics = await repo.getRepoMetrics({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo")
    });
    return c.json({ metrics });
  });

  app.get("/v1/work-thread-metrics", async (c) => {
    const threadId = c.req.query("threadId");
    if (!threadId) return c.json({ error: "thread_id_required" }, 422);
    const metrics = await repo.getWorkThreadMetrics({ threadId });
    return c.json({ metrics });
  });

  app.post("/v1/channel-bindings", async (c) => {
    const parsed = await parseDispatcherBody(c, CreateChannelBindingSchema);
    await repo.upsertChannelBinding({
      provider: parsed.provider,
      accountId: parsed.accountId,
      conversationId: parsed.conversationId,
      repoProvider: parsed.repoProvider,
      owner: parsed.owner,
      repo: parsed.repo,
      ...(parsed.metadata ? { metadata: parsed.metadata } : {})
    });
    await recordControlPlaneEvent({
      type: "binding.channel.upserted",
      severity: "info",
      subject: `${parsed.provider}:${parsed.accountId}/${parsed.conversationId}`,
      payload: {
        provider: parsed.provider,
        accountId: parsed.accountId,
        conversationId: parsed.conversationId,
        repoProvider: parsed.repoProvider,
        owner: parsed.owner,
        repo: parsed.repo,
        hasMetadata: Boolean(parsed.metadata)
      }
    });
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/channel-bindings/:provider/:accountId/:conversationId", async (c) => {
    const binding = await repo.getChannelBinding({
      provider: c.req.param("provider"),
      accountId: c.req.param("accountId"),
      conversationId: c.req.param("conversationId")
    });
    if (!binding) return c.json({ error: "channel_binding_not_found" }, 404);
    return c.json({ binding });
  });

  app.get("/v1/channel-bindings/:provider/:accountId/:conversationId/status", async (c) => {
    const provider = c.req.param("provider");
    const accountId = c.req.param("accountId");
    const conversationId = c.req.param("conversationId");
    const binding = await repo.getChannelBinding({ provider, accountId, conversationId });
    if (!binding) return c.json({ error: "channel_binding_not_found" }, 404);
    const active = await repo.findCancelableRunForSourceContainer({
      source: provider,
      repoProvider: binding.repoProvider,
      owner: binding.owner,
      repo: binding.repo,
      metadata: sourceContainerMetadata({ provider, accountId, conversationId })
    });
    const queuedFollowUps = active ? await repo.listQueuedFollowUpsForActiveRun({ activeRunId: active.run.id }) : [];
    const runTimeoutMs = active ? latestRunTimeoutMs(await repo.listRunEvents({ runId: active.run.id })) : undefined;
    return c.json({
      binding,
      ...(active ? { activeRun: active.run, activeEvent: active.event } : {}),
      ...(runTimeoutMs ? { runTimeoutPolicy: { hardTimeoutMs: runTimeoutMs } } : {}),
      queuedFollowUps
    });
  });

  app.delete("/v1/channel-bindings/:provider/:accountId/:conversationId", async (c) => {
    const provider = c.req.param("provider");
    const accountId = c.req.param("accountId");
    const conversationId = c.req.param("conversationId");
    const deleted = await repo.deleteChannelBinding({
      provider,
      accountId,
      conversationId
    });
    if (!deleted) return c.json({ error: "channel_binding_not_found" }, 404);
    await recordControlPlaneEvent({
      type: "binding.channel.deleted",
      severity: "info",
      subject: `${provider}:${accountId}/${conversationId}`,
      payload: {
        provider,
        accountId,
        conversationId
      }
    });
    return c.body(null, 204);
  });

  app.post("/v1/channel-bindings/:provider/:accountId/:conversationId/cancel-active-run", async (c) => {
    const provider = c.req.param("provider");
    const accountId = c.req.param("accountId");
    const conversationId = c.req.param("conversationId");
    const parsed = await parseDispatcherBody(c, CancelRunSchema);
    const binding = await repo.getChannelBinding({ provider, accountId, conversationId });
    if (!binding) return c.json({ error: "channel_binding_not_found" }, 404);
    const active = await repo.findCancelableRunForSourceContainer({
      source: provider,
      repoProvider: binding.repoProvider,
      owner: binding.owner,
      repo: binding.repo,
      metadata: sourceContainerMetadata({ provider, accountId, conversationId })
    });
    if (!active) return c.json({ error: "active_run_not_found" }, 404);
    const outcome = await repo.cancelRun({
      runId: active.run.id,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(parsed.requestedBy ? { requestedBy: parsed.requestedBy } : {})
    });
    if (outcome.outcome === "not_found") return c.json({ error: "run_not_found" }, 404);
    if (outcome.outcome === "already_terminal") {
      return c.json({ error: "run_already_terminal", run: outcome.run }, 409);
    }
    return c.json({ outcome: "cancelled", run: outcome.run });
  });

  app.post("/v1/slack-channel-bindings", async (c) => {
    const parsed = await parseDispatcherBody(c, CreateSlackChannelBindingSchema);
    await repo.createSlackChannelBinding(parsed);
    await recordControlPlaneEvent({
      type: "binding.channel.upserted",
      severity: "info",
      subject: `slack:${parsed.teamId}/${parsed.channelId}`,
      payload: {
        provider: "slack",
        accountId: parsed.teamId,
        conversationId: parsed.channelId,
        repoProvider: parsed.repoProvider ?? "github",
        owner: parsed.owner,
        repo: parsed.repo,
        compatibilityEndpoint: "/v1/slack-channel-bindings",
        hasMetadata: false
      }
    });
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/slack-channel-bindings/:teamId/:channelId", async (c) => {
    const binding = await repo.getSlackChannelBinding({
      teamId: c.req.param("teamId"),
      channelId: c.req.param("channelId")
    });
    if (!binding) return c.json({ error: "slack_channel_binding_not_found" }, 404);
    return c.json({ binding });
  });

  app.post("/v1/runs", async (c) => {
    const parsed = await parseDispatcherBody(c, CreateRunSchema);
    const admitted = await admission.admitRun({ requestId: parsed.runId, event: parsed.event });

    if (admitted.outcome === "needs_human_decision") {
      const projectTarget = projectTargetRefFromEvent(parsed.event);
      await recordControlPlaneEvent({
        type: "admission.needs_human_decision",
        severity: ["repo_context_missing", "repo_not_bound"].includes(admitted.decision.reasonCode) ? "warn" : "info",
        subject: parsed.runId,
        payload: {
          runId: parsed.runId,
          decision: admitted.decision,
          source: parsed.event.source,
          sourceEventId: parsed.event.sourceEventId,
          projectTarget: projectTarget ? `${projectTarget.provider}:${projectTarget.owner}/${projectTarget.repo}` : null
        }
      });
      return c.json({ decision: admitted.decision }, 202);
    }

    if (admitted.outcome === "drop_duplicate") {
      const replay = await repo.createRun({ id: parsed.runId, event: parsed.event });
      const decision = replay.created ? admitted.decision : replay.replayDecision;
      return c.json({ decision, run: replay.run, idempotentReplay: true }, 200);
    }

    if (admitted.outcome === "follow_up_queued") {
      const event = admitted.followUpRequest.event;
      const activeRunId = admitted.followUpRequest.activeRunId;
      if (activeRunId && shouldDeliverRunStatusUpdate(presentation, { provider: event.callback.provider, state: "queued" })) {
        const queuedPresentation = presentation.runStatusPresentation({
          runId: activeRunId,
          state: "queued",
          message: `Queued follow-up ${admitted.followUpRequest.id} behind the active run.`,
          nextAction: "Wait for the active run final reply, send another follow-up to queue more context, or request cancellation with /stop.",
          detailVisibility: "source_thread"
        });
        const queued = presentation.render({
          provider: event.callback.provider,
          presentation: queuedPresentation
        });
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId: activeRunId,
            kind: "progress",
            provider: event.callback.provider,
            uri: event.callback.uri,
            body: queued.body,
            ...(event.target.agentId ? { agentId: event.target.agentId } : {}),
            ...(event.callback.threadKey ? { threadKey: event.callback.threadKey } : {}),
            ...(queued.blocks?.length ? { blocks: queued.blocks } : {}),
            ...(queued.rich ? { rich: queued.rich } : {}),
            statusMessageKey: `${activeRunId}:status`
          }
        });
      }
      return c.json({ decision: admitted.decision, followUpRequest: admitted.followUpRequest }, 202);
    }

    const createdRun = await repo.createRun({ id: parsed.runId, event: parsed.event });
    if (!createdRun.created) {
      return c.json(
        {
          decision: createdRun.replayDecision,
          run: createdRun.run,
          idempotentReplay: true
        },
        200
      );
    }
    const { run } = createdRun;
    const sourceReceiptDelivery = await deliverSourceReceiptBestEffort({
      repo,
      sink: sourceReceiptSink,
      receipt: {
        runId: run.id,
        provider: parsed.event.callback.provider,
        state: "received",
        event: parsed.event,
        ...(parsed.event.target.agentId ? { agentId: parsed.event.target.agentId } : {})
      }
    });
    const shouldDeliverAcknowledgement =
      presentation.shouldDeliverAcknowledgement(parsed.event.callback.provider) ||
      (shouldDeliverSourceReceipt(parsed.event.callback.provider) && !sourceReceiptDelivery.delivered);
    if (shouldDeliverAcknowledgement) {
      const acknowledgementPresentation = presentation.acknowledgementPresentation({ runId: run.id });
      const acknowledgement = presentation.render({
        provider: parsed.event.callback.provider,
        presentation: acknowledgementPresentation
      });
      const statusMessageKey = larkLifecycleStatusMessageKey({ provider: parsed.event.callback.provider, runId: run.id });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: run.id,
          kind: "acknowledgement",
          provider: parsed.event.callback.provider,
          uri: parsed.event.callback.uri,
          body: acknowledgement.body,
          ...(parsed.event.target.agentId ? { agentId: parsed.event.target.agentId } : {}),
          ...(parsed.event.callback.threadKey ? { threadKey: parsed.event.callback.threadKey } : {}),
          ...(statusMessageKey ? { statusMessageKey } : {}),
          ...(acknowledgement.blocks?.length ? { blocks: acknowledgement.blocks } : {}),
          ...(acknowledgement.rich ? { rich: acknowledgement.rich } : {})
        }
      });
    }
    return c.json({ decision: admitted.decision, run }, 201);
  });

  app.post("/v1/thread-actions", async (c) => {
    const parsed = await parseDispatcherBody(c, ThreadActionInputSchema);
    const command = parseThreadActionCommand(parsed.rawText);
    if (!command) {
      return c.json({ outcome: "ignored", reason: "not_action_command" }, 202);
    }

    const resolved = await resolveThreadAction({
      repo,
      command,
      callback: parsed.callback,
      ...(parsed.metadata ? { metadata: parsed.metadata } : {})
    });
    if (!resolved.ok) {
      if (resolved.runId) {
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId: resolved.runId,
            kind: "final",
            provider: parsed.callback.provider,
            uri: parsed.callback.uri,
            body: resolved.message,
            ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
          }
        });
      }
      return c.json({ outcome: resolved.reason, message: resolved.message }, resolved.reason === "no_proposal" ? 404 : 409);
    }

    const authorization = await authorizeThreadAction({
      repo,
      resolved: resolved.resolved,
      actor: parsed.actor
    });
    if (!authorization.ok) {
      return c.json({ outcome: "unauthorized", reason: authorization.reason, message: authorization.message }, 403);
    }

    const selectionText = selectedActionSummary(resolved.resolved.selectedCandidates);
    const selectedIntents = resolved.resolved.proposal.snapshot.intents.filter((intent) =>
      resolved.resolved.selectedIntentIds.includes(intent.intentId)
    );
    const adapter = adapterForAction({
      event: resolved.resolved.proposal.event,
      callbackProvider: parsed.callback.provider,
      selectedIntents
    });
    const applyPlanId = stableApplyPlanId({ resolved: resolved.resolved, adapter });
    if (command.verb === "apply") {
      const existingPlan = await repo.getApplyPlan({ id: applyPlanId });
      if (existingPlan) {
        const existingDecision = await repo.getApprovalDecision({ id: existingPlan.approvalDecisionId });
        if (selectedIntentsAlreadyApplied({ plan: existingPlan, selectedIntentIds: resolved.resolved.selectedIntentIds })) {
          await deliverAndAudit({
            repo,
            sink: callbackSink,
            retry: callbackRetry,
            message: {
              runId: resolved.resolved.proposal.runId,
              kind: "final",
              provider: parsed.callback.provider,
              uri: parsed.callback.uri,
              body: renderAlreadyAppliedThreadActionBody({ selectionText }),
              ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
            }
          });
          return c.json({ outcome: "already_applied", decision: existingDecision, plan: existingPlan }, 200);
        }
        const isStale = selectedIntentsHaveStaleOutcome({
          plan: existingPlan,
          selectedIntentIds: resolved.resolved.selectedIntentIds
        });
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId: resolved.resolved.proposal.runId,
            kind: "final",
            provider: parsed.callback.provider,
            uri: parsed.callback.uri,
            body: isStale
              ? renderStaleThreadActionBody({
                  selectionText,
                  continueIndex: resolved.resolved.selectedCandidates[0]?.index ?? 1
                })
              : renderAlreadyPlannedThreadActionBody({ selectionText }),
            ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
          }
        });
        return c.json({ outcome: isStale ? "stale" : "already_planned", decision: existingDecision, plan: existingPlan }, 200);
      }
    }

    const providedDecision = parsed.id ? await repo.getApprovalDecision({ id: parsed.id }) : null;
    const canReuseProvidedDecision = providedDecision
      ? approvalDecisionMatchesThreadAction({
          decision: providedDecision,
          command,
          resolved: resolved.resolved,
          actor: parsed.actor
        })
      : false;
    const approvalId = parsed.id && (!providedDecision || canReuseProvidedDecision)
      ? parsed.id
      : stableApprovalId({
          command,
          resolved: resolved.resolved,
          actor: parsed.actor
        });
    const existingDecision = canReuseProvidedDecision
      ? providedDecision
      : await repo.getApprovalDecision({ id: approvalId });
    const decision = existingDecision ?? await repo.recordApprovalDecision({
      id: approvalId,
      proposalId: resolved.resolved.proposal.snapshot.proposalId,
      approvedIntentIds: command.verb === "reject" ? [] : resolved.resolved.selectedIntentIds,
      ...(command.verb === "reject" ? { rejectedIntentIds: resolved.resolved.selectedIntentIds } : {}),
      approvedBy: parsed.actor,
      approvedAt: new Date().toISOString(),
      scope: "manual",
      ...(command.reason ? { reason: command.reason } : {}),
      metadata: {
        source: "thread_action",
        rawText: command.rawText,
        verb: command.verb,
        selection: command.selection,
        callback: parsed.callback,
        ...(parsed.metadata ? { ingressMetadata: parsed.metadata } : {})
      }
    });
    if (!decision) {
      return c.json({ error: "proposal_not_found" }, 404);
    }

    if (command.verb === "reject") {
      if (existingDecision) {
        return c.json({ outcome: "already_rejected", decision }, 200);
      }
      const body = renderThreadActionRecordedBody({
        verb: "reject",
        selectionText
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body,
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "rejected", decision }, 201);
    }

    if (command.verb === "approve") {
      if (existingDecision) {
        return c.json({ outcome: "already_approved", decision }, 200);
      }
      const directApply = await selectedDirectApplyStatus({
        event: resolved.resolved.proposal.event,
        callbackProvider: parsed.callback.provider,
        candidates: resolved.resolved.selectedCandidates,
        ...(input.githubApply ? { githubApply: input.githubApply } : {})
      });
      const body = renderThreadActionRecordedBody({
        verb: "approve",
        selectionText,
        applyIndex: resolved.resolved.selectedCandidates[0]?.index ?? 1,
        directApply
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body,
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "approved", decision }, 201);
    }

    if (command.verb === "continue") {
      const childRun = await createChildRunForThreadAction({
        repo,
        command,
        resolved: resolved.resolved,
        runId: stableChildRunId({ command, resolved: resolved.resolved }),
        approvalDecisionId: decision.id
      });
      const body = renderChildRunCreatedBody({
        lead: "Continuing in OpenTag from this approved action.",
        resolved: resolved.resolved,
        childRun,
        provider: parsed.callback.provider,
        selectionText,
        approvalDecisionId: decision.id
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body,
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "child_run_created", decision, run: childRun }, 201);
    }

    const planResult = await repo.createApplyPlanOnce({
      id: applyPlanId,
      proposalId: resolved.resolved.proposal.snapshot.proposalId,
      approvalDecisionId: decision.id,
      selectedIntentIds: resolved.resolved.selectedIntentIds,
      adapter
    });
    if (!planResult) {
      return c.json({ error: "proposal_or_approval_not_found" }, 404);
    }
    if (!planResult.created) {
      if (selectedIntentsAlreadyApplied({ plan: planResult.plan, selectedIntentIds: resolved.resolved.selectedIntentIds })) {
        await deliverAndAudit({
          repo,
          sink: callbackSink,
          retry: callbackRetry,
          message: {
            runId: resolved.resolved.proposal.runId,
            kind: "final",
            provider: parsed.callback.provider,
            uri: parsed.callback.uri,
            body: renderAlreadyAppliedThreadActionBody({ selectionText }),
            ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
          }
        });
        return c.json({ outcome: "already_applied", decision, plan: planResult.plan }, 200);
      }
      const isStale = selectedIntentsHaveStaleOutcome({
        plan: planResult.plan,
        selectedIntentIds: resolved.resolved.selectedIntentIds
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body: isStale
            ? renderStaleThreadActionBody({
                selectionText,
                continueIndex: resolved.resolved.selectedCandidates[0]?.index ?? 1
              })
            : renderAlreadyPlannedThreadActionBody({ selectionText }),
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: isStale ? "stale" : "already_planned", decision, plan: planResult.plan }, 200);
    }
    const plan = planResult.plan;

    const execution = await executeGitHubApplyPlan({
      repo,
      plan,
      resolved: resolved.resolved,
      ...(input.githubApply ? { githubApply: input.githubApply } : {})
    });
    if (execution.executed) {
      const outcomes = execution.plan.outcomes ?? [];
      const body = renderAppliedThreadActionBody({
        selectionText,
        selectedIntentIds: resolved.resolved.selectedIntentIds,
        outcomes
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body,
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "applied", decision, plan: execution.plan }, 201);
    }

    if (selectedIntentsHaveStaleOutcome({ plan: execution.plan, selectedIntentIds: resolved.resolved.selectedIntentIds })) {
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: resolved.resolved.proposal.runId,
          kind: "final",
          provider: parsed.callback.provider,
          uri: parsed.callback.uri,
          body: renderStaleThreadActionBody({
            selectionText,
            continueIndex: resolved.resolved.selectedCandidates[0]?.index ?? 1
          }),
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "stale", decision, plan: execution.plan }, 200);
    }

    const childRun = await createChildRunForThreadAction({
      repo,
      command,
      resolved: resolved.resolved,
      runId: stableChildRunId({
        command,
        resolved: resolved.resolved,
        sourceApplyPlanId: execution.plan.id,
        fallbackReason: execution.fallbackReason ?? "OpenTag cannot directly apply this intent yet."
      }),
      approvalDecisionId: decision.id,
      sourceApplyPlanId: execution.plan.id,
      fallbackReason: execution.fallbackReason ?? "OpenTag cannot directly apply this intent yet."
    });
    const body = renderChildRunCreatedBody({
      lead: "Needs setup before OpenTag can apply this action directly.",
      resolved: resolved.resolved,
      childRun,
      provider: parsed.callback.provider,
      selectionText,
      approvalDecisionId: decision.id,
      sourceApplyPlanId: execution.plan.id,
      fallbackReason: execution.fallbackReason ?? "The adapter could not execute the selected intent."
    });
    await deliverAndAudit({
      repo,
      sink: callbackSink,
      retry: callbackRetry,
      message: {
        runId: resolved.resolved.proposal.runId,
        kind: "final",
        provider: parsed.callback.provider,
        uri: parsed.callback.uri,
        body,
        ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
      }
    });
    return c.json({ outcome: "child_run_created", decision, plan: execution.plan, run: childRun }, 201);
  });

  app.get("/v1/follow-up-requests/:id", async (c) => {
    const followUpRequest = await repo.getFollowUpRequest({ id: c.req.param("id") });
    if (!followUpRequest) return c.json({ error: "follow_up_request_not_found" }, 404);
    return c.json({ followUpRequest });
  });

  app.post("/v1/follow-up-requests/:id/create-run", async (c) => {
    const parsed = await parseDispatcherBody(c, PromoteFollowUpRequestSchema);
    let promoted;
    try {
      promoted = await promoteFollowUpRequest({
        followUpRequestId: c.req.param("id"),
        runId: parsed.runId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Follow-up request not found:")) {
        return c.json({ error: "follow_up_request_not_found" }, 404);
      }
      if (message.includes("is not queued")) {
        return c.json({ error: "follow_up_request_not_queued" }, 409);
      }
      throw error;
    }
    const followUpRequest = promoted.followUpRequest;
    return c.json({ followUpRequest, run: promoted.run }, 201);
  });

  app.post("/v1/runners/:runnerId/claim", async (c) => {
    const claimed = await repo.claimNextRun({ runnerId: c.req.param("runnerId"), leaseSeconds: 60 });
    if (!claimed) return c.body(null, 204);
    return c.json(claimed, 200);
  });

  app.post("/v1/runners/:runnerId/runs/:runId/heartbeat", async (c) => {
    const ok = await repo.heartbeat({ runnerId: c.req.param("runnerId"), runId: c.req.param("runId") });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
    return c.json({ ok: true });
  });

  app.post("/v1/runs/:runId/running", async (c) => {
    return c.json({
      error: "runner_scoped_endpoint_required",
      message: "Use /v1/runners/:runnerId/runs/:runId/running, /progress, or /complete."
    }, 410);
  });

  app.post("/v1/runners/:runnerId/runs/:runId/running", async (c) => {
    const runId = c.req.param("runId");
    const body = await parseDispatcherBody(c, MarkRunningSchema);
    const headerIdempotencyKey = c.req.header("idempotency-key")?.trim();
    const idempotencyKey = body.idempotencyKey?.trim() || headerIdempotencyKey;
    const runningOutcome = await repo.markRunning({
      runId,
      runnerId: c.req.param("runnerId"),
      executor: body.executor,
      ...(body.runTimeoutMs ? { runTimeoutMs: body.runTimeoutMs } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
    if (runningOutcome === "not_found") return c.json({ error: "run_not_claimed_by_runner" }, 404);
    if (runningOutcome === "duplicate") return c.json({ ok: true, replayed: true });
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const provider = stored.event.callback.provider;
    if (shouldDeliverSourceReceipt(provider)) {
      await deliverSourceReceiptBestEffort({
        repo,
        sink: sourceReceiptSink,
        receipt: {
          runId,
          provider,
          state: "running",
          event: stored.event,
          ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {})
        }
      });
    }
    if (shouldDeliverRunStatusUpdate(presentation, { provider, state: "running" })) {
      const runningPresentation = presentation.runStatusPresentation({
        runId,
        state: "running",
        message: `Running with ${body.executor}.`,
        nextAction: "Wait for the final reply, send a follow-up to queue more context, or request cancellation with /stop.",
        detailVisibility: "source_thread"
      });
      const running = presentation.render({
        provider,
        presentation: runningPresentation
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId,
          kind: "progress",
          provider,
          uri: stored.event.callback.uri,
          body: running.body,
          ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
          ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
          ...(running.blocks?.length ? { blocks: running.blocks } : {}),
          ...(running.rich ? { rich: running.rich } : {}),
          statusMessageKey: `${runId}:status`
        }
      });
    } else if (presentation.shouldDeliverStatusUpdate(provider)) {
      await appendSuppressedRunStatusCallback({ runId, provider, state: "running" });
    }
    return c.json({ ok: true });
  });

  app.post("/v1/runs/:runId/progress", async () => {
    return new Response(JSON.stringify({
      error: "runner_scoped_endpoint_required",
      message: "Use /v1/runners/:runnerId/runs/:runId/running, /progress, or /complete."
    }), { status: 410, headers: { "content-type": "application/json" } });
  });

  app.post("/v1/runners/:runnerId/runs/:runId/progress", async (c) => {
    const runId = c.req.param("runId");
    const body = await parseDispatcherBody(c, ProgressSchema);
    const headerIdempotencyKey = c.req.header("idempotency-key")?.trim();
    const idempotencyKey = body.idempotencyKey?.trim() || headerIdempotencyKey;
    const progressOutcome = await repo.recordProgress({
      runId,
      runnerId: c.req.param("runnerId"),
      message: body.message,
      ...(body.type ? { type: body.type } : {}),
      ...(body.at ? { at: body.at } : {}),
      ...(body.visibility ? { visibility: body.visibility } : {}),
      ...(body.importance ? { importance: body.importance } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
    if (progressOutcome === "not_found") return c.json({ error: "run_not_claimed_by_runner" }, 404);
    if (progressOutcome === "duplicate") return c.json({ ok: true, replayed: true });
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const progressVisibility = body.visibility ?? "audit";
    const shouldDeliverProgress = presentation.shouldDeliverProgress(stored.event.callback.provider);
    if (progressVisibility === "human" && shouldDeliverProgress) {
      const progressPresentation = presentation.progressPresentation({ runId, message: body.message });
      const progress = presentation.render({
        provider: stored.event.callback.provider,
        presentation: progressPresentation
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId,
          kind: "progress",
          provider: stored.event.callback.provider,
          uri: stored.event.callback.uri,
          body: progress.body,
          ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
          ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
          ...(progress.blocks?.length ? { blocks: progress.blocks } : {}),
          ...(progress.rich ? { rich: progress.rich } : {}),
          statusMessageKey: `${runId}:status`
        }
      });
    } else if (progressVisibility === "human") {
      const capability = platformCapabilityForProvider(stored.event.callback.provider);
      await repo.appendRunEvent({
        runId,
        type: "callback.progress.suppressed",
        payload: {
          provider: stored.event.callback.provider,
          reason: "platform_liveness_strategy",
          requestedVisibility: progressVisibility,
          livenessStrategy: capability?.livenessStrategy ?? "unknown"
        },
        visibility: "audit",
        importance: "low",
        message: "Progress callback suppressed by platform liveness strategy; use status or audit for details."
      });
    }
    return c.json({ ok: true });
  });

  app.post("/v1/runs/:runId/complete", async () => {
    return new Response(JSON.stringify({
      error: "runner_scoped_endpoint_required",
      message: "Use /v1/runners/:runnerId/runs/:runId/running, /progress, or /complete."
    }), { status: 410, headers: { "content-type": "application/json" } });
  });

  app.post("/v1/runners/:runnerId/runs/:runId/complete", async (c) => {
    const runId = c.req.param("runId");
    const parsed = await parseDispatcherBody(c, CompleteRunSchema);
    const headerIdempotencyKey = c.req.header("idempotency-key")?.trim();
    const idempotencyKey = parsed.idempotencyKey?.trim() || headerIdempotencyKey;
    const outcome = await repo.completeRun({
      runId,
      runnerId: c.req.param("runnerId"),
      result: parsed.result,
      ...(idempotencyKey ? { idempotencyKey } : {})
    });
    if (outcome === "not_found") return c.json({ error: "run_not_claimed_by_runner" }, 404);
    if (outcome === "duplicate") return c.json({ ok: true, replayed: true });
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const receiptContext = await actionReceiptContextForFinal({
      event: stored.event,
      result: parsed.result,
      ...(input.githubApply ? { githubApply: input.githubApply } : {})
    });
    if (
      parsed.result.conclusion === "needs_human" &&
      shouldDeliverRunStatusUpdate(presentation, { provider: stored.event.callback.provider, state: "waiting_for_approval" })
    ) {
      const waitingPresentation = presentation.runStatusPresentation({
        runId,
        state: "waiting_for_approval",
        message: "Waiting for approval.",
        nextAction: "Review the source-thread action receipt, then approve, reject, apply, or continue from the source thread.",
        detailVisibility: "source_thread"
      });
      const waiting = presentation.render({
        provider: stored.event.callback.provider,
        presentation: waitingPresentation
      });
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId,
          kind: "progress",
          provider: stored.event.callback.provider,
          uri: stored.event.callback.uri,
          body: waiting.body,
          ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
          ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
          ...(waiting.blocks?.length ? { blocks: waiting.blocks } : {}),
          ...(waiting.rich ? { rich: waiting.rich } : {}),
          statusMessageKey: `${runId}:status`
        }
      });
    }
    const finalPresentation = presentation.finalPresentation({
      result: parsed.result,
      runId,
      receiptContext
    });
    const finalCallback = presentation.render({
      provider: stored.event.callback.provider,
      presentation: finalPresentation,
      receiptContext
    });
    const statusMessageKey = larkLifecycleStatusMessageKey({ provider: stored.event.callback.provider, runId });
    await deliverAndAudit({
      repo,
      sink: callbackSink,
      retry: callbackRetry,
      message: {
        runId,
        kind: "final",
        provider: stored.event.callback.provider,
        uri: stored.event.callback.uri,
        body: finalCallback.body,
        ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
        ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
        ...(statusMessageKey ? { statusMessageKey } : {}),
        ...(finalCallback.blocks?.length ? { blocks: finalCallback.blocks } : {}),
        ...(finalCallback.rich ? { rich: finalCallback.rich } : {})
      }
    });
    const shouldPromoteFollowUp = parsed.result.conclusion !== "needs_human" && parsed.result.conclusion !== "cancelled";
    const promotedFollowUp = shouldPromoteFollowUp ? await promoteNextFollowUpAfterTerminalRun({ activeRunId: runId }) : null;
    return c.json({
      ok: true,
      ...(promotedFollowUp
        ? {
            promotedFollowUp: {
              followUpRequest: promotedFollowUp.followUpRequest,
              run: promotedFollowUp.run
            }
          }
        : {})
    });
  });

  app.get("/v1/proposals/:proposalId", async (c) => {
    const proposal = await repo.getSuggestedChanges({ proposalId: c.req.param("proposalId") });
    if (!proposal) return c.json({ error: "proposal_not_found" }, 404);
    return c.json(proposal);
  });

  app.get("/v1/proposals/:proposalId/lineage", async (c) => {
    const lineage = await repo.getProposalLineage({ proposalId: c.req.param("proposalId") });
    if (!lineage) return c.json({ error: "proposal_not_found" }, 404);
    return c.json({ lineage });
  });

  app.get("/v1/proposals/:proposalId/current-intents", async (c) => {
    const intents = await repo.listCurrentMutationIntents({ proposalId: c.req.param("proposalId") });
    if (!intents) return c.json({ error: "proposal_not_found" }, 404);
    return c.json({ intents });
  });

  app.post("/v1/proposals/:proposalId/approvals", async (c) => {
    const proposalId = c.req.param("proposalId");
    const body = await parseDispatcherBody(c, ApprovalDecisionInputSchema, { invalidBodyError: "invalid_approval_decision" });
    const decision = await repo.recordApprovalDecision({
      id: body.id ?? `approval_${proposalId}_${Date.now()}`,
      proposalId,
      approvedIntentIds: body.approvedIntentIds,
      ...(body.rejectedIntentIds?.length ? { rejectedIntentIds: body.rejectedIntentIds } : {}),
      approvedBy: body.approvedBy,
      approvedAt: body.approvedAt ?? new Date().toISOString(),
      scope: body.scope,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {})
    });
    if (!decision) return c.json({ error: "proposal_not_found" }, 404);
    return c.json({ decision }, 201);
  });

  app.get("/v1/approvals/:approvalDecisionId", async (c) => {
    const decision = await repo.getApprovalDecision({ id: c.req.param("approvalDecisionId") });
    if (!decision) return c.json({ error: "approval_decision_not_found" }, 404);
    return c.json({ decision });
  });

  app.post("/v1/proposals/:proposalId/apply-plans", async (c) => {
    const proposalId = c.req.param("proposalId");
    const body = await parseDispatcherBody(c, ApplyPlanInputSchema);
    let executableTarget:
      | {
          proposal: NonNullable<Awaited<ReturnType<typeof repo.getSuggestedChanges>>>;
          target: NonNullable<ReturnType<typeof githubTargetFromEvent>>;
        }
      | undefined;

    if (body.execute) {
      if (body.adapter !== "github") {
        return c.json({ error: "apply_execution_adapter_not_supported" }, 422);
      }
      if (!input.githubApply) {
        return c.json({ error: "github_apply_not_configured" }, 422);
      }
      const proposal = await repo.getSuggestedChanges({ proposalId });
      if (!proposal) return c.json({ error: "proposal_not_found" }, 404);
      const stored = await repo.getRun({ runId: proposal.runId });
      if (!stored) return c.json({ error: "run_not_found" }, 404);
      const target = githubTargetFromEvent(stored.event);
      if (!target) {
        return c.json({ error: "github_target_missing" }, 422);
      }
      executableTarget = { proposal, target };
    }

    const applyPlanInput = {
      id: body.id ?? `apply_${proposalId}_${Date.now()}`,
      proposalId,
      approvalDecisionId: body.approvalDecisionId,
      ...(body.selectedIntentIds !== undefined ? { selectedIntentIds: body.selectedIntentIds } : {}),
      ...(body.adapter ? { adapter: body.adapter } : {})
    };
    let plan: ApplyPlan;
    if (body.execute) {
      const planResult = await repo.createApplyPlanOnce(applyPlanInput);
      if (!planResult) return c.json({ error: "proposal_or_approval_not_found" }, 404);
      plan = planResult.plan;
      if (!planResult.created) {
        return c.json({ plan, alreadyPlanned: true }, 200);
      }
    } else {
      const planResult = await repo.createApplyPlan(applyPlanInput);
      if (!planResult) return c.json({ error: "proposal_or_approval_not_found" }, 404);
      plan = planResult;
    }
    if (body.execute && executableTarget) {
      const githubApply = input.githubApply;
      if (!githubApply) {
        return c.json({ error: "github_apply_not_configured" }, 422);
      }
      const preflightOutcomeByIntentId = new Map((plan.outcomes ?? []).map((outcome) => [outcome.intentId, outcome]));
      const executableIntents = executableTarget.proposal.snapshot.intents.filter((intent) => {
        const outcome = preflightOutcomeByIntentId.get(intent.intentId);
        return outcome?.outcome === "skipped" && outcome.message?.startsWith("Preflight passed");
      });
      const target = {
        token: githubApply.token,
        owner: executableTarget.target.owner,
        repo: executableTarget.target.repoName,
        ...(typeof executableTarget.target.issueNumber === "number" ? { issueNumber: executableTarget.target.issueNumber } : {}),
        ...(executableTarget.target.pullRequestNumber ? { pullRequestNumber: executableTarget.target.pullRequestNumber } : {})
      };
      const executedOutcomes = [];
      const compilerRegistry = createAdapterMutationCompilerRegistry([
        createGitHubIssueMutationCompiler({
          mappings: mappingsFromAdapterPlan(plan.adapterPlan),
          ...(executableTarget.target.targetKind ? { targetKind: executableTarget.target.targetKind } : {})
        })
      ]);
      for (const compilation of compilerRegistry.compile("github", executableIntents)) {
        if (!compilation.ok) {
          executedOutcomes.push(compilation.outcome);
          continue;
        }
        executedOutcomes.push(
          await applyGitHubIssueMutationOperation({
            target,
            operation: compilation.operation as GitHubIssueMutationOperation,
            ...(githubApply.fetchImpl ? { fetchImpl: githubApply.fetchImpl } : {})
          })
        );
      }
      const executedOutcomeByIntentId = new Map(executedOutcomes.map((outcome) => [outcome.intentId, outcome]));
      const mergedOutcomes = (plan.outcomes ?? []).map((outcome) => executedOutcomeByIntentId.get(outcome.intentId) ?? outcome);
      const executedPlan = await repo.updateApplyPlanOutcomes({
        id: plan.id,
        outcomes: mergedOutcomes,
        externalWritesExecuted: true
      });
      return c.json({ plan: executedPlan ?? plan }, 201);
    }
    return c.json({ plan }, 201);
  });

  app.get("/v1/apply-plans/:applyPlanId", async (c) => {
    const plan = await repo.getApplyPlan({ id: c.req.param("applyPlanId") });
    if (!plan) return c.json({ error: "apply_plan_not_found" }, 404);
    return c.json({ plan });
  });

  app.post("/v1/runs/:runId/child-runs", async (c) => {
    const parentRunId = c.req.param("runId");
    const body = await parseDispatcherBody(c, ChildRunInputSchema);
    const parent = await repo.getRun({ runId: parentRunId });
    if (!parent) return c.json({ error: "parent_run_not_found" }, 404);
    const receivedAt = new Date().toISOString();
    const sourceProposalId = body.sourceProposalId ?? body.action.targetId;
    const { run } = await repo.createRun({
      id: body.runId,
      event: childEventFromParent({
        parentEvent: parent.event,
        childRunId: body.runId,
        ...(body.commandText ? { commandText: body.commandText } : {}),
        actionKind: body.action.kind,
        receivedAt
      }),
      parentRunId,
      triggeredByAction: body.action,
      ...(sourceProposalId ? { sourceProposalId } : {}),
      ...(body.sourceApplyPlanId ? { sourceApplyPlanId: body.sourceApplyPlanId } : {})
    });
    return c.json({ run }, 201);
  });

  app.get("/v1/runs/:runId", async (c) => {
    const stored = await repo.getRun({ runId: c.req.param("runId") });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    return c.json(stored);
  });

  app.post("/v1/runs/:runId/cancel", async (c) => {
    const parsed = await parseDispatcherBody(c, CancelRunSchema);
    const outcome = await repo.cancelRun({
      runId: c.req.param("runId"),
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      ...(parsed.requestedBy ? { requestedBy: parsed.requestedBy } : {})
    });
    if (outcome.outcome === "not_found") return c.json({ error: "run_not_found" }, 404);
    if (outcome.outcome === "already_terminal") {
      return c.json({ error: "run_already_terminal", run: outcome.run }, 409);
    }
    return c.json({ outcome: "cancelled", run: outcome.run });
  });

  app.get("/v1/runs/:runId/metrics", async (c) => {
    const runId = c.req.param("runId");
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const metrics = await repo.getRunMetrics({ runId });
    return c.json({ metrics });
  });

  app.get("/v1/runs/:runId/events", async (c) => {
    const events = await repo.listRunEvents({ runId: c.req.param("runId") });
    return c.json({ events });
  });

  app.onError((err, c) => {
    // Preserve explicit HTTP errors raised by handlers/middleware. Request-body
    // parse failures are surfaced as tagged HTTPException(4xx) by parseBody(),
    // so they are returned to the client here. Crucially, we no longer map raw
    // ZodError/SyntaxError to 400 globally: an internal ZodError (e.g. a store
    // repository validating a DB row) or a SyntaxError from an internal
    // JSON.parse must remain a 500 so monitoring still alerts on it.
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    // Unknown errors (including internal ZodError/SyntaxError) remain 500 so
    // monitoring still alerts on genuine server faults.
    console.error("dispatcher unhandled error", err);
    return c.json({ error: "internal_server_error" }, 500);
  });

  return app;
}
