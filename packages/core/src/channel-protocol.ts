import { z } from "zod";
import {
  OpenTagActorRefSchema,
  OpenTagChannelProtocolSchema,
  OpenTagChannelRefSchema,
  OpenTagReplyTargetRefSchema,
  OpenTagThreadRefSchema
} from "./integration-protocol.js";
import { OpenTagPresentationSchema } from "./presentation.js";

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

export const OpenTagChannelPresentationCommandSchema = z
  .object({
    protocol: OpenTagChannelProtocolSchema,
    commandId: z.string().trim().min(1),
    replyTarget: OpenTagReplyTargetRefSchema,
    operation: z.enum(["create", "update", "reply"]),
    presentation: OpenTagPresentationSchema
  })
  .strict();

export type OpenTagChannelTrigger = z.infer<typeof OpenTagChannelTriggerSchema>;
export type OpenTagChannelAttachmentRef = z.infer<typeof OpenTagChannelAttachmentRefSchema>;
export type OpenTagChannelInboundSource = z.infer<typeof OpenTagChannelInboundSourceSchema>;
export type OpenTagChannelInboundMessageInput = z.input<typeof OpenTagChannelInboundMessageSchema>;
export type OpenTagChannelInboundMessage = z.infer<typeof OpenTagChannelInboundMessageSchema>;
export type OpenTagChannelPresentationCommandInput = z.input<typeof OpenTagChannelPresentationCommandSchema>;
export type OpenTagChannelPresentationCommand = z.infer<typeof OpenTagChannelPresentationCommandSchema>;
