import { describe, expect, it, vi } from "vitest";
import {
  createGitHubCompletionApi,
  reconcileGitHubCompletionEvidence,
  type GitHubCompletionApi
} from "../src/completion-evidence.js";

const HEAD_OLD = "a".repeat(40);
const HEAD_CURRENT = "b".repeat(40);
const BASE_SHA = "c".repeat(40);

function completionApi(overrides: Partial<GitHubCompletionApi> = {}): GitHubCompletionApi {
  return {
    async getPullRequest({ pullRequestNumber }) {
      return {
        number: pullRequestNumber,
        state: "open",
        merged: false,
        head: { sha: HEAD_CURRENT },
        base: { ref: "main", sha: BASE_SHA, repo: { full_name: "acme/demo" } }
      };
    },
    async listCheckRunsForRef() {
      return [
        { name: "build", status: "completed", conclusion: "success", head_sha: HEAD_CURRENT },
        { name: "test", status: "completed", conclusion: "failure", head_sha: HEAD_OLD }
      ];
    },
    async getCombinedStatusForRef() {
      return [{ context: "test", state: "success", sha: HEAD_CURRENT }];
    },
    async listPullRequestsForCommit() {
      return [{ number: 7 }];
    },
    ...overrides
  };
}

describe("GitHub completion evidence", () => {
  it("reconciles a PR event against the authoritative current head", async () => {
    const api = completionApi();
    const snapshot = await reconcileGitHubCompletionEvidence({
      eventName: "pull_request",
      deliveryId: "delivery-pr-1",
      payload: {
        number: 7,
        pull_request: { number: 7, head: { sha: HEAD_OLD }, merged: true },
        repository: { name: "demo", owner: { login: "acme" } }
      },
      api,
      observedAt: "2026-07-21T10:00:00.000Z"
    });

    expect(snapshot).toEqual([expect.objectContaining({
      provider: "github",
      deliveryId: "delivery-pr-1",
      repository: { owner: "acme", repo: "demo" },
      pullRequest: {
        number: 7,
        resourceRef: "github:acme/demo:pull_request:7",
        headSha: HEAD_CURRENT,
        baseSha: BASE_SHA,
        baseBranch: "main",
        state: "open"
      },
      checks: { build: "passed", test: "passed" },
      payloadDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    })]);
  });

  it("correlates status events through the commit-to-pull-request API", async () => {
    const listPullRequestsForCommit = vi.fn(async () => [{ number: 7 }]);
    await reconcileGitHubCompletionEvidence({
      eventName: "status",
      deliveryId: "delivery-status-1",
      payload: {
        sha: HEAD_CURRENT,
        repository: { name: "demo", owner: { login: "acme" } }
      },
      api: completionApi({ listPullRequestsForCommit }),
      observedAt: "2026-07-21T10:00:00.000Z"
    });

    expect(listPullRequestsForCommit).toHaveBeenCalledWith({ owner: "acme", repo: "demo", ref: HEAD_CURRENT });
  });

  it("fails closed when GitHub returns a pull request for another base repository", async () => {
    await expect(reconcileGitHubCompletionEvidence({
      eventName: "check_run",
      deliveryId: "delivery-check-1",
      payload: {
        check_run: { head_sha: HEAD_CURRENT, pull_requests: [{ number: 7 }] },
        repository: { name: "demo", owner: { login: "acme" } }
      },
      api: completionApi({
        async getPullRequest({ pullRequestNumber }) {
          return {
            number: pullRequestNumber,
            state: "open",
            merged: false,
            head: { sha: HEAD_CURRENT },
            base: { ref: "main", sha: BASE_SHA, repo: { full_name: "other/demo" } }
          };
        }
      }),
      observedAt: "2026-07-21T10:00:00.000Z"
    })).rejects.toThrow("mismatched target repository");
  });

  it("never includes the API token in reconciliation failures", async () => {
    const api = createGitHubCompletionApi({
      token: "github_secret_token",
      fetchImpl: vi.fn(async () => new Response("nope", { status: 500 }))
    });
    await expect(api.getPullRequest({ owner: "acme", repo: "demo", pullRequestNumber: 7 }))
      .rejects.not.toThrow("github_secret_token");
  });
});
