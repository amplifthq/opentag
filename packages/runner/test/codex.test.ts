import { describe, expect, it } from "vitest";
import { createCodexExecutor } from "../src/codex.js";
import type { CommandRunner } from "../src/command.js";
import { branchNameForRun, parseChangedFiles, worktreePathForRun } from "../src/git.js";

describe("Codex executor", () => {
  it("creates an isolated worktree, runs codex exec, commits, and reports changed files", async () => {
    const calls: { command: string; args: string[]; cwd?: string; input?: string }[] = [];
    let cleaned = false;
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options?.cwd, input: options?.input });
        if (command === "codex" && args.includes("--version")) {
          return { exitCode: 0, stdout: "codex 1.0.0", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { exitCode: 0, stdout: "/tmp/demo\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse --verify main^{commit}") {
          return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "status --porcelain") {
          return {
            exitCode: 0,
            stdout: cleaned ? " M src/demo.ts\n?? test/demo.test.ts\n" : "?? .omx/\n M src/demo.ts\n?? test/demo.test.ts\n",
            stderr: ""
          };
        }
        if (command === "git" && args.join(" ") === "clean -fd -- .omx") {
          cleaned = true;
          return { exitCode: 0, stdout: "Removing .omx/\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "add -- src/demo.ts test/demo.test.ts") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "commit -m OpenTag run run_1") {
          return { exitCode: 0, stdout: "[opentag/run_1 abc123] OpenTag run run_1\n", stderr: "" };
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
        baseBranch: "main",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      })
    ).resolves.toEqual({ ready: true });

    const events: string[] = [];
    const result = await executor.run(
      {
        runId: "run_1",
        workspacePath: "/tmp/demo",
        baseBranch: "main",
        keepWorktree: "never",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [{ kind: "github.issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }]
      },
      {
        emit: async (event) => {
          events.push(event.type);
        }
      }
    );

    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "worktree add -B opentag/run_1 /tmp/demo/.worktrees/opentag/run_1 main")).toBe(true);
    expect(calls.some((call) => call.command === "codex" && call.args[0] === "exec")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "clean -fd -- .omx")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "commit -m OpenTag run run_1")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "worktree remove --force /tmp/demo/.worktrees/opentag/run_1")).toBe(true);
    expect(calls.find((call) => call.command === "codex" && call.args[0] === "exec")?.args).toContain("--full-auto");
    expect(calls.find((call) => call.command === "codex" && call.args[0] === "exec")?.args).toContain("--ephemeral");
    expect(calls.find((call) => call.command === "codex" && call.args[0] === "exec")?.cwd).toBe("/tmp/demo/.worktrees/opentag/run_1");
    expect(calls.find((call) => call.command === "codex" && call.args[0] === "exec")?.input).toContain("fix this");
    expect(events).toEqual(["executor.started", "executor.progress", "executor.progress", "executor.progress", "executor.completed"]);
    expect(result.changedFiles).toEqual(["src/demo.ts", "test/demo.test.ts"]);
    expect(result.summary).toContain("Implemented the requested fix.");
    expect(result.artifacts).toEqual([{ title: "Run branch", uri: "opentag/run_1" }]);
    expect(result.nextAction).toBe("Review the local branch or pull request.");
  });

  it("does not require the main checkout to be clean", async () => {
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "codex" && args.includes("--version")) {
          return { exitCode: 0, stdout: "codex 1.0.0", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { exitCode: 0, stdout: "/tmp/demo\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse --verify main^{commit}") {
          return { exitCode: 0, stdout: "abc123\n", stderr: "" };
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
    ).resolves.toEqual({ ready: true });
  });
});

describe("git helpers", () => {
  it("parses porcelain changed files and filters internal artifacts", () => {
    expect(parseChangedFiles("?? .omx/\n M src/demo.ts\n?? test/demo.test.ts\n")).toEqual(["src/demo.ts", "test/demo.test.ts"]);
  });

  it("sanitizes branch names", () => {
    expect(branchNameForRun("run/with spaces")).toBe("opentag/run-with-spaces");
  });

  it("builds default worktree paths", () => {
    expect(worktreePathForRun({ workspacePath: "/tmp/demo/", runId: "run/with spaces" })).toBe(
      "/tmp/demo/.worktrees/opentag/run-with-spaces"
    );
    expect(worktreePathForRun({ workspacePath: "/tmp/demo", worktreeRoot: "/tmp/worktrees/", runId: "run_1" })).toBe(
      "/tmp/worktrees/run_1"
    );
  });
});
