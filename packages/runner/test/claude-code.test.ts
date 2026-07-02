import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeCodeExecutor } from "../src/claude-code.js";
import type { CommandRunner } from "../src/command.js";
import { worktreePathForRun } from "../src/git.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Claude Code executor", () => {
  it("creates an isolated worktree, runs claude print mode, and reports changed files", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
    const calls: { command: string; args: string[]; input?: string; cwd?: string; env?: Record<string, string | undefined> }[] = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, input: options?.input, cwd: options?.cwd, env: options?.env });
        if (command === "claude" && args.includes("--version")) {
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
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
        if (command === "git" && args.join(" ") === "-c core.quotePath=false status --porcelain -z") {
          return calls.some((call) => call.command === "git" && call.args.join(" ") === "clean -fd -- .claude")
            ? { exitCode: 0, stdout: " M src/demo.ts\0?? test/demo.test.ts\0", stderr: "" }
            : { exitCode: 0, stdout: "?? .claude/\0 M src/demo.ts\0?? test/demo.test.ts\0", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "clean -fd -- .claude") {
          return { exitCode: 0, stdout: "Removing .claude/\n", stderr: "" };
        }
        if (command === "git" && args[0] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "commit") {
          return { exitCode: 0, stdout: "[opentag/run_1 abc123] commit\n", stderr: "" };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "claude" && args.includes("--print")) {
          return { exitCode: 0, stdout: "Implemented the requested Claude Code change.", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    const executor = createClaudeCodeExecutor({
      runner,
      permissionMode: "acceptEdits",
      model: "sonnet"
    });
    await expect(
      executor.canRun({
        runId: "run_1",
        workspacePath: "/tmp/demo",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
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
          summary: "Use the linked issue and propose the narrowest fix.",
          sourcePointers: [{ provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }],
          intent: {
            rawText: "fix this",
            normalizedIntent: "fix",
            requestedBy: { provider: "github", providerUserId: "42", handle: "octocat" }
          },
          sources: [
            {
              pointer: { provider: "github", kind: "issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" },
              role: "primary",
              included: true,
              reason: "The issue is the main source for the request."
            }
          ],
          facts: [{ text: "The failing test is flaky in CI." }],
          exclusions: ["Do not modify unrelated callback code."]
        },
        permissions: [{ scope: "repo:write", reason: "commit code changes on an isolated run branch" }],
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
    const claudePrintCall = calls.find((call) => call.command === "claude" && call.args.includes("--print"));
    expect(
      calls.some(
        (call) => call.command === "git" && call.args.join(" ") === `worktree add -B opentag/run_1 ${worktreePath} main`
      )
    ).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "clean -fd -- .claude")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "add -- src/demo.ts test/demo.test.ts")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "commit -m OpenTag run run_1")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === `worktree remove --force ${worktreePath}`)).toBe(true);
    expect(claudePrintCall?.cwd).toBe(worktreePath);
    expect(claudePrintCall?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudePrintCall?.args).toContain("--input-format");
    expect(claudePrintCall?.args).toContain("text");
    expect(claudePrintCall?.args).toContain("--output-format");
    expect(claudePrintCall?.args).toContain("--no-session-persistence");
    expect(claudePrintCall?.args).toContain("--permission-mode");
    expect(claudePrintCall?.args).toContain("acceptEdits");
    expect(claudePrintCall?.args).toContain("--model");
    expect(claudePrintCall?.args).toContain("sonnet");
    expect(claudePrintCall?.args).not.toContain("--dangerously-skip-permissions");
    expect(claudePrintCall?.input).toContain("OpenTag context packet:");
    expect(claudePrintCall?.input).toContain("Use the linked issue and propose the narrowest fix.");
    expect(claudePrintCall?.input).toContain("intent: fix");
    expect(claudePrintCall?.input).toContain("[primary] github.issue: https://github.com/acme/demo/issues/1");
    expect(claudePrintCall?.input).toContain("Do not modify unrelated callback code.");
    expect(claudePrintCall?.input).toContain("fix this");
    expect(claudePrintCall?.input).toContain("OpenTag owns the source-control handoff after you finish.");
    expect(claudePrintCall?.input).toContain("Do not run, request, or recommend git add, git commit, git push, or gh pr create.");
    expect(claudePrintCall?.input).toContain("OpenTag will publish the run branch and expose pull-request creation as a suggested action.");
    expect(claudePrintCall?.input).toContain("OPENTAG_EXECUTOR_REPORT_START");
    expect(claudePrintCall?.input).toContain('"outcome": "passed"');
    expect(claudePrintCall?.input).toContain("OPENTAG_EXECUTOR_REPORT_END");
    expect(events).toEqual([
      "executor.started",
      "executor.progress",
      "executor.progress",
      "executor.progress",
      "executor.completed"
    ]);
    expect(result.changedFiles).toEqual(["src/demo.ts", "test/demo.test.ts"]);
    expect(result.summary).toContain("Implemented the requested Claude Code change.");
    expect(result.suggestedChanges?.[0]).toMatchObject({
      proposalId: "proposal_run_1",
      sourceRunId: "run_1",
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
    expect(result.verification).toBeUndefined();
    expect(result.suggestedChanges?.[0]?.intents[0]?.params?.["body"]).not.toContain("claude --print");
    expect(result.suggestedChanges?.[0]?.intents[0]?.params?.["verification"]).toBeUndefined();
    expect(result.nextAction).toMatchObject({
      hint: {
        kind: "create_pull_request",
        selectedIntentIds: ["proposal_run_1_create_pr"]
      }
    });
  });

  it("blocks write-capable commands without a repo:write permission grant", async () => {
    const runner: CommandRunner = {
      async run() {
        throw new Error("no command should run when the security assessment blocks");
      }
    };

    const events: { type: string; message: string }[] = [];
    const result = await createClaudeCodeExecutor({ runner }).run(
      {
        runId: "run_blocked",
        workspacePath: "/tmp/demo",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      },
      {
        emit: async (event) => {
          events.push({ type: event.type, message: event.message });
        }
      }
    );

    expect(result.conclusion).toBe("needs_human");
    expect(result.summary).toContain("permission.repo_write_required");
    expect(events.some((event) => event.type === "executor.failed")).toBe(true);
  });

  it("uses Claude plan permission mode for runs without repo:write", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "git" && args.join(" ") === "-c core.quotePath=false status --porcelain -z") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && (args[0] === "worktree" || args[0] === "branch")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "claude" && args.includes("--print")) {
          return { exitCode: 0, stdout: "Read-only analysis complete.", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    await createClaudeCodeExecutor({ runner, permissionMode: "acceptEdits" }).run(
      {
        runId: "run_read_only",
        workspacePath: "/tmp/demo",
        command: { rawText: "investigate this", intent: "investigate", args: {} },
        context: [],
        permissions: [
          { scope: "repo:read", reason: "inspect repository" },
          { scope: "pr:update", reason: "request reviewers after approval" }
        ],
        baseBranch: "main",
        keepWorktree: "on_failure"
      },
      { emit: async () => undefined }
    );

    const claudePrintCall = calls.find((call) => call.command === "claude" && call.args.includes("--print"));
    expect(claudePrintCall?.args).toContain("--permission-mode");
    expect(claudePrintCall?.args).toContain("plan");
    expect(claudePrintCall?.args).not.toContain("acceptEdits");
    expect(claudePrintCall?.args).not.toContain("--dangerously-skip-permissions");
  });

  it("emits an audit warning when --dangerously-skip-permissions is enabled", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "git" && args.join(" ") === "-c core.quotePath=false status --porcelain -z") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && (args[0] === "worktree" || args[0] === "branch")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "claude" && args.includes("--print")) {
          return { exitCode: 0, stdout: "Answered without changes.", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    const events: { type: string; message: string }[] = [];
    await createClaudeCodeExecutor({ runner, dangerouslySkipPermissions: true }).run(
      {
        runId: "run_skip",
        workspacePath: "/tmp/demo",
        command: { rawText: "summarize this repo", intent: "unknown", args: {} },
        context: [],
        permissions: [{ scope: "repo:write", reason: "allow write-capable Claude mode" }],
        baseBranch: "main",
        keepWorktree: "on_failure"
      },
      {
        emit: async (event) => {
          events.push({ type: event.type, message: event.message });
        }
      }
    );

    const claudePrintCall = calls.find((call) => call.command === "claude" && call.args.includes("--print"));
    expect(claudePrintCall?.args).toContain("--dangerously-skip-permissions");
    expect(
      events.some(
        (event) => event.type === "executor.progress" && event.message.includes("--dangerously-skip-permissions")
      )
    ).toBe(true);
  });

  it("returns not ready when the base branch is missing", async () => {
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "claude" && args.includes("--version")) {
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
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
      createClaudeCodeExecutor({ runner }).canRun({
        runId: "run_1",
        workspacePath: "/tmp/demo",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      })
    ).resolves.toEqual({ ready: false, reason: "Base branch 'main' is not available: fatal: Needed a single revision\n" });
  });

  it("returns not ready when the Claude Code CLI is missing", async () => {
    const runner: CommandRunner = {
      async run(command) {
        if (command === "claude") {
          throw new Error("spawn claude ENOENT");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      createClaudeCodeExecutor({ runner }).canRun({
        runId: "run_1",
        workspacePath: "/tmp/demo",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      })
    ).resolves.toEqual({ ready: false, reason: "Claude Code CLI is not available: spawn claude ENOENT" });
  });
});
