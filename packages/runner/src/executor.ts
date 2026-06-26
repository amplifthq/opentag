import { contextPointerLabel, type ContextPacket, type ContextPointer, type OpenTagCommand, type OpenTagRunResult, type PermissionGrant } from "@opentag/core";

export type ExecutorEvent = {
  type: "executor.started" | "executor.progress" | "executor.completed" | "executor.failed";
  message: string;
  at: string;
};

export type ExecutorEventSink = {
  emit(event: ExecutorEvent): Promise<void>;
};

export type ExecutorRunInput = {
  runId: string;
  workspacePath: string;
  command: OpenTagCommand;
  context: ContextPointer[];
  contextPacket?: ContextPacket;
  permissions?: PermissionGrant[];
  baseBranch?: string;
  worktreeRoot?: string;
  keepWorktree?: "always" | "on_failure" | "never";
};

export function renderContextPacketForPrompt(packet?: ContextPacket): string[] {
  if (!packet) return [];

  const lines = ["OpenTag context packet:", `- summary: ${packet.summary}`];

  if (packet.intent) {
    lines.push(`- intent: ${packet.intent.normalizedIntent}`);
    lines.push(`- requested by: ${packet.intent.requestedBy.provider}:${packet.intent.requestedBy.providerUserId}`);
  }

  if (packet.sources?.length) {
    lines.push("- selected sources:");
    for (const source of packet.sources) {
      lines.push(`  - [${source.role}] ${contextPointerLabel(source.pointer)}: ${source.pointer.uri}`);
      lines.push(`    reason: ${source.reason}`);
    }
  }

  if (packet.facts?.length) {
    lines.push("- facts:");
    for (const fact of packet.facts) {
      lines.push(`  - ${fact.text}`);
    }
  }

  if (packet.exclusions?.length) {
    lines.push("- exclusions:");
    for (const exclusion of packet.exclusions) {
      lines.push(`  - ${exclusion}`);
    }
  }

  return lines;
}

export type ExecutorReadiness = {
  ready: boolean;
  reason?: string;
};

export type ExecutorAdapter = {
  id: string;
  displayName: string;
  canRun(input: ExecutorRunInput): Promise<ExecutorReadiness>;
  run(input: ExecutorRunInput, sink: ExecutorEventSink): Promise<OpenTagRunResult>;
  cancel(runId: string): Promise<void>;
};
