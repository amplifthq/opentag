import { describe, expect, it } from "vitest";
import { linearIssueCallbackUri, linearIssueIdFromCallbackUri, normalizeLinearIssueComment } from "../src/normalize.js";

describe("normalizeLinearIssueComment", () => {
  it("normalizes an @opentag Linear issue comment into an OpenTagEvent", () => {
    const event = normalizeLinearIssueComment({
      id: "comment_1",
      commentBody: "@opentag fix the failing import --file src/app.ts --line 12",
      commentUrl: "https://linear.app/acme/issue/ENG-123#comment-comment_1",
      issueId: "issue_123",
      issueIdentifier: "ENG-123",
      issueTitle: "Fix import",
      issueUrl: "https://linear.app/acme/issue/ENG-123/fix-import",
      teamId: "team_eng",
      teamKey: "ENG",
      teamName: "Engineering",
      organizationId: "org_acme",
      actorId: "user_alice",
      actorName: "alice",
      actorDisplayName: "Alice",
      receivedAt: "2026-07-07T00:00:00.000Z",
      projectTarget: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo"
      }
    });

    expect(event).toMatchObject({
      source: "linear",
      sourceEventId: "comment_1",
      actor: {
        provider: "linear",
        providerUserId: "user_alice",
        handle: "Alice",
        organizationId: "org_acme"
      },
      command: {
        intent: "fix"
      },
      workItem: {
        provider: "linear",
        kind: "issue",
        externalId: "ENG-123",
        ownerContainer: {
          provider: "linear",
          id: "team_eng"
        }
      },
      callback: {
        provider: "linear",
        uri: "linear://issue/issue_123/comments",
        threadKey: "ENG|issue|ENG-123"
      },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        issueId: "issue_123",
        issueIdentifier: "ENG-123",
        teamId: "team_eng",
        teamKey: "ENG"
      }
    });
    expect(event?.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "linear", kind: "issue", visibility: "organization" }),
        expect.objectContaining({ provider: "linear", kind: "comment", visibility: "organization" }),
        expect.objectContaining({ kind: "file", uri: "src/app.ts", line: 12 })
      ])
    );
    expect(event?.permissions.map((permission) => permission.scope)).toEqual(
      expect.arrayContaining(["issue:comment", "runner:local", "repo:read", "repo:write", "pr:create"])
    );
  });

  it("returns null for comments without an OpenTag mention", () => {
    expect(
      normalizeLinearIssueComment({
        id: "comment_1",
        commentBody: "regular Linear comment",
        issueId: "issue_123",
        issueIdentifier: "ENG-123",
        issueUrl: "https://linear.app/acme/issue/ENG-123/fix-import",
        teamId: "team_eng",
        actorId: "user_alice",
        receivedAt: "2026-07-07T00:00:00.000Z"
      })
    ).toBeNull();
  });

  it("round-trips callback issue ids through the Linear callback URI", () => {
    expect(linearIssueCallbackUri("issue_123")).toBe("linear://issue/issue_123/comments");
    expect(linearIssueIdFromCallbackUri("linear://issue/issue_123/comments")).toBe("issue_123");
    expect(linearIssueIdFromCallbackUri("https://linear.app/acme/issue/ENG-123")).toBeNull();
  });
});
