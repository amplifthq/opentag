import {
  ApprovalDecisionSchema,
  ApplyIntentOutcomeSchema,
  ApplyPlanSchema,
  ActionHintSchema,
  AdapterMutationMappingSchema,
  OpenTagEventSchema,
  OpenTagRunResultSchema,
  PolicyRuleSchema,
  ProposalLineageSchema,
  preflightMutationIntent,
  protocolRunFieldsFromEvent,
  RunEventImportanceSchema,
  RunEventVisibilitySchema,
  SuggestedChangesSnapshotSchema,
  type ApprovalDecision,
  type ApplyIntentOutcome,
  type ApplyPlan,
  type ActionHint,
  type AdapterMutationMapping,
  type MutationIntentActionability,
  type OpenTagEvent,
  type OpenTagRun,
  type OpenTagRunResult,
  type PolicyRule,
  type ProposalLineage,
  type RunEventImportance,
  type RunEventVisibility,
  type SuggestedChangesSnapshot
} from "@opentag/core";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  applyPlans,
  approvalDecisions,
  channelBindings,
  repoBindings,
  repoMutationMappings,
  repoPolicyRules,
  callbackDeliveries,
  runEvents,
  runners,
  runs,
  suggestedChanges
} from "./schema.js";

export type ClaimedOpenTagRun = {
  run: OpenTagRun;
  event: OpenTagEvent;
};

export type OpenTagAuditEvent = {
  id: number;
  runId: string;
  type: string;
  visibility: RunEventVisibility;
  importance: RunEventImportance;
  message?: string;
  payload: unknown;
  createdAt: string;
};

export type CallbackDeliveryKind = "acknowledgement" | "progress" | "final";
export type CallbackDeliveryProvider = "github" | "slack" | "telegram" | "lark" | "webhook";
export type CallbackDeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

export type CallbackDelivery = {
  id: number;
  runId: string;
  kind: CallbackDeliveryKind;
  provider: CallbackDeliveryProvider;
  uri: string;
  body: string;
  threadKey?: string;
  agentId?: string;
  statusMessageKey?: string;
  blocks?: unknown[];
  status: CallbackDeliveryStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RepoBinding = {
  provider: string;
  owner: string;
  repo: string;
  runnerId: string;
  workspacePath?: string;
  defaultExecutor?: string;
  allowedActors?: string[];
};

export type ChannelBinding = {
  provider: string;
  accountId: string;
  conversationId: string;
  repoProvider: string;
  owner: string;
  repo: string;
  metadata?: Record<string, unknown>;
};

export type SlackChannelBinding = {
  teamId: string;
  channelId: string;
  repoProvider?: string;
  owner: string;
  repo: string;
};

export type RunnerRegistration = {
  runnerId: string;
  name: string;
  createdAt: string;
  heartbeatAt?: string;
};

export type StoredSuggestedChangesSnapshot = {
  runId: string;
  snapshot: SuggestedChangesSnapshot;
};

export type ApplyOutcomeCounts = {
  applied: number;
  skipped: number;
  failed: number;
  stale: number;
  unsupported: number;
};

export type CreateRunResult = {
  run: OpenTagRun;
  created: boolean;
};

export type OpenTagRunMetrics = {
  runId: string;
  totalEventCount: number;
  humanEventCount: number;
  auditEventCount: number;
  debugEventCount: number;
  humanCallbackCount: number;
  threadNoiseRatio: number;
  suggestedChangesCount: number;
  approvalDecisionCount: number;
  applyPlanCount: number;
  childRunCount: number;
  applyOutcomeCounts: ApplyOutcomeCounts;
  staleIntentCount: number;
};

export type OpenTagAggregateMetrics = {
  scope: "repo" | "work_thread";
  scopeId: string;
  runCount: number;
  totalEventCount: number;
  humanEventCount: number;
  auditEventCount: number;
  debugEventCount: number;
  humanCallbackCount: number;
  threadNoiseRatio: number;
  suggestedChangesCount: number;
  approvalDecisionCount: number;
  applyPlanCount: number;
  childRunCount: number;
  applyOutcomeCounts: ApplyOutcomeCounts;
  staleIntentCount: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isIsoExpired(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() <= now.getTime();
}

function defaultRunEventVisibility(type: string): RunEventVisibility {
  if (type.startsWith("callback.")) return "human";
  if (type.startsWith("executor.log")) return "debug";
  if (type === "run.progress") return "audit";
  return "audit";
}

function defaultRunEventImportance(type: string): RunEventImportance {
  if (type === "run.waiting_for_permission") return "blocking";
  if (type === "run.completed" || type.startsWith("callback.final")) return "high";
  if (type === "run.created") return "low";
  return "normal";
}

function runFromRow(row: typeof runs.$inferSelect): OpenTagRun {
  const event = OpenTagEventSchema.parse(JSON.parse(row.eventJson));
  const result = row.resultJson ? OpenTagRunResultSchema.parse(JSON.parse(row.resultJson)) : undefined;
  const triggeredByAction = row.triggeredByActionJson ? ActionHintSchema.parse(JSON.parse(row.triggeredByActionJson)) : undefined;
  const protocolFields = protocolRunFieldsFromEvent(event, row.createdAt);
  return {
    id: row.id,
    eventId: row.eventId,
    status: row.status as OpenTagRun["status"],
    ...protocolFields,
    ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
    ...(triggeredByAction ? { triggeredByAction } : {}),
    ...(row.sourceProposalId ? { sourceProposalId: row.sourceProposalId } : {}),
    ...(row.sourceApplyPlanId ? { sourceApplyPlanId: row.sourceApplyPlanId } : {}),
    assignedRunnerId: row.assignedRunnerId ?? undefined,
    executor: row.executor ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(result ? { result } : {})
  };
}

function callbackDeliveryFromRow(row: typeof callbackDeliveries.$inferSelect): CallbackDelivery {
  const metadata =
    row.metadataJson && typeof row.metadataJson === "string"
      ? (JSON.parse(row.metadataJson) as { agentId?: string; statusMessageKey?: string; blocks?: unknown[] })
      : undefined;
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as CallbackDeliveryKind,
    provider: row.provider as CallbackDeliveryProvider,
    uri: row.uri,
    body: row.body,
    ...(row.threadKey ? { threadKey: row.threadKey } : {}),
    ...(metadata?.agentId ? { agentId: metadata.agentId } : {}),
    ...(metadata?.statusMessageKey ? { statusMessageKey: metadata.statusMessageKey } : {}),
    ...(metadata?.blocks ? { blocks: metadata.blocks } : {}),
    status: row.status as CallbackDeliveryStatus,
    attempts: row.attempts,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function runnerFromRow(row: typeof runners.$inferSelect): RunnerRegistration {
  return {
    runnerId: row.runnerId,
    name: row.name,
    createdAt: row.createdAt,
    ...(row.heartbeatAt ? { heartbeatAt: row.heartbeatAt } : {})
  };
}

function recordFromJson(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function channelBindingFromRow(row: typeof channelBindings.$inferSelect): ChannelBinding {
  const metadata = recordFromJson(row.metadataJson);
  return {
    provider: row.provider,
    accountId: row.accountId,
    conversationId: row.conversationId,
    repoProvider: row.repoProvider,
    owner: row.owner,
    repo: row.repo,
    ...(metadata ? { metadata } : {})
  };
}

function repoKeyFromEvent(event: OpenTagEvent): { provider: string; owner: string; repo: string } | null {
  const owner = event.metadata["owner"];
  const repo = event.metadata["repo"];
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  return {
    provider: typeof event.metadata["repoProvider"] === "string" ? (event.metadata["repoProvider"] as string) : "github",
    owner,
    repo
  };
}

function syntheticManualApprovalPolicyRules(decision: ApprovalDecision): PolicyRule[] {
  return [
    {
      id: `manual_approval_${decision.id}`,
      scope: "primary_anchor_override",
      effect: "allow",
      reason: "Manual approval decision authorized selected proposal intents."
    }
  ];
}

function lineageScopeKey(input: { runId: string; snapshot: SuggestedChangesSnapshot }): string {
  return input.snapshot.workThread?.id ?? `run:${input.runId}`;
}

function computeProposalLineage(snapshots: StoredSuggestedChangesSnapshot[], targetScopeKey: string): ProposalLineage {
  const scoped = snapshots
    .filter((snapshot) => lineageScopeKey(snapshot) === targetScopeKey)
    .sort((left, right) => {
      const timeDelta = new Date(left.snapshot.createdAt).getTime() - new Date(right.snapshot.createdAt).getTime();
      if (timeDelta !== 0) return timeDelta;
      return left.snapshot.proposalId.localeCompare(right.snapshot.proposalId);
    });

  const latestProposalByDomain = new Map<string, string>();
  const explicitSupersession = new Map<string, { proposalId: string; intentId: string }>();
  for (const stored of scoped) {
    const domainsInProposal = new Set<string>();
    for (const intent of stored.snapshot.intents) {
      domainsInProposal.add(intent.domain);
      for (const supersededIntentId of intent.supersedesIntentIds ?? []) {
        explicitSupersession.set(supersededIntentId, { proposalId: stored.snapshot.proposalId, intentId: intent.intentId });
      }
    }
    for (const domain of domainsInProposal) {
      latestProposalByDomain.set(domain, stored.snapshot.proposalId);
    }
  }

  const entries: MutationIntentActionability[] = [];
  for (const stored of scoped) {
    for (const intent of stored.snapshot.intents) {
      const explicit = explicitSupersession.get(intent.intentId);
      const latestProposalId = latestProposalByDomain.get(intent.domain);
      if (explicit) {
        entries.push({
          proposalId: stored.snapshot.proposalId,
          intentId: intent.intentId,
          domain: intent.domain,
          status: "superseded",
          supersededByProposalId: explicit.proposalId,
          supersededByIntentId: explicit.intentId,
          reason: "A later intent explicitly superseded this intent."
        });
      } else if (latestProposalId && latestProposalId !== stored.snapshot.proposalId) {
        const supersedingIntent = scoped
          .find((candidate) => candidate.snapshot.proposalId === latestProposalId)
          ?.snapshot.intents.find((candidateIntent) => candidateIntent.domain === intent.domain);
        entries.push({
          proposalId: stored.snapshot.proposalId,
          intentId: intent.intentId,
          domain: intent.domain,
          status: "superseded",
          supersededByProposalId: latestProposalId,
          ...(supersedingIntent ? { supersededByIntentId: supersedingIntent.intentId } : {}),
          reason: `A newer proposal superseded the ${intent.domain} domain.`
        });
      } else {
        entries.push({
          proposalId: stored.snapshot.proposalId,
          intentId: intent.intentId,
          domain: intent.domain,
          status: "current"
        });
      }
    }
  }

  return ProposalLineageSchema.parse({ scopeKey: targetScopeKey, entries });
}

function emptyApplyOutcomeCounts(): ApplyOutcomeCounts {
  return {
    applied: 0,
    skipped: 0,
    failed: 0,
    stale: 0,
    unsupported: 0
  };
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function metricsFromEvents(runId: string, events: OpenTagAuditEvent[]): OpenTagRunMetrics {
  const latestApplyPlans = new Map<string, ApplyPlan>();
  for (const event of events) {
    if (event.type !== "apply_plan.created" && event.type !== "apply_plan.executed") continue;
    const parsed = ApplyPlanSchema.safeParse(event.payload);
    if (parsed.success) {
      latestApplyPlans.set(parsed.data.id, parsed.data);
    }
  }

  const applyOutcomeCounts = emptyApplyOutcomeCounts();
  for (const plan of latestApplyPlans.values()) {
    for (const outcome of plan.outcomes ?? []) {
      applyOutcomeCounts[outcome.outcome] += 1;
    }
  }

  const humanCallbackCount = events.filter((event) => event.visibility === "human" && event.type.startsWith("callback.")).length;
  const auditEventCount = events.filter((event) => event.visibility === "audit").length;
  return {
    runId,
    totalEventCount: events.length,
    humanEventCount: events.filter((event) => event.visibility === "human").length,
    auditEventCount,
    debugEventCount: events.filter((event) => event.visibility === "debug").length,
    humanCallbackCount,
    threadNoiseRatio: auditEventCount === 0 ? humanCallbackCount : humanCallbackCount / auditEventCount,
    suggestedChangesCount: events
      .filter((event) => event.type === "proposal.snapshot.created")
      .reduce((count, event) => {
        const payload = recordFromUnknown(event.payload);
        const intents = payload?.["intents"];
        return count + (Array.isArray(intents) ? intents.length : 1);
      }, 0),
    approvalDecisionCount: events.filter((event) => event.type === "approval.decision.recorded").length,
    applyPlanCount: latestApplyPlans.size,
    childRunCount: events.filter((event) => event.type === "run.child_created").length,
    applyOutcomeCounts,
    staleIntentCount: applyOutcomeCounts.stale
  };
}

function aggregateMetrics(input: {
  scope: OpenTagAggregateMetrics["scope"];
  scopeId: string;
  runs: OpenTagRunMetrics[];
}): OpenTagAggregateMetrics {
  const applyOutcomeCounts = emptyApplyOutcomeCounts();
  for (const run of input.runs) {
    applyOutcomeCounts.applied += run.applyOutcomeCounts.applied;
    applyOutcomeCounts.skipped += run.applyOutcomeCounts.skipped;
    applyOutcomeCounts.failed += run.applyOutcomeCounts.failed;
    applyOutcomeCounts.stale += run.applyOutcomeCounts.stale;
    applyOutcomeCounts.unsupported += run.applyOutcomeCounts.unsupported;
  }
  const auditEventCount = input.runs.reduce((sum, run) => sum + run.auditEventCount, 0);
  const humanCallbackCount = input.runs.reduce((sum, run) => sum + run.humanCallbackCount, 0);
  return {
    scope: input.scope,
    scopeId: input.scopeId,
    runCount: input.runs.length,
    totalEventCount: input.runs.reduce((sum, run) => sum + run.totalEventCount, 0),
    humanEventCount: input.runs.reduce((sum, run) => sum + run.humanEventCount, 0),
    auditEventCount,
    debugEventCount: input.runs.reduce((sum, run) => sum + run.debugEventCount, 0),
    humanCallbackCount,
    threadNoiseRatio: auditEventCount === 0 ? humanCallbackCount : humanCallbackCount / auditEventCount,
    suggestedChangesCount: input.runs.reduce((sum, run) => sum + run.suggestedChangesCount, 0),
    approvalDecisionCount: input.runs.reduce((sum, run) => sum + run.approvalDecisionCount, 0),
    applyPlanCount: input.runs.reduce((sum, run) => sum + run.applyPlanCount, 0),
    childRunCount: input.runs.reduce((sum, run) => sum + run.childRunCount, 0),
    applyOutcomeCounts,
    staleIntentCount: input.runs.reduce((sum, run) => sum + run.staleIntentCount, 0)
  };
}

export function createOpenTagRepository(db: BetterSQLite3Database) {
  async function appendRunEvent(input: {
    runId: string;
    type: string;
    payload: unknown;
    createdAt?: string;
    visibility?: RunEventVisibility;
    importance?: RunEventImportance;
    message?: string;
  }): Promise<void> {
    await db.insert(runEvents).values({
      runId: input.runId,
      type: input.type,
      visibility: input.visibility ?? defaultRunEventVisibility(input.type),
      importance: input.importance ?? defaultRunEventImportance(input.type),
      message: input.message ?? null,
      payloadJson: JSON.stringify(input.payload),
      createdAt: input.createdAt ?? nowIso()
    });
  }

  return {
    appendRunEvent,

    async registerRunner(input: { runnerId: string; name: string }): Promise<void> {
      const createdAt = nowIso();
      await db.insert(runners).values({ runnerId: input.runnerId, name: input.name, createdAt }).onConflictDoNothing();
    },

    async getRunner(input: { runnerId: string }): Promise<RunnerRegistration | null> {
      const row = await db.select().from(runners).where(eq(runners.runnerId, input.runnerId)).limit(1).get();
      return row ? runnerFromRow(row) : null;
    },

    async createRepoBinding(input: {
      provider: string;
      owner: string;
      repo: string;
      runnerId: string;
      workspacePath?: string;
      defaultExecutor?: string;
      allowedActors?: string[];
    }): Promise<void> {
      await db
        .insert(repoBindings)
        .values({
          ...input,
          workspacePath: input.workspacePath ?? null,
          defaultExecutor: input.defaultExecutor ?? null,
          allowedActorsJson: input.allowedActors ? JSON.stringify(input.allowedActors) : null,
          createdAt: nowIso()
        })
        .onConflictDoUpdate({
          target: [repoBindings.provider, repoBindings.owner, repoBindings.repo],
          set: {
            runnerId: input.runnerId,
            workspacePath: input.workspacePath ?? null,
            defaultExecutor: input.defaultExecutor ?? null,
            allowedActorsJson: input.allowedActors ? JSON.stringify(input.allowedActors) : null
          }
        });
    },

    async upsertRepoPolicyRule(input: { provider: string; owner: string; repo: string; rule: PolicyRule }): Promise<PolicyRule> {
      const rule = PolicyRuleSchema.parse(input.rule);
      const createdAt = nowIso();
      await db
        .insert(repoPolicyRules)
        .values({
          id: rule.id,
          provider: input.provider,
          owner: input.owner,
          repo: input.repo,
          ruleJson: JSON.stringify(rule),
          createdAt
        })
        .onConflictDoUpdate({
          target: [repoPolicyRules.provider, repoPolicyRules.owner, repoPolicyRules.repo, repoPolicyRules.id],
          set: {
            ruleJson: JSON.stringify(rule),
            createdAt
          }
        });
      return rule;
    },

    async listRepoPolicyRules(input: { provider: string; owner: string; repo: string }): Promise<PolicyRule[]> {
      const rows = await db
        .select()
        .from(repoPolicyRules)
        .where(and(eq(repoPolicyRules.provider, input.provider), eq(repoPolicyRules.owner, input.owner), eq(repoPolicyRules.repo, input.repo)))
        .orderBy(asc(repoPolicyRules.createdAt));
      return rows.map((row) => PolicyRuleSchema.parse(JSON.parse(row.ruleJson)));
    },

    async upsertRepoMutationMapping(input: {
      provider: string;
      owner: string;
      repo: string;
      mapping: AdapterMutationMapping;
    }): Promise<AdapterMutationMapping> {
      const mapping = AdapterMutationMappingSchema.parse(input.mapping);
      const createdAt = nowIso();
      await db
        .insert(repoMutationMappings)
        .values({
          id: mapping.id,
          provider: input.provider,
          owner: input.owner,
          repo: input.repo,
          mappingJson: JSON.stringify(mapping),
          createdAt
        })
        .onConflictDoUpdate({
          target: [repoMutationMappings.provider, repoMutationMappings.owner, repoMutationMappings.repo, repoMutationMappings.id],
          set: {
            mappingJson: JSON.stringify(mapping),
            createdAt
          }
        });
      return mapping;
    },

    async listRepoMutationMappings(input: { provider: string; owner: string; repo: string }): Promise<AdapterMutationMapping[]> {
      const rows = await db
        .select()
        .from(repoMutationMappings)
        .where(and(eq(repoMutationMappings.provider, input.provider), eq(repoMutationMappings.owner, input.owner), eq(repoMutationMappings.repo, input.repo)))
        .orderBy(asc(repoMutationMappings.createdAt));
      return rows.map((row) => AdapterMutationMappingSchema.parse(JSON.parse(row.mappingJson)));
    },

    async upsertChannelBinding(input: ChannelBinding): Promise<void> {
      await db
        .insert(channelBindings)
        .values({
          provider: input.provider,
          accountId: input.accountId,
          conversationId: input.conversationId,
          repoProvider: input.repoProvider,
          owner: input.owner,
          repo: input.repo,
          metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
          createdAt: nowIso()
        })
        .onConflictDoUpdate({
          target: [channelBindings.provider, channelBindings.accountId, channelBindings.conversationId],
          set: {
            repoProvider: input.repoProvider,
            owner: input.owner,
            repo: input.repo,
            metadataJson: input.metadata ? JSON.stringify(input.metadata) : null
          }
        });
    },

    async createSlackChannelBinding(input: SlackChannelBinding): Promise<void> {
      const repoProvider = input.repoProvider ?? "github";
      await db
        .insert(channelBindings)
        .values({
          provider: "slack",
          accountId: input.teamId,
          conversationId: input.channelId,
          repoProvider,
          owner: input.owner,
          repo: input.repo,
          metadataJson: null,
          createdAt: nowIso()
        })
        .onConflictDoUpdate({
          target: [channelBindings.provider, channelBindings.accountId, channelBindings.conversationId],
          set: {
            repoProvider,
            owner: input.owner,
            repo: input.repo
          }
        });
    },

    async createRun(input: {
      id: string;
      event: OpenTagEvent;
      parentRunId?: string;
      triggeredByAction?: ActionHint;
      sourceProposalId?: string;
      sourceApplyPlanId?: string;
    }): Promise<CreateRunResult> {
      const event = OpenTagEventSchema.parse(input.event);
      const triggeredByAction = input.triggeredByAction ? ActionHintSchema.parse(input.triggeredByAction) : undefined;
      const createdAt = nowIso();
      const protocolFields = protocolRunFieldsFromEvent(event, createdAt);
      const repoKey = repoKeyFromEvent(event);
      const insertResult = await db
        .insert(runs)
        .values({
        id: input.id,
        eventId: event.id,
        status: "queued",
        eventJson: JSON.stringify(event),
        parentRunId: input.parentRunId ?? null,
        triggeredByActionJson: triggeredByAction ? JSON.stringify(triggeredByAction) : null,
        sourceProposalId: input.sourceProposalId ?? null,
        sourceApplyPlanId: input.sourceApplyPlanId ?? null,
        repoProvider: repoKey?.provider ?? null,
        repoOwner: repoKey?.owner ?? null,
        repoName: repoKey?.repo ?? null,
        workThreadId: protocolFields.thread?.id ?? null,
        createdAt,
        updatedAt: createdAt
        })
        .onConflictDoNothing({ target: runs.eventId });
      if (insertResult.changes === 0) {
        const existingBySourceEvent = await db.select().from(runs).where(eq(runs.eventId, event.id)).limit(1).get();
        if (!existingBySourceEvent) {
          throw new Error(`Run already exists for event ${event.id}, but it could not be loaded`);
        }
        await appendRunEvent({
          runId: existingBySourceEvent.id,
          type: "run.create_idempotent_replay",
          payload: { requestedRunId: input.id, eventId: event.id },
          visibility: "audit",
          importance: "low",
          createdAt
        });
        return { run: runFromRow(existingBySourceEvent), created: false };
      }
      await appendRunEvent({
        runId: input.id,
        type: "run.created",
        payload: { eventId: event.id },
        visibility: "audit",
        importance: "low",
        createdAt
      });
      await appendRunEvent({
        runId: input.id,
        type: "context_packet.generated",
        payload: {
          contextPacket: protocolFields.contextPacket,
          ...(protocolFields.thread ? { thread: protocolFields.thread } : {})
        },
        visibility: "audit",
        importance: "normal",
        message: protocolFields.contextPacket.summary,
        createdAt
      });
      if (input.parentRunId) {
        await appendRunEvent({
          runId: input.parentRunId,
          type: "run.child_created",
          payload: {
            childRunId: input.id,
            ...(triggeredByAction ? { triggeredByAction } : {}),
            ...(input.sourceProposalId ? { sourceProposalId: input.sourceProposalId } : {}),
            ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {})
          },
          visibility: "audit",
          importance: "normal",
          message: `Created child run ${input.id}.`,
          createdAt
        });
      }
      return {
        run: {
          id: input.id,
          eventId: event.id,
          status: "queued",
          ...protocolFields,
          ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
          ...(triggeredByAction ? { triggeredByAction } : {}),
          ...(input.sourceProposalId ? { sourceProposalId: input.sourceProposalId } : {}),
          ...(input.sourceApplyPlanId ? { sourceApplyPlanId: input.sourceApplyPlanId } : {}),
          createdAt,
          updatedAt: createdAt
        },
        created: true
      };
    },

    async claimNextRun(input: { runnerId: string; leaseSeconds: number }): Promise<ClaimedOpenTagRun | null> {
      const now = new Date();
      const activeRows = await db
        .select()
        .from(runs)
        .where(inArray(runs.status, ["assigned", "running"]))
        .orderBy(asc(runs.createdAt));
      for (const activeRow of activeRows) {
        if (!isIsoExpired(activeRow.leaseExpiresAt, now)) continue;
        const updatedAt = nowIso();
        await db
          .update(runs)
          .set({
            status: "queued",
            assignedRunnerId: null,
            leasedAt: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            updatedAt
          })
          .where(eq(runs.id, activeRow.id));
        await appendRunEvent({
          runId: activeRow.id,
          type: "run.lease_expired",
          payload: { previousRunnerId: activeRow.assignedRunnerId, previousLeaseExpiresAt: activeRow.leaseExpiresAt },
          visibility: "audit",
          importance: "normal",
          createdAt: updatedAt
        });
      }

      const queuedRows = await db.select().from(runs).where(eq(runs.status, "queued")).orderBy(asc(runs.createdAt));
      const row = queuedRows.find((candidate) => {
        const event = OpenTagEventSchema.parse(JSON.parse(candidate.eventJson));
        const repoKey = repoKeyFromEvent(event);
        if (!repoKey) return false;
        const binding = db
          .select()
          .from(repoBindings)
          .where(
            and(
              eq(repoBindings.provider, repoKey.provider),
              eq(repoBindings.owner, repoKey.owner),
              eq(repoBindings.repo, repoKey.repo),
              eq(repoBindings.runnerId, input.runnerId)
            )
          )
          .limit(1)
          .get();
        return Boolean(binding);
      });
      if (!row) return null;

      const updatedAt = nowIso();
      const leasedAt = updatedAt;
      const leaseExpiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
      const updateResult = await db
        .update(runs)
        .set({
          status: "assigned",
          assignedRunnerId: input.runnerId,
          leasedAt,
          leaseExpiresAt,
          heartbeatAt: leasedAt,
          updatedAt
        })
        .where(and(eq(runs.id, row.id), eq(runs.status, "queued")));
      if (updateResult.changes === 0) {
        return null;
      }
      await appendRunEvent({
        runId: row.id,
        type: "run.claimed",
        payload: { runnerId: input.runnerId, leasedAt, leaseExpiresAt },
        visibility: "audit",
        importance: "normal",
        createdAt: updatedAt
      });

      return {
        run: {
          id: row.id,
          eventId: row.eventId,
          status: "assigned",
          ...protocolRunFieldsFromEvent(OpenTagEventSchema.parse(JSON.parse(row.eventJson)), row.createdAt),
          ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
          ...(row.triggeredByActionJson ? { triggeredByAction: ActionHintSchema.parse(JSON.parse(row.triggeredByActionJson)) } : {}),
          ...(row.sourceProposalId ? { sourceProposalId: row.sourceProposalId } : {}),
          ...(row.sourceApplyPlanId ? { sourceApplyPlanId: row.sourceApplyPlanId } : {}),
          assignedRunnerId: input.runnerId,
          executor: row.executor ?? undefined,
          createdAt: row.createdAt,
          updatedAt
        },
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      };
    },

    async getRepoBinding(input: { provider: string; owner: string; repo: string }): Promise<RepoBinding | null> {
      const row = await db
        .select()
        .from(repoBindings)
        .where(
          and(eq(repoBindings.provider, input.provider), eq(repoBindings.owner, input.owner), eq(repoBindings.repo, input.repo))
        )
        .limit(1)
        .get();
      if (!row) return null;
      return {
        provider: row.provider,
        owner: row.owner,
        repo: row.repo,
        runnerId: row.runnerId,
        ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
        ...(row.defaultExecutor ? { defaultExecutor: row.defaultExecutor } : {}),
        ...(row.allowedActorsJson ? { allowedActors: JSON.parse(row.allowedActorsJson) as string[] } : {})
      };
    },

    async getChannelBinding(input: {
      provider: string;
      accountId: string;
      conversationId: string;
    }): Promise<ChannelBinding | null> {
      const row = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.provider, input.provider),
            eq(channelBindings.accountId, input.accountId),
            eq(channelBindings.conversationId, input.conversationId)
          )
        )
        .limit(1)
        .get();
      return row ? channelBindingFromRow(row) : null;
    },

    async getSlackChannelBinding(input: { teamId: string; channelId: string }): Promise<SlackChannelBinding | null> {
      const row = await db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.provider, "slack"),
            eq(channelBindings.accountId, input.teamId),
            eq(channelBindings.conversationId, input.channelId)
          )
        )
        .limit(1)
        .get();
      if (!row) return null;
      const binding = channelBindingFromRow(row);
      return {
        teamId: binding.accountId,
        channelId: binding.conversationId,
        repoProvider: binding.repoProvider,
        owner: binding.owner,
        repo: binding.repo
      };
    },

    async heartbeat(input: { runId: string; runnerId: string; leaseSeconds?: number }): Promise<boolean> {
      const updatedAt = nowIso();
      const row = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, input.runId), eq(runs.assignedRunnerId, input.runnerId)))
        .limit(1)
        .get();
      if (!row) return false;
      const leaseSeconds = input.leaseSeconds ?? 60;
      const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      await db
        .update(runs)
        .set({ heartbeatAt: updatedAt, leaseExpiresAt, updatedAt })
        .where(eq(runs.id, input.runId));
      await appendRunEvent({
        runId: input.runId,
        type: "run.heartbeat",
        payload: { runnerId: input.runnerId, heartbeatAt: updatedAt, leaseExpiresAt },
        visibility: "debug",
        importance: "low",
        createdAt: updatedAt
      });
      return true;
    },

    async markRunning(input: { runId: string; executor: string; runnerId?: string }): Promise<boolean> {
      const updatedAt = nowIso();
      const conditions = [eq(runs.id, input.runId)];
      if (input.runnerId) {
        conditions.push(eq(runs.assignedRunnerId, input.runnerId));
      }
      const updateResult = await db
        .update(runs)
        .set({ status: "running", executor: input.executor, updatedAt })
        .where(and(...conditions));
      if (updateResult.changes === 0) {
        return false;
      }
      await appendRunEvent({
        runId: input.runId,
        type: "run.running",
        payload: input.runnerId ? { runnerId: input.runnerId, executor: input.executor } : { executor: input.executor },
        visibility: "audit",
        importance: "normal",
        createdAt: updatedAt
      });
      return true;
    },

    async completeRun(input: { runId: string; result: OpenTagRunResult; runnerId?: string }): Promise<boolean> {
      const result = OpenTagRunResultSchema.parse(input.result);
      const updatedAt = nowIso();
      const status =
        result.conclusion === "success"
          ? "succeeded"
          : result.conclusion === "cancelled"
            ? "cancelled"
            : result.conclusion === "needs_human"
              ? "needs_approval"
              : "failed";
      const runRow = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      if (!runRow) {
        if (input.runnerId) return false;
        throw new Error(`Run not found: ${input.runId}`);
      }
      if (input.runnerId && runRow.assignedRunnerId !== input.runnerId) {
        return false;
      }
      const runThread = runRow ? protocolRunFieldsFromEvent(OpenTagEventSchema.parse(JSON.parse(runRow.eventJson)), runRow.createdAt).thread : undefined;
      await db
        .update(runs)
        .set({
          status,
          resultJson: JSON.stringify(result),
          assignedRunnerId: null,
          leasedAt: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt
        })
        .where(input.runnerId ? and(eq(runs.id, input.runId), eq(runs.assignedRunnerId, input.runnerId)) : eq(runs.id, input.runId));
      for (const snapshot of result.suggestedChanges ?? []) {
        const parsedSnapshot = SuggestedChangesSnapshotSchema.parse({
          ...snapshot,
          sourceRunId: snapshot.sourceRunId ?? input.runId,
          ...(snapshot.workThread || !runThread ? {} : { workThread: runThread })
        });
        await db
          .insert(suggestedChanges)
          .values({
            proposalId: parsedSnapshot.proposalId,
            runId: input.runId,
            snapshotJson: JSON.stringify(parsedSnapshot),
            createdAt: parsedSnapshot.createdAt
          })
          .onConflictDoUpdate({
            target: suggestedChanges.proposalId,
            set: {
              runId: input.runId,
              snapshotJson: JSON.stringify(parsedSnapshot),
              createdAt: parsedSnapshot.createdAt
            }
          });
        await appendRunEvent({
          runId: input.runId,
          type: "proposal.snapshot.created",
          payload: parsedSnapshot,
          visibility: "audit",
          importance: "high",
          message: parsedSnapshot.summary,
          createdAt: updatedAt
        });
      }
      await appendRunEvent({
        runId: input.runId,
        type: "run.completed",
        payload: result,
        visibility: "audit",
        importance: "high",
        message: result.summary,
        createdAt: updatedAt
      });
      if ((result.suggestedChanges?.length ?? 0) > 0 || (result.artifacts?.length ?? 0) > 0) {
        await appendRunEvent({
          runId: input.runId,
          type: "success_metric.observed",
          payload: {
            metric: "time_to_first_useful_artifact",
            artifactCount: result.artifacts?.length ?? 0,
            suggestedChangesCount: result.suggestedChanges?.length ?? 0
          },
          visibility: "audit",
          importance: "normal",
          createdAt: updatedAt
        });
      }
      return true;
    },

    async getSuggestedChanges(input: { proposalId: string }): Promise<StoredSuggestedChangesSnapshot | null> {
      const row = await db.select().from(suggestedChanges).where(eq(suggestedChanges.proposalId, input.proposalId)).limit(1).get();
      if (!row) return null;
      return {
        runId: row.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
      };
    },

    async listSuggestedChangesForRun(input: { runId: string }): Promise<SuggestedChangesSnapshot[]> {
      const rows = await db.select().from(suggestedChanges).where(eq(suggestedChanges.runId, input.runId)).orderBy(asc(suggestedChanges.createdAt));
      return rows.map((row) => SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson)));
    },

    async getProposalLineage(input: { proposalId: string }): Promise<ProposalLineage | null> {
      const targetRow = await db.select().from(suggestedChanges).where(eq(suggestedChanges.proposalId, input.proposalId)).limit(1).get();
      if (!targetRow) return null;
      const target = {
        runId: targetRow.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(targetRow.snapshotJson))
      };
      const rows = await db.select().from(suggestedChanges).orderBy(asc(suggestedChanges.createdAt));
      const snapshots = rows.map((row) => ({
        runId: row.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
      }));
      return computeProposalLineage(snapshots, lineageScopeKey(target));
    },

    async listCurrentMutationIntents(input: { proposalId: string }): Promise<MutationIntentActionability[] | null> {
      const targetRow = await db.select().from(suggestedChanges).where(eq(suggestedChanges.proposalId, input.proposalId)).limit(1).get();
      if (!targetRow) return null;
      const rows = await db.select().from(suggestedChanges).orderBy(asc(suggestedChanges.createdAt));
      const lineage = computeProposalLineage(
        rows.map((row) => ({
          runId: row.runId,
          snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
        })),
        lineageScopeKey({
          runId: targetRow.runId,
          snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(targetRow.snapshotJson))
        })
      );
      if (!lineage) return null;
      return lineage.entries.filter((entry) => entry.status === "current");
    },

    async recordApprovalDecision(input: ApprovalDecision): Promise<ApprovalDecision | null> {
      const decision = ApprovalDecisionSchema.parse(input);
      const storedProposalRow = await db
        .select()
        .from(suggestedChanges)
        .where(eq(suggestedChanges.proposalId, decision.proposalId))
        .limit(1)
        .get();
      if (!storedProposalRow) return null;
      await db
        .insert(approvalDecisions)
        .values({
          id: decision.id,
          proposalId: decision.proposalId,
          decisionJson: JSON.stringify(decision),
          createdAt: decision.approvedAt
        })
        .onConflictDoUpdate({
          target: approvalDecisions.id,
          set: {
            proposalId: decision.proposalId,
            decisionJson: JSON.stringify(decision),
            createdAt: decision.approvedAt
          }
        });
      await appendRunEvent({
        runId: storedProposalRow.runId,
        type: "approval.decision.recorded",
        payload: decision,
        visibility: "audit",
        importance: "high",
        message: `Approved ${decision.approvedIntentIds.length} intent(s).`,
        createdAt: decision.approvedAt
      });
      await appendRunEvent({
        runId: storedProposalRow.runId,
        type: "success_metric.observed",
        payload: {
          metric: "external_write_approval_rate",
          proposalId: decision.proposalId,
          approvedIntentCount: decision.approvedIntentIds.length
        },
        visibility: "audit",
        importance: "normal",
        createdAt: decision.approvedAt
      });
      return decision;
    },

    async getApprovalDecision(input: { id: string }): Promise<ApprovalDecision | null> {
      const row = await db.select().from(approvalDecisions).where(eq(approvalDecisions.id, input.id)).limit(1).get();
      return row ? ApprovalDecisionSchema.parse(JSON.parse(row.decisionJson)) : null;
    },

    async createApplyPlan(input: {
      id: string;
      proposalId: string;
      approvalDecisionId: string;
      selectedIntentIds?: string[];
      adapter?: string;
      policyRules?: PolicyRule[];
    }): Promise<ApplyPlan | null> {
      const storedProposalRow = await db
        .select()
        .from(suggestedChanges)
        .where(eq(suggestedChanges.proposalId, input.proposalId))
        .limit(1)
        .get();
      const decisionRow = await db
        .select()
        .from(approvalDecisions)
        .where(eq(approvalDecisions.id, input.approvalDecisionId))
        .limit(1)
        .get();
      const decision = decisionRow ? ApprovalDecisionSchema.parse(JSON.parse(decisionRow.decisionJson)) : null;
      if (!storedProposalRow || !decision || decision.proposalId !== input.proposalId) return null;
      const storedProposal = {
        runId: storedProposalRow.runId,
        snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(storedProposalRow.snapshotJson))
      };

      const runRow = await db.select().from(runs).where(eq(runs.id, storedProposal.runId)).limit(1).get();
      if (!runRow) return null;
      const event = OpenTagEventSchema.parse(JSON.parse(runRow.eventJson));
      const repoKey = repoKeyFromEvent(event);
      const storedPolicyRuleRows = repoKey
        ? await db
            .select()
            .from(repoPolicyRules)
            .where(and(eq(repoPolicyRules.provider, repoKey.provider), eq(repoPolicyRules.owner, repoKey.owner), eq(repoPolicyRules.repo, repoKey.repo)))
            .orderBy(asc(repoPolicyRules.createdAt))
        : [];
      const storedPolicyRules = storedPolicyRuleRows.map((row) => PolicyRuleSchema.parse(JSON.parse(row.ruleJson)));
      const storedMappingRows = repoKey
        ? await db
            .select()
            .from(repoMutationMappings)
            .where(
              and(
                eq(repoMutationMappings.provider, repoKey.provider),
                eq(repoMutationMappings.owner, repoKey.owner),
                eq(repoMutationMappings.repo, repoKey.repo)
              )
            )
            .orderBy(asc(repoMutationMappings.createdAt))
        : [];
      const storedMappings = storedMappingRows.map((row) => AdapterMutationMappingSchema.parse(JSON.parse(row.mappingJson)));
      const selectedIntentIds = input.selectedIntentIds ?? decision.approvedIntentIds;
      const approvedIntentIds = new Set(decision.approvedIntentIds);
      const proposalIntents = new Map(storedProposal.snapshot.intents.map((intent) => [intent.intentId, intent]));
      const lineageRows = await db.select().from(suggestedChanges).orderBy(asc(suggestedChanges.createdAt));
      const lineage = computeProposalLineage(
        lineageRows.map((row) => ({
          runId: row.runId,
          snapshot: SuggestedChangesSnapshotSchema.parse(JSON.parse(row.snapshotJson))
        })),
        lineageScopeKey(storedProposal)
      );
      const actionabilityByIntentId = new Map(lineage.entries.map((entry) => [entry.intentId, entry]));
      const policyRules = [...storedPolicyRules, ...(input.policyRules ?? []), ...syntheticManualApprovalPolicyRules(decision)];

      const outcomes = selectedIntentIds.map((intentId) => {
        if (!approvedIntentIds.has(intentId)) {
          return {
            intentId,
            outcome: "skipped" as const,
            message: "Intent was not approved by the approval decision."
          };
        }
        const intent = proposalIntents.get(intentId);
        if (!intent) {
          return {
            intentId,
            outcome: "failed" as const,
            message: "Intent does not exist on the referenced proposal."
          };
        }
        const actionability = actionabilityByIntentId.get(intentId);
        if (actionability?.status !== "current") {
          return {
            intentId,
            outcome: "stale" as const,
            message: actionability?.reason ?? "Intent is no longer current for its mutation domain."
          };
        }
        return preflightMutationIntent({
          intent,
          permissions: event.permissions,
          policyRules,
          ...(input.adapter ? { adapter: input.adapter } : {})
        }).outcome;
      });

      const plan = ApplyPlanSchema.parse({
        id: input.id,
        proposalId: input.proposalId,
        approvalDecisionId: input.approvalDecisionId,
        selectedIntentIds,
        ...(input.adapter ? { adapter: input.adapter } : {}),
        adapterPlan: {
          semantics: "preflight first, then per-intent outcome",
          externalWritesExecuted: false,
          mappings: storedMappings
        },
        outcomes
      });
      const createdAt = nowIso();
      await db
        .insert(applyPlans)
        .values({
          id: plan.id,
          proposalId: plan.proposalId,
          approvalDecisionId: plan.approvalDecisionId,
          planJson: JSON.stringify(plan),
          createdAt
        })
        .onConflictDoUpdate({
          target: applyPlans.id,
          set: {
            proposalId: plan.proposalId,
            approvalDecisionId: plan.approvalDecisionId,
            planJson: JSON.stringify(plan),
            createdAt
          }
        });
      await appendRunEvent({
        runId: storedProposal.runId,
        type: "apply_plan.created",
        payload: plan,
        visibility: "audit",
        importance: "high",
        message: `Created apply plan for ${selectedIntentIds.length} intent(s).`,
        createdAt
      });
      return plan;
    },

    async getApplyPlan(input: { id: string }): Promise<ApplyPlan | null> {
      const row = await db.select().from(applyPlans).where(eq(applyPlans.id, input.id)).limit(1).get();
      return row ? ApplyPlanSchema.parse(JSON.parse(row.planJson)) : null;
    },

    async updateApplyPlanOutcomes(input: { id: string; outcomes: ApplyIntentOutcome[]; externalWritesExecuted: boolean }): Promise<ApplyPlan | null> {
      const row = await db.select().from(applyPlans).where(eq(applyPlans.id, input.id)).limit(1).get();
      if (!row) return null;
      const currentPlan = ApplyPlanSchema.parse(JSON.parse(row.planJson));
      const outcomes = input.outcomes.map((outcome) => ApplyIntentOutcomeSchema.parse(outcome));
      const updatedPlan = ApplyPlanSchema.parse({
        ...currentPlan,
        adapterPlan: {
          ...(currentPlan.adapterPlan && typeof currentPlan.adapterPlan === "object" && !Array.isArray(currentPlan.adapterPlan)
            ? currentPlan.adapterPlan
            : {}),
          externalWritesExecuted: input.externalWritesExecuted
        },
        outcomes
      });
      const updatedAt = nowIso();
      await db
        .update(applyPlans)
        .set({ planJson: JSON.stringify(updatedPlan), createdAt: row.createdAt })
        .where(eq(applyPlans.id, input.id));

      const storedProposalRow = await db
        .select()
        .from(suggestedChanges)
        .where(eq(suggestedChanges.proposalId, updatedPlan.proposalId))
        .limit(1)
        .get();
      if (storedProposalRow) {
        await appendRunEvent({
          runId: storedProposalRow.runId,
          type: "apply_plan.executed",
          payload: updatedPlan,
          visibility: "audit",
          importance: "high",
          message: `Executed apply plan with ${outcomes.length} outcome(s).`,
          createdAt: updatedAt
        });
      }
      return updatedPlan;
    },

    async recordProgress(input: {
      runId: string;
      message: string;
      type?: string;
      at?: string;
      visibility?: RunEventVisibility;
      importance?: RunEventImportance;
      runnerId?: string;
    }): Promise<boolean> {
      if (input.runnerId) {
        const row = await db
          .select()
          .from(runs)
          .where(and(eq(runs.id, input.runId), eq(runs.assignedRunnerId, input.runnerId)))
          .limit(1)
          .get();
        if (!row) return false;
      }
      await appendRunEvent({
        runId: input.runId,
        type: "run.progress",
        payload: {
          ...(input.runnerId ? { runnerId: input.runnerId } : {}),
          type: input.type ?? "progress",
          message: input.message,
          at: input.at ?? nowIso()
        },
        visibility: input.visibility ?? "audit",
        importance: input.importance ?? "normal",
        message: input.message,
        createdAt: input.at ?? nowIso()
      });
      return true;
    },

    async getRun(input: { runId: string }): Promise<ClaimedOpenTagRun | null> {
      const row = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1).get();
      if (!row) return null;
      return {
        run: runFromRow(row),
        event: OpenTagEventSchema.parse(JSON.parse(row.eventJson))
      };
    },

    async listRunEvents(input: { runId: string }): Promise<OpenTagAuditEvent[]> {
      const rows = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(asc(runEvents.id));
      return rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        type: row.type,
        visibility: RunEventVisibilitySchema.parse(row.visibility),
        importance: RunEventImportanceSchema.parse(row.importance),
        ...(row.message ? { message: row.message } : {}),
        payload: JSON.parse(row.payloadJson) as unknown,
        createdAt: row.createdAt
      }));
    },

    async enqueueCallbackDelivery(input: {
      runId: string;
      kind: CallbackDeliveryKind;
      provider: CallbackDeliveryProvider;
      uri: string;
      body: string;
      threadKey?: string;
      agentId?: string;
      statusMessageKey?: string;
      blocks?: unknown[];
    }): Promise<CallbackDelivery> {
      const createdAt = nowIso();
      const rows = await db
        .insert(callbackDeliveries)
        .values({
          runId: input.runId,
          kind: input.kind,
          provider: input.provider,
          uri: input.uri,
          body: input.body,
          threadKey: input.threadKey ?? null,
          metadataJson: JSON.stringify({
            ...(input.agentId ? { agentId: input.agentId } : {}),
            ...(input.statusMessageKey ? { statusMessageKey: input.statusMessageKey } : {}),
            ...(input.blocks ? { blocks: input.blocks } : {})
          }),
          status: "pending",
          createdAt,
          updatedAt: createdAt
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("callback delivery was not created");
      await appendRunEvent({
        runId: input.runId,
        type: `callback.${input.kind}.queued`,
        payload: callbackDeliveryFromRow(row),
        visibility: "audit",
        importance: "normal",
        createdAt
      });
      return callbackDeliveryFromRow(row);
    },

    async markCallbackDelivered(input: { deliveryId: number }): Promise<void> {
      const updatedAt = nowIso();
      const row = await db
        .select()
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.id, input.deliveryId))
        .limit(1)
        .get();
      if (!row) return;
      await db
        .update(callbackDeliveries)
        .set({ status: "delivered", attempts: row.attempts + 1, lastError: null, nextAttemptAt: null, updatedAt })
        .where(eq(callbackDeliveries.id, input.deliveryId));
      await appendRunEvent({
        runId: row.runId,
        type: `callback.${row.kind}.delivered`,
        payload: { ...callbackDeliveryFromRow(row), status: "delivered", attempts: row.attempts + 1, updatedAt },
        visibility: "human",
        importance: row.kind === "final" ? "high" : "normal",
        message: row.body,
        createdAt: updatedAt
      });
    },

    async markCallbackFailed(input: { deliveryId: number; error: string; nextAttemptAt?: string }): Promise<void> {
      const updatedAt = nowIso();
      const row = await db
        .select()
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.id, input.deliveryId))
        .limit(1)
        .get();
      if (!row) return;
      await db
        .update(callbackDeliveries)
        .set({ status: "failed", attempts: row.attempts + 1, lastError: input.error, nextAttemptAt: input.nextAttemptAt ?? null, updatedAt })
        .where(eq(callbackDeliveries.id, input.deliveryId));
      await appendRunEvent({
        runId: row.runId,
        type: `callback.${row.kind}.failed`,
        payload: {
          ...callbackDeliveryFromRow(row),
          status: "failed",
          attempts: row.attempts + 1,
          lastError: input.error,
          ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
          updatedAt
        },
        visibility: "audit",
        importance: "normal",
        createdAt: updatedAt
      });
    },

    async listPendingCallbackDeliveries(input: { limit: number; now?: Date; maxAttempts?: number }): Promise<CallbackDelivery[]> {
      const now = input.now ?? new Date();
      const maxAttempts = input.maxAttempts ?? Number.POSITIVE_INFINITY;
      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(inArray(callbackDeliveries.status, ["pending", "failed"]))
        .orderBy(asc(callbackDeliveries.id));
      return rows
        .map(callbackDeliveryFromRow)
        .filter((delivery) => delivery.attempts < maxAttempts)
        .filter((delivery) => !delivery.nextAttemptAt || new Date(delivery.nextAttemptAt).getTime() <= now.getTime())
        .slice(0, input.limit);
    },

    async claimPendingCallbackDeliveries(input: { limit: number; now?: Date; maxAttempts?: number; staleDeliveryThresholdMs?: number }): Promise<CallbackDelivery[]> {
      const now = input.now ?? new Date();
      const maxAttempts = input.maxAttempts ?? Number.POSITIVE_INFINITY;
      const staleThresholdMs = input.staleDeliveryThresholdMs ?? 60_000;
      const staleDeliveryCutoff = new Date(now.getTime() - staleThresholdMs).toISOString();

      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(inArray(callbackDeliveries.status, ["pending", "failed", "delivering"]))
        .orderBy(asc(callbackDeliveries.id));

      const claimed: CallbackDelivery[] = [];
      for (const row of rows) {
        const delivery = callbackDeliveryFromRow(row);
        if (delivery.attempts >= maxAttempts) continue;
        if (delivery.nextAttemptAt && new Date(delivery.nextAttemptAt).getTime() > now.getTime()) continue;
        if (row.status === "delivering" && row.updatedAt > staleDeliveryCutoff) continue;

        const updatedAt = input.now ? input.now.toISOString() : nowIso();
        const claimWhere =
          row.status === "delivering"
            ? and(eq(callbackDeliveries.id, row.id), eq(callbackDeliveries.status, "delivering"), eq(callbackDeliveries.updatedAt, row.updatedAt))
            : and(eq(callbackDeliveries.id, row.id), inArray(callbackDeliveries.status, ["pending", "failed"]));
        const claimResult = await db.update(callbackDeliveries).set({ status: "delivering", updatedAt }).where(claimWhere);
        if (claimResult.changes === 0) continue;

        claimed.push({
          ...delivery,
          status: "delivering",
          updatedAt
        });
        if (claimed.length >= input.limit) break;
      }

      return claimed;
    },

    async getRunMetrics(input: { runId: string }): Promise<OpenTagRunMetrics> {
      const rows = await db.select().from(runEvents).where(eq(runEvents.runId, input.runId)).orderBy(asc(runEvents.id));
      const events = rows.map((row) => ({
        id: row.id,
        runId: row.runId,
        type: row.type,
        visibility: RunEventVisibilitySchema.parse(row.visibility),
        importance: RunEventImportanceSchema.parse(row.importance),
        ...(row.message ? { message: row.message } : {}),
        payload: JSON.parse(row.payloadJson) as unknown,
        createdAt: row.createdAt
      }));
      return metricsFromEvents(input.runId, events);
    },

    async getRepoMetrics(input: { provider: string; owner: string; repo: string }): Promise<OpenTagAggregateMetrics> {
      const runRows = await db
        .select()
        .from(runs)
        .where(and(eq(runs.repoProvider, input.provider), eq(runs.repoOwner, input.owner), eq(runs.repoName, input.repo)))
        .orderBy(asc(runs.createdAt));
      const matchingRunIds = runRows.map((row) => row.id);
      const runMetrics = [];
      for (const runId of matchingRunIds) {
        const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.id));
        runMetrics.push(
          metricsFromEvents(
            runId,
            rows.map((row) => ({
              id: row.id,
              runId: row.runId,
              type: row.type,
              visibility: RunEventVisibilitySchema.parse(row.visibility),
              importance: RunEventImportanceSchema.parse(row.importance),
              ...(row.message ? { message: row.message } : {}),
              payload: JSON.parse(row.payloadJson) as unknown,
              createdAt: row.createdAt
            }))
          )
        );
      }
      return aggregateMetrics({
        scope: "repo",
        scopeId: `${input.provider}:${input.owner}/${input.repo}`,
        runs: runMetrics
      });
    },

    async getWorkThreadMetrics(input: { threadId: string }): Promise<OpenTagAggregateMetrics> {
      const runRows = await db.select().from(runs).where(eq(runs.workThreadId, input.threadId)).orderBy(asc(runs.createdAt));
      const matchingRunIds = runRows.map((row) => row.id);
      const runMetrics = [];
      for (const runId of matchingRunIds) {
        const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.id));
        runMetrics.push(
          metricsFromEvents(
            runId,
            rows.map((row) => ({
              id: row.id,
              runId: row.runId,
              type: row.type,
              visibility: RunEventVisibilitySchema.parse(row.visibility),
              importance: RunEventImportanceSchema.parse(row.importance),
              ...(row.message ? { message: row.message } : {}),
              payload: JSON.parse(row.payloadJson) as unknown,
              createdAt: row.createdAt
            }))
          )
        );
      }
      return aggregateMetrics({
        scope: "work_thread",
        scopeId: input.threadId,
        runs: runMetrics
      });
    }
  };
}
