import type { ContextPointer, OpenTagCommand, OpenTagRunResult, PermissionGrant } from "@opentag/core";

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
  permissions?: PermissionGrant[];
  baseBranch?: string;
  worktreeRoot?: string;
  keepWorktree?: "always" | "on_failure" | "never";
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
