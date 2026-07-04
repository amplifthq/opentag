import { createHash } from "node:crypto";
import { contextPointerLabel, type ContextPacket, type ContextPointer } from "@opentag/core";
import { assertCommandSucceeded, nodeCommandRunner, type CommandResult, type CommandRunner } from "./command.js";
import { executorPolicyPromptLines } from "./executor-report.js";
import { renderContextPacketForPrompt, type ExecutorAdapter } from "./executor.js";
import { branchNameForRun, changedFiles, cleanupInternalArtifacts, createRunBranch } from "./git.js";
import { createExecutorRunResult } from "./result.js";
import { resolveAgentSessionProfile } from "./session-profile.js";

export type HermesExecutorOptions = {
  runner?: CommandRunner;
  hermesCommand?: string;
  profile?: string;
  profileTemplate?: string;
};

const HERMES_PROFILE_MAX_LENGTH = 64;

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
    "Use only the selected Hermes profile for tools, skills, memory, and session behavior.",
    ...executorPolicyPromptLines()
  ].join("\n");
}

function hermesCliProfileName(profileId: string): string {
  const normalized = profileId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+/, "") || "opentag";
  if (normalized.length <= HERMES_PROFILE_MAX_LENGTH) return normalized;

  const hash = createHash("sha256").update(profileId).digest("hex").slice(0, 12);
  const prefix = normalized.slice(0, HERMES_PROFILE_MAX_LENGTH - hash.length - 1);
  return `${prefix}-${hash}`;
}

async function ensureHermesProfile(input: {
  runner: CommandRunner;
  hermesCommand: string;
  workspacePath: string;
  profileName: string;
}): Promise<void> {
  if (input.profileName === "default") return;

  const show = await input.runner.run(input.hermesCommand, ["profile", "show", input.profileName], { cwd: input.workspacePath });
  if (show.exitCode === 0) return;

  const create = await input.runner.run(input.hermesCommand, ["profile", "create", input.profileName, "--clone", "--no-alias"], {
    cwd: input.workspacePath
  });
  if (create.exitCode === 0) return;

  const retry = await input.runner.run(input.hermesCommand, ["profile", "show", input.profileName], { cwd: input.workspacePath });
  if (retry.exitCode === 0) return;

  await assertCommandSucceeded(create, `hermes profile create ${input.profileName}`);
}

export function createHermesExecutor(options: HermesExecutorOptions = {}): ExecutorAdapter {
  const runner = options.runner ?? nodeCommandRunner;
  const hermesCommand = options.hermesCommand ?? "hermes";

  return {
    id: "hermes",
    displayName: "Hermes Executor",
    capability: {
      id: "hermes",
      invocation: "spawn",
      supportsProfile: true,
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
          description: "OpenTag treats a successful `hermes -z` process exit as the normal completion signal."
        }
      ]
    },
    async canRun(input) {
      try {
        const hermesVersion = await runner.run(hermesCommand, ["--version"], { cwd: input.workspacePath });
        if (hermesVersion.exitCode !== 0) {
          return { ready: false, reason: `Hermes CLI is not available: ${hermesVersion.stderr || hermesVersion.stdout}` };
        }
      } catch (error) {
        return { ready: false, reason: `Hermes CLI is not available: ${error instanceof Error ? error.message : String(error)}` };
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
        return { ready: false, reason: "Workspace has uncommitted changes; refusing to run Hermes executor." };
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

      const prompt = buildPrompt({
        runId: input.runId,
        rawText: input.command.rawText,
        context: input.context,
        contextPacket: input.contextPacket
      });

      const profile = resolveAgentSessionProfile({
        ...(options.profile ? { profile: options.profile } : {}),
        ...(options.profileTemplate ? { profileTemplate: options.profileTemplate } : {}),
        metadata: {
          ...(input.metadata ?? {}),
          runId: input.runId
        },
        ...(input.sessionProfile ? { fallback: input.sessionProfile } : {})
      });

      const profileName = profile ? hermesCliProfileName(profile.id) : undefined;
      if (profileName) {
        await sink.emit({
          type: "executor.progress",
          message: `Preparing Hermes profile ${profileName}`,
          at: new Date().toISOString()
        });
        await ensureHermesProfile({ runner, hermesCommand, workspacePath: input.workspacePath, profileName });
      }

      await sink.emit({
        type: "executor.progress",
        message: "Starting hermes -z",
        at: new Date().toISOString()
      });

      const args = [...(profileName ? ["-p", profileName] : []), "-z", prompt];

      let hermesResult: CommandResult | undefined;
      try {
        hermesResult = await runner.run(hermesCommand, args, { cwd: input.workspacePath });
        await assertCommandSucceeded(hermesResult, "hermes -z");
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

      if (!hermesResult) throw new Error("Hermes did not return a result.");

      const files = await changedFiles({ runner, workspacePath: input.workspacePath });
      await sink.emit({
        type: "executor.completed",
        message: `Hermes executor completed with ${files.length} changed file(s)`,
        at: new Date().toISOString()
      });

      const output = hermesResult.stdout.trim() || hermesResult.stderr.trim() || "Hermes completed without textual output.";
      return createExecutorRunResult({
        executorName: "Hermes",
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
  }
}
