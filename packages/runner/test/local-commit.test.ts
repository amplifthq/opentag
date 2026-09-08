import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeCommandRunner, type CommandRunner } from "../src/command.js";
import { captureLocalCommitTarget, commitIsolatedRunChanges } from "../src/local-commit.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opentag-local-commit-")); roots.push(root);
  const repo = join(root, "repo"); const workspace = join(root, "attempt"); mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  mkdirSync(join(repo, "nested")); writeFileSync(join(repo, "nested", "delete.txt"), "tracked\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "base");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-b", "opentag/run_test", workspace);
  return { root, repo, workspace, git, head,
    capture: () => captureLocalCommitTarget({ runner: nodeCommandRunner, repositoryPath: repo, workspacePath: workspace, branch: "opentag/run_test" }) };
}

describe("Runner-owned isolated local commit", () => {
  it("stages literal paths and commits only the worktree without hooks, inherited index or remote I/O", async () => {
    const f = fixture(); const target = await f.capture();
    writeFileSync(join(f.repo, "user.txt"), "user work\n"); f.git(f.repo, "add", "user.txt");
    const indexBefore = f.git(f.repo, "diff", "--cached", "--binary");
    const hook = join(f.repo, ".git", "hooks", "pre-commit"); const marker = join(f.root, "hook-ran");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(hook, 0o755);
    const name = ":(glob)literal file.txt";
    writeFileSync(join(f.workspace, name), "only this\n");
    const foreignIndex = join(f.root, "foreign-index"); vi.stubEnv("GIT_INDEX_FILE", foreignIndex);
    const calls: string[][] = [];
    const runner: CommandRunner = { run(command, args, options) { calls.push([command, ...args]); return nodeCommandRunner.run(command, args, options); } };
    expect(await commitIsolatedRunChanges({ runner, target, message: "local result", assertCurrent: async () => true })).toBe(true);
    vi.unstubAllEnvs();
    expect(f.git(f.workspace, "show", `HEAD:${name}`)).toBe("only this");
    expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.repo, "diff", "--cached", "--binary")).toBe(indexBefore);
    expect(existsSync(marker)).toBe(false); expect(existsSync(foreignIndex)).toBe(false);
    expect(calls.every(call => call[0] === "git" && !call.includes("push"))).toBe(true);
  });

  it("rejects the primary checkout and changed branch identity", async () => {
    const f = fixture(); const target = await f.capture();
    await expect(captureLocalCommitTarget({ runner: nodeCommandRunner, repositoryPath: f.repo, workspacePath: f.repo, branch: "main" }))
      .rejects.toThrow("local_commit_workspace_not_isolated");
    f.git(f.workspace, "checkout", "-b", "other"); writeFileSync(join(f.workspace, "change.txt"), "change");
    await expect(commitIsolatedRunChanges({ runner: nodeCommandRunner, target, message: "no", assertCurrent: async () => true }))
      .rejects.toThrow("local_commit_workspace_not_isolated");
    expect(f.git(f.workspace, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("commits tracked deletions after their containing directory is removed", async () => {
    const f = fixture(); const target = await f.capture();
    rmSync(join(f.workspace, "nested"), { recursive: true });
    expect(await commitIsolatedRunChanges({ runner: nodeCommandRunner, target,
      message: "delete tracked directory", assertCurrent: async () => true })).toBe(true);
    expect(f.git(f.workspace, "diff", "HEAD^", "HEAD", "--name-status")).toBe("D\tnested/delete.txt");
    expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
  });

  it("stops before commit when authority expires after staging, retaining local evidence", async () => {
    const f = fixture(); const target = await f.capture(); let current = true;
    writeFileSync(join(f.workspace, "change.txt"), "change");
    const runner: CommandRunner = { async run(command, args, options) {
      const result = await nodeCommandRunner.run(command, args, options);
      if (args.includes("add")) current = false;
      return result;
    } };
    await expect(commitIsolatedRunChanges({ runner, target, message: "no", assertCurrent: async () => current }))
      .rejects.toThrow("local_commit_authority_expired");
    expect(f.git(f.workspace, "rev-parse", "HEAD")).toBe(f.head);
    expect(f.git(f.workspace, "diff", "--cached", "--name-only")).toBe("change.txt");
  });

  it("rejects configured clean filters and redirected index metadata", async () => {
    const f = fixture(); const target = await f.capture();
    writeFileSync(join(f.workspace, "change.txt"), "change");
    f.git(f.repo, "config", "filter.unsafe.clean", "false");
    await expect(commitIsolatedRunChanges({ runner: nodeCommandRunner, target, message: "no", assertCurrent: async () => true }))
      .rejects.toThrow("local_commit_filters_unsupported");
    f.git(f.repo, "config", "--unset", "filter.unsafe.clean");
    const index = join(target.gitDir, "index"); rmSync(index); symlinkSync(join(f.repo, ".git", "index"), index);
    const original = readFileSync(join(f.repo, ".git", "index"));
    await expect(commitIsolatedRunChanges({ runner: nodeCommandRunner, target, message: "no", assertCurrent: async () => true }))
      .rejects.toThrow("local_commit_metadata_redirected");
    expect(readFileSync(join(f.repo, ".git", "index"))).toEqual(original);
  });
});
