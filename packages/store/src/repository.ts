import { OpenTagEventSchema, OpenTagRunResultSchema, type OpenTagEvent, type OpenTagRun, type OpenTagRunResult } from "@opentag/core";
import { and, asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { callbackDeliveries, repoBindings, runEvents, runners, runs, slackChannelBindings } from "./schema.js";

export type ClaimedOpenTagRun = {
  run: OpenTagRun;
  event: OpenTagEvent;
};

export type OpenTagAuditEvent = {
  id: number;
  runId: string;
  type: string;
  payload: unknown;
  createdAt: string;
};

export type CallbackDeliveryKind = "acknowledgement" | "progress" | "final";
export type CallbackDeliveryProvider = "github" | "slack" | "lark" | "webhook";
export type CallbackDeliveryStatus = "pending" | "delivered" | "failed";

export type CallbackDelivery = {
  id: number;
  runId: string;
  kind: CallbackDeliveryKind;
  provider: CallbackDeliveryProvider;
  uri: string;
  body: string;
  threadKey?: string;
  status: CallbackDeliveryStatus;
  attempts: number;
  lastError?: string;
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

export type SlackChannelBinding = {
  teamId: string;
  channelId: string;
  owner: string;
  repo: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isIsoExpired(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() <= now.getTime();
}

function runFromRow(row: typeof runs.$inferSelect): OpenTagRun {
  const result = row.resultJson ? OpenTagRunResultSchema.parse(JSON.parse(row.resultJson)) : undefined;
  return {
    id: row.id,
    eventId: row.eventId,
    status: row.status as OpenTagRun["status"],
    assignedRunnerId: row.assignedRunnerId ?? undefined,
    executor: row.executor ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(result ? { result } : {})
  };
}

function callbackDeliveryFromRow(row: typeof callbackDeliveries.$inferSelect): CallbackDelivery {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as CallbackDeliveryKind,
    provider: row.provider as CallbackDeliveryProvider,
    uri: row.uri,
    body: row.body,
    ...(row.threadKey ? { threadKey: row.threadKey } : {}),
    status: row.status as CallbackDeliveryStatus,
    attempts: row.attempts,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
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

export function createOpenTagRepository(db: BetterSQLite3Database) {
  async function appendRunEvent(input: { runId: string; type: string; payload: unknown; createdAt?: string }): Promise<void> {
    await db.insert(runEvents).values({
      runId: input.runId,
      type: input.type,
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

    async createSlackChannelBinding(input: SlackChannelBinding): Promise<void> {
      await db
        .insert(slackChannelBindings)
        .values({
          teamId: input.teamId,
          channelId: input.channelId,
          owner: input.owner,
          repo: input.repo,
          createdAt: nowIso()
        })
        .onConflictDoUpdate({
          target: [slackChannelBindings.teamId, slackChannelBindings.channelId],
          set: {
            owner: input.owner,
            repo: input.repo
          }
        });
    },

    async createRun(input: { id: string; event: OpenTagEvent }): Promise<OpenTagRun> {
      const event = OpenTagEventSchema.parse(input.event);
      const existingBySourceEvent = await db
        .select()
        .from(runs)
        .where(and(eq(runs.source, event.source), eq(runs.sourceEventId, event.sourceEventId)))
        .limit(1)
        .get();
      if (existingBySourceEvent) {
        await appendRunEvent({
          runId: existingBySourceEvent.id,
          type: "run.duplicate_ignored",
          payload: { eventId: event.id, source: event.source, sourceEventId: event.sourceEventId }
        });
        return runFromRow(existingBySourceEvent);
      }

      const existingById = await db.select().from(runs).where(eq(runs.id, input.id)).limit(1).get();
      if (existingById) {
        await appendRunEvent({
          runId: existingById.id,
          type: "run.duplicate_ignored",
          payload: { eventId: event.id, source: event.source, sourceEventId: event.sourceEventId }
        });
        return runFromRow(existingById);
      }

      const createdAt = nowIso();
      await db.insert(runs).values({
        id: input.id,
        eventId: event.id,
        source: event.source,
        sourceEventId: event.sourceEventId,
        status: "queued",
        eventJson: JSON.stringify(event),
        createdAt,
        updatedAt: createdAt
      });
      await appendRunEvent({
        runId: input.id,
        type: "run.created",
        payload: { eventId: event.id },
        createdAt
      });
      return {
        id: input.id,
        eventId: event.id,
        status: "queued",
        createdAt,
        updatedAt: createdAt
      };
    },

    async claimNextRun(input: { runnerId: string; leaseSeconds: number }): Promise<ClaimedOpenTagRun | null> {
      const now = new Date();
      const activeRows = await db.select().from(runs).where(and(eq(runs.status, "assigned"))).orderBy(asc(runs.createdAt));
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
      await db
        .update(runs)
        .set({
          status: "assigned",
          assignedRunnerId: input.runnerId,
          leasedAt,
          leaseExpiresAt,
          heartbeatAt: leasedAt,
          updatedAt
        })
        .where(eq(runs.id, row.id));
      await appendRunEvent({
        runId: row.id,
        type: "run.claimed",
        payload: { runnerId: input.runnerId, leasedAt, leaseExpiresAt },
        createdAt: updatedAt
      });

      return {
        run: {
          id: row.id,
          eventId: row.eventId,
          status: "assigned",
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

    async getSlackChannelBinding(input: { teamId: string; channelId: string }): Promise<SlackChannelBinding | null> {
      const row = await db
        .select()
        .from(slackChannelBindings)
        .where(and(eq(slackChannelBindings.teamId, input.teamId), eq(slackChannelBindings.channelId, input.channelId)))
        .limit(1)
        .get();
      if (!row) return null;
      return {
        teamId: row.teamId,
        channelId: row.channelId,
        owner: row.owner,
        repo: row.repo
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
        createdAt: updatedAt
      });
      return true;
    },

    async markRunning(input: { runId: string; runnerId: string; executor: string }): Promise<boolean> {
      const updatedAt = nowIso();
      const row = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, input.runId), eq(runs.assignedRunnerId, input.runnerId)))
        .limit(1)
        .get();
      if (!row) return false;

      await db.update(runs).set({ status: "running", executor: input.executor, updatedAt }).where(eq(runs.id, input.runId));
      await appendRunEvent({
        runId: input.runId,
        type: "run.running",
        payload: { runnerId: input.runnerId, executor: input.executor },
        createdAt: updatedAt
      });
      return true;
    },

    async completeRun(input: { runId: string; runnerId: string; result: OpenTagRunResult }): Promise<boolean> {
      const result = OpenTagRunResultSchema.parse(input.result);
      const updatedAt = nowIso();
      const row = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, input.runId), eq(runs.assignedRunnerId, input.runnerId)))
        .limit(1)
        .get();
      if (!row) return false;

      const status = result.conclusion === "success" ? "succeeded" : result.conclusion === "cancelled" ? "cancelled" : "failed";
      await db
        .update(runs)
        .set({ status, resultJson: JSON.stringify(result), leaseExpiresAt: null, heartbeatAt: null, updatedAt })
        .where(eq(runs.id, input.runId));
      await appendRunEvent({
        runId: input.runId,
        type: "run.completed",
        payload: { runnerId: input.runnerId, result },
        createdAt: updatedAt
      });
      return true;
    },

    async recordProgress(input: { runId: string; runnerId: string; message: string; type?: string; at?: string }): Promise<boolean> {
      const row = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, input.runId), eq(runs.assignedRunnerId, input.runnerId)))
        .limit(1)
        .get();
      if (!row) return false;

      await appendRunEvent({
        runId: input.runId,
        type: "run.progress",
        payload: {
          runnerId: input.runnerId,
          type: input.type ?? "progress",
          message: input.message,
          at: input.at ?? nowIso()
        }
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

    async getRunBySourceEvent(input: { source: string; sourceEventId: string }): Promise<ClaimedOpenTagRun | null> {
      const row = await db
        .select()
        .from(runs)
        .where(and(eq(runs.source, input.source), eq(runs.sourceEventId, input.sourceEventId)))
        .limit(1)
        .get();
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
        .set({ status: "delivered", attempts: row.attempts + 1, lastError: null, updatedAt })
        .where(eq(callbackDeliveries.id, input.deliveryId));
      await appendRunEvent({
        runId: row.runId,
        type: `callback.${row.kind}.delivered`,
        payload: { ...callbackDeliveryFromRow(row), status: "delivered", attempts: row.attempts + 1, updatedAt },
        createdAt: updatedAt
      });
    },

    async markCallbackFailed(input: { deliveryId: number; error: string }): Promise<void> {
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
        .set({ status: "failed", attempts: row.attempts + 1, lastError: input.error, updatedAt })
        .where(eq(callbackDeliveries.id, input.deliveryId));
      await appendRunEvent({
        runId: row.runId,
        type: `callback.${row.kind}.failed`,
        payload: { ...callbackDeliveryFromRow(row), status: "failed", attempts: row.attempts + 1, lastError: input.error, updatedAt },
        createdAt: updatedAt
      });
    },

    async listCallbackDeliveries(input: { runId: string }): Promise<CallbackDelivery[]> {
      const rows = await db
        .select()
        .from(callbackDeliveries)
        .where(eq(callbackDeliveries.runId, input.runId))
        .orderBy(asc(callbackDeliveries.id));
      return rows.map(callbackDeliveryFromRow);
    }
  };
}
