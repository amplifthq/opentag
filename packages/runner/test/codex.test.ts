import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexExecutor } from "../src/codex.js";
import type { CommandRunner } from "../src/command.js";
import { branchNameForRun, commitRunChanges, parseChangedFiles, worktreePathForRun } from "../src/git.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Codex executor", () => {
  it("creates an isolated worktree, runs codex exec, and reports changed files", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-secret");
    const calls: { command: string; args: string[]; input?: string; cwd?: string; env?: Record<string, string | undefined> }[] = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, input: options?.input, cwd: options?.cwd, env: options?.env });
        if (command === "codex" && args.includes("--version")) {
          return { exitCode: 0, stdout: "codex 1.0.0", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { exitCode: 0, stdout: "/tmp/demo\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse --verify main^{commit}") {
          return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "status --porcelain") {
          return calls.length < 4
            ? { exitCode: 0, stdout: "", stderr: "" }
            : {
                exitCode: 0,
                stdout:
                  calls.some((call) => call.command === "git" && call.args.join(" ") === "clean -fd -- .omx")
                    ? " M src/demo.ts\n?? test/demo.test.ts\n"
                    : "?? .omx/\n M src/demo.ts\n?? test/demo.test.ts\n",
                stderr: ""
              };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "commit") {
          return { exitCode: 0, stdout: "[opentag/run_1 abc123] commit\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "clean -fd -- .omx") {
          return { exitCode: 0, stdout: "Removing .omx/\n", stderr: "" };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "codex" && args[0] === "exec") {
          return { exitCode: 0, stdout: "Implemented the requested fix.", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    const executor = createCodexExecutor({ runner });
    await expect(
      executor.canRun({
        runId: "run_1",
        workspacePath: "/tmp/demo",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [],
        permissions: [{ scope: "repo:write", reason: "write branch" }]
      })
    ).resolves.toEqual({ ready: true });

    const events: string[] = [];
    const result = await executor.run(
      {
        runId: "run_1",
        workspacePath: "/tmp/demo",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }],
        contextPacket: {
          summary: "Fix the requested issue with the narrowest possible change.",
          sourcePointers: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }],
          facts: [{ text: "CI is failing on the linked issue." }],
          exclusions: ["Do not touch unrelated operational files."]
        },
        permissions: [{ scope: "repo:write", reason: "write branch" }],
        baseBranch: "main",
        keepWorktree: "on_failure"
      },
      {
        emit: async (event) => {
          events.push(event.type);
        }
      }
    );

    const worktreePath = worktreePathForRun({ workspacePath: "/tmp/demo", runId: "run_1" });
    expect(
      calls.some(
        (call) =>
          call.command === "git" &&
          call.args.join(" ") === `worktree add -B opentag/run_1 ${worktreePath} main`
      )
    ).toBe(true);
    expect(calls.some((call) => call.command === "codex" && call.args[0] === "exec")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "clean -fd -- .omx")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "add -- src/demo.ts test/demo.test.ts")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "commit -m OpenTag run run_1")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === `worktree remove --force ${worktreePath}`)).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "branch -D opentag/run_1")).toBe(false);
    const codexExecCall = calls.find((call) => call.command === "codex" && call.args[0] === "exec");
    expect(codexExecCall?.args).toContain("--full-auto");
    expect(codexExecCall?.args).toContain("--ephemeral");
    expect(codexExecCall?.input).toContain("OpenTag context packet:");
    expect(codexExecCall?.input).toContain("Fix the requested issue with the narrowest possible change.");
    expect(codexExecCall?.input).toContain("Do not touch unrelated operational files.");
    expect(codexExecCall?.input).toContain("fix this");
    expect(codexExecCall?.cwd).toBe(worktreePath);
    expect(codexExecCall?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(events).toEqual(["executor.started", "executor.progress", "executor.progress", "executor.progress", "executor.completed"]);
    expect(result.changedFiles).toEqual(["src/demo.ts", "test/demo.test.ts"]);
    expect(result.summary).toContain("Implemented the requested fix.");
    expect(result.artifacts?.[0]).toMatchObject({ title: "Run branch", uri: "opentag/run_1" });
    expect(result.suggestedChanges?.[0]).toMatchObject({
      proposalId: "proposal_run_1",
      intents: [
        {
          intentId: "proposal_run_1_create_pr",
          domain: "pull_request",
          action: "create_pull_request",
          params: { title: "OpenTag run run_1", head: "opentag/run_1", base: "main" }
        },
        { intentId: "proposal_run_1_link_branch", domain: "artifact_links", action: "link_artifact" },
        { intentId: "proposal_run_1_request_review", domain: "review", action: "request_review" }
      ]
    });
    expect(result.nextAction).toMatchObject({
      hint: {
        kind: "create_pull_request",
        selectedIntentIds: ["proposal_run_1_create_pr"]
      }
    });
  });

  it("removes the empty run branch when codex completes without changes", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-secret");
    const calls: { command: string; args: string[]; cwd?: string }[] = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options?.cwd });
        if (command === "codex" && args.includes("--version")) {
          return { exitCode: 0, stdout: "codex 1.0.0", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { exitCode: 0, stdout: "/tmp/demo\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse --verify main^{commit}") {
          return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "status --porcelain") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "branch -D opentag/run_no_change") {
          return { exitCode: 0, stdout: "Deleted branch opentag/run_no_change\n", stderr: "" };
        }
        if (command === "codex" && args[0] === "exec") {
          return { exitCode: 0, stdout: "Nothing to change.", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    const result = await createCodexExecutor({ runner }).run(
      {
        runId: "run_no_change",
        workspacePath: "/tmp/demo",
        command: { rawText: "hi", intent: "unknown", args: {} },
        context: [],
        permissions: [{ scope: "repo:write", reason: "write branch" }],
        baseBranch: "main",
        keepWorktree: "on_failure"
      },
      { emit: async () => undefined }
    );

    const worktreePath = worktreePathForRun({ workspacePath: "/tmp/demo", runId: "run_no_change" });
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === `worktree remove --force ${worktreePath}`)).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "branch -D opentag/run_no_change")).toBe(true);
    expect(result.changedFiles).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.nextAction).toBe("No file changes were detected.");
  });

  it("refuses to run when the workspace has uncommitted changes", async () => {
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "codex" && args.includes("--version")) {
          return { exitCode: 0, stdout: "codex 1.0.0", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { exitCode: 0, stdout: "/tmp/demo\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse --verify main^{commit}") {
          return { exitCode: 1, stdout: "", stderr: "fatal: Needed a single revision\n" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      createCodexExecutor({ runner }).canRun({
        runId: "run_1",
        workspacePath: "/tmp/demo",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      })
    ).resolves.toEqual({ ready: false, reason: "Base branch 'main' is not available: fatal: Needed a single revision\n" });
  });
});

describe("git helpers", () => {
  it("parses porcelain changed files and filters internal artifacts", () => {
    expect(parseChangedFiles("?? .omx/\n M src/demo.ts\n?? test/demo.test.ts\n")).toEqual(["src/demo.ts", "test/demo.test.ts"]);
  });

  it("sanitizes branch names", () => {
    expect(branchNameForRun("run/with spaces")).toBe("opentag/run-with-spaces");
  });

  it("stages and commits selected changed files", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "git" && args.join(" ") === "status --porcelain") {
          return { exitCode: 0, stdout: " M src/demo.ts\n?? test/demo.test.ts\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await commitRunChanges({
      runner,
      workspacePath: "/tmp/demo",
      message: "OpenTag run run_1"
    });

    expect(calls).toEqual([
      "git status --porcelain",
      "git add -- src/demo.ts test/demo.test.ts",
      "git commit -m OpenTag run run_1"
    ]);
  });
});
