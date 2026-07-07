import { describe, expect, it } from "vitest";
import { createOpenclawExecutor } from "../src/openclaw.js";
import type { CommandRunner } from "../src/command.js";
import { EXECUTOR_REPORT_END, EXECUTOR_REPORT_START } from "../src/executor-report.js";

describe("OpenClaw executor", () => {
  it("creates an isolated branch, runs an OpenClaw agent turn with context, and reports changed files", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joinedArgs = args.join(" ");

        if (command === "openclaw" && args.includes("--version")) {
          return { exitCode: 0, stdout: "OpenClaw 1.0.0", stderr: "" };
        }

        if (command === "git" && joinedArgs === "status --porcelain") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        if (command === "git" && joinedArgs === "-c core.quotePath=false status --porcelain -z") {
          return calls.some((call) => call.command === "openclaw" && call.args[0] === "agent")
            ? { exitCode: 0, stdout: " M src/demo.ts\0?? test/demo.test.ts\0", stderr: "" }
            : { exitCode: 0, stdout: "", stderr: "" };
        }

        if (command === "git" && joinedArgs === "checkout -B opentag/run_1 main") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        if (command === "openclaw" && args[0] === "agent") {
          return { exitCode: 0, stdout: "Implemented the requested OpenClaw change.", stderr: "" };
        }

        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    const executor = createOpenclawExecutor({ runner });

    await expect(
      executor.canRun({
        runId: "run_1",
        workspacePath: "/tmp/demo",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      })
    ).resolves.toEqual({ ready: true });

    const result = await executor.run({
      runId: "run_1",
      workspacePath: "/tmp/demo",
      command: { rawText: "fix this", intent: "fix", args: {} },
      context: [{ kind: "github.issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }],
      contextPacket: {
        summary: "Use the linked issue and propose the narrowest fix.",
        sourcePointers: [{ kind: "github.issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" }],
        intent: {
          rawText: "fix this",
          normalizedIntent: "fix",
          requestedBy: { provider: "github", providerUserId: "42", handle: "octocat" }
        },
        sources: [
          {
            pointer: { kind: "github.issue", uri: "https://github.com/acme/demo/issues/1", visibility: "public" },
            role: "primary",
            included: true,
            reason: "The issue is the main source for the request."
          }
        ],
        facts: [{ text: "The failing test is flaky in CI." }],
        exclusions: ["Do not modify unrelated callback code."]
      },
      baseBranch: "main",
      metadata: { provider: "slack", accountId: "T123", conversationId: 456 }
    }, {
      emit: async () => {}
    });

    const openclawCall = calls.find((call) => call.command === "openclaw" && call.args[0] === "agent");
    const prompt = openclawCall?.args[openclawCall.args.indexOf("-m") + 1];

    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "checkout -B opentag/run_1 main")).toBe(true);
    expect(openclawCall?.args).toContain("--agent");
    expect(openclawCall?.args).toContain("main");
    expect(openclawCall?.args).toContain("--session-key");
    expect(openclawCall?.args).toContain("opentag");
    expect(openclawCall?.args).not.toContain("--deliver");
    expect(openclawCall?.args).not.toContain("--model");

    expect(prompt).toContain("OpenTag context packet:");
    expect(prompt).toContain("Use the linked issue and propose the narrowest fix.");
    expect(prompt).toContain("fix this");
    expect(prompt).toContain("The failing test is flaky in CI.");
    expect(prompt).toContain("Do not modify unrelated callback code.");
    expect(prompt).toContain("https://github.com/acme/demo/issues/1");
    expect(prompt).toContain("OpenTag owns the source-control handoff after you finish.");
    expect(prompt).toContain(EXECUTOR_REPORT_START);
    expect(prompt).toContain(EXECUTOR_REPORT_END);

    expect(result.changedFiles).toEqual(["src/demo.ts", "test/demo.test.ts"]);
    expect(result.summary).toContain("Implemented the requested OpenClaw change.");
    expect(result.artifacts).toEqual([
      expect.objectContaining({ kind: "patch", title: "Generated patch", uri: "opentag/run_1" }),
      expect.objectContaining({ kind: "report", title: "Run report", uri: "opentag://run/run_1/report" }),
      expect.objectContaining({ kind: "log_summary", title: "Log summary", uri: "opentag://run/run_1/log-summary" })
    ]);
  });

  it("returns not ready when the OpenClaw CLI is missing", async () => {
    const runner: CommandRunner = {
      async run(command) {
        if (command === "openclaw") {
          throw new Error("spawn openclaw ENOENT");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      createOpenclawExecutor({ runner }).canRun({
        runId: "run_1",
        workspacePath: "/tmp/demo",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      })
    ).resolves.toEqual({ ready: false, reason: "OpenClaw CLI is not available: spawn openclaw ENOENT" });
  });

  it("returns not ready when git status throws", async () => {
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "openclaw" && args.includes("--version")) {
          return { exitCode: 0, stdout: "OpenClaw 1.0.0", stderr: "" };
        }
        throw new Error("bad cwd");
      }
    };

    await expect(
      createOpenclawExecutor({ runner }).canRun({
        runId: "run_1",
        workspacePath: "/tmp/missing",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      })
    ).resolves.toEqual({ ready: false, reason: "Workspace is not a git checkout: bad cwd" });
  });

  it("honors configured command, agent, and session key overrides", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joinedArgs = args.join(" ");

        if (command === "git" && args[0] === "checkout") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "/opt/tools/openclaw" && args[0] === "agent") {
          return { exitCode: 0, stdout: "done", stderr: "" };
        }
        if (command === "git" && joinedArgs === "-c core.quotePath=false status --porcelain -z") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    await createOpenclawExecutor({
      runner,
      openclawCommand: "/opt/tools/openclaw",
      agent: "ops",
      sessionKey: "opentag-ops"
    }).run({
      runId: "run_1",
      workspacePath: "/tmp/demo",
      command: { rawText: "fix this", intent: "fix", args: {} },
      context: []
    }, {
      emit: async () => {}
    });

    const openclawCall = calls.find((call) => call.command === "/opt/tools/openclaw" && call.args[0] === "agent");
    expect(openclawCall?.args).toContain("--agent");
    expect(openclawCall?.args).toContain("ops");
    expect(openclawCall?.args).toContain("--session-key");
    expect(openclawCall?.args).toContain("opentag-ops");
  });

  it("cleans internal artifacts when OpenClaw exits unsuccessfully", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joinedArgs = args.join(" ");

        if (command === "git" && args[0] === "checkout") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "openclaw" && args[0] === "agent") {
          return { exitCode: 1, stdout: "", stderr: "failed" };
        }
        if (command === "git" && joinedArgs === "-c core.quotePath=false status --porcelain -z") {
          return { exitCode: 0, stdout: "?? .omx/session.json\0", stderr: "" };
        }
        if (command === "git" && joinedArgs === "clean -fd -- .omx") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    await expect(
      createOpenclawExecutor({ runner }).run({
        runId: "run_1",
        workspacePath: "/tmp/demo",
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      }, {
        emit: async () => {}
      })
    ).rejects.toThrow("openclaw agent failed with exit code 1: failed");

    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "clean -fd -- .omx")).toBe(true);
  });
});
