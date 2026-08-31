import { createHash } from "node:crypto";
import { DeliveryIntentV2Schema, type DeliveryIntentV2 } from "@opentag/delivery-contract";
import { composeTeamRelayThreadProjection } from "@opentag/core";
import { createSlackTeamRelayProjectionBlocks, renderSlackTeamRelayProjection } from "@opentag/slack";
import type { Pool } from "pg";
import type { HostedRunCoordinator } from "../hosted-runs/index.js";

const hash = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
type Enqueue = { enqueue(input: { intent: DeliveryIntentV2; providerRequest: object;
  phase: "received" | "running" | "terminal"; frozenDeadline: string }): Promise<unknown> };

export function createTeamRelayProjectionService(input: { pool: Pool; hosted: HostedRunCoordinator;
  producer: Enqueue; clock: { now(): Date };
  controls?: { issueProjectionControls(input: { organizationId: string; runId: string;
    generation: number }): Promise<any[]> } }) {
  const service = { async projectRun(command: { organizationId: string; runId: string;
    projectionRevision?: number; includeControls?: boolean }) {
    const run = await input.hosted.inspect(command); if (!run) return { kind: "missing" as const };
    const current = await input.pool.query<{ current_attempt_number: number; projection_revision: string }>(
      "SELECT current_attempt_number,projection_revision::text FROM cp_hosted_run WHERE organization_id=$1 AND run_id=$2",
      [command.organizationId, command.runId]);
    const baseline = await input.pool.query<{ intent: unknown; payload: any; state: string;
      error_code: string | null; deadline_at: Date }>(`SELECT intent,payload,state,error_code,deadline_at
        FROM cp_provider_delivery_intent WHERE organization_id=$1 AND run_id=$2
        AND provider_id='slack' AND state <> 'superseded' ORDER BY created_at DESC,intent_id DESC LIMIT 1`,
      [command.organizationId, command.runId]);
    const row = baseline.rows[0]; const generation = current.rows[0]?.current_attempt_number;
    const projectionRevision = Number(current.rows[0]?.projection_revision ?? 0);
    if (!row || !generation) return { kind: "not_projectable" as const };
    if (command.projectionRevision !== undefined && command.projectionRevision !== projectionRevision) {
      return { kind: "superseded" as const, projectionRevision };
    }
    const state = run.status;
    if (!(["waiting_for_runner", "assigned", "running", "waiting_for_approval",
      "publication_pending", "proposal_ready", "ready_for_review", "failed", "cancelled",
      "interrupted", "timed_out"] as string[]).includes(state)) return { kind: "not_projectable" as const };
    const deliveryState = ["accepted", "rejected", "outcome_unknown", "attention"].includes(row.state)
      ? row.state as "accepted" | "rejected" | "outcome_unknown" | "attention" : "pending";
    const issuedControls = command.includeControls === false || !input.controls ? []
      : await input.controls.issueProjectionControls({ organizationId: command.organizationId,
          runId: command.runId, generation });
    const controls = issuedControls.filter((control) => state === "publication_pending"
      ? control.kind === "status" || control.kind === "cancel" || control.kind.startsWith("publication_")
      : !control.kind.startsWith("publication_")).slice(0, 4);
    const presentation = composeTeamRelayThreadProjection({ runId: command.runId, generation,
      state: state as Parameters<typeof composeTeamRelayThreadProjection>[0]["state"], controls,
      providerDelivery: { state: deliveryState,
        ...(row.error_code ? { reasonCode: row.error_code as any } : {}) } });
    const text = renderSlackTeamRelayProjection(presentation);
    const blocks = createSlackTeamRelayProjectionBlocks(presentation);
    const base = DeliveryIntentV2Schema.parse(row.intent);
    const identity = { runId: command.runId, generation, projectionRevision, state, deliveryState,
      errorCode: row.error_code, presentation };
    const suffix = hash(identity).slice(7, 31);
    const exactParams = [command.organizationId,command.runId,
      "statusMessageId" in base ? base.statusMessageId ?? null : null,
      base.providerBinding.providerInstanceId,base.providerBinding.bindingDigest,base.targetDigest,
      base.authoritySnapshotDigest,base.provenance.kind === "business"
        ? base.provenance.repositoryIdentityDigest : null,
      base.provenance.kind === "business" ? base.provenance.authorityLineageDigest : null];
    const inFlightAnchor = await input.pool.query(`SELECT 1 FROM cp_provider_delivery_intent
      WHERE organization_id=$1 AND run_id=$2 AND status_message_id=$3 AND provider_id='slack'
        AND provider_instance_id=$4 AND provider_binding_digest=$5 AND intent->>'targetDigest'=$6
        AND authority_snapshot_digest=$7
        AND intent->'provenance'->>'repositoryIdentityDigest'=$8
        AND intent->'provenance'->>'authorityLineageDigest'=$9
        AND intent->>'operation'='create'
        AND state IN ('pending','leased','provider_io_begun','outcome_unknown') LIMIT 1`,exactParams);
    if (inFlightAnchor.rows[0]) return { kind: "anchor_pending" as const };
    const anchor = await input.pool.query<{ external_resource_id: string; external_resource_digest: string }>(
      `SELECT DISTINCT external_resource_id,external_resource_digest FROM cp_provider_delivery_intent
       WHERE organization_id=$1 AND run_id=$2 AND status_message_id=$3 AND state='accepted'
         AND provider_id='slack' AND provider_instance_id=$4 AND provider_binding_digest=$5
         AND intent->>'targetDigest'=$6 AND authority_snapshot_digest=$7
         AND intent->'provenance'->>'repositoryIdentityDigest'=$8
         AND intent->'provenance'->>'authorityLineageDigest'=$9
         AND external_resource_id IS NOT NULL AND external_resource_digest IS NOT NULL LIMIT 2`,
      exactParams);
    if (anchor.rows.length > 1) return { kind: "anchor_ambiguous" as const };
    const acceptedAnchor = anchor.rows[0];
    const intent = DeliveryIntentV2Schema.parse({ ...base,
      sideEffectIntentId: `intent_projection_${suffix}`,
      idempotencyKey: `delivery_projection_${suffix}`,
      operation: acceptedAnchor ? "update" : "create", projectionRevision,
      presentationDigest: hash({ text, blocks }),
      createdAt: input.clock.now().toISOString() });
    const priorRequest = row.payload?.providerRequest ?? {};
    const priorOperation = priorRequest.operation ?? {};
    const providerRequest = { ...priorRequest,
      operation: acceptedAnchor ? { kind: "update_message",
        channelId: priorOperation.channelId, messageTs: acceptedAnchor.external_resource_id }
        : priorOperation,
      presentation: { kind: "message", text, textFormat: "mrkdwn", blocks } };
    const terminal = ["proposal_ready", "ready_for_review", "failed", "cancelled",
      "interrupted", "timed_out"].includes(state);
    await input.producer.enqueue({ intent, providerRequest,
      phase: terminal ? "terminal" : state === "running" ? "running" : "received",
      frozenDeadline: row.deadline_at.toISOString() });
    return { kind: "queued" as const, presentation, intentId: intent.sideEffectIntentId };
  }, async projectDeliveryIntent(intentId: string) {
    const result = await input.pool.query<{ organization_id: string; run_id: string | null }>(
      "SELECT organization_id,run_id FROM cp_provider_delivery_intent WHERE intent_id=$1", [intentId]);
    const row = result.rows[0];
    return row?.run_id ? service.projectRun({ organizationId: row.organization_id,
      runId: row.run_id, includeControls: false })
      : { kind: "not_projectable" as const };
  } };
  return service;
}
