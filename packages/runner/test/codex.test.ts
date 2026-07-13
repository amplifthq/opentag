import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexExecutor } from "../src/codex.js";
import type { CommandRunner } from "../src/command.js";
import { EXECUTOR_REPORT_END, EXECUTOR_REPORT_START } from "../src/executor-report.js";
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
        if (command === "git" && args.join(" ") === "-c core.quotePath=false status --porcelain -z") {
          return calls.length < 4
            ? { exitCode: 0, stdout: "", stderr: "" }
            : {
                exitCode: 0,
                stdout:
                  calls.some((call) => call.command === "git" && call.args.join(" ") === "clean -fd -- .omx")
                    ? " M src/demo.ts\0?? test/demo.test.ts\0"
                    : "?? .omx/\0 M src/demo.ts\0?? test/demo.test.ts\0",
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
        workspace: { kind: "repository", path: "/tmp/demo" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [],
        permissions: [{ scope: "repo:write", reason: "write branch" }]
      })
    ).resolves.toEqual({ ready: true });

    const events: string[] = [];
    const result = await executor.run(
      {
        runId: "run_1",
        workspace: { kind: "repository", path: "/tmp/demo" },
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
    expect(codexExecCall?.input).toContain("OpenTag owns the source-control handoff after you finish.");
    expect(codexExecCall?.input).toContain("Do not run, request, or recommend git add, git commit, git push, or gh pr create.");
    expect(codexExecCall?.input).toContain("OpenTag will publish the run branch and expose pull-request creation as a suggested action.");
    expect(codexExecCall?.input).toContain("If the user asked a read-only question or summary request, put the user-facing answer before this block");
    expect(codexExecCall?.input).toContain("OPENTAG_EXECUTOR_REPORT_START");
    expect(codexExecCall?.input).toContain('"outcome": "passed"');
    expect(codexExecCall?.input).toContain("OPENTAG_EXECUTOR_REPORT_END");
    expect(codexExecCall?.cwd).toBe(worktreePath);
    expect(codexExecCall?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(events).toEqual(["executor.started", "executor.progress", "executor.progress", "executor.progress", "executor.completed"]);
    expect(result.changedFiles).toEqual(["src/demo.ts", "test/demo.test.ts"]);
    expect(result.summary).toContain("Implemented the requested fix.");
    expect(result.artifacts).toEqual([
      expect.objectContaining({ kind: "patch", title: "Generated patch", uri: "opentag/run_1" }),
      expect.objectContaining({ kind: "report", title: "Run report", uri: "opentag://run/run_1/report" }),
      expect.objectContaining({ kind: "log_summary", title: "Log summary", uri: "opentag://run/run_1/log-summary" })
    ]);
    expect(result.suggestedChanges?.[0]).toMatchObject({
      proposalId: "proposal_run_1",
      intents: [
        {
          intentId: "proposal_run_1_create_pr",
          domain: "pull_request",
          action: "create_pull_request",
          params: { title: "OpenTag run run_1", head: "opentag/run_1", base: "main" }
        }
      ]
    });
    expect(result.verification).toBeUndefined();
    expect(result.suggestedChanges?.[0]?.intents[0]?.params?.["body"]).not.toContain("codex exec");
    expect(result.suggestedChanges?.[0]?.intents[0]?.params?.["verification"]).toBeUndefined();
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
        if (command === "git" && args.join(" ") === "-c core.quotePath=false status --porcelain -z") {
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
        workspace: { kind: "repository", path: "/tmp/demo" },
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
    expect(result.artifacts?.map((artifact) => artifact.type)).toEqual(["diagnosis_report", "log_summary"]);
    expect(result.artifacts?.every((artifact) => artifact.sourceRunId === "run_no_change")).toBe(true);
    expect(result.nextAction).toBe("No file changes were detected.");
  });

  it("selects the read-only sandbox for runs without a write scope", async () => {
    const codexExecCalls: string[][] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "git" && args.join(" ") === "-c core.quotePath=false status --porcelain -z") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && (args[0] === "worktree" || args[0] === "branch")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "codex" && args[0] === "exec") {
          codexExecCalls.push(args);
          return { exitCode: 0, stdout: "Summary of the repository.", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    await createCodexExecutor({ runner }).run(
      {
        runId: "run_read_sandbox",
        workspace: { kind: "repository", path: "/tmp/demo" },
        command: { rawText: "summarize this repo", intent: "unknown", args: {} },
        context: [],
        permissions: [{ scope: "repo:read", reason: "read-only summary" }],
        baseBranch: "main",
        keepWorktree: "on_failure"
      },
      { emit: async () => undefined }
    );

    expect(codexExecCalls[0]).toContain("--sandbox");
    expect(codexExecCalls[0]).toContain("read-only");
    expect(codexExecCalls[0]).not.toContain("--full-auto");
  });

  it("preserves Codex read-only answers when the executor report has no file changes", async () => {
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "git" && args.join(" ") === "-c core.quotePath=false status --porcelain -z") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "branch -D opentag/run_readonly") {
          return { exitCode: 0, stdout: "Deleted branch opentag/run_readonly\n", stderr: "" };
        }
        if (command === "codex" && args[0] === "exec") {
          return {
            exitCode: 0,
            stdout: [
              "This repository implements OpenTag, a local-first bridge from source threads to local coding agents.",
              "",
              EXECUTOR_REPORT_START,
              JSON.stringify({
                changes: [],
                verification: [
                  {
                    command: "git status --short --branch",
                    outcome: "passed",
                    summary: "Confirmed the checkout stayed clean."
                  }
                ],
                risks: []
              }),
              EXECUTOR_REPORT_END
            ].join("\n"),
            stderr: ""
          };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    const result = await createCodexExecutor({ runner }).run(
      {
        runId: "run_readonly",
        workspace: { kind: "repository", path: "/tmp/demo" },
        command: { rawText: "Summarize this repo at a high level. Do not modify files.", intent: "unknown", args: {} },
        context: [],
        permissions: [{ scope: "repo:read", reason: "read-only summary" }],
        baseBranch: "main",
        keepWorktree: "on_failure"
      },
      { emit: async () => undefined }
    );

    expect(result.changedFiles).toEqual([]);
    expect(result.summary).toContain("This repository implements OpenTag");
    expect(result.summary).toContain("Verified:");
    expect(result.summary).toContain("git status --short --branch");
    expect(result.summary).not.toContain(EXECUTOR_REPORT_START);
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
        workspace: { kind: "repository", path: "/tmp/demo" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      })
    ).resolves.toEqual({ ready: false, reason: "Base branch 'main' is not available: fatal: Needed a single revision\n" });
  });
});

describe("git helpers", () => {
  it("parses porcelain changed files and filters internal artifacts", () => {
    expect(parseChangedFiles("?? .omx/\0 M src/demo.ts\0?? test/demo.test.ts\0")).toEqual(["src/demo.ts", "test/demo.test.ts"]);
  });

  it("keeps the rename destination and skips the source record", () => {
    // `R  dest\0src\0` — porcelain -z emits the destination in the record and
    // the source as a separate following NUL-terminated record.
    expect(parseChangedFiles("R  src/new-name.ts\0src/old-name.ts\0")).toEqual(["src/new-name.ts"]);
  });

  it("parses copy records the same way as renames", () => {
    expect(parseChangedFiles("C  src/copy.ts\0src/original.ts\0")).toEqual(["src/copy.ts"]);
  });

  it("keeps the worktree-side rename destination and skips the source record", () => {
    expect(parseChangedFiles(" R src/new-name.ts\0src/old-name.ts\0")).toEqual(["src/new-name.ts"]);
  });

  it("parses worktree-side copy records the same way as index-side copies", () => {
    expect(parseChangedFiles(" C src/copy.ts\0src/original.ts\0")).toEqual(["src/copy.ts"]);
  });

  it("preserves quoted and unicode paths verbatim under -z", () => {
    // With `-z` and core.quotePath=false git emits raw bytes: no surrounding
    // quotes, no escaping, and spaces inside the path are kept intact.
    expect(parseChangedFiles(' M src/a file with spaces.ts\0?? "weird".ts\0 M café/résumé.ts\0')).toEqual([
      "src/a file with spaces.ts",
      '"weird".ts',
      "café/résumé.ts"
    ]);
  });

  it("handles a rename of a unicode path followed by an ordinary change", () => {
    expect(parseChangedFiles("R  docs/náme.md\0docs/óld.md\0 M src/demo.ts\0")).toEqual(["docs/náme.md", "src/demo.ts"]);
  });

  it("sanitizes branch names", () => {
    expect(branchNameForRun("run/with spaces")).toBe("opentag/run-with-spaces");
  });

  it("stages and commits selected changed files", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options?.cwd });
        if (command === "git" && args.join(" ") === "-c core.quotePath=false status --porcelain -z") {
          return { exitCode: 0, stdout: " M src/demo.ts\0?? test/demo.test.ts\0", stderr: "" };
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
      { command: "git", args: ["-c", "core.quotePath=false", "status", "--porcelain", "-z"], cwd: "/tmp/demo" },
      { command: "git", args: ["add", "--", "src/demo.ts", "test/demo.test.ts"], cwd: "/tmp/demo" },
      { command: "git", args: ["commit", "-m", "OpenTag run run_1"], cwd: "/tmp/demo" }
    ]);
  });
});
