import { createHash } from "node:crypto";
import {
  AdapterMutationMappingSchema,
  ActorIdentitySchema,
  ActionHintSchema,
  conversationKeysFromEvent,
  parseThreadActionCommand,
  projectTargetRefFromEvent,
  suggestedActionCandidatesFromSnapshots,
  type ActorIdentity,
  type ApplyIntentOutcome,
  type ApplyPlan,
  type MutationIntent,
  type OpenTagEvent,
  type OpenTagRun,
  type SuggestedChangesSnapshot,
  type SuggestedActionCandidate,
  type ThreadActionCommand,
  createAdapterMutationCompilerRegistry,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  PolicyRuleSchema,
  RunEventImportanceSchema,
  RunEventVisibilitySchema
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
 * HTTP 400. Malformed JSON (SyntaxError from c.req.json()) and request-schema
 * validation failures (ZodError from schema.parse()) are tagged as HTTPException
 * with status 400 so the global onError handler can return them as client errors
 * without masking unrelated internal ZodError/SyntaxError as 400s. Any other
 * error is rethrown unchanged and falls through to a 500.
 */
async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new HTTPException(400, {
        res: c.json({ error: "invalid_json_body" }, 400)
      });
    }
    throw err;
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    throw new HTTPException(400, {
      res: c.json({ error: "invalid_request_body", issues: result.error.issues }, 400)
    });
  }
  return result.data;
}
import { createAdmissionRuntime, type AgentAccessProfileCheck } from "./admission.js";
import { createDefaultCallbackPresentation, type CallbackPresentation } from "./presentation.js";

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

const PromoteFollowUpRequestSchema = z.object({
  runId: z.string().min(1)
});

const CompleteRunSchema = z.object({
  result: OpenTagRunResultSchema
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

const ProgressSchema = z.object({
  type: z.string().min(1).optional(),
  message: z.string().min(1),
  at: z.string().datetime().optional(),
  visibility: RunEventVisibilitySchema.optional(),
  importance: RunEventImportanceSchema.optional()
});

function childEventFromParent(input: {
  parentEvent: OpenTagEvent;
  childRunId: string;
  commandText?: string;
  actionKind: string;
  receivedAt: string;
  extraContext?: OpenTagEvent["context"];
  metadata?: Record<string, unknown>;
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
    metadata: {
      ...input.parentEvent.metadata,
      ...(input.metadata ?? {})
    }
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

function childRunContextLines(input: {
  resolved: ResolvedThreadAction;
  approvalDecisionId?: string;
  sourceApplyPlanId?: string;
  fallbackReason?: string;
}): string[] {
  const previousSummary = input.resolved.proposal.run.result?.summary ?? input.resolved.proposal.snapshot.summary;
  return [
    `- Proposal: \`${input.resolved.proposal.snapshot.proposalId}\``,
    `- Selected intents: ${input.resolved.selectedIntentIds.map((intentId) => `\`${intentId}\``).join(", ")}`,
    `- Previous run: \`${input.resolved.proposal.runId}\``,
    ...(input.approvalDecisionId ? [`- Approval decision: \`${input.approvalDecisionId}\``] : []),
    `- Previous result: ${previousSummary}`,
    ...(input.sourceApplyPlanId ? [`- Apply plan: \`${input.sourceApplyPlanId}\``] : []),
    ...(input.fallbackReason ? [`- Fallback reason: ${input.fallbackReason}`] : [])
  ];
}

function renderChildRunCreatedBody(input: {
  lead: string;
  resolved: ResolvedThreadAction;
  childRun: OpenTagRun;
  approvalDecisionId?: string;
  sourceApplyPlanId?: string;
  fallbackReason?: string;
}): string {
  return [
    input.lead,
    "",
    `Child run: \`${input.childRun.id}\``,
    "",
    "Context carried into the child run:",
    ...childRunContextLines(input),
    "",
    "The model will continue from this approved proposal instead of starting from a fresh mention."
  ].join("\n");
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
      }
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
  blocks?: SlackBlock[];
};

export type CallbackSink = {
  deliver(message: CallbackMessage): Promise<void>;
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
    await input.sink.deliver({
      runId: input.delivery.runId,
      kind: input.delivery.kind,
      provider: input.delivery.provider,
      uri: input.delivery.uri,
      body: input.delivery.body,
      ...(input.delivery.threadKey ? { threadKey: input.delivery.threadKey } : {}),
      ...(input.delivery.agentId ? { agentId: input.delivery.agentId } : {}),
      ...(input.delivery.statusMessageKey ? { statusMessageKey: input.delivery.statusMessageKey } : {}),
      ...(input.delivery.blocks ? { blocks: input.delivery.blocks as SlackBlock[] } : {})
    });
    await input.repo.markCallbackDelivered({ deliveryId: input.delivery.id });
    return true;
  } catch (error) {
    const nextAttemptAt = nextCallbackAttemptAt({ attempts: input.delivery.attempts, ...(input.retry ?? {}) });
    await input.repo.markCallbackFailed({
      deliveryId: input.delivery.id,
      error: error instanceof Error ? error.message : String(error),
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
    ...(input.message.blocks ? { blocks: input.message.blocks } : {})
  });
  await deliverCallbackDelivery({
    repo: input.repo,
    sink: input.sink,
    delivery,
    ...(input.retry ? { retry: input.retry } : {})
  });
}

function isAuthorized(request: Request, pairingToken: string | undefined): boolean {
  if (!pairingToken) return true;
  return request.headers.get("authorization") === `Bearer ${pairingToken}`;
}

export function createDispatcherApp(input: {
  databasePath: string;
  callbackSink?: CallbackSink;
  pairingToken?: string;
  presentation?: CallbackPresentation;
  githubApply?: GitHubApplyOptions;
  callbackRetry?: CallbackRetryOptions;
  agentAccessProfileCheck?: AgentAccessProfileCheck;
}) {
  const sqlite = new Database(input.databasePath);
  migrateSchema(sqlite);
  const repo = createOpenTagRepository(drizzle(sqlite));
  const app = new Hono();
  const callbackSink = input.callbackSink ?? noopCallbackSink;
  const presentation = input.presentation ?? createDefaultCallbackPresentation();
  const callbackRetry = input.callbackRetry ?? {};
  const admission = createAdmissionRuntime({
    repo,
    ...(input.agentAccessProfileCheck ? { agentAccessProfileCheck: input.agentAccessProfileCheck } : {})
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    if (!isAuthorized(c.req.raw, input.pairingToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.post("/v1/runners", async (c) => {
    const parsed = await parseBody(c, CreateRunnerSchema);
    await repo.registerRunner(parsed);
    return c.json({ ok: true }, 201);
  });

  app.get("/v1/runners/:runnerId", async (c) => {
    const runner = await repo.getRunner({ runnerId: c.req.param("runnerId") });
    if (!runner) return c.json({ error: "runner_not_found" }, 404);
    return c.json({ runner });
  });

  app.post("/v1/repo-bindings", async (c) => {
    const parsed = await parseBody(c, CreateRepoBindingSchema);
    await repo.createRepoBinding({
      provider: parsed.provider,
      owner: parsed.owner,
      repo: parsed.repo,
      runnerId: parsed.runnerId,
      ...(parsed.workspacePath ? { workspacePath: parsed.workspacePath } : {}),
      ...(parsed.defaultExecutor ? { defaultExecutor: parsed.defaultExecutor } : {}),
      ...(parsed.allowedActors?.length ? { allowedActors: parsed.allowedActors } : {})
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
    const parsed = await parseBody(c, UpsertPolicyRuleSchema);
    const rule = await repo.upsertRepoPolicyRule({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo"),
      rule: parsed.rule
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
    const parsed = await parseBody(c, UpsertMutationMappingSchema);
    const mapping = await repo.upsertRepoMutationMapping({
      provider: c.req.param("provider"),
      owner: c.req.param("owner"),
      repo: c.req.param("repo"),
      mapping: parsed.mapping
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
    const parsed = await parseBody(c, CreateChannelBindingSchema);
    await repo.upsertChannelBinding({
      provider: parsed.provider,
      accountId: parsed.accountId,
      conversationId: parsed.conversationId,
      repoProvider: parsed.repoProvider,
      owner: parsed.owner,
      repo: parsed.repo,
      ...(parsed.metadata ? { metadata: parsed.metadata } : {})
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

  app.post("/v1/slack-channel-bindings", async (c) => {
    const parsed = await parseBody(c, CreateSlackChannelBindingSchema);
    await repo.createSlackChannelBinding(parsed);
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
    const parsed = await parseBody(c, CreateRunSchema);
    const admitted = await admission.admitRun({ requestId: parsed.runId, event: parsed.event });

    if (admitted.outcome === "needs_human_decision") {
      return c.json({ decision: admitted.decision }, 202);
    }

    if (admitted.outcome === "drop_duplicate") {
      await repo.appendRunEvent({
        runId: admitted.run.id,
        type: "admission.decided",
        payload: admitted.decision,
        visibility: "audit",
        importance: "normal",
        message: admitted.decision.reason
      });
      await repo.appendRunEvent({
        runId: admitted.run.id,
        type: "run.create_idempotent_replay",
        payload: { requestedRunId: parsed.runId, eventId: parsed.event.id },
        visibility: "audit",
        importance: "low"
      });
      return c.json({ decision: admitted.decision, run: admitted.run, idempotentReplay: true }, 200);
    }

    if (admitted.outcome === "follow_up_queued") {
      return c.json({ decision: admitted.decision, followUpRequest: admitted.followUpRequest }, 202);
    }

    const createdRun = await repo.createRun({ id: parsed.runId, event: parsed.event });
    if (!createdRun.created) {
      return c.json(
        {
          decision: {
            ...admitted.decision,
            action: "drop_duplicate",
            reason: "Source event already created a run.",
            reasonCode: "duplicate_source_event",
            activeRunId: createdRun.run.id
          },
          run: createdRun.run,
          idempotentReplay: true
        },
        200
      );
    }
    const { run } = createdRun;
    if (presentation.shouldDeliverAcknowledgement(parsed.event.callback.provider)) {
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: run.id,
          kind: "acknowledgement",
          provider: parsed.event.callback.provider,
          uri: parsed.event.callback.uri,
          body: presentation.acknowledgement({ provider: parsed.event.callback.provider, runId: run.id }),
          ...(parsed.event.target.agentId ? { agentId: parsed.event.target.agentId } : {}),
          ...(parsed.event.callback.threadKey ? { threadKey: parsed.event.callback.threadKey } : {})
        }
      });
    }
    return c.json({ decision: admitted.decision, run }, 201);
  });

  app.post("/v1/thread-actions", async (c) => {
    const parsed = await parseBody(c, ThreadActionInputSchema);
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
          return c.json({ outcome: "already_applied", decision: existingDecision, plan: existingPlan }, 200);
        }
        const fallbackReason = "An apply plan already exists for this selected action; OpenTag will not execute it again from a repeated thread reply.";
        const childRun = await createChildRunForThreadAction({
          repo,
          command,
          resolved: resolved.resolved,
          runId: stableChildRunId({
            command,
            resolved: resolved.resolved,
            sourceApplyPlanId: existingPlan.id,
            fallbackReason
          }),
          approvalDecisionId: existingPlan.approvalDecisionId,
          sourceApplyPlanId: existingPlan.id,
          fallbackReason
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
            body: renderChildRunCreatedBody({
              lead: "This action was already planned, so OpenTag will not execute the external write again.",
              resolved: resolved.resolved,
              childRun,
              approvalDecisionId: existingPlan.approvalDecisionId,
              sourceApplyPlanId: existingPlan.id,
              fallbackReason
            }),
            ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
          }
        });
        return c.json({ outcome: "already_planned", decision: existingDecision, plan: existingPlan, run: childRun }, 200);
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
      const body = `Rejected ${selectionText} from \`${resolved.resolved.proposal.snapshot.proposalId}\`.`;
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
      const body = `Approved ${selectionText} from \`${resolved.resolved.proposal.snapshot.proposalId}\`.\n\nReply with \`apply ${resolved.resolved.selectedCandidates[0]?.index ?? 1}\` to apply it, or \`continue ${resolved.resolved.selectedCandidates[0]?.index ?? 1}\` to continue with a follow-up run.`;
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
        lead: `Continuing from ${selectionText} in \`${resolved.resolved.proposal.snapshot.proposalId}\`.`,
        resolved: resolved.resolved,
        childRun,
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
        return c.json({ outcome: "already_applied", decision, plan: planResult.plan }, 200);
      }
      const fallbackReason = "An apply plan already exists for this selected action; OpenTag will not execute it again from a repeated thread reply.";
      const childRun = await createChildRunForThreadAction({
        repo,
        command,
        resolved: resolved.resolved,
        runId: stableChildRunId({
          command,
          resolved: resolved.resolved,
          sourceApplyPlanId: planResult.plan.id,
          fallbackReason
        }),
        approvalDecisionId: decision.id,
        sourceApplyPlanId: planResult.plan.id,
        fallbackReason
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
          body: renderChildRunCreatedBody({
            lead: "This action was already planned, so OpenTag will not execute the external write again.",
            resolved: resolved.resolved,
            childRun,
            approvalDecisionId: decision.id,
            sourceApplyPlanId: planResult.plan.id,
            fallbackReason
          }),
          ...(parsed.callback.threadKey ? { threadKey: parsed.callback.threadKey } : {})
        }
      });
      return c.json({ outcome: "already_planned", decision, plan: planResult.plan, run: childRun }, 200);
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
      const body = [
        `Applied ${selectionText} from \`${resolved.resolved.proposal.snapshot.proposalId}\`.`,
        "",
        "Result:",
        ...outcomes
          .filter((outcome) => resolved.resolved.selectedIntentIds.includes(outcome.intentId))
          .map((outcome) => `- \`${outcome.intentId}\`: ${outcome.outcome}${outcome.externalUri ? ` (${outcome.externalUri})` : ""}`)
      ].join("\n");
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
      lead: `Action ${selectionText} was approved, but OpenTag cannot directly apply it yet.`,
      resolved: resolved.resolved,
      childRun,
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
    const parsed = await parseBody(c, PromoteFollowUpRequestSchema);
    let promoted;
    try {
      promoted = await repo.createRunFromFollowUpRequest({
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
    const event = followUpRequest.event;
    if (presentation.shouldDeliverAcknowledgement(event.callback.provider)) {
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId: promoted.run.id,
          kind: "acknowledgement",
          provider: event.callback.provider,
          uri: event.callback.uri,
          body: presentation.acknowledgement({ provider: event.callback.provider, runId: promoted.run.id }),
          ...(event.target.agentId ? { agentId: event.target.agentId } : {}),
          ...(event.callback.threadKey ? { threadKey: event.callback.threadKey } : {})
        }
      });
    }
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
    const body = await parseBody(c, z.object({ executor: z.string().min(1) }));
    const ok = await repo.markRunning({
      runId: c.req.param("runId"),
      runnerId: c.req.param("runnerId"),
      executor: body.executor
    });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
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
    const body = await parseBody(c, ProgressSchema);
    const ok = await repo.recordProgress({
      runId,
      runnerId: c.req.param("runnerId"),
      message: body.message,
      ...(body.type ? { type: body.type } : {}),
      ...(body.at ? { at: body.at } : {}),
      ...(body.visibility ? { visibility: body.visibility } : {}),
      ...(body.importance ? { importance: body.importance } : {})
    });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    if (presentation.shouldDeliverProgress(stored.event.callback.provider)) {
      await deliverAndAudit({
        repo,
        sink: callbackSink,
        retry: callbackRetry,
        message: {
          runId,
          kind: "progress",
          provider: stored.event.callback.provider,
          uri: stored.event.callback.uri,
          body: presentation.progress({ provider: stored.event.callback.provider, runId, message: body.message }),
          ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
          ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
          statusMessageKey: `${runId}:status`
        }
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
    const parsed = await parseBody(c, CompleteRunSchema);
    const ok = await repo.completeRun({ runId, runnerId: c.req.param("runnerId"), result: parsed.result });
    if (!ok) return c.json({ error: "run_not_claimed_by_runner" }, 404);
    const stored = await repo.getRun({ runId });
    if (!stored) return c.json({ error: "run_not_found" }, 404);
    const finalPresentation = presentation.final({ provider: stored.event.callback.provider, result: parsed.result });
    await deliverAndAudit({
      repo,
      sink: callbackSink,
      retry: callbackRetry,
      message: {
        runId,
        kind: "final",
        provider: stored.event.callback.provider,
        uri: stored.event.callback.uri,
        body: finalPresentation.body,
        ...(stored.event.target.agentId ? { agentId: stored.event.target.agentId } : {}),
        ...(stored.event.callback.threadKey ? { threadKey: stored.event.callback.threadKey } : {}),
        ...(finalPresentation.blocks?.length ? { blocks: finalPresentation.blocks } : {})
      }
    });
    return c.json({ ok: true });
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
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err) {
      if (err instanceof SyntaxError) {
        return c.json({ error: "invalid_json_body" }, 400);
      }
      throw err;
    }
    const parsedBody = ApprovalDecisionInputSchema.safeParse(rawBody);
    if (!parsedBody.success) return c.json({ error: "invalid_approval_decision" }, 400);
    const body = parsedBody.data;
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
    const body = await parseBody(c, ApplyPlanInputSchema);
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
    const body = await parseBody(c, ChildRunInputSchema);
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
    // parse failures are surfaced as tagged HTTPException(400) by parseBody(),
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
