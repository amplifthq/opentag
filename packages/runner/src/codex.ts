import { contextPointerLabel, type ContextPacket, type ContextPointer } from "@opentag/core";
import { assertCommandSucceeded, nodeCommandRunner, type CommandRunner } from "./command.js";
import { executorReportPromptLines } from "./executor-report.js";
import { renderContextPacketForPrompt, type ExecutorAdapter } from "./executor.js";
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
import { assessRunnerSecurity, formatSecurityAssessment, scrubEnvironment, type RunnerSecurityPolicy } from "./security.js";

export type CodexExecutorOptions = {
  runner?: CommandRunner;
  codexCommand?: string;
  model?: string;
  security?: RunnerSecurityPolicy;
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
    "OpenTag owns the source-control handoff after you finish.",
    "Do not run, request, or recommend git add, git commit, git push, or gh pr create.",
    "Do not ask the user to approve local source-control commands; summarize file changes and verification only.",
    "OpenTag will publish the run branch and expose pull-request creation as a suggested action.",
    ...executorReportPromptLines()
  ].join("\n");
}

export function createCodexExecutor(options: CodexExecutorOptions = {}): ExecutorAdapter {
  const runner = options.runner ?? nodeCommandRunner;
  const codexCommand = options.codexCommand ?? "codex";

  return {
    id: "codex",
    displayName: "Codex Executor",
    async canRun(input) {
      const codexVersion = await runner.run(codexCommand, ["--version"], { cwd: input.workspacePath });
      if (codexVersion.exitCode !== 0) {
        return { ready: false, reason: `Codex CLI is not available: ${codexVersion.stderr || codexVersion.stdout}` };
      }
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
      const security = options.security;
      const worktreePath = worktreePathForRun({
        workspacePath: input.workspacePath,
        runId: input.runId,
        ...(input.worktreeRoot ? { worktreeRoot: input.worktreeRoot } : {})
      });
      const assessment = assessRunnerSecurity({
        executorId: "codex",
        workspacePath: input.workspacePath,
        executionPath: worktreePath,
        command: input.command,
        context: input.context,
        ...(input.permissions ? { permissions: input.permissions } : {}),
        ...(security ? { policy: security } : {})
      });
      if (assessment.findings.length > 0) {
        await sink.emit({
          type: assessment.allowed ? "executor.progress" : "executor.failed",
          message: formatSecurityAssessment(assessment),
          at: new Date().toISOString()
        });
      }
      if (!assessment.allowed) {
        return {
          conclusion: "needs_human",
          summary: formatSecurityAssessment(assessment),
          nextAction: "Review the request and rerun with a narrower prompt or an explicit local policy override if appropriate."
        };
      }

      const branchName = branchNameForRun(input.runId);
      const baseBranch = input.baseBranch ?? "main";
      const keepWorktree = input.keepWorktree ?? "on_failure";
      let completed = false;
      let changedFileCount: number | undefined;

      await sink.emit({
        type: "executor.started",
        message: `Creating isolated worktree ${worktreePath} on ${branchName}`,
        at: new Date().toISOString()
      });
      try {
        await createRunWorktree({
          runner,
          workspacePath: input.workspacePath,
          worktreePath,
          branchName,
          baseBranch
        });

        await sink.emit({
          type: "executor.progress",
          message: "Starting codex exec",
          at: new Date().toISOString()
        });

        const args = [
          "exec",
          "--cd",
          worktreePath,
          "--full-auto",
          "--ephemeral",
          ...(options.model ? ["--model", options.model] : []),
          "-"
        ];
        const codexResult = await runner.run(codexCommand, args, {
          cwd: worktreePath,
          env: scrubEnvironment(undefined, security),
          input: buildPrompt({
            runId: input.runId,
            rawText: input.command.rawText,
            context: input.context,
            contextPacket: input.contextPacket
          })
        });
        await assertCommandSucceeded(codexResult, "codex exec");

        const cleanedArtifacts = await cleanupInternalArtifacts({ runner, workspacePath: worktreePath });
        if (cleanedArtifacts.length > 0) {
          await sink.emit({
            type: "executor.progress",
            message: `Cleaned internal artifacts: ${cleanedArtifacts.join(", ")}`,
            at: new Date().toISOString()
          });
        }

        const files = await changedFiles({ runner, workspacePath: worktreePath });
        changedFileCount = files.length;
        if (files.length > 0) {
          await sink.emit({
            type: "executor.progress",
            message: `Committing ${files.length} changed file(s) to ${branchName}`,
            at: new Date().toISOString()
          });
          await commitRunChanges({
            runner,
            workspacePath: worktreePath,
            message: `OpenTag run ${input.runId}`
          });
        }
        completed = true;

        await sink.emit({
          type: "executor.completed",
          message: `Codex executor completed with ${files.length} changed file(s)`,
          at: new Date().toISOString()
        });

        const output = codexResult.stdout.trim() || codexResult.stderr.trim() || "Codex completed without textual output.";
        return createExecutorRunResult({
          executorName: "Codex",
          runId: input.runId,
          branchName,
          ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
          output,
          changedFiles: files,
          extraArtifacts: keepWorktree === "always" ? [{ title: "Run worktree", uri: worktreePath }] : []
        });
      } finally {
        const shouldRemove = keepWorktree === "never" || (keepWorktree === "on_failure" && completed);
        if (shouldRemove) {
          try {
            await removeRunWorktree({ runner, workspacePath: input.workspacePath, worktreePath });
            if (completed && changedFileCount === 0) {
              await deleteRunBranch({ runner, workspacePath: input.workspacePath, branchName });
            }
          } catch (error) {
            await sink.emit({
              type: "executor.progress",
              message: `Could not clean up run worktree or branch for ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
              at: new Date().toISOString()
            });
          }
        }
      }
    },
    async cancel() {
      return;
    }
  };
}
