import { z } from "zod";
import {
  ContextPacketSchema,
  ContextPointerSchema,
  OpenTagCommandSchema,
  PermissionGrantSchema,
  ResultArtifactSchema
} from "./schema.js";

export const OpenTagExecutorProtocolVersionSchema = z.literal("opentag.executor.v1");
export const OpenTagExecutorTransportSchema = z.literal("stdio-jsonl");

export const OpenTagExecutorWorkspaceIsolationSchema = z.enum(["branch", "worktree"]);
export const OpenTagExecutorSessionScopeSchema = z.enum(["run", "source_thread", "custom"]);
export const OpenTagExecutorProgressEventModeSchema = z.enum(["none", "audit", "human"]);
export const OpenTagExecutorConversationAccessSchema = z.enum(["none", "request", "thread_transcript"]);

export const OpenTagExecutorProtocolCapabilitiesSchema = z
  .object({
    workspaceIsolation: OpenTagExecutorWorkspaceIsolationSchema.default("worktree"),
    conversationAccess: OpenTagExecutorConversationAccessSchema.default("request"),
    progressEvents: OpenTagExecutorProgressEventModeSchema.default("audit"),
    supportsCancel: z.boolean().default(false),
    supportsStreaming: z.boolean().default(false)
  })
  .strict();

export const OpenTagExecutorProtocolManifestSchema = z
  .object({
    protocol: OpenTagExecutorProtocolVersionSchema,
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    transport: OpenTagExecutorTransportSchema,
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    capabilities: OpenTagExecutorProtocolCapabilitiesSchema.default({})
  })
  .strict();

export const OpenTagExecutorProtocolWorkspaceSchema = z
  .object({
    path: z.string().min(1),
    baseBranch: z.string().min(1),
    branchName: z.string().min(1),
    isolation: OpenTagExecutorWorkspaceIsolationSchema
  })
  .strict();

export const OpenTagExecutorProtocolSessionSchema = z
  .object({
    scope: OpenTagExecutorSessionScopeSchema,
    key: z.string().min(1)
  })
  .strict();

export const OpenTagExecutorProtocolSourceControlSchema = z
  .object({
    owner: z.literal("opentag"),
    forbiddenCommands: z.array(z.string().min(1))
  })
  .strict();

export const OpenTagExecutorRunRequestSchema = z
  .object({
    protocol: OpenTagExecutorProtocolVersionSchema,
    runId: z.string().min(1),
    workspace: OpenTagExecutorProtocolWorkspaceSchema,
    session: OpenTagExecutorProtocolSessionSchema,
    command: OpenTagCommandSchema,
    context: z.array(ContextPointerSchema),
    contextPacket: ContextPacketSchema.optional(),
    permissions: z.array(PermissionGrantSchema).default([]),
    metadata: z.record(z.unknown()).default({}),
    sourceControl: OpenTagExecutorProtocolSourceControlSchema
  })
  .strict();

export const OpenTagExecutorProtocolVerificationSchema = z
  .object({
    command: z.string().min(1).optional(),
    outcome: z.enum(["passed", "failed", "not_run"]),
    summary: z.string().min(1).optional()
  })
  .strict();

const BaseProtocolEventSchema = z
  .object({
    message: z.string().min(1),
    at: z.string().datetime().optional()
  })
  .strict();

export const OpenTagExecutorStartedEventSchema = BaseProtocolEventSchema.extend({
  type: z.literal("started")
});

export const OpenTagExecutorProgressEventSchema = BaseProtocolEventSchema.extend({
  type: z.literal("progress")
});

export const OpenTagExecutorCompletedEventSchema = BaseProtocolEventSchema.extend({
  type: z.literal("completed"),
  actualWorkspacePath: z.string().min(1),
  summary: z.string().min(1),
  verification: z.array(OpenTagExecutorProtocolVerificationSchema).default([]),
  artifacts: z.array(ResultArtifactSchema).default([]),
  notes: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([])
});

export const OpenTagExecutorFailedEventSchema = BaseProtocolEventSchema.extend({
  type: z.literal("failed"),
  actualWorkspacePath: z.string().min(1).optional()
});

export const OpenTagExecutorProtocolEventSchema = z.discriminatedUnion("type", [
  OpenTagExecutorStartedEventSchema,
  OpenTagExecutorProgressEventSchema,
  OpenTagExecutorCompletedEventSchema,
  OpenTagExecutorFailedEventSchema
]);

export type OpenTagExecutorProtocolVersion = z.infer<typeof OpenTagExecutorProtocolVersionSchema>;
export type OpenTagExecutorTransport = z.infer<typeof OpenTagExecutorTransportSchema>;
export type OpenTagExecutorWorkspaceIsolation = z.infer<typeof OpenTagExecutorWorkspaceIsolationSchema>;
export type OpenTagExecutorSessionScope = z.infer<typeof OpenTagExecutorSessionScopeSchema>;
export type OpenTagExecutorProtocolCapabilities = z.infer<typeof OpenTagExecutorProtocolCapabilitiesSchema>;
export type OpenTagExecutorProtocolManifest = z.infer<typeof OpenTagExecutorProtocolManifestSchema>;
export type OpenTagExecutorProtocolWorkspace = z.infer<typeof OpenTagExecutorProtocolWorkspaceSchema>;
export type OpenTagExecutorProtocolSession = z.infer<typeof OpenTagExecutorProtocolSessionSchema>;
export type OpenTagExecutorRunRequest = z.infer<typeof OpenTagExecutorRunRequestSchema>;
export type OpenTagExecutorProtocolVerification = z.infer<typeof OpenTagExecutorProtocolVerificationSchema>;
export type OpenTagExecutorStartedEvent = z.infer<typeof OpenTagExecutorStartedEventSchema>;
export type OpenTagExecutorProgressEvent = z.infer<typeof OpenTagExecutorProgressEventSchema>;
export type OpenTagExecutorCompletedEvent = z.infer<typeof OpenTagExecutorCompletedEventSchema>;
export type OpenTagExecutorFailedEvent = z.infer<typeof OpenTagExecutorFailedEventSchema>;
export type OpenTagExecutorProtocolEvent = z.infer<typeof OpenTagExecutorProtocolEventSchema>;
