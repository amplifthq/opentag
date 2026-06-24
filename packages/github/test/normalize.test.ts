import { describe, expect, it } from "vitest";
import { normalizeGitHubIssueComment } from "../src/normalize.js";

describe("normalizeGitHubIssueComment", () => {
  it("normalizes an @opentag GitHub issue comment", () => {
    const event = normalizeGitHubIssueComment({
      id: "123",
      commentBody: "@opentag fix this",
      commentUrl: "https://github.com/acme/demo/issues/1#issuecomment-123",
      apiCommentsUrl: "https://api.github.com/repos/acme/demo/issues/1/comments",
      issueUrl: "https://github.com/acme/demo/issues/1",
      owner: "acme",
      repo: "demo",
      actorId: 42,
      actorLogin: "octocat",
      private: false,
      receivedAt: "2026-06-24T00:00:00.000Z"
    });

    expect(event?.source).toBe("github");
    expect(event?.command.intent).toBe("fix");
    expect(event?.permissions.map((permission) => permission.scope)).toContain("pr:create");
    expect(event?.metadata).toMatchObject({ owner: "acme", repo: "demo" });
  });
});
