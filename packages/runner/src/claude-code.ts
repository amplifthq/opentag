import { contextPointerLabel, type ContextPacket, type ContextPointer } from "@opentag/core";
import { assertCommandSucceeded, nodeCommandRunner, type CommandRunner } from "./command.js";
import { renderContextPacketForPrompt, type ExecutorAdapter } from "./executor.js";
import { branchNameForRun, changedFiles, cleanupInternalArtifacts, createRunBranch } from "./git.js";
import { createExecutorRunResult } from "./result.js";

export type ClaudeCodeExecutorOptions = {
  runner?: CommandRunner;
  claudeCommand?: string;
  model?: string;
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "plan";
  dangerouslySkipPermissions?: boolean;
};

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
    "Work autonomously but keep the change narrow. Run relevant verification if you modify files.",
    "End with a concise summary of what changed, what was verified, and the recommended next action."
  ].join("\n");
}

export function createClaudeCodeExecutor(options: ClaudeCodeExecutorOptions = {}): ExecutorAdapter {
  const runner = options.runner ?? nodeCommandRunner;
  const claudeCommand = options.claudeCommand ?? "claude";

  return {
    id: "claude-code",
    displayName: "Claude Code Executor",
    async canRun(input) {
      try {
        const claudeVersion = await runner.run(claudeCommand, ["--version"], { cwd: input.workspacePath });
        if (claudeVersion.exitCode !== 0) {
          return { ready: false, reason: `Claude Code CLI is not available: ${claudeVersion.stderr || claudeVersion.stdout}` };
        }
      } catch (error) {
        return { ready: false, reason: `Claude Code CLI is not available: ${error instanceof Error ? error.message : String(error)}` };
      }
      const gitStatus = await runner.run("git", ["status", "--porcelain"], { cwd: input.workspacePath });
      if (gitStatus.exitCode !== 0) {
        return { ready: false, reason: `Workspace is not a git checkout: ${gitStatus.stderr || gitStatus.stdout}` };
      }
      if (gitStatus.stdout.trim().length > 0) {
        return { ready: false, reason: "Workspace has uncommitted changes; refusing to run Claude Code executor." };
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
        message: "Starting claude --print",
        at: new Date().toISOString()
      });

      const args = [
        "--print",
        "--input-format",
        "text",
        "--output-format",
        "text",
        "--no-session-persistence",
        ...(options.model ? ["--model", options.model] : []),
        ...(options.permissionMode ? ["--permission-mode", options.permissionMode] : []),
        ...(options.dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : [])
      ];
      const claudeResult = await runner.run(claudeCommand, args, {
        cwd: input.workspacePath,
        input: buildPrompt({
          runId: input.runId,
          rawText: input.command.rawText,
          context: input.context,
          contextPacket: input.contextPacket
        })
      });
      await assertCommandSucceeded(claudeResult, "claude --print");

      const cleanedArtifacts = await cleanupInternalArtifacts({ runner, workspacePath: input.workspacePath });
      if (cleanedArtifacts.length > 0) {
        await sink.emit({
          type: "executor.progress",
          message: `Cleaned internal artifacts: ${cleanedArtifacts.join(", ")}`,
          at: new Date().toISOString()
        });
      }

      const files = await changedFiles({ runner, workspacePath: input.workspacePath });
      await sink.emit({
        type: "executor.completed",
        message: `Claude Code executor completed with ${files.length} changed file(s)`,
        at: new Date().toISOString()
      });

      const output = claudeResult.stdout.trim() || claudeResult.stderr.trim() || "Claude Code completed without textual output.";
      return createExecutorRunResult({
        executorName: "Claude Code",
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
