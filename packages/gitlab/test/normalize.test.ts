import { describe, expect, it } from "vitest";
import { normalizeGitLabNote } from "../src/normalize.js";

describe("normalizeGitLabNote", () => {
  it("normalizes an @opentag issue note into an OpenTagEvent", () => {
    const event = normalizeGitLabNote({
      id: "123",
      noteBody: "@opentag fix this",
      noteUrl: "https://gitlab.com/acme/demo/-/issues/1#note_123",
      apiNotesUrl: "https://gitlab.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      issueIid: 1,
      workItemUrl: "https://gitlab.com/acme/demo/-/issues/1",
      projectPathWithNamespace: "acme/demo",
      projectId: 42,
      projectVisibility: "public",
      actorId: 7,
      actorUsername: "alice",
      noteableType: "Issue",
      receivedAt: "2026-06-29T00:00:00.000Z"
    });

    expect(event?.source).toBe("gitlab");
    expect(event?.command.intent).toBe("fix");
    expect(event?.context[0]).toMatchObject({ provider: "gitlab", kind: "issue", visibility: "public" });
    expect(event?.workItem).toMatchObject({
      provider: "gitlab",
      kind: "issue",
      externalId: "acme/demo#1",
      ownerContainer: { id: "acme/demo" }
    });
    expect(event?.callback.threadKey).toBe("acme/demo#1");
    expect(event?.callback.uri).toContain("/api/v4/projects/acme%2Fdemo/issues/1/notes");
    expect(event?.permissions.map((p) => p.scope)).toEqual(
      expect.arrayContaining(["issue:comment", "runner:local", "repo:read", "repo:write", "pr:create"])
    );
    expect(event?.metadata).toMatchObject({
      repoProvider: "gitlab",
      projectPathWithNamespace: "acme/demo",
      projectId: 42,
      issueIid: 1,
      noteableType: "Issue"
    });
    expect(event?.metadata).not.toHaveProperty("mergeRequestIid");
  });

  it("normalizes an @opentag merge request note with review permission", () => {
    const event = normalizeGitLabNote({
      id: "456",
      noteBody: "@opentag review this change",
      noteUrl: "https://gitlab.com/acme/demo/-/merge_requests/9#note_456",
      apiNotesUrl: "https://gitlab.com/api/v4/projects/acme%2Fdemo/merge_requests/9/notes",
      issueIid: 9,
      mergeRequestIid: 9,
      workItemUrl: "https://gitlab.com/acme/demo/-/merge_requests/9",
      projectPathWithNamespace: "acme/demo",
      projectId: 42,
      projectVisibility: "internal",
      actorId: 7,
      actorUsername: "alice",
      noteableType: "MergeRequest",
      receivedAt: "2026-06-29T00:00:00.000Z"
    });

    expect(event?.command.intent).toBe("review");
    expect(event?.workItem).toMatchObject({ kind: "merge_request", externalId: "acme/demo#9" });
    expect(event?.context[0]).toMatchObject({ provider: "gitlab", kind: "merge_request", visibility: "private" });
    expect(event?.permissions.map((p) => p.scope)).toContain("pr:update");
    expect(event?.metadata).toMatchObject({ mergeRequestIid: 9 });
  });

  it("treats internal GitLab visibility as private in context pointers", () => {
    const event = normalizeGitLabNote({
      id: "1",
      noteBody: "@opentag investigate this",
      noteUrl: "https://gitlab.com/acme/demo/-/issues/2#note_1",
      apiNotesUrl: "https://gitlab.com/api/v4/projects/acme%2Fdemo/issues/2/notes",
      issueIid: 2,
      workItemUrl: "https://gitlab.com/acme/demo/-/issues/2",
      projectPathWithNamespace: "acme/demo",
      projectId: 42,
      projectVisibility: "internal",
      actorId: 7,
      actorUsername: "alice",
      noteableType: "Issue",
      receivedAt: "2026-06-29T00:00:00.000Z"
    });

    expect(event?.context.every((pointer) => pointer.visibility === "private")).toBe(true);
    expect(event?.metadata.projectVisibility).toBe("internal");
  });

  it("returns null for notes that do not contain an @opentag mention", () => {
    expect(
      normalizeGitLabNote({
        id: "1",
        noteBody: "regular comment",
        noteUrl: "https://gitlab.com/acme/demo/-/issues/1#note_1",
        apiNotesUrl: "https://gitlab.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
        issueIid: 1,
        workItemUrl: "https://gitlab.com/acme/demo/-/issues/1",
        projectPathWithNamespace: "acme/demo",
        projectId: 42,
        projectVisibility: "public",
        actorId: 7,
        actorUsername: "alice",
        noteableType: "Issue",
        receivedAt: "2026-06-29T00:00:00.000Z"
      })
    ).toBeNull();
  });

  it("returns null for noteable types outside the MVP scope", () => {
    expect(
      normalizeGitLabNote({
        id: "1",
        noteBody: "@opentag fix this",
        noteUrl: "https://gitlab.com/acme/demo/-/snippets/1#note_1",
        apiNotesUrl: "https://gitlab.com/api/v4/projects/acme%2Fdemo/snippets/1/notes",
        issueIid: 1,
        workItemUrl: "https://gitlab.com/acme/demo/-/snippets/1",
        projectPathWithNamespace: "acme/demo",
        projectId: 42,
        projectVisibility: "public",
        actorId: 7,
        actorUsername: "alice",
        noteableType: "Snippet",
        receivedAt: "2026-06-29T00:00:00.000Z"
      })
    ).toBeNull();
  });

  it("does not grant pull-request update permission for read-only review intents", () => {
    const event = normalizeGitLabNote({
      id: "1",
      noteBody: "@opentag explain this change",
      noteUrl: "https://gitlab.com/acme/demo/-/merge_requests/9#note_1",
      apiNotesUrl: "https://gitlab.com/api/v4/projects/acme%2Fdemo/merge_requests/9/notes",
      issueIid: 9,
      mergeRequestIid: 9,
      workItemUrl: "https://gitlab.com/acme/demo/-/merge_requests/9",
      projectPathWithNamespace: "acme/demo",
      projectId: 42,
      projectVisibility: "public",
      actorId: 7,
      actorUsername: "alice",
      noteableType: "MergeRequest",
      receivedAt: "2026-06-29T00:00:00.000Z"
    });

    expect(event?.command.intent).toBe("explain");
    expect(event?.permissions.map((p) => p.scope)).not.toContain("pr:update");
  });

  it("keeps requested scopes in parsed command metadata instead of elevating them into granted permissions", () => {
    const event = normalizeGitLabNote({
      id: "1",
      noteBody: "@opentag fix auth --scope repo:write --executor codex --file src/auth.ts --line 12",
      noteUrl: "https://gitlab.com/acme/demo/-/issues/1#note_1",
      apiNotesUrl: "https://gitlab.com/api/v4/projects/acme%2Fdemo/issues/1/notes",
      issueIid: 1,
      workItemUrl: "https://gitlab.com/acme/demo/-/issues/1",
      projectPathWithNamespace: "acme/demo",
      projectId: 42,
      projectVisibility: "public",
      actorId: 7,
      actorUsername: "alice",
      noteableType: "Issue",
      receivedAt: "2026-06-29T00:00:00.000Z"
    });

    expect(event?.target.executorHint).toBe("codex");
    expect(event?.command.parsed?.requestedScopes).toEqual(["repo:write"]);
    expect(event?.permissions.filter((p) => p.scope === "repo:write")).toHaveLength(1);
    expect(event?.context).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "file", uri: "src/auth.ts", line: 12 })])
    );
  });
});