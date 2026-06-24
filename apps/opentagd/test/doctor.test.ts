import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner, ExecutorAdapter } from "@opentag/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorHasFailures, formatDoctorChecks, runDoctor } from "../src/doctor.js";

let checkoutPath: string;

const readyExecutor: ExecutorAdapter = {
  id: "echo",
  displayName: "Echo Executor",
  async canRun() {
    return { ready: true };
  },
  async run() {
    return { conclusion: "success", summary: "ok" };
  },
  async cancel() {
    return;
  }
};

const readyGit: CommandRunner = {
  async run(command, args) {
    if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
  }
};

function fakeDispatcherFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname === "/healthz") {
    return Promise.resolve(Response.json({ ok: true }));
  }
  if (url.pathname === "/v1/runners/runner_1") {
    return Promise.resolve(
      Response.json({
        runner: {
          runnerId: "runner_1",
          name: "Local Runner",
          createdAt: "2026-06-24T00:00:00.000Z"
        }
      })
    );
  }
  if (url.pathname === "/v1/repo-bindings/github/acme/demo") {
    return Promise.resolve(
      Response.json({
        binding: {
          provider: "github",
          owner: "acme",
          repo: "demo",
          runnerId: "runner_1",
          workspacePath: checkoutPath,
          defaultExecutor: "echo"
        }
      })
    );
  }
  if (url.pathname === "/v1/slack-channel-bindings/T123/C123") {
    return Promise.resolve(
      Response.json({
        binding: {
          teamId: "T123",
          channelId: "C123",
          owner: "acme",
          repo: "demo"
        }
      })
    );
  }
  return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
}

describe("opentagd doctor", () => {
  beforeEach(() => {
    checkoutPath = mkdtempSync(join(tmpdir(), "opentagd-doctor-"));
  });

  afterEach(() => {
    rmSync(checkoutPath, { recursive: true, force: true });
  });

  it("checks dispatcher, runner, checkout, executor, bindings, and optional tokens", async () => {
    const checks = await runDoctor({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "http://dispatcher.test",
        repositories: [
          {
            provider: "github",
            owner: "acme",
            repo: "demo",
            checkoutPath,
            defaultExecutor: "echo",
            baseBranch: "main",
            pushRemote: "origin",
            keepWorktree: "on_failure"
          }
        ],
        slackChannels: [{ teamId: "T123", channelId: "C123", owner: "acme", repo: "demo" }],
        pollIntervalMs: 5000,
        heartbeatIntervalMs: 15000
      },
      executors: { echo: readyExecutor },
      commandRunner: readyGit,
      fetchImpl: fakeDispatcherFetch as typeof fetch
    });

    expect(doctorHasFailures(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain("OK   dispatcher health");
    expect(checks.map((item) => item.name)).toEqual([
      "dispatcher health",
      "runner registration",
      "acme/demo checkout",
      "acme/demo git repo",
      "echo executor",
      "acme/demo binding",
      "T123/C123 Slack binding",
      "GitHub token"
    ]);
    expect(checks.at(-1)).toMatchObject({ status: "warn", name: "GitHub token" });
  });

  it("fails when the configured executor is not available locally", async () => {
    const checks = await runDoctor({
      config: {
        runnerId: "runner_1",
        dispatcherUrl: "http://dispatcher.test",
        repositories: [
          {
            provider: "github",
            owner: "acme",
            repo: "demo",
            checkoutPath,
            defaultExecutor: "codex",
            baseBranch: "main",
            pushRemote: "origin",
            keepWorktree: "on_failure"
          }
        ],
        pollIntervalMs: 5000,
        heartbeatIntervalMs: 15000
      },
      executors: { echo: readyExecutor },
      commandRunner: readyGit,
      fetchImpl: fakeDispatcherFetch as typeof fetch
    });

    expect(doctorHasFailures(checks)).toBe(true);
    expect(checks).toContainEqual({
      status: "fail",
      name: "codex executor",
      message: "No local executor is configured with this id."
    });
  });
});
