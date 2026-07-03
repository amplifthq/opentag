import type { ExecutorAdapter } from "./executor.js";

function nowIso(): string {
  return new Date().toISOString();
}

export function createEchoExecutor(): ExecutorAdapter {
  return {
    id: "echo",
    displayName: "Echo Executor",
    capability: {
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
      completionSignals: [
        {
          type: "process_exit",
          required: true,
          description: "The in-process echo executor returns a structured result immediately."
        }
      ]
    },
    async canRun() {
      return { ready: true };
    },
    async run(input, sink) {
      const completedAt = nowIso();
      await sink.emit({
        type: "executor.started",
        message: `Echo executor started for ${input.runId}`,
        at: nowIso()
      });
      await sink.emit({
        type: "executor.completed",
        message: `Echo executor completed for ${input.runId}`,
        at: completedAt
      });
      return {
        conclusion: "success",
        summary: `Echoed OpenTag command: ${input.command.rawText}`,
        artifacts: [
          {
            id: `${input.runId}:echo-diagnosis-report`,
            type: "diagnosis_report",
            kind: "report",
            title: "Echo diagnosis report",
            uri: `opentag://run/${encodeURIComponent(input.runId)}/echo-report`,
            summary: `Echo executor validated the governed loop for: ${input.command.rawText}`,
            sourceRunId: input.runId,
            createdAt: completedAt,
            metadata: {
              executor: "echo",
              command: input.command.rawText,
              contextPointerCount: input.context.length,
              hasContextPacket: Boolean(input.contextPacket)
            }
          }
        ],
        verification: [
          {
            command: "echo",
            outcome: "passed",
            excerpt: input.command.rawText
          }
        ],
        nextAction: {
          summary: "No external state change is suggested for the echo executor result.",
          hint: { kind: "none" }
        }
      };
    },
    async cancel() {
      return;
    }
  };
}
