import { describe, expect, it, vi } from "vitest";
import { createGitLabWebhookApp, verifyGitLabToken } from "../src/ingress.js";

describe("verifyGitLabToken", () => {
  it("returns true for matching tokens", () => {
    expect(verifyGitLabToken({ webhookSecret: "shared-secret", token: "shared-secret" })).toBe(true);
  });

  it("returns false for non-matching tokens", () => {
    expect(verifyGitLabToken({ webhookSecret: "shared-secret", token: "different-token" })).toBe(false);
  });

  it("returns false when the configured secret is empty", () => {
    expect(verifyGitLabToken({ webhookSecret: "", token: "shared-secret" })).toBe(false);
  });

  it("does not leak token length via Buffer.length checks", () => {
    // The security-critical property: both inputs are hashed to a fixed-length
    // digest before timingSafeEqual, so the comparison buffer length is always
    // 32 bytes regardless of the actual token length. A 1024-byte token must
    // compare equal to itself and unequal to any 1023-byte variant.
    const longSharedSecret = "x".repeat(1024);
    expect(verifyGitLabToken({ webhookSecret: longSharedSecret, token: longSharedSecret })).toBe(true);
    expect(verifyGitLabToken({ webhookSecret: longSharedSecret, token: "x".repeat(1023) })).toBe(false);
    expect(verifyGitLabToken({ webhookSecret: longSharedSecret, token: "x".repeat(1025) })).toBe(false);
  });
});

describe("GitLab webhook ingress", () => {
  it("rejects requests without the X-Gitlab-Token header", async () => {
    const app = createGitLabWebhookApp({
      webhookSecret: "shared-secret",
      createRun: vi.fn(async () => ({ runId: "run_1" })),
      now: () => "2026-06-29T00:00:00.000Z"
    });

    const response = await app.request("/gitlab/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gitlab-event": "Note Hook" },
      body: "{}"
    });

    expect(response.status).toBe(401);
  });

  it("rejects requests with an invalid X-Gitlab-Token", async () => {
    const app = createGitLabWebhookApp({
      webhookSecret: "shared-secret",
      createRun: vi.fn(async () => ({ runId: "run_1" })),
      now: () => "2026-06-29T00:00:00.000Z"
    });

    const response = await app.request("/gitlab/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Note Hook",
        "x-gitlab-token": "wrong-token"
      },
      body: "{}"
    });

    expect(response.status).toBe(401);
  });

  it("creates a run for a signed Note Hook issue mention", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const app = createGitLabWebhookApp({
      webhookSecret: "shared-secret",
      createRun,
      now: () => "2026-06-29T00:00:00.000Z"
    });
    const body = JSON.stringify({
      object_kind: "note",
      object_attributes: {
        id: 1001,
        note: "@opentag investigate this",
        url: "https://gitlab.com/acme/demo/-/issues/1#note_1001",
        noteable_type: "Issue"
      },
      project: {
        id: 42,
        path_with_namespace: "acme/demo",
        visibility: "public",
        web_url: "https://gitlab.com/acme/demo"
      },
      issue: {
        iid: 1,
        url: "https://gitlab.com/acme/demo/-/issues/1"
      },
      user: { id: 7, username: "alice" }
    });

    const response = await app.request("/gitlab/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Note Hook",
        "x-gitlab-token": "shared-secret"
      },
      body
    });

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(createRun.mock.calls[0]![0]).toMatchObject({
      source: "gitlab",
      metadata: { repoProvider: "gitlab", projectPathWithNamespace: "acme/demo", issueIid: 1 },
      callback: { provider: "gitlab" }
    });
  });

  it("routes thread-action comments to submitThreadAction when provided", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({ outcome: "applied" }));
    const app = createGitLabWebhookApp({
      webhookSecret: "shared-secret",
      createRun,
      submitThreadAction,
      now: () => "2026-06-29T00:00:00.000Z"
    });
    const body = JSON.stringify({
      object_kind: "note",
      object_attributes: {
        id: 1002,
        note: "apply 1",
        url: "https://gitlab.com/acme/demo/-/issues/1#note_1002",
        noteable_type: "Issue"
      },
      project: {
        id: 42,
        path_with_namespace: "acme/demo",
        visibility: "public",
        web_url: "https://gitlab.com/acme/demo"
      },
      issue: {
        iid: 1,
        url: "https://gitlab.com/acme/demo/-/issues/1"
      },
      user: { id: 7, username: "alice" }
    });

    const response = await app.request("/gitlab/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Note Hook",
        "x-gitlab-token": "shared-secret"
      },
      body
    });

    expect(response.status).toBe(200);
    expect(createRun).not.toHaveBeenCalled();
    expect(submitThreadAction).toHaveBeenCalledTimes(1);
    expect(submitThreadAction.mock.calls[0]![0]).toMatchObject({
      id: expect.stringMatching(/^approval_gitlab_note_1002_[0-9a-f]{12}$/),
      actor: { handle: "alice" },
      callback: { provider: "gitlab" }
    });
  });

  it("ignores noteable types outside the MVP scope", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const app = createGitLabWebhookApp({
      webhookSecret: "shared-secret",
      createRun,
      now: () => "2026-06-29T00:00:00.000Z"
    });
    const body = JSON.stringify({
      object_kind: "note",
      object_attributes: {
        id: 1003,
        note: "@opentag investigate this",
        url: "https://gitlab.com/acme/demo/-/snippets/1#note_1003",
        noteable_type: "Snippet"
      },
      project: {
        id: 42,
        path_with_namespace: "acme/demo",
        visibility: "public",
        web_url: "https://gitlab.com/acme/demo"
      },
      user: { id: 7, username: "alice" }
    });

    const response = await app.request("/gitlab/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Note Hook",
        "x-gitlab-token": "shared-secret"
      },
      body
    });

    expect(response.status).toBe(200);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("encodes work-item kind into callback.threadKey so an issue and MR with the same iid do not collide", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({ outcome: "applied" }));
    const app = createGitLabWebhookApp({
      webhookSecret: "shared-secret",
      createRun,
      submitThreadAction,
      now: () => "2026-06-29T00:00:00.000Z"
    });
    const baseProject = {
      id: 42,
      path_with_namespace: "acme/demo",
      visibility: "public",
      web_url: "https://gitlab.com/acme/demo"
    } as const;
    const baseUser = { id: 7, username: "alice" } as const;
    const headers = {
      "content-type": "application/json",
      "x-gitlab-event": "Note Hook",
      "x-gitlab-token": "shared-secret"
    };

    const issueBody = JSON.stringify({
      object_kind: "note",
      object_attributes: {
        id: 3001,
        note: "apply 1",
        url: "https://gitlab.com/acme/demo/-/issues/9#note_3001",
        noteable_type: "Issue"
      },
      project: baseProject,
      issue: { iid: 9, url: "https://gitlab.com/acme/demo/-/issues/9" },
      user: baseUser
    });
    const mrBody = JSON.stringify({
      object_kind: "note",
      object_attributes: {
        id: 3002,
        note: "apply 1",
        url: "https://gitlab.com/acme/demo/-/merge_requests/9#note_3002",
        noteable_type: "MergeRequest"
      },
      project: baseProject,
      merge_request: { iid: 9, url: "https://gitlab.com/acme/demo/-/merge_requests/9" },
      user: baseUser
    });

    const r1 = await app.request("/gitlab/webhooks", { method: "POST", headers, body: issueBody });
    const r2 = await app.request("/gitlab/webhooks", { method: "POST", headers, body: mrBody });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(submitThreadAction).toHaveBeenCalledTimes(2);
    const issueKey = submitThreadAction.mock.calls[0]![0]!.callback.threadKey;
    const mrKey = submitThreadAction.mock.calls[1]![0]!.callback.threadKey;
    expect(issueKey).toBe("acme/demo|issue|9");
    expect(mrKey).toBe("acme/demo|merge_request|9");
    expect(issueKey).not.toBe(mrKey);
  });

  it("binds the action id to the raw body so mutated bodies get a distinct id", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({ outcome: "applied" }));
    const makeApp = () =>
      createGitLabWebhookApp({
        webhookSecret: "shared-secret",
        createRun,
        submitThreadAction,
        now: () => "2026-06-29T00:00:00.000Z"
      });
    const basePayload = {
      object_kind: "note",
      object_attributes: {
        id: 2001,
        url: "https://gitlab.com/acme/demo/-/issues/1#note_2001",
        noteable_type: "Issue"
      },
      project: {
        id: 42,
        path_with_namespace: "acme/demo",
        visibility: "public",
        web_url: "https://gitlab.com/acme/demo"
      },
      issue: { iid: 1, url: "https://gitlab.com/acme/demo/-/issues/1" },
      user: { id: 7, username: "alice" }
    } as const;
    const headers = {
      "content-type": "application/json",
      "x-gitlab-event": "Note Hook",
      "x-gitlab-token": "shared-secret"
    };

    const r1 = await makeApp().request("/gitlab/webhooks", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...basePayload, object_attributes: { ...basePayload.object_attributes, note: "apply 1" } })
    });
    const r2 = await makeApp().request("/gitlab/webhooks", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...basePayload, object_attributes: { ...basePayload.object_attributes, note: "apply 2" } })
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(submitThreadAction).toHaveBeenCalledTimes(2);
    const id1 = submitThreadAction.mock.calls[0]![0]!.id;
    const id2 = submitThreadAction.mock.calls[1]![0]!.id;
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^approval_gitlab_note_2001_[0-9a-f]{12}$/);
    expect(id2).toMatch(/^approval_gitlab_note_2001_[0-9a-f]{12}$/);
  });

  it("yields the same action id when the same body is delivered twice", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({ outcome: "applied" }));
    const app = createGitLabWebhookApp({
      webhookSecret: "shared-secret",
      createRun,
      submitThreadAction,
      now: () => "2026-06-29T00:00:00.000Z"
    });
    const body = JSON.stringify({
      object_kind: "note",
      object_attributes: {
        id: 2002,
        note: "apply 1",
        url: "https://gitlab.com/acme/demo/-/issues/1#note_2002",
        noteable_type: "Issue"
      },
      project: {
        id: 42,
        path_with_namespace: "acme/demo",
        visibility: "public",
        web_url: "https://gitlab.com/acme/demo"
      },
      issue: { iid: 1, url: "https://gitlab.com/acme/demo/-/issues/1" },
      user: { id: 7, username: "alice" }
    });
    const headers = {
      "content-type": "application/json",
      "x-gitlab-event": "Note Hook",
      "x-gitlab-token": "shared-secret"
    };

    const r1 = await app.request("/gitlab/webhooks", { method: "POST", headers, body });
    const r2 = await app.request("/gitlab/webhooks", { method: "POST", headers, body });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(submitThreadAction).toHaveBeenCalledTimes(2);
    const id1 = submitThreadAction.mock.calls[0]![0]!.id;
    const id2 = submitThreadAction.mock.calls[1]![0]!.id;
    expect(id1).toBe(id2);
  });

  it("does not buffer the body when the token is invalid", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const app = createGitLabWebhookApp({
      webhookSecret: "shared-secret",
      createRun,
      now: () => "2026-06-29T00:00:00.000Z"
    });
    // Even though this body would parse into a valid note that mentions
    // @opentag, the token check must reject the request without consuming
    // the body. If the handler buffered the body first (the bug the
    // hardening closes), the token check would still fail but the response
    // would observe body-buffering costs in the test; here we assert the
    // observable contract: 401 returned and `createRun` never invoked.
    const body = JSON.stringify({
      object_kind: "note",
      object_attributes: {
        id: 1999,
        note: "@opentag investigate this",
        url: "https://gitlab.com/acme/demo/-/issues/1#note_1999",
        noteable_type: "Issue"
      },
      project: {
        id: 42,
        path_with_namespace: "acme/demo",
        visibility: "public",
        web_url: "https://gitlab.com/acme/demo"
      },
      issue: { iid: 1, url: "https://gitlab.com/acme/demo/-/issues/1" },
      user: { id: 7, username: "alice" }
    });

    const response = await app.request("/gitlab/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Note Hook",
        "x-gitlab-token": "wrong-token"
      },
      body
    });

    expect(response.status).toBe(401);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 422 when the JSON body is well-formed but fails the shape predicate", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const app = createGitLabWebhookApp({
      webhookSecret: "shared-secret",
      createRun,
      now: () => "2026-06-29T00:00:00.000Z"
    });
    // Missing `project` and `user` — these are the shape fields the predicate
    // checks. Without validation, the handler would otherwise proceed and
    // synthesise URLs from `undefined`.
    const body = JSON.stringify({
      object_kind: "note",
      object_attributes: {
        id: 1998,
        note: "@opentag investigate this",
        url: "https://gitlab.com/acme/demo/-/issues/1#note_1998",
        noteable_type: "Issue"
      }
    });

    const response = await app.request("/gitlab/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Note Hook",
        "x-gitlab-token": "shared-secret"
      },
      body
    });

    expect(response.status).toBe(422);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 413 when content-length declares a payload at or above the 1 MiB cap", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const app = createGitLabWebhookApp({
      webhookSecret: "shared-secret",
      createRun,
      now: () => "2026-06-29T00:00:00.000Z"
    });

    const response = await app.request("/gitlab/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Note Hook",
        "x-gitlab-token": "shared-secret",
        "content-length": "1048576"
      },
      // We pass an empty body — the size cap rejects purely on the header
      // value before any body bytes are consumed. Validating this contract
      // prevents the regresssion of moving the size check after body read.
      body: ""
    });

    expect(response.status).toBe(413);
    expect(createRun).not.toHaveBeenCalled();
  });

  describe("path_with_namespace nested-subgroup support", () => {
    // GitLab documents project.path_with_namespace as the full hierarchical
    // path with arbitrary subgroup depth (group/subgroup/project). The shape
    // predicate must accept two-or-more segments and still reject payloads
    // with delimiter-injection (|) or whitespace in any segment.
    function buildNoteBody(pathWithNamespace: string): string {
      return JSON.stringify({
        object_kind: "note",
        object_attributes: {
          id: 2001,
          note: "@opentag investigate this",
          url: `https://gitlab.com/${pathWithNamespace}/-/issues/1#note_2001`,
          noteable_type: "Issue"
        },
        project: {
          id: 42,
          path_with_namespace: pathWithNamespace,
          visibility: "public",
          web_url: `https://gitlab.com/${pathWithNamespace}`
        },
        issue: {
          iid: 1,
          url: `https://gitlab.com/${pathWithNamespace}/-/issues/1`
        },
        user: { id: 7, username: "alice" }
      });
    }

    async function postNote(pathWithNamespace: string): Promise<{ response: Response; createRun: ReturnType<typeof vi.fn> }> {
      const createRun = vi.fn(async () => ({ runId: "run_1" }));
      const app = createGitLabWebhookApp({
        webhookSecret: "shared-secret",
        createRun,
        now: () => "2026-06-29T00:00:00.000Z"
      });
      const response = await app.request("/gitlab/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-event": "Note Hook",
          "x-gitlab-token": "shared-secret"
        },
        body: buildNoteBody(pathWithNamespace)
      });
      return { response, createRun };
    }

    it("accepts a two-segment path_with_namespace (regression)", async () => {
      const { response } = await postNote("acme/demo");
      expect(response.status).toBe(200);
    });

    it("accepts a three-segment nested-subgroup path", async () => {
      const { response } = await postNote("acme/team/demo");
      expect(response.status).toBe(200);
    });

    it("accepts a four-segment nested-subgroup path", async () => {
      const { response } = await postNote("acme/team/sub/demo");
      expect(response.status).toBe(200);
    });

    it("rejects a single-segment path (no slash)", async () => {
      const { response } = await postNote("acme");
      expect(response.status).toBe(422);
    });

    it("rejects a trailing-slash path", async () => {
      const { response } = await postNote("acme/demo/");
      expect(response.status).toBe(422);
    });

    it("rejects a pipe character anywhere in the path", async () => {
      const { response } = await postNote("acme|evil/demo");
      expect(response.status).toBe(422);
    });

    it("rejects whitespace inside a segment", async () => {
      const { response } = await postNote("acme /demo");
      expect(response.status).toBe(422);
    });

    it("rejects an empty path", async () => {
      const { response } = await postNote("");
      expect(response.status).toBe(422);
    });

    it("encodes nested-segment slashes for the REST callback URL", async () => {
      // The dispatcher-callback URI is built by encodeProjectPath inside
      // buildApiNotesUrl; assert the URI that createRun actually received so
      // a regression in buildApiNotesUrl (e.g. dropping encodeProjectPath
      // for nested paths) is caught here. Recomputing the expected URL
      // locally would be tautological.
      const { response, createRun } = await postNote("acme/team/demo");
      expect(response.status).toBe(200);
      expect(createRun).toHaveBeenCalledTimes(1);
      const event = createRun.mock.calls[0]![0] as {
        callback: { uri: string; threadKey: string };
      };
      expect(event.callback.uri).toBe(
        "https://gitlab.com/api/v4/projects/acme%2Fteam%2Fdemo/issues/1/notes"
      );
      expect(event.callback.threadKey).toBe("acme/team/demo|issue|1");
    });
  });

  describe("shape predicate field coverage", () => {
    // The predicate must reject signed payloads missing any field the handler
    // reads. Each test below removes one required field from a fully-populated
    // fixture and asserts the Hono handler returns 422 invalid_payload without
    // invoking createRun or submitThreadAction.

    const basePayload = {
      object_kind: "note" as const,
      object_attributes: {
        id: 3001,
        note: "@opentag investigate this",
        url: "https://gitlab.com/acme/demo/-/issues/1#note_3001",
        noteable_type: "Issue" as const
      },
      project: {
        id: 42,
        path_with_namespace: "acme/demo",
        visibility: "public" as const,
        web_url: "https://gitlab.com/acme/demo"
      },
      issue: { iid: 1, url: "https://gitlab.com/acme/demo/-/issues/1" },
      user: { id: 7, username: "alice" }
    };

    function postNoteWith(body: unknown): Promise<{ response: Response; createRun: ReturnType<typeof vi.fn> }> {
      const createRun = vi.fn(async () => ({ runId: "run_1" }));
      const app = createGitLabWebhookApp({
        webhookSecret: "shared-secret",
        createRun,
        now: () => "2026-06-29T00:00:00.000Z"
      });
      return app
        .request("/gitlab/webhooks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-gitlab-event": "Note Hook",
            "x-gitlab-token": "shared-secret"
          },
          body: JSON.stringify(body)
        })
        .then((response) => ({ response, createRun }));
    }

    it("returns 422 when object_attributes.url is missing", async () => {
      const { object_attributes, ...rest } = basePayload;
      const payload = { ...rest, object_attributes: { ...object_attributes } };
      delete (payload.object_attributes as Record<string, unknown>).url;
      const { response, createRun } = await postNoteWith(payload);
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("returns 422 when project.id is missing", async () => {
      const { project, ...rest } = basePayload;
      const payload = { ...rest, project: { ...project } };
      delete (payload.project as Record<string, unknown>).id;
      const { response, createRun } = await postNoteWith(payload);
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("returns 422 when project.visibility is missing", async () => {
      const { project, ...rest } = basePayload;
      const payload = { ...rest, project: { ...project } };
      delete (payload.project as Record<string, unknown>).visibility;
      const { response, createRun } = await postNoteWith(payload);
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("returns 422 when user.username is missing", async () => {
      const { user, ...rest } = basePayload;
      const payload = { ...rest, user: { ...user } };
      delete (payload.user as Record<string, unknown>).username;
      const { response, createRun } = await postNoteWith(payload);
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("returns 422 when user.id is a string instead of a number", async () => {
      const { user, ...rest } = basePayload;
      const payload = { ...rest, user: { ...user, id: "7" } };
      const { response, createRun } = await postNoteWith(payload);
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("returns 422 when project.visibility is an unrecognised string", async () => {
      const { project, ...rest } = basePayload;
      const payload = { ...rest, project: { ...project, visibility: "internal-but-secret" } };
      const { response, createRun } = await postNoteWith(payload);
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("returns 422 when object_attributes.noteable_type is missing", async () => {
      const { object_attributes, ...rest } = basePayload;
      const payload = { ...rest, object_attributes: { ...object_attributes } };
      delete (payload.object_attributes as Record<string, unknown>).noteable_type;
      const { response, createRun } = await postNoteWith(payload);
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("regression: complete payload with nested-group path still passes (200)", async () => {
      // Belt-and-braces: a fully-populated payload with a 3-segment path must
      // succeed end-to-end after the predicate was tightened, otherwise a
      // regression in a later edit could break nested-subgroup support
      // without surfacing in CI.
      const payload = {
        ...basePayload,
        project: {
          ...basePayload.project,
          path_with_namespace: "acme/team/demo",
          web_url: "https://gitlab.com/acme/team/demo"
        },
        issue: {
          iid: 1,
          url: "https://gitlab.com/acme/team/demo/-/issues/1"
        },
        object_attributes: {
          ...basePayload.object_attributes,
          url: "https://gitlab.com/acme/team/demo/-/issues/1#note_3001"
        }
      };
      const { response, createRun } = await postNoteWith(payload);
      expect(response.status).toBe(200);
      expect(createRun).toHaveBeenCalledTimes(1);
      expect(createRun.mock.calls[0]![0]).toMatchObject({
        metadata: { projectPathWithNamespace: "acme/team/demo" }
      });
    });
  });

  describe("supported-note integrity check (iid > 0 + URL present)", () => {
    // Real GitLab payloads always carry a positive iid AND a non-empty
    // matching URL on the issue / merge_request object. The handler must
    // reject payloads missing either with 422 invalid_payload rather than
    // synthesise a callback URL out of `undefined` or build
    // `https://gitlab.com/.../-/issues/0/notes`.

    function postRaw(body: unknown): Promise<{ response: Response; createRun: ReturnType<typeof vi.fn> }> {
      const createRun = vi.fn(async () => ({ runId: "run_1" }));
      const app = createGitLabWebhookApp({
        webhookSecret: "shared-secret",
        createRun,
        now: () => "2026-06-29T00:00:00.000Z"
      });
      return app
        .request("/gitlab/webhooks", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-gitlab-event": "Note Hook",
            "x-gitlab-token": "shared-secret"
          },
          body: JSON.stringify(body)
        })
        .then((response) => ({ response, createRun }));
    }

    const supportedBase = {
      object_kind: "note" as const,
      object_attributes: {
        id: 4001,
        note: "@opentag investigate this",
        url: "https://gitlab.com/acme/demo/-/issues/1#note_4001",
        noteable_type: "Issue" as const
      },
      project: {
        id: 42,
        path_with_namespace: "acme/demo",
        visibility: "public" as const,
        web_url: "https://gitlab.com/acme/demo"
      },
      issue: { iid: 1, url: "https://gitlab.com/acme/demo/-/issues/1" },
      user: { id: 7, username: "alice" }
    };

    it("returns 422 when the issue note has iid = 0", async () => {
      const { response, createRun } = await postRaw({
        ...supportedBase,
        issue: { ...supportedBase.issue, iid: 0 }
      });
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("returns 422 when the merge-request note has iid = 0", async () => {
      const { response, createRun } = await postRaw({
        ...supportedBase,
        object_attributes: {
          ...supportedBase.object_attributes,
          noteable_type: "MergeRequest",
          url: "https://gitlab.com/acme/demo/-/merge_requests/9#note_4001"
        },
        issue: undefined,
        merge_request: { iid: 0, url: "https://gitlab.com/acme/demo/-/merge_requests/9" }
      });
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("returns 422 when the issue note has an empty url string", async () => {
      const { response, createRun } = await postRaw({
        ...supportedBase,
        issue: { ...supportedBase.issue, url: "" }
      });
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("returns 422 when the merge-request note is missing merge_request.url", async () => {
      // object_attributes.url mirrors the merge-request note URL so the only
      // missing field is merge_request.url — keeping the 422 assertion focused
      // on that gap and avoiding spurious URL/type consistency failures.
      const { response, createRun } = await postRaw({
        ...supportedBase,
        object_attributes: {
          ...supportedBase.object_attributes,
          noteable_type: "MergeRequest",
          url: "https://gitlab.com/acme/demo/-/merge_requests/9#note_4001"
        },
        issue: undefined,
        merge_request: { iid: 9, url: undefined }
      });
      expect(response.status).toBe(422);
      expect(createRun).not.toHaveBeenCalled();
    });

    it("regression: positive iid + non-empty URL still produces 200", async () => {
      const { response, createRun } = await postRaw(supportedBase);
      expect(response.status).toBe(200);
      expect(createRun).toHaveBeenCalledTimes(1);
    });

    it("regression: unsupported noteable types still return 200 { ok: true } without invoking createRun", async () => {
      // Snippet notes are out of MVP scope. The handler bails out before the
      // integrity check, so the HTTP response stays 200 (GitLab marks the
      // webhook healthy) and no run is created.
      const { response, createRun } = await postRaw({
        ...supportedBase,
        object_attributes: {
          ...supportedBase.object_attributes,
          noteable_type: "Snippet"
        }
      });
      expect(response.status).toBe(200);
      expect(createRun).not.toHaveBeenCalled();
    });
  });
});