import type { ContextPointer } from "@opentag/core";
import { assertCommandSucceeded, nodeCommandRunner, type CommandRunner } from "./command.js";
import type { ExecutorAdapter } from "./executor.js";
import { branchNameForRun, changedFiles, cleanupInternalArtifacts, createRunBranch } from "./git.js";

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
      const gitStatus = await runner.run("git", ["status", "--porcelain"], { cwd: input.workspacePath });
      if (gitStatus.exitCode !== 0) {
        return { ready: false, reason: `Workspace is not a git checkout: ${gitStatus.stderr || gitStatus.stdout}` };
      }
      if (gitStatus.stdout.trim().length > 0) {
        return { ready: false, reason: "Workspace has uncommitted changes; refusing to run Codex executor." };
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
      await createRunBranch({ runner, workspacePath: input.workspacePath, branchName });

      await sink.emit({
        type: "executor.progress",
        message: "Starting codex exec",
        at: new Date().toISOString()
      });

      const args = [
        "exec",
        "--cd",
        input.workspacePath,
        "--full-auto",
        "--ephemeral",
        ...(options.model ? ["--model", options.model] : []),
        "-"
      ];
      const codexResult = await runner.run(codexCommand, args, {
        cwd: input.workspacePath,
        input: buildPrompt({
          runId: input.runId,
          rawText: input.command.rawText,
          context: input.context
        })
      });
      await assertCommandSucceeded(codexResult, "codex exec");

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
        message: `Codex executor completed with ${files.length} changed file(s)`,
        at: new Date().toISOString()
      });

      const output = codexResult.stdout.trim() || codexResult.stderr.trim() || "Codex completed without textual output.";
      return {
        conclusion: "success",
        summary: output.slice(-4000),
        changedFiles: files,
        artifacts: [{ title: "Run branch", uri: branchName }],
        verification: [
          {
            command: "codex exec",
            outcome: "passed",
            excerpt: output.slice(-1000)
          }
        ],
        nextAction: files.length > 0 ? "Review the local branch and create a pull request." : "No file changes were detected."
      };
    },
    async cancel() {
      return;
    }
  };
}
