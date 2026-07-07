import { resolve } from "node:path";
import type { ContextPacket, ContextPointer, OpenTagCommand, PermissionGrant, ResultArtifact } from "@opentag/core";
import { assertCommandSucceeded, nodeCommandRunner, type CommandResult, type CommandRunner } from "./command.js";
import { type ExecutorAdapter, type ExecutorEventSink, type ExecutorRunInput } from "./executor.js";
import { EXECUTOR_REPORT_END, EXECUTOR_REPORT_START } from "./executor-report.js";
import {
  branchNameForRun,
  changedFiles,
  cleanupInternalArtifacts,
  commitRunChanges,
  createRunBranch,
  createRunWorktree,
  deleteRunBranch,
  removeRunWorktree,
  worktreePathForRun
} from "./git.js";
import { createExecutorRunResult } from "./result.js";

const SOURCE_CONTROL_FORBIDDEN_COMMANDS = ["git add", "git commit", "git push", "gh pr create"];

export type ProtocolExecutorCapabilities = {
  workspaceIsolation: "branch" | "worktree";
  conversationAccess: "none" | "request" | "thread_transcript";
  progressEvents: "none" | "audit" | "human";
  supportsCancel: boolean;
  supportsStreaming: boolean;
};

export type ProtocolExecutorManifestInput = {
  protocol: "opentag.executor.v1";
  id: string;
  label: string;
  transport: "stdio-jsonl";
  command: string;
  args?: string[];
  capabilities?: Partial<ProtocolExecutorCapabilities>;
};

export type ProtocolExecutorManifest = {
  protocol: "opentag.executor.v1";
  id: string;
  label: string;
  transport: "stdio-jsonl";
  command: string;
  args: string[];
  capabilities: ProtocolExecutorCapabilities;
};

export type ProtocolExecutorRunRequest = {
  protocol: "opentag.executor.v1";
  runId: string;
  workspace: {
    path: string;
    baseBranch: string;
    branchName: string;
    isolation: "branch" | "worktree";
  };
  session: {
    scope: "run";
    key: string;
  };
  command: OpenTagCommand;
  context: ContextPointer[];
  contextPacket?: ContextPacket;
  permissions: PermissionGrant[];
  metadata: Record<string, unknown>;
  sourceControl: {
    owner: "opentag";
    forbiddenCommands: string[];
  };
};

export type ProtocolExecutorVerification = {
  command?: string;
  outcome: "passed" | "failed" | "not_run";
  summary?: string;
};

type ProtocolBaseEvent = {
  message: string;
  at?: string;
};

export type ProtocolExecutorStartedEvent = ProtocolBaseEvent & {
  type: "started";
};

export type ProtocolExecutorProgressEvent = ProtocolBaseEvent & {
  type: "progress";
};

export type ProtocolExecutorCompletedEvent = ProtocolBaseEvent & {
  type: "completed";
  actualWorkspacePath: string;
  summary: string;
  verification: ProtocolExecutorVerification[];
  artifacts: ResultArtifact[];
  notes: string[];
  risks: string[];
};

export type ProtocolExecutorFailedEvent = ProtocolBaseEvent & {
  type: "failed";
  actualWorkspacePath?: string;
};

export type ProtocolExecutorEvent =
  | ProtocolExecutorStartedEvent
  | ProtocolExecutorProgressEvent
  | ProtocolExecutorCompletedEvent
  | ProtocolExecutorFailedEvent;

export type ProtocolExecutorOptions = {
  manifest: ProtocolExecutorManifestInput;
  runner?: CommandRunner;
};

export function defaultProtocolSessionKey(input: { executorId: string; runId: string }): string {
  const safeExecutorId = input.executorId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const safeRunId = input.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `opentag:${safeExecutorId}:${safeRunId}`;
}

function eventAt(event: ProtocolExecutorEvent): string {
  return event.at ?? new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeManifest(input: ProtocolExecutorManifestInput): ProtocolExecutorManifest {
  const capabilities = input.capabilities ?? {};
  return {
    protocol: input.protocol,
    id: input.id.trim(),
    label: input.label.trim(),
    transport: input.transport,
    command: input.command.trim(),
    args: input.args ?? [],
    capabilities: {
      workspaceIsolation: capabilities.workspaceIsolation ?? "worktree",
      conversationAccess: capabilities.conversationAccess ?? "request",
      progressEvents: capabilities.progressEvents ?? "audit",
      supportsCancel: capabilities.supportsCancel ?? false,
      supportsStreaming: capabilities.supportsStreaming ?? false
    }
  };
}

function assertValidManifest(manifest: ProtocolExecutorManifest): void {
  if (manifest.protocol !== "opentag.executor.v1") throw new Error("Protocol executor manifest must use opentag.executor.v1.");
  if (manifest.transport !== "stdio-jsonl") throw new Error("Protocol executor prototype only supports stdio-jsonl transport.");
  if (!manifest.id) throw new Error("Protocol executor manifest id must not be empty.");
  if (!manifest.label) throw new Error("Protocol executor manifest label must not be empty.");
  if (!manifest.command) throw new Error("Protocol executor manifest command must not be empty.");
}

function parseVerification(value: unknown): ProtocolExecutorVerification[] {
  if (!Array.isArray(value)) return [];
  const allowedOutcomes = new Set(["passed", "failed", "not_run"]);
  return value.flatMap((item) => {
    const record = asRecord(item);
    const outcome = record ? nonEmptyString(record["outcome"]) : undefined;
    if (!record || !outcome || !allowedOutcomes.has(outcome)) return [];
    const command = nonEmptyString(record["command"]);
    const summary = nonEmptyString(record["summary"]);
    return [
      {
        outcome: outcome as "passed" | "failed" | "not_run",
        ...(command ? { command } : {}),
        ...(summary ? { summary } : {})
      }
    ];
  });
}

function parseProtocolArtifacts(value: unknown): ResultArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const title = record ? nonEmptyString(record["title"]) : undefined;
    const uri = record ? nonEmptyString(record["uri"]) : undefined;
    if (!record || !title || !uri) return [];
    return [record as ResultArtifact];
  });
}

function parseProtocolEventValue(value: unknown, lineNumber: number): ProtocolExecutorEvent {
  const record = asRecord(value);
  const type = record ? nonEmptyString(record["type"]) : undefined;
  const message = record ? nonEmptyString(record["message"]) : undefined;
  if (!record || !type || !message) {
    throw new Error(`Protocol executor emitted invalid event at line ${lineNumber}: missing type or message.`);
  }
  const at = nonEmptyString(record["at"]);
  const base = { message, ...(at ? { at } : {}) };

  if (type === "started" || type === "progress") {
    return { type, ...base };
  }
  if (type === "failed") {
    const actualWorkspacePath = nonEmptyString(record["actualWorkspacePath"]);
    return { type, ...base, ...(actualWorkspacePath ? { actualWorkspacePath } : {}) };
  }
  if (type === "completed") {
    const actualWorkspacePath = nonEmptyString(record["actualWorkspacePath"]);
    const summary = nonEmptyString(record["summary"]);
    if (!actualWorkspacePath || !summary) {
      throw new Error(`Protocol executor emitted invalid completed event at line ${lineNumber}: missing actualWorkspacePath or summary.`);
    }
    return {
      type,
      ...base,
      actualWorkspacePath,
      summary,
      verification: parseVerification(record["verification"]),
      artifacts: parseProtocolArtifacts(record["artifacts"]),
      notes: stringArray(record["notes"]),
      risks: stringArray(record["risks"])
    };
  }

  throw new Error(`Protocol executor emitted invalid event at line ${lineNumber}: unknown type ${type}.`);
}

async function emitProtocolEvent(sink: ExecutorEventSink, event: ProtocolExecutorEvent): Promise<void> {
  if (event.type === "started") {
    await sink.emit({ type: "executor.started", message: event.message, at: eventAt(event) });
  }
  if (event.type === "progress") {
    await sink.emit({ type: "executor.progress", message: event.message, at: eventAt(event) });
  }
  if (event.type === "failed") {
    await sink.emit({ type: "executor.failed", message: event.message, at: eventAt(event) });
  }
}

function parseProtocolEvents(stdout: string): ProtocolExecutorEvent[] {
  const events: ProtocolExecutorEvent[] = [];
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Protocol executor emitted malformed JSONL on stdout at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    events.push(parseProtocolEventValue(parsed, index + 1));
  }

  return events;
}

function finalEvent(events: ProtocolExecutorEvent[]): ProtocolExecutorCompletedEvent | ProtocolExecutorFailedEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "completed" || event?.type === "failed") return event;
  }
  return undefined;
}

function assertActualWorkspace(input: { expected: string; actual: string; executorId: string }): void {
  const expected = resolve(input.expected);
  const actual = resolve(input.actual);
  if (actual !== expected) {
    throw new Error(
      `Protocol executor ${input.executorId} reported actual workspace ${actual}, expected ${expected}. Refusing to accept changes from an unbound workspace.`
    );
  }
}

function requestForRun(input: {
  run: ExecutorRunInput;
  manifest: ProtocolExecutorManifest;
  workspacePath: string;
  branchName: string;
  baseBranch: string;
}): ProtocolExecutorRunRequest {
  return {
    protocol: "opentag.executor.v1",
    runId: input.run.runId,
    workspace: {
      path: input.workspacePath,
      baseBranch: input.baseBranch,
      branchName: input.branchName,
      isolation: input.manifest.capabilities.workspaceIsolation
    },
    session: {
      scope: "run",
      key: defaultProtocolSessionKey({ executorId: input.manifest.id, runId: input.run.runId })
    },
    command: input.run.command,
    context: input.run.context,
    ...(input.run.contextPacket ? { contextPacket: input.run.contextPacket } : {}),
    permissions: input.run.permissions ?? [],
    metadata: input.run.metadata ?? {},
    sourceControl: {
      owner: "opentag",
      forbiddenCommands: SOURCE_CONTROL_FORBIDDEN_COMMANDS
    }
  };
}

function outputForCompletedEvent(input: { completed: ProtocolExecutorCompletedEvent; changedFiles: string[] }): string {
  return [
    input.completed.summary,
    "",
    EXECUTOR_REPORT_START,
    JSON.stringify(
      {
        changes: [
          { summary: input.completed.summary },
          ...input.changedFiles.map((file) => ({ file, summary: "Changed by protocol executor." }))
        ],
        verification: input.completed.verification,
        artifacts: input.completed.artifacts,
        risks: input.completed.risks,
        notes: input.completed.notes
      },
      null,
      2
    ),
    EXECUTOR_REPORT_END
  ].join("\n");
}

async function cleanupAfterChild(input: {
  runner: CommandRunner;
  workspacePath: string;
  sink: ExecutorEventSink;
  primaryError?: unknown;
}): Promise<void> {
  try {
    const cleanedArtifacts = await cleanupInternalArtifacts({ runner: input.runner, workspacePath: input.workspacePath });
    if (cleanedArtifacts.length > 0) {
      await input.sink.emit({
        type: "executor.progress",
        message: `Cleaned internal artifacts: ${cleanedArtifacts.join(", ")}`,
        at: new Date().toISOString()
      });
    }
  } catch (cleanupError) {
    if (!input.primaryError) throw cleanupError;
    await input.sink.emit({
      type: "executor.progress",
      message: `Failed to clean internal artifacts: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      at: new Date().toISOString()
    });
  }
}

async function createIsolation(input: {
  runner: CommandRunner;
  run: ExecutorRunInput;
  manifest: ProtocolExecutorManifest;
  branchName: string;
  baseBranch: string;
}): Promise<string> {
  if (input.manifest.capabilities.workspaceIsolation === "branch") {
    await createRunBranch({
      runner: input.runner,
      workspacePath: input.run.workspacePath,
      branchName: input.branchName,
      startPoint: input.baseBranch
    });
    return input.run.workspacePath;
  }

  const worktreePath = worktreePathForRun({
    workspacePath: input.run.workspacePath,
    runId: input.run.runId,
    ...(input.run.worktreeRoot ? { worktreeRoot: input.run.worktreeRoot } : {})
  });
  await createRunWorktree({
    runner: input.runner,
    workspacePath: input.run.workspacePath,
    worktreePath,
    branchName: input.branchName,
    baseBranch: input.baseBranch
  });
  return worktreePath;
}

async function maybeRemoveIsolation(input: {
  runner: CommandRunner;
  run: ExecutorRunInput;
  manifest: ProtocolExecutorManifest;
  workspacePath: string;
  branchName: string;
  completed: boolean;
  changedFileCount: number | undefined;
  sink: ExecutorEventSink;
}): Promise<void> {
  if (input.manifest.capabilities.workspaceIsolation !== "worktree") return;
  const keepWorktree = input.run.keepWorktree ?? "on_failure";
  const shouldRemove = keepWorktree === "never" || (keepWorktree === "on_failure" && input.completed);
  if (!shouldRemove) return;

  try {
    await removeRunWorktree({ runner: input.runner, workspacePath: input.run.workspacePath, worktreePath: input.workspacePath });
    if (input.completed && input.changedFileCount === 0) {
      await deleteRunBranch({ runner: input.runner, workspacePath: input.run.workspacePath, branchName: input.branchName });
    }
  } catch (error) {
    await input.sink.emit({
      type: "executor.progress",
      message: `Could not clean up protocol executor worktree or branch for ${input.workspacePath}: ${error instanceof Error ? error.message : String(error)}`,
      at: new Date().toISOString()
    });
  }
}

function childFailure(input: { manifest: ProtocolExecutorManifest; result: CommandResult }): Error | undefined {
  if (input.result.exitCode === 0) return undefined;
  return new Error(`protocol executor ${input.manifest.id} failed with exit code ${input.result.exitCode}: ${input.result.stderr || input.result.stdout}`);
}

export function createProtocolExecutor(options: ProtocolExecutorOptions): ExecutorAdapter {
  const manifest = normalizeManifest(options.manifest);
  assertValidManifest(manifest);
  const runner = options.runner ?? nodeCommandRunner;

  return {
    id: manifest.id,
    displayName: manifest.label,
    capability: {
      id: manifest.id,
      invocation: "spawn",
      supportsProfile: false,
      supportsStreaming: manifest.capabilities.supportsStreaming,
      supportsCancel: manifest.capabilities.supportsCancel,
      supportsHookCompletion: false,
      progressEvents: manifest.capabilities.progressEvents,
      approvalMode: "opentag_policy",
      contextAccess: ["context_packet", "context_pointers", "workspace"],
      promptAssembly: "opentag",
      writeAccess: "workspace",
      conversationAccess: manifest.capabilities.conversationAccess,
      promptMutation: "none",
      rawContextAccess: false,
      writeActionAccess: "none",
      workspaceIsolation: manifest.capabilities.workspaceIsolation,
      requiredSecrets: [],
      completionSignals: [
        {
          type: "process_exit",
          required: true,
          description: "OpenTag treats the stdio-jsonl child process exit and a final protocol event as the completion signal."
        }
      ]
    },
    async canRun(input) {
      const gitRepo = await runner.run("git", ["rev-parse", "--show-toplevel"], { cwd: input.workspacePath });
      if (gitRepo.exitCode !== 0) {
        return { ready: false, reason: `Workspace is not a git checkout: ${gitRepo.stderr || gitRepo.stdout}` };
      }
      const baseBranch = input.baseBranch ?? "main";
      const baseRef = await runner.run("git", ["rev-parse", "--verify", `${baseBranch}^{commit}`], {
        cwd: input.workspacePath
      });
      if (baseRef.exitCode !== 0) {
        return { ready: false, reason: `Base branch '${baseBranch}' is not available: ${baseRef.stderr || baseRef.stdout}` };
      }
      return { ready: true };
    },
    async run(input, sink) {
      const branchName = branchNameForRun(input.runId);
      const baseBranch = input.baseBranch ?? "main";
      let completed = false;
      let changedFileCount: number | undefined;
      let workspacePath = input.workspacePath;

      await sink.emit({
        type: "executor.started",
        message: `Creating protocol executor ${manifest.capabilities.workspaceIsolation} isolation ${branchName}`,
        at: new Date().toISOString()
      });

      try {
        workspacePath = await createIsolation({ runner, run: input, manifest, branchName, baseBranch });
        const request = requestForRun({ run: input, manifest, workspacePath, branchName, baseBranch });
        const childResult = await runner.run(manifest.command, manifest.args, {
          cwd: workspacePath,
          input: `${JSON.stringify(request)}\n`
        });

        let primaryError: unknown = childFailure({ manifest, result: childResult });
        let events: ProtocolExecutorEvent[] = [];
        if (!primaryError) {
          try {
            events = parseProtocolEvents(childResult.stdout);
          } catch (error) {
            primaryError = error;
          }
        }

        if (!primaryError) {
          for (const event of events) {
            await emitProtocolEvent(sink, event);
          }
          const final = finalEvent(events);
          if (!final) {
            primaryError = new Error(`Protocol executor ${manifest.id} exited without a completed or failed event.`);
          } else if (final.type === "failed") {
            primaryError = new Error(`Protocol executor ${manifest.id} failed: ${final.message}`);
          } else {
            try {
              assertActualWorkspace({ expected: workspacePath, actual: final.actualWorkspacePath, executorId: manifest.id });
            } catch (error) {
              primaryError = error;
            }
          }
        }

        await cleanupAfterChild({ runner, workspacePath, sink, ...(primaryError ? { primaryError } : {}) });
        if (primaryError) throw primaryError;

        const completedEvent = finalEvent(events);
        if (!completedEvent || completedEvent.type !== "completed") {
          throw new Error(`Protocol executor ${manifest.id} exited without a completed event.`);
        }

        const files = await changedFiles({ runner, workspacePath });
        changedFileCount = files.length;
        if (files.length > 0) {
          await sink.emit({
            type: "executor.progress",
            message: `Committing ${files.length} changed file(s) to ${branchName}`,
            at: new Date().toISOString()
          });
          await commitRunChanges({
            runner,
            workspacePath,
            message: `OpenTag run ${input.runId}`
          });
        }
        completed = true;

        await sink.emit({
          type: "executor.completed",
          message: `Protocol executor ${manifest.id} completed with ${files.length} changed file(s)`,
          at: new Date().toISOString()
        });

        return createExecutorRunResult({
          executorName: manifest.label,
          runId: input.runId,
          branchName,
          baseBranch,
          output: outputForCompletedEvent({ completed: completedEvent, changedFiles: files }),
          changedFiles: files
        });
      } finally {
        await maybeRemoveIsolation({
          runner,
          run: input,
          manifest,
          workspacePath,
          branchName,
          completed,
          changedFileCount,
          sink
        });
      }
    },
    async cancel() {
      return;
    }
  };
}
