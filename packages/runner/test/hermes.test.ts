import { describe, expect, it } from "vitest";
import { createHermesExecutor } from "../src/hermes.js";
import type { CommandRunner } from "../src/command.js";
import { EXECUTOR_REPORT_END, EXECUTOR_REPORT_START } from "../src/executor-report.js";

describe("Hermes executor", () => {
  it("creates an isolated branch, runs Hermes with a fixed profile and context, and reports changed files", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joinedArgs = args.join(" ");

        if (command === "hermes" && args.includes("--version")) {
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        }

        if (command === "git" && joinedArgs === "status --porcelain") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        if (command === "git" && joinedArgs === "-c core.quotePath=false status --porcelain -z") {
          return calls.some((call) => call.command === "hermes" && call.args.includes("-z"))
            ? { exitCode: 0, stdout: " M src/demo.ts\0?? test/demo.test.ts\0", stderr: "" }
            : { exitCode: 0, stdout: "", stderr: "" };
        }

        if (command === "git" && joinedArgs === "checkout -B opentag/run_1 main") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        if (command === "hermes" && args.includes("-z")) {
          return { exitCode: 0, stdout: "Implemented the requested Hermes change.", stderr: "" };
        }

        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    const executor = createHermesExecutor({
      runner,
      profile: "opentag-fixed"
    });

    await expect(
      executor.canRun({
        runId: "run_1",
        workspace: { kind: "repository", path: "/tmp/demo" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [],
        metadata: { provider: "slack", accountId: "T123", conversationId: 456 }
      })
    ).resolves.toEqual({ ready: true });

    const result = await executor.run({
      runId: "run_1",
      workspace: { kind: "repository", path: "/tmp/demo" },
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

    const hermesCall = calls.find((call) => call.command === "hermes" && call.args.includes("-z"));
    const prompt = hermesCall?.args[hermesCall.args.indexOf("-z") + 1];

    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "checkout -B opentag/run_1 main")).toBe(true);
    expect(calls).toContainEqual({ command: "hermes", args: ["-p", "opentag-fixed", "--version"] });
    expect(hermesCall?.args.slice(0, 3)).toEqual(["-p", "opentag-fixed", "-z"]);
    expect(hermesCall?.args).not.toContain("--provider");
    expect(hermesCall?.args).not.toContain("--model");
    expect(hermesCall?.args).not.toContain("-s");

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
    expect(result.summary).toContain("Implemented the requested Hermes change.");
    expect(result.artifacts).toEqual([
      expect.objectContaining({ kind: "patch", title: "Generated patch", uri: "opentag/run_1" }),
      expect.objectContaining({ kind: "report", title: "Run report", uri: "opentag://run/run_1/report" }),
      expect.objectContaining({ kind: "log_summary", title: "Log summary", uri: "opentag://run/run_1/log-summary" })
    ]);
  });

  it("returns not ready when git status throws", async () => {
    const runner: CommandRunner = {
      async run(command, args) {
        if (command === "hermes" && args.includes("--version")) {
          return { exitCode: 0, stdout: "1.0.0", stderr: "" };
        }
        throw new Error("bad cwd");
      }
    };

    await expect(
      createHermesExecutor({ runner }).canRun({
        runId: "run_1",
        workspace: { kind: "repository", path: "/tmp/missing" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      })
    ).resolves.toEqual({ ready: false, reason: "Workspace is not a git checkout: bad cwd" });
  });

  it("fails readiness with actionable guidance when the fixed profile is unavailable", async () => {
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        return { exitCode: 1, stdout: "", stderr: "Profile 'opentag' does not exist" };
      }
    };

    await expect(
      createHermesExecutor({ runner }).canRun({
        runId: "run_1",
        workspace: { kind: "scratch", path: "/tmp/demo" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      })
    ).resolves.toEqual({
      ready: false,
      reason:
        "Hermes profile 'opentag' is not ready: Profile 'opentag' does not exist " +
        "Create it with `hermes profile create opentag` or configure daemon.hermes.profile to an existing dedicated profile."
    });
    expect(calls).toEqual([{ command: "hermes", args: ["-p", "opentag", "--version"], cwd: "/tmp/demo" }]);
  });

  it("uses the fixed default profile instead of a derived agent session profile", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joinedArgs = args.join(" ");

        if (command === "git" && args[0] === "checkout") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "hermes" && args.includes("-z")) {
          return { exitCode: 0, stdout: "done", stderr: "" };
        }
        if (command === "git" && joinedArgs === "-c core.quotePath=false status --porcelain -z") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    await createHermesExecutor({ runner }).run({
      runId: "run_1",
      workspace: { kind: "repository", path: "/tmp/demo" },
      command: { rawText: "fix this", intent: "fix", args: {} },
      context: [],
      sessionProfile: {
        id: "opentag-slack-T123-C456-acme-demo-U123",
        template: "opentag-{provider}-{accountId}-{conversationId}-{owner}-{repo}-{actorId}",
        sourceProvider: "slack",
        projectTarget: "github:acme/demo"
      }
    }, {
      emit: async () => {}
    });

    const hermesCall = calls.find((call) => call.command === "hermes" && call.args.includes("-z"));
    expect(hermesCall?.args.slice(0, 3)).toEqual(["-p", "opentag", "-z"]);
    expect(hermesCall?.args).not.toContain("opentag-slack-T123-C456-acme-demo-U123");
  });

  it("cleans internal artifacts when Hermes exits unsuccessfully", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        const joinedArgs = args.join(" ");

        if (command === "git" && args[0] === "checkout") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "hermes" && args.includes("-z")) {
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
      createHermesExecutor({ runner }).run({
        runId: "run_1",
        workspace: { kind: "repository", path: "/tmp/demo" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: []
      }, {
        emit: async () => {}
      })
    ).rejects.toThrow("hermes -z failed with exit code 1: failed");

    expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "clean -fd -- .omx")).toBe(true);
  });
});
