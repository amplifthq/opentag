import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandRunner } from "./command.js";
import { assertCommandSucceeded } from "./command.js";
import type { ExecutorWorkspace } from "./executor.js";

export type GitStatusEntry = {
  status: string;
  path: string;
};

const INTERNAL_ARTIFACT_ROOTS = [".omx", ".codex", ".claude"];

export function branchNameForRun(runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `opentag/${safeRunId}`;
}

// Git status command used by the helpers below. We use the NUL-delimited
// porcelain form (`-z`) so that renamed/copied entries and paths containing
// spaces, quotes, newlines, or unicode survive parsing intact. `-z` also
// disables the quoting/escaping that the default newline form applies, and
// `core.quotePath=false` keeps unicode bytes verbatim rather than \NNN escapes.
export const STATUS_PORCELAIN_Z_ARGS = ["-c", "core.quotePath=false", "status", "--porcelain", "-z"];

// Parses `git status --porcelain -z` output (NUL-delimited records).
//
// In the `-z` format each record is terminated by a NUL byte. For ordinary
// entries a record is `XY <path>`. For rename ("R") and copy ("C") entries the
// destination is emitted in the `XY <dest>` record and the source path follows
// as a SEPARATE NUL-terminated record. We consume that following record as the
// source and keep the destination as the changed path, so consumers never see
// the literal `original -> renamed` arrow form that breaks `git add --`.
export function parseStatusEntries(statusOutput: string): GitStatusEntry[] {
  const records = statusOutput.split("\0");
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    const status = record.slice(0, 2);
    const path = record.slice(3);

    // Rename/copy records carry a trailing source record we must skip past so
    // it is not mistaken for an independent change. Git's XY status can put
    // rename/copy in either column (index or worktree), so check both.
    const isRenameOrCopy = status.includes("R") || status.includes("C");
    if (isRenameOrCopy) {
      index += 1;
    }

    if (path.length === 0) continue;
    entries.push({ status, path });
  }

  return entries;
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
  startPoint?: string;
}): Promise<void> {
  const result = await input.runner.run("git", ["checkout", "-B", input.branchName, ...(input.startPoint ? [input.startPoint] : [])], { cwd: input.workspacePath });
  await assertCommandSucceeded(result, "create run branch");
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

export function executionPathForAttempt(input: {
  workspace: ExecutorWorkspace;
  runId: string;
  attemptId: string;
  worktreeRoot?: string;
}): string {
  if (input.workspace.kind === "scratch") return input.workspace.path;
  return worktreePathForRun({
    workspacePath: input.workspace.path,
    runId: input.attemptId === input.runId ? input.runId : `${input.runId}-${input.attemptId}`,
    ...(input.worktreeRoot ? { worktreeRoot: input.worktreeRoot } : {})
  });
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

export async function deleteRunBranch(input: { runner: CommandRunner; workspacePath: string; branchName: string }): Promise<void> {
  const result = await input.runner.run("git", ["branch", "-D", input.branchName], {
    cwd: input.workspacePath
  });
  await assertCommandSucceeded(result, "delete empty run branch");
}

export async function changedFiles(input: { runner: CommandRunner; workspacePath: string }): Promise<string[]> {
  const result = await input.runner.run("git", STATUS_PORCELAIN_Z_ARGS, { cwd: input.workspacePath });
  await assertCommandSucceeded(result, "read changed files");
  return parseChangedFiles(result.stdout);
}

export async function cleanupInternalArtifacts(input: { runner: CommandRunner; workspacePath: string }): Promise<string[]> {
  const statusResult = await input.runner.run("git", STATUS_PORCELAIN_Z_ARGS, { cwd: input.workspacePath });
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

export async function commitChangedFiles(input: {
  runner: CommandRunner;
  workspacePath: string;
  files: string[];
  message: string;
}): Promise<void> {
  if (input.files.length === 0) return;
  const addResult = await input.runner.run("git", ["add", "--", ...input.files], { cwd: input.workspacePath });
  await assertCommandSucceeded(addResult, "stage changed files");
  const commitResult = await input.runner.run("git", ["commit", "-m", input.message], { cwd: input.workspacePath });
  await assertCommandSucceeded(commitResult, "commit changed files");
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
