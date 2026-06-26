import { describe, expect, it } from "vitest";
import { applyGitHubIssueMutationIntent, compileGitHubIssueMutationIntent } from "../src/apply.js";

describe("GitHub apply helpers", () => {
  it("compiles semantic mutation intents into GitHub issue operations", () => {
    expect(
      compileGitHubIssueMutationIntent({
        intentId: "intent_add",
        domain: "labels",
        action: "add_label",
        summary: "Add label.",
        params: { label: "bug" }
      })
    ).toEqual({
      ok: true,
      intentId: "intent_add",
      operation: {
        kind: "add_label",
        intentId: "intent_add",
        label: "bug"
      }
    });

    expect(
      compileGitHubIssueMutationIntent({
        intentId: "intent_assignee",
        domain: "assignee",
        action: "set_assignee",
        summary: "Set assignee.",
        params: { assignee: "alice" }
      })
    ).toEqual({
      ok: true,
      intentId: "intent_assignee",
      operation: {
        kind: "set_assignees",
        intentId: "intent_assignee",
        assignees: ["alice"]
      }
    });
  });

  it("compiles status and priority through explicit GitHub label mappings", () => {
    expect(
      compileGitHubIssueMutationIntent(
        {
          intentId: "intent_status",
          domain: "status",
          action: "transition_status",
          summary: "Mark blocked.",
          params: { status: "blocked" }
        },
        {
          mappings: [
            {
              id: "github_status_labels",
              adapter: "github",
              domain: "status",
              strategy: "label",
              values: { blocked: "status/blocked" }
            }
          ]
        }
      )
    ).toEqual({
      ok: true,
      intentId: "intent_status",
      operation: {
        kind: "replace_mapped_label",
        intentId: "intent_status",
        label: "status/blocked",
        removeLabels: []
      }
    });

    expect(
      compileGitHubIssueMutationIntent(
        {
          intentId: "intent_priority",
          domain: "priority",
          action: "set_priority",
          summary: "Set P1.",
          params: { priority: "P1" }
        },
        {
          mappings: [
            {
              id: "github_priority_labels",
              adapter: "github",
              domain: "priority",
              strategy: "label",
              values: { P0: "priority/P0", P1: "priority/P1" }
            }
          ]
        }
      )
    ).toEqual({
      ok: true,
      intentId: "intent_priority",
      operation: {
        kind: "replace_mapped_label",
        intentId: "intent_priority",
        label: "priority/P1",
        removeLabels: ["priority/P0"]
      }
    });
  });

  it("applies mapped label transitions by removing conflicting mapped labels first", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown; authorization: string | null }> = [];
    const fetchImpl = (async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        authorization: new Headers(init?.headers).get("authorization")
      });
      if (init?.method === "DELETE") {
        return new Response("", { status: 404 });
      }
      return Response.json({});
    }) as typeof fetch;

    await expect(
      applyGitHubIssueMutationIntent({
        target: { token: "ghs_test", owner: "acme", repo: "demo", issueNumber: 7 },
        fetchImpl,
        mappings: [{ id: "priority", adapter: "github", domain: "priority", strategy: "label", values: { P0: "priority/P0", P1: "priority/P1" } }],
        intent: {
          intentId: "intent_priority",
          domain: "priority",
          action: "set_priority",
          summary: "Set P1.",
          params: { priority: "P1" }
        }
      })
    ).resolves.toMatchObject({ intentId: "intent_priority", outcome: "applied" });

    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/7/labels/priority%2FP0",
        method: "DELETE",
        authorization: "Bearer ghs_test"
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/7/labels",
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { labels: ["priority/P1"] }
      }
    ]);
  });

  it("applies label mutation intents through GitHub issue APIs", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown; authorization: string | null }> = [];
    const fetchImpl = (async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        authorization: new Headers(init?.headers).get("authorization")
      });
      return Response.json({});
    }) as typeof fetch;

    const target = { token: "ghs_test", owner: "acme", repo: "demo", issueNumber: 7 };
    await expect(
      applyGitHubIssueMutationIntent({
        target,
        fetchImpl,
        intent: {
          intentId: "intent_add",
          domain: "labels",
          action: "add_label",
          summary: "Add label.",
          params: { label: "bug" }
        }
      })
    ).resolves.toMatchObject({ intentId: "intent_add", outcome: "applied" });

    await expect(
      applyGitHubIssueMutationIntent({
        target,
        fetchImpl,
        intent: {
          intentId: "intent_remove",
          domain: "labels",
          action: "remove_label",
          summary: "Remove label.",
          params: { label: "needs triage" }
        }
      })
    ).resolves.toMatchObject({ intentId: "intent_remove", outcome: "applied" });

    await expect(
      applyGitHubIssueMutationIntent({
        target,
        fetchImpl,
        intent: {
          intentId: "intent_set",
          domain: "labels",
          action: "set_labels",
          summary: "Set labels.",
          params: { labels: ["bug", "p1"] }
        }
      })
    ).resolves.toMatchObject({ intentId: "intent_set", outcome: "applied" });

    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/7/labels",
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { labels: ["bug"] }
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/7/labels/needs%20triage",
        method: "DELETE",
        authorization: "Bearer ghs_test"
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/7/labels",
        method: "PUT",
        authorization: "Bearer ghs_test",
        body: { labels: ["bug", "p1"] }
      }
    ]);
  });

  it("returns unsupported for non-label domains", async () => {
    await expect(
      applyGitHubIssueMutationIntent({
        target: { token: "ghs_test", owner: "acme", repo: "demo", issueNumber: 7 },
        intent: {
          intentId: "intent_status",
          domain: "status",
          action: "transition_status",
          summary: "Move status.",
          params: { status: "in_progress" }
        }
      })
    ).resolves.toMatchObject({
      intentId: "intent_status",
      outcome: "unsupported",
      message: "GitHub status writes require an explicit Project field or label mapping policy."
    });

    await expect(
      applyGitHubIssueMutationIntent({
        target: { token: "ghs_test", owner: "acme", repo: "demo", issueNumber: 7 },
        intent: {
          intentId: "intent_priority",
          domain: "priority",
          action: "set_priority",
          summary: "Set priority.",
          params: { priority: "P1" }
        }
      })
    ).resolves.toMatchObject({
      intentId: "intent_priority",
      outcome: "unsupported",
      message: "GitHub priority writes require an explicit label or Project field mapping policy."
    });
  });

  it("compiles review requests only for pull request targets", () => {
    const intent = {
      intentId: "intent_review",
      domain: "review",
      action: "request_review",
      summary: "Request review.",
      params: { reviewer: "alice" }
    };

    expect(compileGitHubIssueMutationIntent(intent)).toEqual({
      ok: false,
      outcome: {
        intentId: "intent_review",
        outcome: "unsupported",
        message: "GitHub review requests require a pull request target."
      }
    });
    expect(compileGitHubIssueMutationIntent(intent, { targetKind: "pull_request" })).toEqual({
      ok: true,
      intentId: "intent_review",
      operation: {
        kind: "request_review",
        intentId: "intent_review",
        reviewers: ["alice"]
      }
    });
  });

  it("applies review request intents through GitHub pull request APIs", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown; authorization: string | null }> = [];
    const fetchImpl = (async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        authorization: new Headers(init?.headers).get("authorization")
      });
      return Response.json({});
    }) as typeof fetch;

    await expect(
      applyGitHubIssueMutationIntent({
        target: { token: "ghs_test", owner: "acme", repo: "demo", issueNumber: 11, pullRequestNumber: 11 },
        targetKind: "pull_request",
        fetchImpl,
        intent: {
          intentId: "intent_review",
          domain: "review",
          action: "request_review",
          summary: "Request review.",
          params: { reviewers: ["alice", "bob"], teamReviewers: ["core"] }
        }
      })
    ).resolves.toEqual({
      intentId: "intent_review",
      outcome: "applied",
      externalUri: "https://github.com/acme/demo/pull/11"
    });

    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls/11/requested_reviewers",
        method: "GET",
        authorization: "Bearer ghs_test"
      },
      {
        url: "https://api.github.com/repos/acme/demo/pulls/11/requested_reviewers",
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { reviewers: ["alice", "bob"], team_reviewers: ["core"] }
      }
    ]);
  });

  it("does not re-request reviewers that GitHub already lists as requested", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = (async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      return Response.json({
        users: [{ login: "alice" }],
        teams: [{ slug: "core" }]
      });
    }) as typeof fetch;

    await expect(
      applyGitHubIssueMutationIntent({
        target: { token: "ghs_test", owner: "acme", repo: "demo", issueNumber: 11, pullRequestNumber: 11 },
        targetKind: "pull_request",
        fetchImpl,
        intent: {
          intentId: "intent_review",
          domain: "review",
          action: "request_review",
          summary: "Request review.",
          params: { reviewers: ["alice"], teamReviewers: ["core"] }
        }
      })
    ).resolves.toMatchObject({
      intentId: "intent_review",
      outcome: "applied",
      message: "Requested reviewers were already present; skipped GitHub notification retry."
    });

    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/pulls/11/requested_reviewers",
        method: "GET"
      }
    ]);
  });

  it("applies assignee mutation intents through GitHub issue APIs", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown; authorization: string | null }> = [];
    const fetchImpl = (async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        authorization: new Headers(init?.headers).get("authorization")
      });
      return Response.json({});
    }) as typeof fetch;

    const target = { token: "ghs_test", owner: "acme", repo: "demo", issueNumber: 7 };
    await expect(
      applyGitHubIssueMutationIntent({
        target,
        fetchImpl,
        intent: {
          intentId: "intent_set_assignee",
          domain: "assignee",
          action: "set_assignee",
          summary: "Set assignee.",
          params: { assignee: "alice" }
        }
      })
    ).resolves.toMatchObject({ intentId: "intent_set_assignee", outcome: "applied" });

    await expect(
      applyGitHubIssueMutationIntent({
        target,
        fetchImpl,
        intent: {
          intentId: "intent_add_assignee",
          domain: "assignee",
          action: "add_assignee",
          summary: "Add assignee.",
          params: { assignee: "bob" }
        }
      })
    ).resolves.toMatchObject({ intentId: "intent_add_assignee", outcome: "applied" });

    await expect(
      applyGitHubIssueMutationIntent({
        target,
        fetchImpl,
        intent: {
          intentId: "intent_remove_assignee",
          domain: "assignee",
          action: "remove_assignee",
          summary: "Remove assignee.",
          params: { assignee: "carol" }
        }
      })
    ).resolves.toMatchObject({ intentId: "intent_remove_assignee", outcome: "applied" });

    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/demo/issues/7",
        method: "PATCH",
        authorization: "Bearer ghs_test",
        body: { assignees: ["alice"] }
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/7/assignees",
        method: "POST",
        authorization: "Bearer ghs_test",
        body: { assignees: ["bob"] }
      },
      {
        url: "https://api.github.com/repos/acme/demo/issues/7/assignees",
        method: "DELETE",
        authorization: "Bearer ghs_test",
        body: { assignees: ["carol"] }
      }
    ]);
  });
});
