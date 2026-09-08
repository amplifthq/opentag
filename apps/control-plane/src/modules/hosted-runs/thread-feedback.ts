import type { Pool } from "pg";
import { PermissionResolutionReceiptEnvelopeV1Schema } from "@opentag/control-protocol";
import { readRunPublicationEffect } from "../effects/index.js";

/** Shared, read-only approval facts for Console and channel presentation. */
export async function readRunThreadFeedback(pool: Pool, input: {
  organizationId: string; runId: string; attemptNumber: number;
}) {
  const permissions = await pool.query<{state:string;current_receipt:unknown}>(
    `SELECT state,current_receipt FROM cp_permission_request
     WHERE organization_id=$1 AND run_id=$2 AND attempt_number=$3
       AND (state='waiting' OR current_receipt->'payload'->>'decision' IN ('allow_once','deny'))
     ORDER BY created_at DESC,permission_request_id DESC LIMIT 1`,
    [input.organizationId,input.runId,input.attemptNumber]);
  const permission=permissions.rows[0];
  const receipt=permission?PermissionResolutionReceiptEnvelopeV1Schema.parse(permission.current_receipt):undefined;
  if(receipt&&(receipt.organizationId!==input.organizationId||receipt.runId!==input.runId
    ||receipt.attempt.attemptNumber!==input.attemptNumber||receipt.payload.state!==permission!.state)){
    throw new Error("projection_permission_receipt_mismatch");
  }
  const approval=receipt&&["waiting","authorized","denied"].includes(receipt.payload.state)
    ? {state:receipt.payload.state as "waiting"|"authorized"|"denied",actionDescriptor:receipt.payload.actionDescriptor}:undefined;
  return {approval,approvalRef:receipt?.payload.permissionRequestId,publication:await readRunPublicationEffect(pool,input)};
}
