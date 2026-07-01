import { formatProjectTargetRef, projectTargetRefFromEvent, type OpenTagEvent, type ProjectTargetRef } from "@opentag/core";

export const DEFAULT_AGENT_SESSION_PROFILE_TEMPLATE =
  "opentag-{provider}-{accountId}-{conversationId}-{owner}-{repo}-{actorId}";

export type AgentSessionProfile = {
  id: string;
  template: string;
  sourceProvider: string;
  projectTarget?: string;
  accountId?: string;
  conversationId?: string;
  actorId?: string;
};

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function sanitizeAgentSessionProfileId(profile: string): string {
  return profile.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function profileTemplateValue(input: {
  key: string;
  runId: string;
  sourceProvider: string;
  metadata: Record<string, unknown>;
  projectTargetRef?: ProjectTargetRef;
  actorId?: string;
}): string {
  if (input.key === "runId") return input.runId;
  if (input.key === "provider" || input.key === "sourceProvider") return input.sourceProvider;
  if (input.key === "projectTarget") return input.projectTargetRef ? formatProjectTargetRef(input.projectTargetRef) : "";
  if (input.key === "repoProvider") return input.projectTargetRef?.provider ?? metadataString(input.metadata, "repoProvider");
  if (input.key === "owner") return input.projectTargetRef?.owner ?? metadataString(input.metadata, "owner");
  if (input.key === "repo") return input.projectTargetRef?.repo ?? metadataString(input.metadata, "repo");
  if (input.key === "actorId") return input.actorId ?? "";
  return metadataString(input.metadata, input.key);
}

export function createAgentSessionProfile(input: {
  runId: string;
  sourceProvider: string;
  metadata?: Record<string, unknown>;
  projectTargetRef?: ProjectTargetRef | null;
  actorId?: string;
  template?: string;
  fallbackId?: string;
}): AgentSessionProfile | undefined {
  const template = input.template ?? DEFAULT_AGENT_SESSION_PROFILE_TEMPLATE;
  const metadata = input.metadata ?? {};
  const projectTargetRef = input.projectTargetRef ?? undefined;
  const profile = template.replace(/\{([^}]+)\}/g, (_match, key: string) =>
    profileTemplateValue({
      key,
      runId: input.runId,
      sourceProvider: input.sourceProvider,
      metadata,
      ...(projectTargetRef ? { projectTargetRef } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {})
    })
  );
  const id = sanitizeAgentSessionProfileId(profile) || (input.fallbackId ? sanitizeAgentSessionProfileId(input.fallbackId) : "");
  if (!id) return undefined;

  const accountId = metadataString(metadata, "accountId");
  const conversationId = metadataString(metadata, "conversationId");
  return {
    id,
    template,
    sourceProvider: input.sourceProvider,
    ...(projectTargetRef ? { projectTarget: formatProjectTargetRef(projectTargetRef) } : {}),
    ...(accountId ? { accountId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {})
  };
}

export function createAgentSessionProfileForEvent(input: {
  runId: string;
  event: OpenTagEvent;
  metadata?: Record<string, unknown>;
  template?: string;
  fallbackId?: string;
}): AgentSessionProfile | undefined {
  return createAgentSessionProfile({
    runId: input.runId,
    sourceProvider: input.event.source,
    metadata: input.metadata ?? input.event.metadata,
    projectTargetRef: projectTargetRefFromEvent(input.event),
    actorId: input.event.actor.providerUserId,
    ...(input.template ? { template: input.template } : {}),
    ...(input.fallbackId ? { fallbackId: input.fallbackId } : {})
  });
}

export function resolveAgentSessionProfile(input: {
  profile?: string;
  profileTemplate?: string;
  metadata?: Record<string, unknown>;
  projectTargetRef?: ProjectTargetRef | null;
  actorId?: string;
  fallback?: AgentSessionProfile;
}): AgentSessionProfile | undefined {
  if (input.profile) {
    const id = sanitizeAgentSessionProfileId(input.profile);
    const metadata = input.metadata ?? {};
    const accountId = metadataString(metadata, "accountId") || input.fallback?.accountId;
    const conversationId = metadataString(metadata, "conversationId") || input.fallback?.conversationId;
    const actorId = input.actorId ?? input.fallback?.actorId;
    const projectTarget = input.projectTargetRef ? formatProjectTargetRef(input.projectTargetRef) : input.fallback?.projectTarget;
    return id
      ? {
          id,
          template: input.profile,
          sourceProvider: input.fallback?.sourceProvider || metadataString(input.metadata, "provider") || "unknown",
          ...(projectTarget ? { projectTarget } : {}),
          ...(accountId ? { accountId } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(actorId ? { actorId } : {})
        }
      : input.fallback;
  }
  if (input.profileTemplate) {
    return createAgentSessionProfile({
      runId: metadataString(input.metadata, "runId") || input.fallback?.id || "run",
      sourceProvider: metadataString(input.metadata, "provider") || input.fallback?.sourceProvider || "unknown",
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.projectTargetRef ? { projectTargetRef: input.projectTargetRef } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
      template: input.profileTemplate,
      ...(input.fallback?.id ? { fallbackId: input.fallback.id } : {})
    });
  }
  return input.fallback;
}
