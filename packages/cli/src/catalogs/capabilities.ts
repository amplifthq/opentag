import { OPEN_TAG_PLATFORM_CAPABILITIES, type PlatformCapabilityDescriptor } from "@opentag/core";
import { EXECUTOR_CATALOG, type ExecutorId, isExecutorId } from "./executors.js";
import { PLATFORM_CATALOG, type PlatformId } from "./platforms.js";

export type ExecutorCapabilityDescriptor = {
  id: string;
  invocation: "spawn" | "hook_ingest" | "hybrid";
  supportsProfile: boolean;
  supportsStreaming: boolean;
  supportsCancel: boolean;
  supportsHookCompletion: boolean;
  progressEvents: "none" | "audit" | "human";
  approvalMode: "none" | "opentag_policy" | "executor_managed";
  contextAccess: Array<"context_packet" | "context_pointers" | "workspace">;
  promptAssembly: "opentag" | "executor_adapter" | "external_runtime";
  writeAccess: "none" | "workspace" | "external";
  conversationAccess: "none" | "request" | "thread_transcript";
  promptMutation: "none" | "append" | "replace";
  rawContextAccess: boolean;
  writeActionAccess: "none" | "propose" | "execute";
  workspaceIsolation: "none" | "branch" | "worktree" | "external";
  requiredSecrets: string[];
  completionSignals: Array<"process_exit" | "hook_event" | "stream_event">;
};

export const PLATFORM_CAPABILITIES: Record<PlatformId, PlatformCapabilityDescriptor> = OPEN_TAG_PLATFORM_CAPABILITIES;

export const EXECUTOR_CAPABILITIES: Record<ExecutorId, ExecutorCapabilityDescriptor> = {
  codex: {
    id: "codex",
    invocation: "spawn",
    supportsProfile: false,
    supportsStreaming: true,
    supportsCancel: true,
    supportsHookCompletion: false,
    progressEvents: "audit",
    approvalMode: "opentag_policy",
    contextAccess: ["context_packet", "context_pointers", "workspace"],
    promptAssembly: "opentag",
    writeAccess: "workspace",
    conversationAccess: "request",
    promptMutation: "none",
    rawContextAccess: false,
    writeActionAccess: "propose",
    workspaceIsolation: "worktree",
    requiredSecrets: [],
    completionSignals: ["stream_event"]
  },
  "claude-code": {
    id: "claude-code",
    invocation: "spawn",
    supportsProfile: false,
    supportsStreaming: true,
    supportsCancel: true,
    supportsHookCompletion: false,
    progressEvents: "audit",
    approvalMode: "opentag_policy",
    contextAccess: ["context_packet", "context_pointers", "workspace"],
    promptAssembly: "opentag",
    writeAccess: "workspace",
    conversationAccess: "request",
    promptMutation: "none",
    rawContextAccess: false,
    writeActionAccess: "propose",
    workspaceIsolation: "worktree",
    requiredSecrets: [],
    completionSignals: ["stream_event"]
  },
  cursor: {
    id: "cursor",
    invocation: "spawn",
    supportsProfile: false,
    supportsStreaming: true,
    supportsCancel: true,
    supportsHookCompletion: false,
    progressEvents: "audit",
    approvalMode: "opentag_policy",
    contextAccess: ["context_packet", "context_pointers", "workspace"],
    promptAssembly: "opentag",
    writeAccess: "workspace",
    conversationAccess: "request",
    promptMutation: "none",
    rawContextAccess: false,
    writeActionAccess: "propose",
    workspaceIsolation: "worktree",
    requiredSecrets: [],
    completionSignals: ["stream_event"]
  },
  opencode: {
    id: "opencode",
    invocation: "spawn",
    supportsProfile: false,
    supportsStreaming: true,
    supportsCancel: true,
    supportsHookCompletion: false,
    progressEvents: "audit",
    approvalMode: "opentag_policy",
    contextAccess: ["context_packet", "context_pointers", "workspace"],
    promptAssembly: "opentag",
    writeAccess: "workspace",
    conversationAccess: "request",
    promptMutation: "none",
    rawContextAccess: false,
    writeActionAccess: "propose",
    workspaceIsolation: "worktree",
    requiredSecrets: [],
    completionSignals: ["stream_event"]
  },
  hermes: {
    id: "hermes",
    invocation: "spawn",
    supportsProfile: true,
    supportsStreaming: true,
    supportsCancel: true,
    supportsHookCompletion: false,
    progressEvents: "audit",
    approvalMode: "opentag_policy",
    contextAccess: ["context_packet", "context_pointers", "workspace"],
    promptAssembly: "opentag",
    writeAccess: "workspace",
    conversationAccess: "request",
    promptMutation: "none",
    rawContextAccess: false,
    writeActionAccess: "propose",
    workspaceIsolation: "worktree",
    requiredSecrets: [],
    completionSignals: ["stream_event"]
  },
  echo: {
    id: "echo",
    invocation: "spawn",
    supportsProfile: false,
    supportsStreaming: false,
    supportsCancel: false,
    supportsHookCompletion: false,
    progressEvents: "audit",
    approvalMode: "opentag_policy",
    contextAccess: ["context_packet", "context_pointers"],
    promptAssembly: "opentag",
    writeAccess: "none",
    conversationAccess: "request",
    promptMutation: "none",
    rawContextAccess: false,
    writeActionAccess: "none",
    workspaceIsolation: "none",
    requiredSecrets: [],
    completionSignals: ["process_exit"]
  }
};

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

export function formatPlatformCapability(id: PlatformId): string {
  const descriptor = PLATFORM_CATALOG.find((platform) => platform.id === id);
  const capability = PLATFORM_CAPABILITIES[id];
  const label = descriptor?.label ?? id;
  return `${label}: events=${yesNo(capability.receivesEvents)}, replies=${yesNo(capability.repliesToSourceThread)}, status_updates=${yesNo(capability.supportsStatusUpdates)}, rich=${yesNo(capability.supportsRichPresentation)}, actions=${yesNo(capability.supportsActionReplies)}, explicit_addressing=${yesNo(capability.requiresExplicitAddressing)}, liveness=${capability.livenessStrategy}`;
}

export function formatExecutorCapability(id: string): string {
  const capability = isExecutorId(id) ? EXECUTOR_CAPABILITIES[id] : undefined;
  const label = EXECUTOR_CATALOG.find((executor) => executor.id === id)?.label ?? id;
  if (!capability) {
    return `${label}: custom executor, capability details unknown`;
  }
  const secrets = capability.requiredSecrets.length ? capability.requiredSecrets.join(",") : "none";
  const completion = capability.completionSignals.length ? capability.completionSignals.join(",") : "none";
  const context = capability.contextAccess.length ? capability.contextAccess.join(",") : "none";
  return `${label}: invocation=${capability.invocation}, profile=${yesNo(capability.supportsProfile)}, streaming=${yesNo(capability.supportsStreaming)}, cancel=${yesNo(capability.supportsCancel)}, hook_completion=${yesNo(capability.supportsHookCompletion)}, progress=${capability.progressEvents}, approval=${capability.approvalMode}, context=${context}, prompt=${capability.promptAssembly}, write=${capability.writeAccess}, conversation=${capability.conversationAccess}, prompt_mutation=${capability.promptMutation}, raw_context=${yesNo(capability.rawContextAccess)}, write_actions=${capability.writeActionAccess}, isolation=${capability.workspaceIsolation}, secrets=${secrets}, completion=${completion}`;
}

export function formatConfiguredCapabilities(input: { platforms: PlatformId[]; executors: string[] }): string[] {
  const platformLines = input.platforms.map((id) => `  platform ${formatPlatformCapability(id)}`);
  const uniqueExecutors = [...new Set(input.executors)];
  const executorLines = uniqueExecutors.map((id) => `  executor ${formatExecutorCapability(id)}`);
  return ["Capabilities:", ...(platformLines.length ? platformLines : ["  platform none"]), ...(executorLines.length ? executorLines : ["  executor none"])];
}
