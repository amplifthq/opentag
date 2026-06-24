import { z } from "zod";

export const SourceSchema = z.enum(["github", "slack", "lark", "cli", "webhook"]);
export const ProviderSchema = z.enum(["github", "slack", "lark"]);
export const ExecutorHintSchema = z.enum(["claude-code", "codex", "hermes", "openclaw", "custom"]);
export const PermissionScopeSchema = z.enum([
  "repo:read",
  "repo:write",
  "issue:comment",
  "chat:postMessage",
  "pr:create",
  "pr:update",
  "runner:local",
  "network:restricted"
]);
export const CommandArgValueSchema = z.union([z.string(), z.boolean(), z.number()]);
export const CommandFlagValueSchema = z.union([CommandArgValueSchema, z.array(CommandArgValueSchema)]);

export const CommandReferenceSchema = z.object({
  kind: z.enum(["file", "path", "line", "range", "url", "text"]),
  uri: z.string().min(1),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  title: z.string().min(1).optional()
});

export const CommandParseDiagnosticSchema = z.object({
  level: z.enum(["warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  token: z.string().min(1).optional()
});

export const ParsedOpenTagCommandSchema = z.object({
  version: z.literal("v1"),
  prompt: z.string(),
  flags: z.record(CommandFlagValueSchema),
  references: z.array(CommandReferenceSchema),
  requestedScopes: z.array(PermissionScopeSchema),
  approval: z.enum(["auto", "required", "never"]).optional(),
  network: z.enum(["restricted"]).optional(),
  executorHint: ExecutorHintSchema.optional(),
  diagnostics: z.array(CommandParseDiagnosticSchema)
});

export const ActorIdentitySchema = z.object({
  provider: ProviderSchema,
  providerUserId: z.string().min(1),
  handle: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional()
});

export const AgentTargetSchema = z.object({
  mention: z.string().min(1),
  agentId: z.string().min(1),
  executorHint: ExecutorHintSchema.optional(),
  workspaceHint: z.string().min(1).optional()
});

export const OpenTagCommandSchema = z.object({
  rawText: z.string(),
  intent: z.enum(["fix", "review", "investigate", "explain", "run", "unknown"]),
  args: z.record(CommandArgValueSchema),
  parsed: ParsedOpenTagCommandSchema.optional()
});

export const ContextPointerSchema = z.object({
  kind: z.enum([
    "github.repo",
    "github.issue",
    "github.pull_request",
    "github.comment",
    "github.commit",
    "file",
    "url",
    "text"
  ]),
  uri: z.string().min(1),
  title: z.string().min(1).optional(),
  visibility: z.enum(["public", "private", "organization"])
});

export const PermissionGrantSchema = z.object({
  scope: PermissionScopeSchema,
  reason: z.string().min(1),
  expiresAt: z.string().datetime().optional()
});

export const CallbackRouteSchema = z.object({
  provider: z.enum(["github", "slack", "lark", "webhook"]),
  uri: z.string().min(1),
  threadKey: z.string().min(1).optional()
});

export const OpenTagEventSchema = z.object({
  id: z.string().min(1),
  source: SourceSchema,
  sourceEventId: z.string().min(1),
  receivedAt: z.string().datetime(),
  actor: ActorIdentitySchema,
  target: AgentTargetSchema,
  command: OpenTagCommandSchema,
  context: z.array(ContextPointerSchema),
  permissions: z.array(PermissionGrantSchema),
  callback: CallbackRouteSchema,
  metadata: z.record(z.unknown())
});

export const OpenTagRunResultSchema = z.object({
  conclusion: z.enum(["success", "failure", "cancelled", "needs_human"]),
  summary: z.string(),
  changedFiles: z.array(z.string()).optional(),
  createdPullRequestUrl: z.string().url().optional(),
  artifacts: z.array(z.object({ title: z.string(), uri: z.string() })).optional(),
  verification: z
    .array(
      z.object({
        command: z.string(),
        outcome: z.enum(["passed", "failed", "not_run"]),
        excerpt: z.string().optional()
      })
    )
    .optional(),
  nextAction: z.string().optional()
});

export const OpenTagRunSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  status: z.enum(["queued", "assigned", "running", "needs_approval", "succeeded", "failed", "cancelled"]),
  assignedRunnerId: z.string().min(1).optional(),
  executor: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  result: OpenTagRunResultSchema.optional()
});

export type ActorIdentity = z.infer<typeof ActorIdentitySchema>;
export type AgentTarget = z.infer<typeof AgentTargetSchema>;
export type OpenTagCommand = z.infer<typeof OpenTagCommandSchema>;
export type ParsedOpenTagCommand = z.infer<typeof ParsedOpenTagCommandSchema>;
export type CommandParseDiagnostic = z.infer<typeof CommandParseDiagnosticSchema>;
export type CommandReference = z.infer<typeof CommandReferenceSchema>;
export type ContextPointer = z.infer<typeof ContextPointerSchema>;
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;
export type CallbackRoute = z.infer<typeof CallbackRouteSchema>;
export type OpenTagEvent = z.infer<typeof OpenTagEventSchema>;
export type OpenTagRun = z.infer<typeof OpenTagRunSchema>;
export type OpenTagRunResult = z.infer<typeof OpenTagRunResultSchema>;
