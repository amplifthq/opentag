import { contextPointerLabel, type ContextPacket, type ContextPointer } from "@opentag/core";
import { assertCommandSucceeded, nodeCommandRunner, type CommandResult, type CommandRunner } from "./command.js";
import { executorPolicyPromptLines } from "./executor-report.js";
import { renderContextPacketForPrompt, type ExecutorAdapter } from "./executor.js";
import { branchNameForRun, changedFiles, cleanupInternalArtifacts, createRunBranch } from "./git.js";
import { createExecutorRunResult } from "./result.js";

export type OpenclawExecutorOptions = {
  runner?: CommandRunner;
  openclawCommand?: string;
  agent?: string;
  sessionKey?: string;
};

const DEFAULT_OPENCLAW_AGENT = "main";
const DEFAULT_OPENCLAW_SESSION_KEY = "opentag";

function contextLines(context: ContextPointer[]): string {
  if (!context.length) return "No additional context pointers were provided.";
  return context.map((pointer) => `- ${contextPointerLabel(pointer)}: ${pointer.uri}`).join("\n");
}

function buildPrompt(input: {
  runId: string;
  rawText: string;
  context: ContextPointer[];
  contextPacket: ContextPacket | undefined;
}): string {
  return [
    "You are executing an OpenTag run in a local checkout.",
    `Run ID: ${input.runId}`,
    "",
    "User request:",
    input.rawText,
    "",
    ...renderContextPacketForPrompt(input.contextPacket),
    ...(input.contextPacket ? [""] : []),
    "Context pointers:",
    contextLines(input.context),
    "",
    ...executorPolicyPromptLines()
  ].join("\n");
}

export function createOpenclawExecutor(options: OpenclawExecutorOptions = {}): ExecutorAdapter {
  const runner = options.runner ?? nodeCommandRunner;
  const openclawCommand = options.openclawCommand ?? "openclaw";
  const openclawAgent = options.agent ?? DEFAULT_OPENCLAW_AGENT;
  const openclawSessionKey = options.sessionKey ?? DEFAULT_OPENCLAW_SESSION_KEY;

  return {
    id: "openclaw",
    displayName: "OpenClaw Executor",
    capability: {
      id: "openclaw",
      invocation: "spawn",
      supportsProfile: false,
      supportsStreaming: false,
      supportsCancel: false,
      supportsHookCompletion: false,
      progressEvents: "audit",
      approvalMode: "opentag_policy",
      contextAccess: ["context_packet", "context_pointers", "workspace"],
      promptAssembly: "executor_adapter",
      writeAccess: "workspace",
      conversationAccess: "request",
      promptMutation: "none",
      rawContextAccess: false,
      writeActionAccess: "none",
      workspaceIsolation: "branch",
      requiredSecrets: [],
      completionSignals: [
        {
          type: "process_exit",
          required: true,
          description: "OpenTag treats a successful `openclaw agent` process exit as the normal completion signal."
        }
      ]
    },
    async canRun(input) {
      try {
        const openclawVersion = await runner.run(openclawCommand, ["--version"], { cwd: input.workspacePath });
        if (openclawVersion.exitCode !== 0) {
          return { ready: false, reason: `OpenClaw CLI is not available: ${openclawVersion.stderr || openclawVersion.stdout}` };
        }
      } catch (error) {
        return { ready: false, reason: `OpenClaw CLI is not available: ${error instanceof Error ? error.message : String(error)}` };
      }

      let gitStatus: CommandResult;
      try {
        gitStatus = await runner.run("git", ["status", "--porcelain"], { cwd: input.workspacePath });
      } catch (error) {
        return { ready: false, reason: `Workspace is not a git checkout: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (gitStatus.exitCode !== 0) {
        return { ready: false, reason: `Workspace is not a git checkout: ${gitStatus.stderr || gitStatus.stdout}` };
      }
      if (gitStatus.stdout.trim().length > 0) {
        return { ready: false, reason: "Workspace has uncommitted changes; refusing to run OpenClaw executor." };
      }

      return { ready: true };
    },
    async run(input, sink) {
      const branchName = branchNameForRun(input.runId);
      await sink.emit({
        type: "executor.started",
        message: `Creating isolated branch ${branchName}`,
        at: new Date().toISOString()
      });

      await createRunBranch({
        runner,
        workspacePath: input.workspacePath,
        branchName,
        ...(input.baseBranch ? { startPoint: input.baseBranch } : {})
      });

      await sink.emit({
        type: "executor.progress",
        message: "Starting openclaw agent",
        at: new Date().toISOString()
      });

      const prompt = buildPrompt({
        runId: input.runId,
        rawText: input.command.rawText,
        context: input.context,
        contextPacket: input.contextPacket
      });

      const args = ["agent", "-m", prompt, "--agent", openclawAgent, "--session-key", openclawSessionKey];

      let openclawResult: CommandResult | undefined;
      try {
        openclawResult = await runner.run(openclawCommand, args, { cwd: input.workspacePath });
        await assertCommandSucceeded(openclawResult, "openclaw agent");
      } finally {
        const cleanedArtifacts = await cleanupInternalArtifacts({ runner, workspacePath: input.workspacePath });
        if (cleanedArtifacts.length > 0) {
          await sink.emit({
            type: "executor.progress",
            message: `Cleaned internal artifacts: ${cleanedArtifacts.join(", ")}`,
            at: new Date().toISOString()
          });
        }
      }

      if (!openclawResult) throw new Error("OpenClaw did not return a result.");

      const files = await changedFiles({ runner, workspacePath: input.workspacePath });
      await sink.emit({
        type: "executor.completed",
        message: `OpenClaw executor completed with ${files.length} changed file(s)`,
        at: new Date().toISOString()
      });

      const output = openclawResult.stdout.trim() || openclawResult.stderr.trim() || "OpenClaw completed without textual output.";
      return createExecutorRunResult({
        executorName: "OpenClaw",
        runId: input.runId,
        branchName,
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        output,
        changedFiles: files
      });
    },
    async cancel() {
      return;
    }
  };
}
