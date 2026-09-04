import type {
  ContextPacket,
  ContextPacketFactConfidence,
  ContextPointer,
  ConversationAnchor,
  OpenTagEvent,
  WorkItemReference,
  WorkThread
} from "./schema.js";

const CONTEXT_PACKET_STAGES = ["collect", "classify", "filter", "preserve", "summarize", "budget", "emit"] as const;

export type ContextSourceClassification = "primary_evidence" | "supporting_context" | "background_noise" | "sensitive_material";

export type ClassifiedContextPointer = {
  pointer: ContextPointer;
  classification: ContextSourceClassification;
  reason: string;
};

function contextPacketSourceRole(classification: ContextSourceClassification): "primary" | "supporting" | "background" {
  switch (classification) {
    case "primary_evidence":
      return "primary";
    case "supporting_context":
      return "supporting";
    case "background_noise":
    case "sensitive_material":
      return "background";
  }
}

export function contextPointerLabel(pointer: ContextPointer): string {
  return pointer.provider ? `${pointer.provider}.${pointer.kind}` : pointer.kind;
}

export type ContextPacketAssemblyOptions = {
  budgetTokens?: number;
  risks?: string[];
  exclusions?: string[];
  redactions?: Array<{ reason: string; sourceUri?: string }>;
  hooks?: ContextPacketAssemblyHooks;
};

export type ContextPacketAssemblyHooks = {
  collect?(input: { event: OpenTagEvent; pointers: ContextPointer[] }): ContextPointer[];
  classify?(input: { event: OpenTagEvent; classified: ClassifiedContextPointer[] }): ClassifiedContextPointer[];
  filter?(input: { event: OpenTagEvent; classified: ClassifiedContextPointer[] }): ClassifiedContextPointer[];
  preserve?(input: { event: OpenTagEvent; facts: ContextPacketFact[] }): ContextPacketFact[];
  summarize?(input: { event: OpenTagEvent; summary: string }): string;
  budget?(input: {
    event: OpenTagEvent;
    classified: ClassifiedContextPointer[];
    budgetTokens?: number;
  }): ClassifiedContextPointer[];
  emit?(input: { event: OpenTagEvent; packet: ContextPacket }): ContextPacket;
};

function classifyContextPointer(pointer: ContextPointer): ClassifiedContextPointer {
  if (pointer.kind === "text") {
    return { pointer, classification: "primary_evidence", reason: "Original user-authored text is primary evidence." };
  }
  if (["issue", "pull_request", "comment", "thread", "message"].includes(pointer.kind)) {
    return { pointer, classification: "primary_evidence", reason: `${contextPointerLabel(pointer)} is directly attached to the invocation.` };
  }
  if (["repo", "file", "url"].includes(pointer.kind)) {
    return { pointer, classification: "supporting_context", reason: `${contextPointerLabel(pointer)} supports execution but is not itself the request.` };
  }
  return { pointer, classification: "supporting_context", reason: "Pointer is relevant context." };
}

export function collectContextPointers(event: OpenTagEvent): ContextPointer[] {
  return event.context;
}

export function classifyContextPointers(pointers: ContextPointer[]): ClassifiedContextPointer[] {
  return pointers.map((pointer) => classifyContextPointer(pointer));
}

export function filterClassifiedContextPointers(classified: ClassifiedContextPointer[]): ClassifiedContextPointer[] {
  return classified.filter((entry) => entry.classification !== "background_noise" && entry.classification !== "sensitive_material");
}

type ContextPacketFact = { text: string; sourceUri?: string; source?: ContextPointer; confidence?: ContextPacketFactConfidence };

function metadataString(event: OpenTagEvent, key: string): string | undefined {
  const value = event.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataStringArray(event: OpenTagEvent, key: string): string[] {
  const value = event.metadata[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function preserveActionLoopFacts(event: OpenTagEvent): ContextPacketFact[] {
  const facts: ContextPacketFact[] = [];
  const threadActionVerb = metadataString(event, "threadActionVerb");
  const parentRunId = metadataString(event, "parentRunId");
  const sourceProposalId = metadataString(event, "sourceProposalId");
  const approvalDecisionId = metadataString(event, "approvalDecisionId");
  const sourceApplyPlanId = metadataString(event, "sourceApplyPlanId");
  const previousRunSummary = metadataString(event, "previousRunSummary");
  const fallbackReason = metadataString(event, "fallbackReason");
  const selectedIntentIds = metadataStringArray(event, "selectedIntentIds");

  if (threadActionVerb) facts.push({ text: `Action loop thread action: ${threadActionVerb}`, confidence: "observed" });
  if (parentRunId) facts.push({ text: `Action loop parent run: ${parentRunId}`, confidence: "observed" });
  if (sourceProposalId) facts.push({ text: `Action loop proposal: ${sourceProposalId}`, confidence: "observed" });
  if (approvalDecisionId) facts.push({ text: `Action loop approval decision: ${approvalDecisionId}`, confidence: "observed" });
  if (sourceApplyPlanId) facts.push({ text: `Action loop apply plan: ${sourceApplyPlanId}`, confidence: "observed" });
  if (selectedIntentIds.length > 0) facts.push({ text: `Action loop selected intents: ${selectedIntentIds.join(", ")}`, confidence: "observed" });
  if (previousRunSummary) facts.push({ text: `Action loop previous result: ${previousRunSummary}`, confidence: "observed" });
  if (fallbackReason) facts.push({ text: `Action loop fallback reason: ${fallbackReason}`, confidence: "observed" });

  return facts;
}

export function preserveContextFacts(event: OpenTagEvent, classified: ClassifiedContextPointer[]): ContextPacketFact[] {
  const sourceUri = classified[0]?.pointer.uri;
  return [
    {
      text: `Requested intent: ${event.command.intent}`,
      ...(sourceUri ? { sourceUri } : {}),
      ...(classified[0]?.pointer ? { source: classified[0].pointer } : {}),
      confidence: "observed"
    },
    ...preserveActionLoopFacts(event),
    ...classified.map((entry) => ({
      text: `${entry.classification}: ${contextPointerLabel(entry.pointer)}`,
      sourceUri: entry.pointer.uri,
      source: entry.pointer,
      confidence: "observed" as const
    }))
  ];
}

export function summarizeContextPacket(event: OpenTagEvent): string {
  // A whitespace-only rawText is functionally empty, so fall back to the derived
  // request label rather than emitting a blank summary.
  return event.command.rawText.trim() || `OpenTag ${event.command.intent} request`;
}

export function budgetContextPointers(classified: ClassifiedContextPointer[], budgetTokens?: number): ClassifiedContextPointer[] {
  if (!budgetTokens) return classified;
  const maxPointers = Math.max(1, Math.floor(budgetTokens / 500));
  return classified.slice(0, maxPointers);
}

export function assembleContextPacketFromEvent(
  event: OpenTagEvent,
  emittedAt = event.receivedAt,
  options: ContextPacketAssemblyOptions = {}
): ContextPacket {
  const collected = options.hooks?.collect?.({ event, pointers: collectContextPointers(event) }) ?? collectContextPointers(event);
  const classified = options.hooks?.classify?.({ event, classified: classifyContextPointers(collected) }) ?? classifyContextPointers(collected);
  const filtered =
    options.hooks?.filter?.({ event, classified: filterClassifiedContextPointers(classified) }) ??
    filterClassifiedContextPointers(classified);
  const budgeted =
    options.hooks?.budget?.({
      event,
      classified: budgetContextPointers(filtered, options.budgetTokens),
      ...(options.budgetTokens ? { budgetTokens: options.budgetTokens } : {})
    }) ??
    budgetContextPointers(filtered, options.budgetTokens);
  const writeScopes = event.permissions
    .map((permission) => permission.scope)
    .filter((scope) => scope === "repo:write" || scope === "pr:create" || scope === "pr:update");
  const summary = options.hooks?.summarize?.({ event, summary: summarizeContextPacket(event) }) ?? summarizeContextPacket(event);
  const facts = options.hooks?.preserve?.({ event, facts: preserveContextFacts(event, budgeted) }) ?? preserveContextFacts(event, budgeted);
  const packet = {
    summary,
    sourcePointers: budgeted.map((entry) => entry.pointer),
    intent: {
      // OpenTagCommandSchema.rawText permits an empty string, but
      // ContextPacketIntentSchema.rawText requires min length 1. A
      // whitespace-only rawText is functionally empty, so trim before the
      // emptiness check and fall back to the (always non-empty) summary. The
      // original, untrimmed rawText is preserved whenever it has real content,
      // keeping the emitted packet schema-valid so the store does not accept the
      // run on write and then throw on read.
      rawText: event.command.rawText.trim() ? event.command.rawText : summary,
      normalizedIntent: event.command.intent,
      requestedBy: event.actor
    },
    sources: budgeted.map((entry) => ({
      pointer: entry.pointer,
      role: contextPacketSourceRole(entry.classification),
      included: true,
      reason: entry.reason
    })),
    facts,
    risks:
      options.risks ??
      (writeScopes.length > 0
        ? [`External write-capable scopes were requested: ${writeScopes.join(", ")}.`]
        : ["No external write-capable scopes were requested."]),
    exclusions: options.exclusions ?? ["Do not mutate external state unless an explicit capability and policy allow it."],
    mustPreserve: [summary],
    ...(options.redactions?.length ? { redactions: options.redactions } : {}),
    assembly: {
      stages: [...CONTEXT_PACKET_STAGES],
      ...(options.budgetTokens ? { budgetTokens: options.budgetTokens } : {}),
      emittedAt
    }
  };
  return options.hooks?.emit?.({ event, packet }) ?? packet;
}

export function defaultRunEventMetadata(type: string): {
  visibility: "human" | "audit" | "debug";
  importance: "low" | "normal" | "high" | "blocking";
} {
  const visibility = type === "delivery.activation_blocked" ? "human" : type.startsWith("executor.log") ? "debug" : "audit";
  const importance =
    type === "run.waiting_for_permission" || type === "delivery.activation_blocked"
      ? "blocking"
      : type === "run.completed"
        ? "high"
        : type === "run.created"
          ? "low"
          : "normal";
  return { visibility, importance };
}

function firstContextUri(event: OpenTagEvent, input: { provider?: string; kind: string }): string | undefined {
  return event.context.find((pointer) => pointer.kind === input.kind && (!input.provider || pointer.provider === input.provider))?.uri;
}

export function workItemReferenceFromEvent(event: OpenTagEvent): WorkItemReference | undefined {
  return event.workItem;
}

export function primaryConversationAnchorFromEvent(event: OpenTagEvent): ConversationAnchor {
  const sourcePointer =
    firstContextUri(event, { provider: "slack", kind: "message" }) ??
    firstContextUri(event, { provider: event.callback.provider, kind: "thread" }) ??
    firstContextUri(event, { kind: "url" });
  return {
    provider: event.callback.provider,
    kind: event.callback.threadKey ? "thread" : `${event.callback.provider}_thread`,
    externalId: event.callback.threadKey ?? event.callback.uri,
    uri: sourcePointer ?? event.callback.uri,
    controlPlane: true,
    canApprove: true,
    ...(event.callback.threadKey ? { threadKey: event.callback.threadKey } : {})
  };
}

function callbackConversationKey(callback: OpenTagEvent["callback"]): string {
  return `${callback.provider}:${callback.threadKey ?? callback.uri}`;
}

export function conversationKeysFromCallback(callback: OpenTagEvent["callback"]): string[] {
  return [callbackConversationKey(callback)];
}

export function conversationKeyFromEvent(event: OpenTagEvent): string {
  return callbackConversationKey(event.callback);
}

export function conversationKeysFromEvent(event: OpenTagEvent): string[] {
  return conversationKeysFromCallback(event.callback);
}

export function workThreadFromEvent(event: OpenTagEvent): WorkThread | undefined {
  const workItemReference = workItemReferenceFromEvent(event);
  if (!workItemReference) return undefined;

  const primaryAnchor = primaryConversationAnchorFromEvent(event);
  return {
    id: `thread_${workItemReference.provider}_${workItemReference.externalId}_${primaryAnchor.externalId}`,
    workItemReference,
    primaryAnchor
  };
}

export function contextPacketFromEvent(event: OpenTagEvent, emittedAt = event.receivedAt): ContextPacket {
  return assembleContextPacketFromEvent(event, emittedAt);
}

export function protocolRunFieldsFromEvent(
  event: OpenTagEvent,
  emittedAt = event.receivedAt
): { thread?: WorkThread; contextPacket: ContextPacket } {
  const thread = workThreadFromEvent(event);
  const contextPacket = contextPacketFromEvent(event, emittedAt);
  return {
    ...(thread ? { thread } : {}),
    contextPacket
  };
}
