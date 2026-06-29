import { describe, expect, it } from "vitest";
import { createClaudeCodeExecutor } from "../src/claude-code.js";
import type { CommandRunner } from "../src/command.js";

describe("Claude Code executor", () => {
  it("creates an isolated branch, runs claude print mode, and reports changed files", async () => {
    const calls: { command: string; args: string[]; input?: string }[] = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, input: options?.input });
        if (command === "claude" && args.includes("--version")) {
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        }
        // The canRun dirty-check uses plain `status --porcelain`; the git
        // helpers (cleanup + changedFiles) use the NUL-delimited `-z` form.
        if (command === "git" && args.join(" ") === "status --porcelain") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "-c core.quotePath=false status --porcelain -z") {
          return calls.some((call) => call.command === "git" && call.args.join(" ") === "clean -fd -- .claude")
            ? { exitCode: 0, stdout: " M src/demo.ts\0?? test/demo.test.ts\0", stderr: "" }
            : { exitCode: 0, stdout: "?? .claude/\0 M src/demo.ts\0?? test/demo.test.ts\0", stderr: "" };
        }
        if (command === "git" && args[0] === "checkout") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "clean -fd -- .claude") {
          return { exitCode: 0, stdout: "Removing .claude/\n", stderr: "" };
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
        baseBranch: "main"
      },
      {
        emit: async (event) => {
          events.push(event.type);
        }
      }
    );

    const claudePrintCall = calls.find((call) => call.command === "claude" && call.args.includes("--print"));
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "checkout -B opentag/run_1 main")).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "clean -fd -- .claude")).toBe(true);
    expect(claudePrintCall?.args).toContain("--input-format");
    expect(claudePrintCall?.args).toContain("text");
    expect(claudePrintCall?.args).toContain("--output-format");
    expect(claudePrintCall?.args).toContain("--no-session-persistence");
    expect(claudePrintCall?.args).toContain("--permission-mode");
    expect(claudePrintCall?.args).toContain("acceptEdits");
    expect(claudePrintCall?.args).toContain("--model");
    expect(claudePrintCall?.args).toContain("sonnet");
    expect(claudePrintCall?.input).toContain("OpenTag context packet:");
    expect(claudePrintCall?.input).toContain("Use the linked issue and propose the narrowest fix.");
    expect(claudePrintCall?.input).toContain("intent: fix");
    expect(claudePrintCall?.input).toContain("[primary] github.issue: https://github.com/acme/demo/issues/1");
    expect(claudePrintCall?.input).toContain("Do not modify unrelated callback code.");
    expect(claudePrintCall?.input).toContain("fix this");
    expect(events).toEqual(["executor.started", "executor.progress", "executor.progress", "executor.completed"]);
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

  it("refuses to run when the workspace has uncommitted changes", async () => {
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "claude" && args.includes("--version")) {
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "status --porcelain") {
          return { exitCode: 0, stdout: " M dirty.ts\n", stderr: "" };
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
    ).resolves.toEqual({ ready: false, reason: "Workspace has uncommitted changes; refusing to run Claude Code executor." });
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
