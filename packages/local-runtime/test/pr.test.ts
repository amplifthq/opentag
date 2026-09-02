import { describe, expect, it, vi } from "vitest";
import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import { maybeCreatePullRequest } from "../src/pr.js";

describe("legacy automatic pull-request compatibility", () => {
  it("returns the executor result without git or provider side effects", async () => {
    const commandRunner = {
      run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    };
    const fetchImpl = vi.fn<typeof fetch>();
    const event: OpenTagEvent = {
      id: "event_1",
      source: "github",
      sourceEventId: "delivery_1",
      receivedAt: "2026-08-10T00:00:00.000Z",
      actor: { provider: "github", providerUserId: "user_1", handle: "octocat" },
      target: { mention: "@opentag", agentId: "opentag" },
      command: { rawText: "fix it", intent: "fix", args: {} },
      context: [],
      permissions: [{ scope: "pr:create", reason: "requested" }],
      callback: { provider: "github", uri: "https://example.test/callback" },
      metadata: { repoProvider: "github", owner: "acme", repo: "widget" },
    };
    const run: OpenTagRun = {
      id: "run_1",
      eventId: event.id,
      status: "running",
      createdAt: event.receivedAt,
      updatedAt: event.receivedAt,
    };
    const result: OpenTagRunResult = {
      conclusion: "success",
      summary: "updated",
      changedFiles: ["README.md"],
    };

    await expect(maybeCreatePullRequest({
      run,
      event,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "widget",
        checkoutPath: "/tmp/widget",
        baseBranch: "main",
        pushRemote: "origin",
      },
      result,
      options: {
        githubToken: "ghs_legacy",
        preparePullRequestBranch: true,
        allowAutoCreatePullRequest: true,
        commandRunner,
        fetchImpl,
      },
    })).resolves.toBe(result);
    expect(commandRunner.run).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
