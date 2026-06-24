import type { ContextPointer, OpenTagCommand, OpenTagRunResult } from "@opentag/core";

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
  baseBranch?: string;
  worktreeRoot?: string;
  keepWorktree?: "always" | "on_failure" | "never";
  command: OpenTagCommand;
  context: ContextPointer[];
};

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
