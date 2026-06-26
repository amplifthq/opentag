import { describe, expect, it, vi } from "vitest";
import { handleIssueCommentCreated, handlePullRequestReviewCommentCreated } from "../src/app.js";

describe("GitHub Probot handler", () => {
  it("creates a dispatcher run for an opentag mention", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const postComment = vi.fn(async () => undefined);

    await handleIssueCommentCreated({
      payload: {
        comment: {
          id: 123,
          body: "@opentag fix this",
          html_url: "https://github.com/acme/demo/issues/1#issuecomment-123"
        },
        issue: {
          html_url: "https://github.com/acme/demo/issues/1",
          comments_url: "https://api.github.com/repos/acme/demo/issues/1/comments",
          number: 1
        },
        repository: {
          name: "demo",
          private: false,
          owner: { login: "acme" }
        },
        sender: {
          id: 42,
          login: "octocat"
        }
      },
      createRun,
      postComment,
      now: () => "2026-06-24T00:00:00.000Z"
    });

    expect(createRun).toHaveBeenCalledOnce();
    expect(postComment).toHaveBeenCalledWith("OpenTag picked this up. Run: `run_1`");
  });

  it("ignores comments without an opentag mention", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const postComment = vi.fn(async () => undefined);

    await handleIssueCommentCreated({
      payload: {
        comment: {
          id: 123,
          body: "plain comment",
          html_url: "https://github.com/acme/demo/issues/1#issuecomment-123"
        },
        issue: {
          html_url: "https://github.com/acme/demo/issues/1",
          comments_url: "https://api.github.com/repos/acme/demo/issues/1/comments",
          number: 1
        },
        repository: {
          name: "demo",
          private: false,
          owner: { login: "acme" }
        },
        sender: {
          id: 42,
          login: "octocat"
        }
      },
      createRun,
      postComment,
      now: () => "2026-06-24T00:00:00.000Z"
    });

    expect(createRun).not.toHaveBeenCalled();
    expect(postComment).not.toHaveBeenCalled();
  });

  it("submits source-thread action replies instead of creating a new issue run", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const postComment = vi.fn(async () => undefined);

    await handleIssueCommentCreated({
      payload: {
        comment: {
          id: 124,
          body: "apply 1",
          html_url: "https://github.com/acme/demo/issues/1#issuecomment-124"
        },
        issue: {
          html_url: "https://github.com/acme/demo/issues/1",
          comments_url: "https://api.github.com/repos/acme/demo/issues/1/comments",
          number: 1
        },
        repository: {
          name: "demo",
          private: false,
          owner: { login: "acme" }
        },
        sender: {
          id: 42,
          login: "octocat"
        }
      },
      createRun,
      submitThreadAction,
      postComment,
      now: () => "2026-06-24T00:00:00.000Z"
    });

    expect(createRun).not.toHaveBeenCalled();
    expect(postComment).not.toHaveBeenCalled();
    expect(submitThreadAction).toHaveBeenCalledWith({
      id: "approval_github_comment_124",
      rawText: "apply 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        issueNumber: 1,
        commentUrl: "https://github.com/acme/demo/issues/1#issuecomment-124"
      }
    });
  });

  it("does not post a local acknowledgement when dispatcher owns callbacks", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const postComment = vi.fn(async () => undefined);

    await handleIssueCommentCreated({
      payload: {
        comment: {
          id: 123,
          body: "@opentag fix this",
          html_url: "https://github.com/acme/demo/issues/1#issuecomment-123"
        },
        issue: {
          html_url: "https://github.com/acme/demo/issues/1",
          comments_url: "https://api.github.com/repos/acme/demo/issues/1/comments",
          number: 1
        },
        repository: {
          name: "demo",
          private: false,
          owner: { login: "acme" }
        },
        sender: {
          id: 42,
          login: "octocat"
        }
      },
      createRun,
      postComment,
      now: () => "2026-06-24T00:00:00.000Z",
      dispatcherOwnsCallbacks: true
    });

    expect(createRun).toHaveBeenCalledOnce();
    expect(postComment).not.toHaveBeenCalled();
  });

  it("does not post a local acknowledgement when the dispatcher does not create a run", async () => {
    const createRun = vi.fn(async () => ({}));
    const postComment = vi.fn(async () => undefined);

    await handleIssueCommentCreated({
      payload: {
        comment: {
          id: 123,
          body: "@opentag fix this",
          html_url: "https://github.com/acme/demo/issues/1#issuecomment-123"
        },
        issue: {
          html_url: "https://github.com/acme/demo/issues/1",
          comments_url: "https://api.github.com/repos/acme/demo/issues/1/comments",
          number: 1
        },
        repository: {
          name: "demo",
          private: false,
          owner: { login: "acme" }
        },
        sender: {
          id: 42,
          login: "octocat"
        }
      },
      createRun,
      postComment,
      now: () => "2026-06-24T00:00:00.000Z"
    });

    expect(createRun).toHaveBeenCalledOnce();
    expect(postComment).not.toHaveBeenCalled();
  });

  it("creates a dispatcher run for an opentag PR review comment", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_2" }));
    const postComment = vi.fn(async () => undefined);

    await handlePullRequestReviewCommentCreated({
      payload: {
        comment: {
          id: 456,
          body: "@opentag review this",
          html_url: "https://github.com/acme/demo/pull/2#discussion_r456"
        },
        pull_request: {
          html_url: "https://github.com/acme/demo/pull/2",
          number: 2
        },
        repository: {
          name: "demo",
          private: false,
          owner: { login: "acme" }
        },
        sender: {
          id: 42,
          login: "octocat"
        }
      },
      createRun,
      postComment,
      now: () => "2026-06-24T00:00:00.000Z"
    });

    expect(createRun).toHaveBeenCalledOnce();
    expect(postComment).toHaveBeenCalledWith("OpenTag picked this up. Run: `run_2`");
  });

  it("submits source-thread action replies from PR review comments", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_2" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const postComment = vi.fn(async () => undefined);

    await handlePullRequestReviewCommentCreated({
      payload: {
        comment: {
          id: 457,
          body: "continue 1",
          html_url: "https://github.com/acme/demo/pull/2#discussion_r457"
        },
        pull_request: {
          html_url: "https://github.com/acme/demo/pull/2",
          number: 2
        },
        repository: {
          name: "demo",
          private: false,
          owner: { login: "acme" }
        },
        sender: {
          id: 42,
          login: "octocat"
        }
      },
      createRun,
      submitThreadAction,
      postComment,
      now: () => "2026-06-24T00:00:00.000Z"
    });

    expect(createRun).not.toHaveBeenCalled();
    expect(postComment).not.toHaveBeenCalled();
    expect(submitThreadAction).toHaveBeenCalledWith({
      id: "approval_github_pr_review_comment_457",
      rawText: "continue 1",
      actor: { provider: "github", providerUserId: "42", handle: "octocat" },
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/2/comments",
        threadKey: "acme/demo#2"
      },
      metadata: {
        repoProvider: "github",
        owner: "acme",
        repo: "demo",
        pullRequestNumber: 2,
        commentUrl: "https://github.com/acme/demo/pull/2#discussion_r457"
      }
    });
  });
});
