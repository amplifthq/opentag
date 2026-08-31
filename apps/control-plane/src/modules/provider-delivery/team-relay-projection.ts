import { createHash } from "node:crypto";
import { DeliveryIntentV2Schema, deliveryExternalResourceLookupDescriptor,
  type DeliveryIntentV2, type ExpectedDeliveryOwner } from "@opentag/delivery-contract";
import { composeTeamRelayThreadProjection } from "@opentag/core";
import { createSlackTeamRelayProjectionBlocks, renderSlackTeamRelayProjection } from "@opentag/slack";
import type { Pool } from "pg";
import type { HostedRunCoordinator } from "../hosted-runs/index.js";
import { readExactDeliveryAnchor } from "./repository.js";
import { z } from "zod";

const hash = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
type Enqueue = { enqueue(input: { intent: DeliveryIntentV2; providerRequest: object;
  phase: "received" | "running" | "terminal"; frozenDeadline: string }): Promise<unknown> };

export function createTeamRelayProjectionService(input: { pool: Pool; hosted: HostedRunCoordinator;
  producer: Enqueue; clock: { now(): Date };
  deliveryOwner?: Pick<ExpectedDeliveryOwner,"runtimeOwnerId"|"runtimeGeneration"|"schemaGeneration">;
  controls?: { issueProjectionControls(input: { organizationId: string; runId: string;
    generation: number }): Promise<any[]> } }) {
  const service = { async projectRun(command: { organizationId: string; runId: string;
    projectionRevision?: number; includeControls?: boolean;
    deliveryEvent?: { intentId:string; revision:number; eventSequence:number } }) {
    const run = await input.hosted.inspect(command); if (!run) return { kind: "missing" as const };
    const current = await input.pool.query<{ current_attempt_number: number; projection_revision: string }>(
      "SELECT current_attempt_number,projection_revision::text FROM cp_hosted_run WHERE organization_id=$1 AND run_id=$2",
      [command.organizationId, command.runId]);
    const baseline = await input.pool.query<{ intent: unknown; payload: any; state: string;
      error_code: string | null; deadline_at: Date }>(`SELECT intent,payload,state,error_code,deadline_at
        FROM cp_provider_delivery_intent WHERE organization_id=$1 AND run_id=$2
        AND provider_id='slack' AND state <> 'superseded'
        ORDER BY CASE projection_purpose WHEN 'anchor_update' THEN 0 WHEN 'anchor_create' THEN 1 ELSE 2 END,
          created_at DESC,intent_id DESC LIMIT 1`,
      [command.organizationId, command.runId]);
    const row = baseline.rows[0]; const generation = current.rows[0]?.current_attempt_number;
    const projectionRevision = Number(current.rows[0]?.projection_revision ?? 0);
    if (!row || !generation) return { kind: "not_projectable" as const };
    if (!command.deliveryEvent&&command.projectionRevision !== undefined
      && command.projectionRevision !== projectionRevision) {
      return { kind: "superseded" as const, projectionRevision };
    }
    const state = run.status;
    if (!(["waiting_for_runner", "assigned", "running", "waiting_for_approval",
      "publication_pending", "proposal_ready", "ready_for_review", "failed", "cancelled",
      "interrupted", "timed_out"] as string[]).includes(state)) return { kind: "not_projectable" as const };
    let deliveryState:"pending"|"accepted"|"rejected"|"outcome_unknown"|"attention" =
      ["accepted", "rejected", "outcome_unknown", "attention"].includes(row.state)
      ? row.state as "accepted" | "rejected" | "outcome_unknown" | "attention" : "pending";
    let deliveryErrorCode=row.error_code;
    if(command.deliveryEvent){
      const event=await input.pool.query<{state:string;error_code:string|null}>(`SELECT delivery.state,
        delivery.error_code FROM cp_projection_delivery_watermark watermark
        JOIN cp_provider_delivery_intent delivery ON delivery.intent_id=watermark.intent_id
          AND delivery.revision=watermark.delivery_revision AND delivery.state=watermark.delivery_state
        WHERE watermark.organization_id=$1 AND watermark.run_id=$2 AND watermark.intent_id=$3
          AND watermark.delivery_revision=$4 AND watermark.projection_revision=$5
          AND watermark.event_sequence=$6
          AND watermark.delivery_state IN ('accepted','rejected','outcome_unknown','attention')`,
      [command.organizationId,command.runId,command.deliveryEvent.intentId,
        command.deliveryEvent.revision,command.projectionRevision,command.deliveryEvent.eventSequence]);
      const exact=event.rows[0]; if(!exact)return {kind:"delivery_event_stale" as const};
      if(!["accepted","rejected","outcome_unknown","attention"].includes(exact.state))
        return {kind:"delivery_event_stale" as const};
      deliveryState=exact.state as typeof deliveryState; deliveryErrorCode=exact.error_code;
    }
    const issuedControls = command.includeControls === false || !input.controls ? []
      : await input.controls.issueProjectionControls({ organizationId: command.organizationId,
          runId: command.runId, generation });
    const controls = issuedControls.filter((control) => state === "publication_pending"
      ? control.kind === "status" || control.kind === "cancel" || control.kind.startsWith("publication_")
      : !control.kind.startsWith("publication_")).slice(0, 4);
    const presentation = composeTeamRelayThreadProjection({ runId: command.runId, generation,
      state: state as Parameters<typeof composeTeamRelayThreadProjection>[0]["state"], controls,
      providerDelivery: { state: deliveryState,
        ...(deliveryErrorCode ? { reasonCode: deliveryErrorCode as any } : {}) } });
    const text = renderSlackTeamRelayProjection(presentation);
    const blocks = createSlackTeamRelayProjectionBlocks(presentation);
    const base = DeliveryIntentV2Schema.parse(row.intent);
    const identity = { runId: command.runId, generation, projectionRevision, state, deliveryState,
      projectionEventSequence:command.deliveryEvent?.eventSequence??0,errorCode: row.error_code, presentation };
    const suffix = hash(identity).slice(7, 31);
    if(base.provenance.kind!=="business"||!("statusMessageId" in base)||!base.statusMessageId)
      return {kind:"not_projectable" as const};
    const createIdentity=DeliveryIntentV2Schema.parse({...base,operation:"create"});
    const runtimeOwner=input.deliveryOwner??{runtimeOwnerId:"control-plane",runtimeGeneration:1,schemaGeneration:1};
    const descriptor=deliveryExternalResourceLookupDescriptor({intent:createIdentity,
      statusMessageId:base.statusMessageId,owner:{organizationId:base.organizationId,
        providerId:base.providerBinding.providerId,providerInstanceId:base.providerBinding.providerInstanceId,
        providerBindingDigest:base.providerBinding.bindingDigest,
        providerConfigGeneration:base.providerBinding.providerConfigGeneration,
        providerConfigGenerationDigest:base.providerBinding.providerConfigGenerationDigest,...runtimeOwner}});
    const anchor=await readExactDeliveryAnchor(input.pool,descriptor);
    if(anchor.outcome==="pending"){
      await input.pool.query(`INSERT INTO cp_projection_deferred_revision(organization_id,run_id,
        projection_revision,anchor_intent_id,state,created_at) VALUES($1,$2,$3,$4,'pending',$5)
        ON CONFLICT(organization_id,run_id,projection_revision) DO UPDATE SET
          anchor_intent_id=EXCLUDED.anchor_intent_id,state='pending',woken_at=NULL`,
      [command.organizationId,command.runId,projectionRevision,anchor.anchorIntentId,input.clock.now()]);
      return {kind:"anchor_pending" as const};
    }
    if(anchor.outcome==="ambiguous")return {kind:"anchor_ambiguous" as const};
    const acceptedAnchor=anchor.outcome==="exact"?anchor:undefined;
    const intent = DeliveryIntentV2Schema.parse({ ...base,
      sideEffectIntentId: `intent_projection_${suffix}`,
      idempotencyKey: `delivery_projection_${suffix}`,
      operation: acceptedAnchor ? "update" : "create", projectionRevision,
      projectionEventSequence:command.deliveryEvent?.eventSequence??0,
      projectionPurpose: acceptedAnchor ? "anchor_update" : "anchor_create",
      presentationDigest: hash({ text, blocks }),
      createdAt: input.clock.now().toISOString() });
    const priorRequest = row.payload?.providerRequest ?? {};
    const priorOperation = priorRequest.operation ?? {};
    const providerRequest = { ...priorRequest,
      operation: acceptedAnchor ? { kind: "update_message",
        channelId: priorOperation.channelId, messageTs: acceptedAnchor.externalResourceId }
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

export function createTeamRelayProjectionJobHandler(service:ReturnType<typeof createTeamRelayProjectionService>){
  return async(job:{payload:unknown})=>{
    const payload=z.object({organizationId:z.string().min(1),runId:z.string().min(1),
      projectionRevision:z.number().int().positive(),deliveryIntentId:z.string().min(1).optional(),
      deliveryRevision:z.number().int().positive().optional(),eventSequence:z.number().int().positive().optional()
    }).strict().superRefine((value,context)=>{
      if([value.deliveryIntentId,value.deliveryRevision,value.eventSequence].filter((item)=>item!==undefined).length%3!==0)
        context.addIssue({code:"custom",message:"delivery event identity must be complete"});
    }).parse(job.payload);
    return service.projectRun({...payload,...(payload.deliveryIntentId?{deliveryEvent:{
      intentId:payload.deliveryIntentId,revision:payload.deliveryRevision!,eventSequence:payload.eventSequence!}}:{})});
  };
}
