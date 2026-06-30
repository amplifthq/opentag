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
      id: "approval_gitlab_note_1002",
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
});