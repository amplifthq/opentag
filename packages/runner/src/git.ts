import type { CommandRunner } from "./command.js";
import { assertCommandSucceeded } from "./command.js";

export function branchNameForRun(runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `opentag/${safeRunId}`;
}

export function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export async function createRunBranch(input: {
  runner: CommandRunner;
  workspacePath: string;
  branchName: string;
}): Promise<void> {
  const result = await input.runner.run("git", ["checkout", "-B", input.branchName], { cwd: input.workspacePath });
  await assertCommandSucceeded(result, "create run branch");
}

export async function changedFiles(input: { runner: CommandRunner; workspacePath: string }): Promise<string[]> {
  const result = await input.runner.run("git", ["status", "--porcelain"], { cwd: input.workspacePath });
  await assertCommandSucceeded(result, "read changed files");
  return parseChangedFiles(result.stdout);
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
