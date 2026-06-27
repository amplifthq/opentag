import { describe, expect, it, vi } from "vitest";
import { computeGitHubSignature, createGitHubWebhookApp } from "../src/ingress.js";

function signedRequest(input: { body: string; secret: string; event: string }): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": input.event,
      "x-hub-signature-256": computeGitHubSignature({ webhookSecret: input.secret, rawBody: input.body })
    },
    body: input.body
  };
}

describe("GitHub webhook ingress", () => {
  it("creates a run for a signed issue comment mention", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun,
      now: () => "2026-06-27T00:00:00.000Z"
    });
    const body = JSON.stringify({
      action: "created",
      comment: {
        id: 123,
        body: "@opentag investigate this",
        html_url: "https://github.com/acme/demo/issues/1#issuecomment-123"
      },
      issue: {
        html_url: "https://github.com/acme/demo/issues/1",
        comments_url: "https://api.github.com/repos/acme/demo/issues/1/comments",
        number: 1
      },
      repository: { name: "demo", private: false, owner: { login: "acme" } },
      sender: { id: 42, login: "octocat" }
    });

    const response = await app.request("/github/webhooks", signedRequest({ body, secret: "secret", event: "issue_comment" }));

    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(createRun.mock.calls[0]![0]).toMatchObject({
      source: "github",
      metadata: { repoProvider: "github", owner: "acme", repo: "demo", issueNumber: 1 },
      callback: { provider: "github" }
    });
  });

  it("rejects invalid signatures", async () => {
    const app = createGitHubWebhookApp({
      webhookSecret: "secret",
      createRun: vi.fn(async () => ({ runId: "run_1" })),
      now: () => "2026-06-27T00:00:00.000Z"
    });

    const response = await app.request("/github/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=bad"
      },
      body: "{}"
    });

    expect(response.status).toBe(401);
  });
});
