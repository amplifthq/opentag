import { z } from "zod";
import {
  OpenTagActorRefSchema,
  OpenTagChannelProtocolSchema,
  OpenTagChannelRefSchema,
  OpenTagReplyTargetRefSchema,
  OpenTagThreadRefSchema
} from "./integration-protocol.js";

export const OpenTagChannelTriggerSchema = z.enum([
  "mention",
  "command",
  "message_action",
  "bound_thread_reply",
  "automation"
]);

export const OpenTagChannelAttachmentRefSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: z.enum(["file", "image", "audio", "video", "link", "other"]),
    name: z.string().trim().min(1).optional(),
    mediaType: z.string().trim().min(1).optional(),
    uri: z.string().trim().min(1).optional()
  })
  .strict();

export const OpenTagChannelInboundSourceSchema = z
  .object({
    kind: z.literal("channel_message"),
    channel: OpenTagChannelRefSchema,
    thread: OpenTagThreadRefSchema.optional(),
    actor: OpenTagActorRefSchema
  })
  .strict();

export const OpenTagChannelInboundMessageSchema = z
  .object({
    protocol: OpenTagChannelProtocolSchema,
    eventId: z.string().trim().min(1),
    occurredAt: z.string().datetime({ offset: true }),
    trigger: OpenTagChannelTriggerSchema,
    source: OpenTagChannelInboundSourceSchema,
    text: z.string().optional(),
    attachments: z.array(OpenTagChannelAttachmentRefSchema).default([]),
    replyTarget: OpenTagReplyTargetRefSchema
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.trigger === "bound_thread_reply" && !event.source.thread) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source", "thread"],
        message: "A bound-thread reply must include its source thread."
      });
    }
  });

export const OpenTagChannelRunCardSchema = z
  .object({
    kind: z.literal("run_card"),
    runId: z.string().trim().min(1),
    state: z.enum([
      "received",
      "queued",
      "running",
      "waiting_input",
      "waiting_approval",
      "verifying",
      "blocked",
      "completed",
      "completed_with_warnings",
      "failed",
      "cancelled",
      "unknown"
    ]),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1).optional(),
    nextAction: z.string().trim().min(1).optional(),
    detailLevel: z.enum(["quiet", "balanced", "detailed"]).default("balanced")
  })
  .strict();

export const OpenTagChannelApprovalDecisionSchema = z.enum(["allow_once", "allow_run", "deny"]);

export const OpenTagChannelApprovalPromptSchema = z
  .object({
    kind: z.literal("approval_prompt"),
    runId: z.string().trim().min(1),
    approvalId: z.string().trim().min(1),
    proposalHash: z.string().trim().min(1),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    decisions: z.array(OpenTagChannelApprovalDecisionSchema).min(1)
  })
  .strict();

export const OpenTagChannelActionReceiptSchema = z
  .object({
    kind: z.literal("action_receipt"),
    runId: z.string().trim().min(1),
    actionId: z.string().trim().min(1),
    state: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
    summary: z.string().trim().min(1),
    receiptRef: z.string().trim().min(1).optional()
  })
  .strict();

export const OpenTagChannelArtifactRefSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    uri: z.string().trim().min(1),
    mediaType: z.string().trim().min(1).optional()
  })
  .strict();

export const OpenTagChannelFinalSummarySchema = z
  .object({
    kind: z.literal("final_summary"),
    runId: z.string().trim().min(1),
    conclusion: z.enum(["completed", "completed_with_warnings", "failed", "cancelled", "unknown"]),
    summary: z.string().trim().min(1),
    artifacts: z.array(OpenTagChannelArtifactRefSchema).default([])
  })
  .strict();

export const OpenTagChannelPresentationSchema = z.discriminatedUnion("kind", [
  OpenTagChannelRunCardSchema,
  OpenTagChannelApprovalPromptSchema,
  OpenTagChannelActionReceiptSchema,
  OpenTagChannelFinalSummarySchema
]);

export const OpenTagChannelPresentationCommandSchema = z
  .object({
    protocol: OpenTagChannelProtocolSchema,
    commandId: z.string().trim().min(1),
    replyTarget: OpenTagReplyTargetRefSchema,
    operation: z.enum(["create", "update", "reply"]),
    presentation: OpenTagChannelPresentationSchema
  })
  .strict();

export type OpenTagChannelTrigger = z.infer<typeof OpenTagChannelTriggerSchema>;
export type OpenTagChannelAttachmentRef = z.infer<typeof OpenTagChannelAttachmentRefSchema>;
export type OpenTagChannelInboundSource = z.infer<typeof OpenTagChannelInboundSourceSchema>;
export type OpenTagChannelInboundMessageInput = z.input<typeof OpenTagChannelInboundMessageSchema>;
export type OpenTagChannelInboundMessage = z.infer<typeof OpenTagChannelInboundMessageSchema>;
export type OpenTagChannelRunCard = z.infer<typeof OpenTagChannelRunCardSchema>;
export type OpenTagChannelApprovalDecision = z.infer<typeof OpenTagChannelApprovalDecisionSchema>;
export type OpenTagChannelApprovalPrompt = z.infer<typeof OpenTagChannelApprovalPromptSchema>;
export type OpenTagChannelActionReceipt = z.infer<typeof OpenTagChannelActionReceiptSchema>;
export type OpenTagChannelArtifactRef = z.infer<typeof OpenTagChannelArtifactRefSchema>;
export type OpenTagChannelFinalSummary = z.infer<typeof OpenTagChannelFinalSummarySchema>;
export type OpenTagChannelPresentation = z.infer<typeof OpenTagChannelPresentationSchema>;
export type OpenTagChannelPresentationCommandInput = z.input<typeof OpenTagChannelPresentationCommandSchema>;
export type OpenTagChannelPresentationCommand = z.infer<typeof OpenTagChannelPresentationCommandSchema>;
