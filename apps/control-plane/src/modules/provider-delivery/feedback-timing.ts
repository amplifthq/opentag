import { z } from "zod";
import { isCredentialSafeText } from "@opentag/core";

const id = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_:.-]+$/u).refine(isCredentialSafeText);
export const FeedbackTimingSchema = z.object({
  stage:z.enum(["approval_committed","projection_enqueued","delivery_started","delivery_settled"]),
  runId:id,operationId:id,approvalRef:id.optional(),at:z.string().datetime(),
  durationMs:z.number().nonnegative().nullable(),queueMs:z.number().nonnegative().nullable().optional(),
  result:z.enum(["authorized","denied","queued","begun","accepted","rejected","outcome_unknown","attention"]).optional(),
}).strict();

export function feedbackElapsedMs(start:number,end:number):number|null {
  return Number.isFinite(start)&&Number.isFinite(end)&&end>=start?Math.round(end-start):null;
}

/** Content-free diagnostics only. Logging can never change an approval or delivery outcome. */
export function logFeedbackTiming(input:z.infer<typeof FeedbackTimingSchema>,logger:Pick<Console,"info"|"warn">=console):boolean {
  try {
    const parsed=FeedbackTimingSchema.safeParse(input);
    if(!parsed.success){logger.warn("control_plane_feedback_timing_invalid");return false;}
    logger.info(JSON.stringify({event:"control_plane_feedback_timing",...parsed.data}));
    return true;
  }catch{return false;}
}
