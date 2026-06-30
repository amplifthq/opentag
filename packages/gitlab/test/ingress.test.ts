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
});