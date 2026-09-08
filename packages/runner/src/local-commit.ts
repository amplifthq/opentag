import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertCommandSucceeded, type CommandRunner } from "./command.js";
import { changedFiles } from "./git.js";

type LocalCommitTarget = Readonly<{
  workspace: string; repository: string; gitDir: string; commonDir: string;
  branch: string; head: string;
}>;

// No inherited Git routing, hooks, signing, fsmonitor or clean/process filters.
// This runner is internal: no model-selected command or flags enter it.
export function createLocalGitRunner(runner: CommandRunner): CommandRunner {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0" });
  return { run(command, args, options) {
    if (command !== "git") throw new Error("local_commit_command_invalid");
    const safeArgs = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
    return runner.run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
      "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null",
      "-c", "diff.ignoreSubmodules=all", "-c", "submodule.recurse=false",
      "-c", "user.name=OpenTag", "-c", "user.email=opentag@localhost", ...safeArgs], { ...options, env });
  } };
}

async function value(runner: CommandRunner, cwd: string, args: string[]) {
  const result = await runner.run("git", args, { cwd });
  if (result.exitCode !== 0) throw new Error("local_commit_identity_unavailable");
  return result.stdout.trim();
}

export async function captureLocalCommitTarget(input: {
  runner: CommandRunner; workspacePath: string; repositoryPath: string; branch: string;
}): Promise<LocalCommitTarget> {
  const runner = createLocalGitRunner(input.runner);
  const workspace = await realpath(input.workspacePath);
  const repository = await realpath(input.repositoryPath);
  const top = await realpath(await value(runner, workspace, ["rev-parse", "--show-toplevel"]));
  const gitDir = await realpath(await value(runner, workspace, ["rev-parse", "--absolute-git-dir"]));
  const commonDir = await realpath(resolve(workspace, await value(runner, workspace, ["rev-parse", "--git-common-dir"])));
  const repositoryCommon = await realpath(resolve(repository, await value(runner, repository, ["rev-parse", "--git-common-dir"])));
  const branch = await value(runner, workspace, ["symbolic-ref", "--quiet", "HEAD"]);
  const head = await value(runner, workspace, ["rev-parse", "HEAD^{commit}"]);
  if (workspace === repository || top !== workspace || gitDir === commonDir
    || commonDir !== repositoryCommon || branch !== `refs/heads/${input.branch}`) {
    throw new Error("local_commit_workspace_not_isolated");
  }
  return Object.freeze({ workspace, repository, gitDir, commonDir, branch, head });
}

export async function assertLocalCommitAuthority(input: {
  runner: CommandRunner; target: LocalCommitTarget;
  assertCurrent(): Promise<boolean>;
}): Promise<void> {
  const runner = createLocalGitRunner(input.runner);
  const { target } = input;
  if (!await input.assertCurrent()) throw new Error("local_commit_authority_expired");
  const current = await captureLocalCommitTarget({ runner: input.runner,
    workspacePath: target.workspace, repositoryPath: target.repository,
    branch: target.branch.slice("refs/heads/".length) });
  if (JSON.stringify(current) !== JSON.stringify(target)) throw new Error("local_commit_identity_changed");
  for (const name of ["index", "HEAD"]) {
    const file = await lstat(resolve(target.gitDir, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (file && !file.isFile()) throw new Error("local_commit_metadata_redirected");
  }
  const filters = await runner.run("git", ["config", "--get-regexp", "^filter\\."], { cwd: target.workspace });
  if (filters.exitCode !== 1) throw new Error("local_commit_filters_unsupported");
}

export async function commitIsolatedRunChanges(input: {
  runner: CommandRunner; target: LocalCommitTarget; message: string;
  assertCurrent(): Promise<boolean>;
}): Promise<boolean> {
  const runner = createLocalGitRunner(input.runner);
  const { target } = input;
  const check = () => assertLocalCommitAuthority(input);
  await check();
  const files = await changedFiles({ runner, workspacePath: target.workspace });
  if (!files.length) return false;
  const validatePath = async (path: string) => {
    if (!path || isAbsolute(path) || path.split(/[\\/]/u).some(part =>
      part === ".." || [".git", ".omx", ".codex", ".claude"].includes(part.toLowerCase()))) {
      throw new Error("local_commit_path_invalid");
    }
    const parent = relative(target.workspace, await realpath(dirname(resolve(target.workspace, path))));
    if (isAbsolute(parent) || parent === ".." || parent.startsWith(`..${sep}`)) {
      throw new Error("local_commit_path_escape");
    }
  };
  for (const file of files) await validatePath(file);
  await check();
  await assertCommandSucceeded(await runner.run("git", ["add", "--", ...files], { cwd: target.workspace }), "stage isolated run changes");
  const staged = await runner.run("git", ["diff", "--cached", "--name-only", "--no-renames", "-z"], { cwd: target.workspace });
  await assertCommandSucceeded(staged, "inspect isolated staged paths");
  for (const path of staged.stdout.split("\0").filter(Boolean)) await validatePath(path);
  await check();
  await assertCommandSucceeded(await runner.run("git", ["commit", "-m", input.message], { cwd: target.workspace }), "commit isolated run changes");
  return true;
}
