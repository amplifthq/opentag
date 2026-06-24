import { describe, expect, it } from "vitest";
import { normalizeGitHubIssueComment, normalizeGitHubPullRequestReviewComment } from "../src/normalize.js";

describe("normalizeGitHubIssueComment", () => {
  it("normalizes an @opentag GitHub issue comment", () => {
    const event = normalizeGitHubIssueComment({
      id: "123",
      commentBody: "@opentag fix this",
      commentUrl: "https://github.com/acme/demo/issues/1#issuecomment-123",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/1/comments",
      issueUrl: "https://github.com/acme/demo/issues/1",
      issueNumber: 1,
      owner: "acme",
      repo: "demo",
      actorId: 42,
      actorLogin: "octocat",
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z",
      installationId: 99
    });

    expect(event?.source).toBe("github");
    expect(event?.command.intent).toBe("fix");
    expect(event?.command.args).toMatchObject({ prompt: "this" });
    expect(event?.permissions.map((permission) => permission.scope)).toContain("pr:create");
    expect(event?.metadata).toMatchObject({ owner: "acme", repo: "demo", issueNumber: 1, installationId: 99 });
  });

  it("maps command parser hints into GitHub event fields", () => {
    const event = normalizeGitHubIssueComment({
      id: "789",
      commentBody: "@opentag review auth changes --file packages/auth/src/index.ts --range 12-30 --scope repo:read --network restricted --executor codex --approval required",
      commentUrl: "https://github.com/acme/demo/issues/3#issuecomment-789",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/3/comments",
      issueUrl: "https://github.com/acme/demo/issues/3",
      issueNumber: 3,
      owner: "acme",
      repo: "demo",
      actorId: 42,
      actorLogin: "octocat",
      private: true,
      receivedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(event?.target.executorHint).toBe("codex");
    expect(event?.command.parsed).toMatchObject({
      prompt: "auth changes",
      approval: "required",
      network: "restricted",
      requestedScopes: ["repo:read", "network:restricted"]
    });
    expect(event?.context).toContainEqual({
      kind: "file",
      uri: "packages/auth/src/index.ts#L12-L30",
      visibility: "private",
      title: "Command file reference"
    });
    expect(event?.permissions.map((permission) => permission.scope)).toContain("network:restricted");
    expect(event?.metadata).toMatchObject({
      commandParser: "v1",
      approval: "required",
      network: "restricted"
    });
  });

  it("normalizes an @opentag pull request review comment", () => {
    const event = normalizeGitHubPullRequestReviewComment({
      id: "456",
      commentBody: "@opentag review this change",
      commentUrl: "https://github.com/acme/demo/pull/2#discussion_r456",
      pullRequestUrl: "https://github.com/acme/demo/pull/2",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/2/comments",
      owner: "acme",
      repo: "demo",
      pullRequestNumber: 2,
      actorId: 42,
      actorLogin: "octocat",
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z",
      installationId: 77
    });

    expect(event?.id).toBe("evt_github_pr_review_comment_456");
    expect(event?.context[0]?.kind).toBe("github.pull_request");
    expect(event?.callback.threadKey).toBe("acme/demo#2");
    expect(event?.metadata).toMatchObject({ pullRequestNumber: 2, installationId: 77 });
  });
});
