import { contextPointerLabel, type ContextPacket, type ContextPointer } from "@opentag/core";
import { assertCommandSucceeded, nodeCommandRunner, type CommandRunner } from "./command.js";
import { executorPolicyPromptLines } from "./executor-report.js";
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

export type ClaudeCodeExecutorOptions = {
  runner?: CommandRunner;
  claudeCommand?: string;
  model?: string;
  permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "plan";
  dangerouslySkipPermissions?: boolean;
  security?: RunnerSecurityPolicy;
};

function permissionsAllowWorkspaceWriteMode(permissions: readonly { scope: string }[] | undefined): boolean {
  return permissions?.some((permission) => permission.scope === "repo:write") ?? false;
}

function claudePermissionModeForRun(input: {
  permissions: readonly { scope: string }[] | undefined;
  configuredMode: ClaudeCodeExecutorOptions["permissionMode"];
}): NonNullable<ClaudeCodeExecutorOptions["permissionMode"]> {
  const workspaceWriteAllowed = permissionsAllowWorkspaceWriteMode(input.permissions);
  if (!workspaceWriteAllowed) return "plan";
  return input.configuredMode ?? "acceptEdits";
}

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

export function createClaudeCodeExecutor(options: ClaudeCodeExecutorOptions = {}): ExecutorAdapter {
  const runner = options.runner ?? nodeCommandRunner;
  const claudeCommand = options.claudeCommand ?? "claude";

  return {
    id: "claude-code",
    displayName: "Claude Code Executor",
    capability: {
      id: "claude-code",
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
      workspaceIsolation: "worktree",
      requiredSecrets: [
        {
          id: "anthropic_api_key",
          label: "Anthropic API key",
          required: false,
          env: "ANTHROPIC_API_KEY",
          description:
            "Needed when the local Claude Code CLI is configured to authenticate from environment. The scrubbed executor environment drops it by default; add it to security.extraSafeEnv to pass it through."
        }
      ],
      completionSignals: [
        {
          type: "process_exit",
          required: true,
          description: "OpenTag treats a successful `claude --print` process exit as the normal completion signal."
        }
      ]
    },
    async canRun(input) {
      try {
        const claudeVersion = await runner.run(claudeCommand, ["--version"], { cwd: input.workspacePath });
        if (claudeVersion.exitCode !== 0) {
          return { ready: false, reason: `Claude Code CLI is not available: ${claudeVersion.stderr || claudeVersion.stdout}` };
        }
      } catch (error) {
        return { ready: false, reason: `Claude Code CLI is not available: ${error instanceof Error ? error.message : String(error)}` };
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
        executorId: "claude-code",
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

      const workspaceWriteAllowed = permissionsAllowWorkspaceWriteMode(input.permissions);
      const dangerousSkipPermissions = workspaceWriteAllowed && options.dangerouslySkipPermissions === true;
      const permissionMode = claudePermissionModeForRun({
        permissions: input.permissions,
        configuredMode: options.permissionMode
      });

      if (options.dangerouslySkipPermissions && !workspaceWriteAllowed) {
        await sink.emit({
          type: "executor.progress",
          message: "Ignoring Claude Code --dangerously-skip-permissions because this run was not granted repo:write.",
          at: new Date().toISOString()
        });
      }

      if (dangerousSkipPermissions) {
        await sink.emit({
          type: "executor.progress",
          message:
            "WARNING: Claude Code is running with --dangerously-skip-permissions; every tool call is auto-approved without any permission gate.",
          at: new Date().toISOString()
        });
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
          "--permission-mode",
          permissionMode,
          ...(dangerousSkipPermissions ? ["--dangerously-skip-permissions"] : [])
        ];
        const claudeResult = await runner.run(claudeCommand, args, {
          cwd: worktreePath,
          env: scrubEnvironment(undefined, security),
          input: buildPrompt({
            runId: input.runId,
            rawText: input.command.rawText,
            context: input.context,
            contextPacket: input.contextPacket
          })
        });
        await assertCommandSucceeded(claudeResult, "claude --print");

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
