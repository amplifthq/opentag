import { resolve } from "node:path";
import type {
  OpenTagExecutorCompletedEvent,
  OpenTagExecutorFailedEvent,
  OpenTagExecutorIntegrationRoleInput,
  OpenTagExecutorProtocolCapabilities,
  OpenTagExecutorProtocolEvent,
  OpenTagExecutorProtocolVerification,
  OpenTagExecutorRunRequest,
  OpenTagIntegrationManifestInput,
  OpenTagStdioJsonlBindingInput,
  OpenTagStdioJsonlBinding
} from "@opentag/core";
import {
  OpenTagExecutorProtocolEventSchema,
  OpenTagExecutorRunRequestSchema,
  OpenTagIntegrationManifestSchema
} from "@opentag/core";
import { nodeCommandRunner, type CommandEnvironment, type CommandResult, type CommandRunner } from "./command.js";
import { type ExecutorAdapter, type ExecutorEventSink, type ExecutorRunInput } from "./executor.js";
import { EXECUTOR_REPORT_END, EXECUTOR_REPORT_START } from "./executor-report.js";
import {
  branchNameForRun,
  changedFiles,
  cleanupInternalArtifacts,
  commitRunChanges,
  createRunWorktree,
  deleteRunBranch,
  removeRunWorktree,
  worktreePathForRun
} from "./git.js";
import { createExecutorRunResult } from "./result.js";
import { scrubEnvironment } from "./security.js";

const SOURCE_CONTROL_FORBIDDEN_COMMANDS = ["git add", "git commit", "git push", "gh pr create"];

export type ProtocolExecutorStdioJsonlBindingInput = OpenTagStdioJsonlBindingInput;
export type ProtocolExecutorRoleInput = OpenTagExecutorIntegrationRoleInput;
export type ProtocolExecutorManifestInput = OpenTagIntegrationManifestInput;
export type ProtocolExecutorCapabilities = OpenTagExecutorProtocolCapabilities;
export type ProtocolExecutorStdioJsonlBinding = OpenTagStdioJsonlBinding;

export type ProtocolExecutorManifest = {
  protocol: "opentag.integration.v1";
  id: string;
  label: string;
  profile: "stdio-jsonl-basic";
  bindingName: string;
  binding: ProtocolExecutorStdioJsonlBinding;
  capabilities: ProtocolExecutorCapabilities;
};

export type ProtocolExecutorRunRequest = OpenTagExecutorRunRequest;
export type ProtocolExecutorVerification = OpenTagExecutorProtocolVerification;
export type ProtocolExecutorCompletedEvent = OpenTagExecutorCompletedEvent;
export type ProtocolExecutorFailedEvent = OpenTagExecutorFailedEvent;
export type ProtocolExecutorEvent = OpenTagExecutorProtocolEvent;

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

function normalizeManifest(input: ProtocolExecutorManifestInput): ProtocolExecutorManifest {
  const parsed = OpenTagIntegrationManifestSchema.parse(input);
  const executor = parsed.roles.executor;
  if (!executor) {
    throw new Error("Protocol executor manifest must declare roles.executor.");
  }
  const bindingName = executor.binding;
  const binding = parsed.bindings[bindingName];
  if (!binding) throw new Error(`Protocol executor role references missing binding '${bindingName}'.`);
  return {
    protocol: parsed.protocol,
    id: parsed.id,
    label: parsed.label,
    profile: executor.profile,
    bindingName,
    binding,
    capabilities: executor.capabilities
  };
}

function parseProtocolEventValue(value: unknown, lineNumber: number): ProtocolExecutorEvent {
  try {
    return OpenTagExecutorProtocolEventSchema.parse(value);
  } catch (error) {
    throw new Error(
      `Protocol executor emitted invalid event at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
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
  return OpenTagExecutorRunRequestSchema.parse({
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
    ...(input.run.source ? { source: input.run.source } : {}),
    ...(input.run.targets ? { targets: input.run.targets } : {}),
    replyTo: input.run.replyTo ?? [],
    context: input.run.context,
    ...(input.run.contextPacket ? { contextPacket: input.run.contextPacket } : {}),
    permissions: input.run.permissions ?? [],
    metadata: input.run.metadata ?? {},
    sourceControl: {
      owner: "opentag",
      forbiddenCommands: SOURCE_CONTROL_FORBIDDEN_COMMANDS
    }
  });
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
  branchName: string;
  baseBranch: string;
}): Promise<string> {
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
  workspacePath: string;
  branchName: string;
  completed: boolean;
  changedFileCount: number | undefined;
  sink: ExecutorEventSink;
}): Promise<void> {
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

function envForBinding(binding: ProtocolExecutorStdioJsonlBinding): CommandEnvironment {
  return { ...scrubEnvironment(), ...binding.env };
}

export function createProtocolExecutor(options: ProtocolExecutorOptions): ExecutorAdapter {
  const manifest = normalizeManifest(options.manifest);
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
        workspacePath = await createIsolation({ runner, run: input, branchName, baseBranch });
        const request = requestForRun({ run: input, manifest, workspacePath, branchName, baseBranch });
        const childResult = await runner.run(manifest.binding.command, manifest.binding.args, {
          cwd: manifest.binding.cwd ?? workspacePath,
          input: `${JSON.stringify(request)}\n`,
          env: envForBinding(manifest.binding)
        });

        let primaryError: unknown = childFailure({ manifest, result: childResult });
        let events: ProtocolExecutorEvent[] = [];
        let eventParseError: unknown;
        try {
          events = parseProtocolEvents(childResult.stdout);
        } catch (error) {
          eventParseError = error;
        }

        for (const event of events) {
          await emitProtocolEvent(sink, event);
        }
        primaryError ??= eventParseError;

        if (!primaryError) {
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

        await cleanupAfterChild({ runner, workspacePath, sink });
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
