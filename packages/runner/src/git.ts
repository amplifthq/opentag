import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandRunner } from "./command.js";
import { assertCommandSucceeded } from "./command.js";

export type GitStatusEntry = {
  status: string;
  path: string;
};

const INTERNAL_ARTIFACT_ROOTS = [".omx", ".codex", ".claude"];

export function branchNameForRun(runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `opentag/${safeRunId}`;
}

export function worktreePathForRun(input: {
  workspacePath: string;
  runId: string;
  worktreeRoot?: string;
}): string {
  const safeRunId = input.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const root = input.worktreeRoot ?? `${input.workspacePath.replace(/\/$/, "")}/.worktrees/opentag`;
  return `${root.replace(/\/$/, "")}/${safeRunId}`;
}

export function parseStatusEntries(statusOutput: string): GitStatusEntry[] {
  return statusOutput
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3).trim()
    }))
    .filter((entry) => entry.path.length > 0);
}

export function isInternalArtifactPath(path: string): boolean {
  return INTERNAL_ARTIFACT_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

export function parseChangedFiles(statusOutput: string): string[] {
  return parseStatusEntries(statusOutput)
    .map((entry) => entry.path)
    .filter((path) => !isInternalArtifactPath(path));
}

export async function createRunBranch(input: {
  runner: CommandRunner;
  workspacePath: string;
  branchName: string;
}): Promise<void> {
  const result = await input.runner.run("git", ["checkout", "-B", input.branchName], { cwd: input.workspacePath });
  await assertCommandSucceeded(result, "create run branch");
}

export async function createRunWorktree(input: {
  runner: CommandRunner;
  workspacePath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
}): Promise<void> {
  mkdirSync(dirname(input.worktreePath), { recursive: true });
  const result = await input.runner.run(
    "git",
    ["worktree", "add", "-B", input.branchName, input.worktreePath, input.baseBranch],
    { cwd: input.workspacePath }
  );
  await assertCommandSucceeded(result, "create run worktree");
}

export async function removeRunWorktree(input: {
  runner: CommandRunner;
  workspacePath: string;
  worktreePath: string;
}): Promise<void> {
  const result = await input.runner.run("git", ["worktree", "remove", "--force", input.worktreePath], {
    cwd: input.workspacePath
  });
  await assertCommandSucceeded(result, "remove run worktree");
}

export async function changedFiles(input: { runner: CommandRunner; workspacePath: string }): Promise<string[]> {
  const result = await input.runner.run("git", ["status", "--porcelain"], { cwd: input.workspacePath });
  await assertCommandSucceeded(result, "read changed files");
  return parseChangedFiles(result.stdout);
}

export async function cleanupInternalArtifacts(input: { runner: CommandRunner; workspacePath: string }): Promise<string[]> {
  const statusResult = await input.runner.run("git", ["status", "--porcelain"], { cwd: input.workspacePath });
  await assertCommandSucceeded(statusResult, "scan internal artifacts");
  const untrackedRoots = Array.from(
    new Set(
      parseStatusEntries(statusResult.stdout)
        .filter((entry) => entry.status === "??" && isInternalArtifactPath(entry.path))
        .map((entry) => entry.path.split("/", 1)[0] ?? entry.path)
    )
  );
  if (untrackedRoots.length === 0) return [];

  const cleanResult = await input.runner.run("git", ["clean", "-fd", "--", ...untrackedRoots], {
    cwd: input.workspacePath
  });
  await assertCommandSucceeded(cleanResult, "clean internal artifacts");
  return untrackedRoots;
}

export async function commitRunChanges(input: {
  runner: CommandRunner;
  workspacePath: string;
  message: string;
}): Promise<boolean> {
  const files = await changedFiles({ runner: input.runner, workspacePath: input.workspacePath });
  if (files.length === 0) return false;

  const addResult = await input.runner.run("git", ["add", "--", ...files], {
    cwd: input.workspacePath
  });
  await assertCommandSucceeded(addResult, "stage run changes");

  const commitResult = await input.runner.run("git", ["commit", "-m", input.message], {
    cwd: input.workspacePath
  });
  await assertCommandSucceeded(commitResult, "commit run changes");
  return true;
}

export async function pushBranch(input: {
  runner: CommandRunner;
  workspacePath: string;
  remote: string;
  branchName: string;
}): Promise<void> {
  const result = await input.runner.run("git", ["push", "-u", input.remote, input.branchName], { cwd: input.workspacePath });
  await assertCommandSucceeded(result, "push run branch");
}
