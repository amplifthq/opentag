import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "@opentag/runner";
import { createEchoExecutor } from "@opentag/runner";
import { doctorHasFailures, formatDoctorChecks, runDoctor } from "../src/doctor.js";

describe("opentagd doctor", () => {
  it("reports healthy dispatcher, runner, repo binding, and executor readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "opentagd-doctor-"));
    const checkoutPath = join(root, "demo");
    mkdirSync(checkoutPath, { recursive: true });
    writeFileSync(join(checkoutPath, ".git"), "gitdir: /tmp/fake-git\n");

    const commandRunner: CommandRunner = {
      async run(command, args, options) {
        if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") {
          return { exitCode: 0, stdout: "true\n", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "status --porcelain") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
      }
    };

    const checks = await runDoctor({
      config: {
        runnerId: "runner_local",
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
        githubToken: "ghs_test",
        pollIntervalMs: 5000,
        heartbeatIntervalMs: 15000
      },
      executors: { echo: createEchoExecutor() },
      commandRunner,
      fetchImpl: async (url) => {
        const stringUrl = String(url);
        if (stringUrl.endsWith("/healthz")) {
          return Response.json({ ok: true });
        }
        if (stringUrl.endsWith("/v1/runners/runner_local")) {
          return Response.json({
            runner: { runnerId: "runner_local", name: "Local Runner", createdAt: "2026-06-24T00:00:00.000Z" }
          });
        }
        if (stringUrl.endsWith("/v1/repo-bindings/github/acme/demo")) {
          return Response.json({
            binding: {
              provider: "github",
              owner: "acme",
              repo: "demo",
              runnerId: "runner_local",
              workspacePath: checkoutPath,
              defaultExecutor: "echo"
            }
          });
        }
        if (stringUrl.endsWith("/v1/slack-channel-bindings/T123/C123")) {
          return Response.json({
            binding: {
              teamId: "T123",
              channelId: "C123",
              owner: "acme",
              repo: "demo"
            }
          });
        }
        return new Response("not found", { status: 404 });
      }
    });

    expect(doctorHasFailures(checks)).toBe(false);
    expect(formatDoctorChecks(checks)).toContain("OK");

    rmSync(root, { recursive: true, force: true });
  });
});
