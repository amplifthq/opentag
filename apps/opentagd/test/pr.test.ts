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

const slackEvent: OpenTagEvent = {
  ...event,
  id: "evt_slack_1",
  source: "slack",
  sourceEventId: "Ev123",
  actor: { provider: "slack", providerUserId: "U456", organizationId: "T123" },
  target: { mention: "<@U_APP>", agentId: "opentag" },
  permissions: [
    { scope: "chat:postMessage", reason: "reply in the originating Slack thread" },
    { scope: "runner:local", reason: "execute the run on a paired local daemon" },
    { scope: "repo:read", reason: "inspect the repository in the paired local checkout" },
    { scope: "repo:write", reason: "commit code changes on an isolated run branch" },
    { scope: "pr:create", reason: "open a pull request for completed code changes" }
  ],
  callback: {
    provider: "slack",
    uri: "https://slack.com/api/chat.postMessage",
    threadKey: "T123|C123|1710000000.000100"
  },
  metadata: {
    teamId: "T123",
    channelId: "C123",
    messageTs: "1710000000.000100",
    repoProvider: "github",
    owner: "acme",
    repo: "demo"
  }
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

  it("creates a GitHub pull request for Slack runs mapped to a GitHub repository", async () => {
    const commands: string[] = [];
    const requests: string[] = [];
    const updated = await maybeCreatePullRequest({
      run,
      event: slackEvent,
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
          return Response.json({ html_url: "https://github.com/acme/demo/pull/2" });
        }) as typeof fetch
      }
    });

    expect(commands).toEqual(["git push -u origin opentag/run_1"]);
    expect(requests).toEqual(["https://api.github.com/repos/acme/demo/pulls"]);
    expect(updated.createdPullRequestUrl).toBe("https://github.com/acme/demo/pull/2");
    expect(updated.artifacts).toContainEqual({ title: "Pull request", uri: "https://github.com/acme/demo/pull/2" });
  });

  it("treats a null repoProvider as the default GitHub repository target", async () => {
    const commands: string[] = [];
    const requests: string[] = [];
    const updated = await maybeCreatePullRequest({
      run,
      event: {
        ...slackEvent,
        metadata: {
          ...slackEvent.metadata,
          repoProvider: null
        }
      },
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
          return Response.json({ html_url: "https://github.com/acme/demo/pull/3" });
        }) as typeof fetch
      }
    });

    expect(commands).toEqual(["git push -u origin opentag/run_1"]);
    expect(requests).toEqual(["https://api.github.com/repos/acme/demo/pulls"]);
    expect(updated.createdPullRequestUrl).toBe("https://github.com/acme/demo/pull/3");
  });

  it("does not create a GitHub pull request for non-GitHub repository targets", async () => {
    await expect(
      maybeCreatePullRequest({
        run,
        event: {
          ...slackEvent,
          metadata: {
            ...slackEvent.metadata,
            repoProvider: "gitlab"
          }
        },
        binding: { provider: "github", owner: "acme", repo: "demo", checkoutPath: "/tmp/demo" },
        result,
        options: {
          githubToken: "ghs_test",
          commandRunner: {
            async run() {
              throw new Error("should not push a branch");
            }
          },
          fetchImpl: (async () => {
            throw new Error("should not create a pull request");
          }) as typeof fetch
        }
      })
    ).resolves.toBe(result);
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
