import { z } from "zod";

const ProviderDataSchema = z.record(z.unknown());

export const OpenTagIntegrationProtocolVersionSchema = z.literal("opentag.integration.v1");
export const OpenTagExecutorRoleProtocolVersionSchema = z.literal("opentag.executor.v1");
export const OpenTagStdioJsonlBindingKindSchema = z.literal("stdio-jsonl");
export const OpenTagExecutorProfileSchema = z.literal("stdio-jsonl-basic");

export const OpenTagExecutorWorkspaceIsolationSchema = z.literal("worktree");
export const OpenTagExecutorProgressEventModeSchema = z.literal("audit");
export const OpenTagExecutorConversationAccessSchema = z.literal("request");

export const OpenTagExecutorProtocolCapabilitiesSchema = z
  .object({
    workspaceIsolation: OpenTagExecutorWorkspaceIsolationSchema.default("worktree"),
    conversationAccess: OpenTagExecutorConversationAccessSchema.default("request"),
    progressEvents: OpenTagExecutorProgressEventModeSchema.default("audit"),
    supportsCancel: z.literal(false).default(false),
    supportsStreaming: z.literal(false).default(false)
  })
  .strict();

export const OpenTagStdioJsonlBindingSchema = z
  .object({
    kind: OpenTagStdioJsonlBindingKindSchema,
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().trim().min(1).optional(),
    env: z.record(z.string()).default({})
  })
  .strict();

export const OpenTagIntegrationBindingSchema = OpenTagStdioJsonlBindingSchema;

export const OpenTagExecutorIntegrationRoleSchema = z
  .object({
    protocol: OpenTagExecutorRoleProtocolVersionSchema,
    profile: OpenTagExecutorProfileSchema,
    binding: z.string().trim().min(1),
    capabilities: OpenTagExecutorProtocolCapabilitiesSchema.default({})
  })
  .strict();

export const OpenTagIntegrationRolesSchema = z
  .object({
    executor: OpenTagExecutorIntegrationRoleSchema.optional()
  })
  .strict();

export const OpenTagResourceCapabilitySchema = z
  .object({
    refs: z.boolean().default(true),
    read: z.boolean().default(false),
    write: z.boolean().default(false),
    comments: z.boolean().optional(),
    status: z.boolean().optional()
  })
  .strict();

export const OpenTagIntegrationResourcesSchema = z
  .object({
    repo: OpenTagResourceCapabilitySchema.optional(),
    changeRequest: OpenTagResourceCapabilitySchema.optional(),
    workItem: OpenTagResourceCapabilitySchema.optional(),
    context: OpenTagResourceCapabilitySchema.optional(),
    identity: OpenTagResourceCapabilitySchema.optional()
  })
  .strict()
  .default({});

export const OpenTagIntegrationManifestSchema = z
  .object({
    protocol: OpenTagIntegrationProtocolVersionSchema,
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    bindings: z.record(OpenTagIntegrationBindingSchema),
    roles: OpenTagIntegrationRolesSchema,
    resources: OpenTagIntegrationResourcesSchema
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (Object.keys(manifest.bindings).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bindings"],
        message: "Integration manifest must declare at least one binding."
      });
    }
    const executor = manifest.roles.executor;
    if (!executor) return;
    const binding = manifest.bindings[executor.binding];
    if (!binding) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roles", "executor", "binding"],
        message: `Executor role references missing binding '${executor.binding}'.`
      });
      return;
    }
    if (executor.profile === "stdio-jsonl-basic" && binding.kind !== "stdio-jsonl") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roles", "executor", "binding"],
        message: "Executor profile stdio-jsonl-basic requires a stdio-jsonl binding."
      });
    }
  });

export const OpenTagActorRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagChannelRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1).optional(),
    workspace: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagThreadRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
    parentMessageId: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagRepoRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    owner: z.string().trim().min(1),
    name: z.string().trim().min(1),
    url: z.string().trim().min(1).optional(),
    defaultBranch: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagChangeRequestRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    repo: OpenTagRepoRefSchema.optional(),
    id: z.string().trim().min(1),
    number: z.number().int().positive().optional(),
    title: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    sourceBranch: z.string().trim().min(1).optional(),
    targetBranch: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagWorkItemRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagContextRefKindSchema = z.enum(["doc", "wiki", "file", "search", "memory", "thread", "issue", "change_request", "url"]);

export const OpenTagContextRefSchema = z
  .object({
    provider: z.string().trim().min(1),
    kind: OpenTagContextRefKindSchema,
    id: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    url: z.string().trim().min(1).optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagRunSourceKindSchema = z.enum(["channel_message", "automation", "api", "webhook"]);

export const OpenTagRunSourceRefSchema = z
  .object({
    kind: OpenTagRunSourceKindSchema,
    channel: OpenTagChannelRefSchema.optional(),
    thread: OpenTagThreadRefSchema.optional(),
    actor: OpenTagActorRefSchema.optional(),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export const OpenTagRunTargetsSchema = z
  .object({
    repo: OpenTagRepoRefSchema.optional(),
    changeRequest: OpenTagChangeRequestRefSchema.optional(),
    workItem: OpenTagWorkItemRefSchema.optional(),
    context: z.array(OpenTagContextRefSchema).default([])
  })
  .strict();

export const OpenTagReplyPurposeSchema = z.enum(["all", "progress", "final", "error", "approval"]);
export const OpenTagReplyDeliveryPurposeSchema = OpenTagReplyPurposeSchema.exclude(["all"]);

export const OpenTagReplyTargetRefSchema = z
  .object({
    channel: OpenTagChannelRefSchema,
    thread: OpenTagThreadRefSchema.optional(),
    purpose: OpenTagReplyPurposeSchema.default("all"),
    providerData: ProviderDataSchema.optional()
  })
  .strict();

export type OpenTagIntegrationProtocolVersion = z.infer<typeof OpenTagIntegrationProtocolVersionSchema>;
export type OpenTagExecutorRoleProtocolVersion = z.infer<typeof OpenTagExecutorRoleProtocolVersionSchema>;
export type OpenTagStdioJsonlBindingKind = z.infer<typeof OpenTagStdioJsonlBindingKindSchema>;
export type OpenTagExecutorProfile = z.infer<typeof OpenTagExecutorProfileSchema>;
export type OpenTagExecutorWorkspaceIsolation = z.infer<typeof OpenTagExecutorWorkspaceIsolationSchema>;
export type OpenTagExecutorProgressEventMode = z.infer<typeof OpenTagExecutorProgressEventModeSchema>;
export type OpenTagExecutorConversationAccess = z.infer<typeof OpenTagExecutorConversationAccessSchema>;
export type OpenTagExecutorProtocolCapabilities = z.infer<typeof OpenTagExecutorProtocolCapabilitiesSchema>;
export type OpenTagStdioJsonlBindingInput = z.input<typeof OpenTagStdioJsonlBindingSchema>;
export type OpenTagStdioJsonlBinding = z.infer<typeof OpenTagStdioJsonlBindingSchema>;
export type OpenTagIntegrationBinding = z.infer<typeof OpenTagIntegrationBindingSchema>;
export type OpenTagExecutorIntegrationRoleInput = z.input<typeof OpenTagExecutorIntegrationRoleSchema>;
export type OpenTagExecutorIntegrationRole = z.infer<typeof OpenTagExecutorIntegrationRoleSchema>;
export type OpenTagIntegrationRoles = z.infer<typeof OpenTagIntegrationRolesSchema>;
export type OpenTagResourceCapability = z.infer<typeof OpenTagResourceCapabilitySchema>;
export type OpenTagIntegrationResources = z.infer<typeof OpenTagIntegrationResourcesSchema>;
export type OpenTagIntegrationManifestInput = z.input<typeof OpenTagIntegrationManifestSchema>;
export type OpenTagIntegrationManifest = z.infer<typeof OpenTagIntegrationManifestSchema>;
export type OpenTagActorRef = z.infer<typeof OpenTagActorRefSchema>;
export type OpenTagChannelRef = z.infer<typeof OpenTagChannelRefSchema>;
export type OpenTagThreadRef = z.infer<typeof OpenTagThreadRefSchema>;
export type OpenTagRepoRef = z.infer<typeof OpenTagRepoRefSchema>;
export type OpenTagChangeRequestRef = z.infer<typeof OpenTagChangeRequestRefSchema>;
export type OpenTagWorkItemRef = z.infer<typeof OpenTagWorkItemRefSchema>;
export type OpenTagContextRefKind = z.infer<typeof OpenTagContextRefKindSchema>;
export type OpenTagContextRef = z.infer<typeof OpenTagContextRefSchema>;
export type OpenTagRunSourceKind = z.infer<typeof OpenTagRunSourceKindSchema>;
export type OpenTagRunSourceRef = z.infer<typeof OpenTagRunSourceRefSchema>;
export type OpenTagRunTargets = z.infer<typeof OpenTagRunTargetsSchema>;
export type OpenTagReplyPurpose = z.infer<typeof OpenTagReplyPurposeSchema>;
export type OpenTagReplyDeliveryPurpose = z.infer<typeof OpenTagReplyDeliveryPurposeSchema>;
export type OpenTagReplyTargetRef = z.infer<typeof OpenTagReplyTargetRefSchema>;

export function selectReplyTargetsForPurpose(
  replyTo: readonly OpenTagReplyTargetRef[],
  purpose: OpenTagReplyDeliveryPurpose
): OpenTagReplyTargetRef[] {
  return replyTo.filter((target) => target.purpose === "all" || target.purpose === purpose);
}
