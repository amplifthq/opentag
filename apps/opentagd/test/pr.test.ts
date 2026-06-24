import type { OpenTagEvent, OpenTagRun, OpenTagRunResult } from "@opentag/core";
import { describe, expect, it } from "vitest";
import { maybeCreatePullRequest } from "../src/pr.js";

const run: OpenTagRun = {
  id: "run_1",
  eventId: "evt_1",
  status: "running",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z"
};

const event: OpenTagEvent = {
  id: "evt_1",
  source: "github",
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github", providerUserId: "42" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix", args: {} },
  context: [],
  permissions: [
    { scope: "issue:comment", reason: "reply to source thread" },
    { scope: "pr:create", reason: "open a pull request for code changes" }
  ],
  callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

const result: OpenTagRunResult = {
  conclusion: "success",
  summary: "Implemented the fix.",
  changedFiles: ["src/demo.ts"]
};

describe("maybeCreatePullRequest", () => {
  it("pushes the run branch and creates a GitHub pull request when allowed", async () => {
    const commands: string[] = [];
    const requests: string[] = [];
    const updated = await maybeCreatePullRequest({
      run,
      event,
      binding: {
        provider: "github",
        owner: "acme",
        repo: "demo",
        checkoutPath: "/tmp/demo",
        baseBranch: "main",
        pushRemote: "origin"
      },
      result,
      options: {
        githubToken: "ghs_test",
        commandRunner: {
          async run(command, args) {
            commands.push(`${command} ${args.join(" ")}`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        },
        fetchImpl: (async (url) => {
          requests.push(String(url));
          return Response.json({ html_url: "https://github.com/acme/demo/pull/1" });
        }) as typeof fetch
      }
    });

    expect(commands).toEqual(["git push -u origin opentag/run_1"]);
    expect(requests).toEqual(["https://api.github.com/repos/acme/demo/pulls"]);
    expect(updated.createdPullRequestUrl).toBe("https://github.com/acme/demo/pull/1");
    expect(updated.nextAction).toContain("https://github.com/acme/demo/pull/1");
  });

  it("leaves the result unchanged without a GitHub token", async () => {
    await expect(
      maybeCreatePullRequest({
        run,
        event,
        binding: { provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" },
        result,
        options: {}
      })
    ).resolves.toBe(result);
  });
});
