import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/command.js";
import { createProtocolExecutor, defaultProtocolSessionKey } from "../src/protocol-executor.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `opentag-${name}-`));
  tempRoots.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initGitRepo(): string {
  const repo = tempDir("protocol-repo");
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.email", "opentag@example.test"]);
  runGit(repo, ["config", "user.name", "OpenTag Test"]);
  writeFileSync(join(repo, "README.md"), "# demo\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial"]);
  return repo;
}

function manifestForFixture(fixture: string) {
  return {
    protocol: "opentag.integration.v1" as const,
    id: "fake-protocol",
    label: "Fake Protocol",
    bindings: {
      executorStdio: {
        kind: "stdio-jsonl" as const,
        command: process.execPath,
        args: [join(fixturesDir, fixture)]
      }
    },
    roles: {
      executor: {
        protocol: "opentag.executor.v1" as const,
        profile: "stdio-jsonl-basic" as const,
        binding: "executorStdio",
        capabilities: {
          workspaceIsolation: "worktree" as const,
          conversationAccess: "request" as const,
          progressEvents: "audit" as const,
          supportsCancel: false,
          supportsStreaming: false
        }
      }
    }
  };
}

describe("protocol executor", () => {
  it("runs a stdio-jsonl shim in an isolated worktree and reports changed files", async () => {
    const repo = initGitRepo();
    const executor = createProtocolExecutor({ manifest: manifestForFixture("protocol-shim.mjs") });
    const events: string[] = [];

    const result = await executor.run(
      {
        runId: "run_protocol",
        workspacePath: repo,
        command: { rawText: "write protocol output", intent: "fix", args: {} },
        source: {
          kind: "channel_message",
          channel: { provider: "slack", id: "C123" },
          thread: { provider: "slack", id: "171234.5678" },
          actor: { provider: "slack", id: "U123", displayName: "Ada" }
        },
        targets: {
          repo: { provider: "github", owner: "amplifthq", name: "opentag", defaultBranch: "main" },
          changeRequest: { provider: "github", id: "79", number: 79, title: "Add protocol executor" },
          context: [{ provider: "github", kind: "thread", id: "issue-comment-1" }]
        },
        replyTo: [{ channel: { provider: "slack", id: "C123" }, thread: { provider: "slack", id: "171234.5678" }, purpose: "all" }],
        context: [],
        baseBranch: "main"
      },
      {
        emit: async (event) => {
          events.push(`${event.type}:${event.message}`);
        }
      }
    );

    expect(events).toContain("executor.started:Protocol shim started");
    expect(events).toContain("executor.progress:Protocol shim wrote files");
    expect(result.changedFiles).toEqual(["protocol-output.txt", "protocol-request.json"]);
    expect(result.summary).toContain("Protocol shim completed the run.");
    expect(result.summary).toContain("protocol-shim self-check");

    const branchFile = runGit(repo, ["show", "opentag/run_protocol:protocol-output.txt"]);
    expect(branchFile).toContain("run=run_protocol");
    expect(branchFile).toContain(defaultProtocolSessionKey({ executorId: "fake-protocol", runId: "run_protocol" }));

    const request = JSON.parse(runGit(repo, ["show", "opentag/run_protocol:protocol-request.json"]));
    expect(request.source.channel.provider).toBe("slack");
    expect(request.targets.repo.name).toBe("opentag");
    expect(request.targets.changeRequest.number).toBe(79);
    expect(request.replyTo[0].purpose).toBe("all");
  }, 15_000);

  it("rejects a shim that acknowledges a different actual workspace", async () => {
    const repo = initGitRepo();
    const executor = createProtocolExecutor({ manifest: manifestForFixture("protocol-shim-bad-workspace.mjs") });

    await expect(
      executor.run(
        {
          runId: "run_bad_workspace",
          workspacePath: repo,
          command: { rawText: "write elsewhere", intent: "fix", args: {} },
          context: [],
          baseBranch: "main",
          keepWorktree: "never"
        },
        { emit: async () => undefined }
      )
    ).rejects.toThrow("Refusing to accept changes from an unbound workspace");
  }, 15_000);

  it("uses a per-run default protocol session key", () => {
    expect(defaultProtocolSessionKey({ executorId: "fake protocol", runId: "run/one" })).toBe("opentag:fake-protocol:run-one");
    expect(defaultProtocolSessionKey({ executorId: "fake protocol", runId: "run/two" })).toBe("opentag:fake-protocol:run-two");
  });

  it("preserves a primary child failure when cleanup also fails", async () => {
    const calls: { command: string; args: string[]; cwd?: string }[] = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, cwd: options?.cwd });
        if (command === "git" && args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "fake-shim") {
          return { exitCode: 1, stdout: "", stderr: "child failed" };
        }
        if (command === "git" && args.join(" ") === "-c core.quotePath=false status --porcelain -z") {
          return { exitCode: 1, stdout: "", stderr: "cleanup exploded" };
        }
        if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };
    const manifest = manifestForFixture("protocol-shim.mjs");
    manifest.bindings.executorStdio = { ...manifest.bindings.executorStdio, command: "fake-shim", args: [] };
    const executor = createProtocolExecutor({ manifest, runner });
    const events: string[] = [];
    const repo = tempDir("protocol-mock-repo");

    await expect(
      executor.run(
        {
          runId: "run_cleanup",
          workspacePath: repo,
          command: { rawText: "fail", intent: "fix", args: {} },
          context: [],
          baseBranch: "main",
          keepWorktree: "never"
        },
        {
          emit: async (event) => {
            events.push(event.message);
          }
        }
      )
    ).rejects.toThrow("protocol executor fake-protocol failed with exit code 1: child failed");

    expect(events.some((event) => event.includes("cleanup exploded"))).toBe(true);
    expect(calls.some((call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "remove")).toBe(true);
  });

  it("rejects malformed JSONL output", async () => {
    const repo = initGitRepo();
    const executor = createProtocolExecutor({ manifest: manifestForFixture("protocol-shim-malformed.mjs") });

    await expect(
      executor.run(
        {
          runId: "run_malformed",
          workspacePath: repo,
          command: { rawText: "bad json", intent: "fix", args: {} },
          context: [],
          baseBranch: "main",
          keepWorktree: "never"
        },
        { emit: async () => undefined }
      )
    ).rejects.toThrow("malformed JSONL");
  }, 15_000);

  it("rejects shim output without a final event", async () => {
    const repo = initGitRepo();
    const executor = createProtocolExecutor({ manifest: manifestForFixture("protocol-shim-missing-final.mjs") });

    await expect(
      executor.run(
        {
          runId: "run_missing_final",
          workspacePath: repo,
          command: { rawText: "no final", intent: "fix", args: {} },
          context: [],
          baseBranch: "main",
          keepWorktree: "never"
        },
        { emit: async () => undefined }
      )
    ).rejects.toThrow("without a completed or failed event");
  }, 15_000);

  it("exposes manifest capabilities through the executor contract", () => {
    const executor = createProtocolExecutor({ manifest: manifestForFixture("protocol-shim.mjs") });

    expect(executor.capability).toMatchObject({
      id: "fake-protocol",
      invocation: "spawn",
      progressEvents: "audit",
      promptAssembly: "opentag",
      conversationAccess: "request",
      workspaceIsolation: "worktree"
    });
  });

  it("requires an executor role in the integration manifest", () => {
    const manifest = { ...manifestForFixture("protocol-shim.mjs"), roles: {} };

    expect(() => createProtocolExecutor({ manifest })).toThrow("roles.executor");
  });
});
