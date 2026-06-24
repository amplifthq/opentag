import type { ContextPointer } from "@opentag/core";
import { assertCommandSucceeded, nodeCommandRunner, type CommandRunner } from "./command.js";
import type { ExecutorAdapter } from "./executor.js";
import {
  branchNameForRun,
  changedFiles,
  cleanupInternalArtifacts,
  commitRunChanges,
  createRunWorktree,
  removeRunWorktree,
  worktreePathForRun
} from "./git.js";

export type CodexExecutorOptions = {
  runner?: CommandRunner;
  codexCommand?: string;
  model?: string;
};

function contextLines(context: ContextPointer[]): string {
  if (!context.length) return "No additional context pointers were provided.";
  return context.map((pointer) => `- ${pointer.kind}: ${pointer.uri}`).join("\n");
}

function buildPrompt(input: {
  runId: string;
  rawText: string;
  context: ContextPointer[];
}): string {
  return [
    "You are executing an OpenTag run in a local checkout.",
    `Run ID: ${input.runId}`,
    "",
    "User request:",
    input.rawText,
    "",
    "Context pointers:",
    contextLines(input.context),
    "",
    "Work autonomously but keep the change narrow. Run relevant verification if you modify files. End with a concise summary."
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
      const branchName = branchNameForRun(input.runId);
      const baseBranch = input.baseBranch ?? "main";
      const keepWorktree = input.keepWorktree ?? "on_failure";
      const worktreePath = worktreePathForRun({
        workspacePath: input.workspacePath,
        runId: input.runId,
        ...(input.worktreeRoot ? { worktreeRoot: input.worktreeRoot } : {})
      });
      let completed = false;

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
          input: buildPrompt({
            runId: input.runId,
            rawText: input.command.rawText,
            context: input.context
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
        return {
          conclusion: "success",
          summary: output.slice(-4000),
          changedFiles: files,
          artifacts: [
            { title: "Run branch", uri: branchName },
            ...(keepWorktree === "always" ? [{ title: "Run worktree", uri: worktreePath }] : [])
          ],
          verification: [
            {
              command: "codex exec",
              outcome: "passed",
              excerpt: output.slice(-1000)
            }
          ],
          nextAction:
            files.length > 0
              ? keepWorktree === "always"
                ? "Review the local worktree or pull request branch."
                : "Review the local branch or pull request."
              : "No file changes were detected."
        };
      } finally {
        const shouldRemove =
          keepWorktree === "never" || (keepWorktree === "on_failure" && completed);
        if (shouldRemove) {
          try {
            await removeRunWorktree({ runner, workspacePath: input.workspacePath, worktreePath });
          } catch (error) {
            await sink.emit({
              type: "executor.progress",
              message: `Could not remove run worktree ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
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
