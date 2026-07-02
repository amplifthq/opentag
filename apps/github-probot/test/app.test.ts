import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIssueCommentCreated, handlePullRequestReviewCommentCreated, newRunId } from "../src/app.js";

describe("newRunId", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces a unique id for distinct runs created in the same millisecond", () => {
    // Freeze the clock: a Date.now()-based id would collide here, pass the
    // eventId guard, then throw SQLITE_CONSTRAINT on the run primary key.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T00:00:00.000Z"));

    const first = newRunId();
    const second = newRunId();

    expect(first).toMatch(/^run_/);
    expect(second).toMatch(/^run_/);
    expect(first).not.toBe(second);
  });
});

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

  it("uses resolved GitHub repository permission for run actor write access", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_permission" }));
    const postComment = vi.fn(async () => undefined);
    const resolveActorWriteAccess = vi.fn(async () => true);

    await handleIssueCommentCreated({
      payload: {
        comment: {
          id: 125,
          body: "@opentag fix this",
          html_url: "https://github.com/acme/demo/issues/1#issuecomment-125",
          author_association: "COLLABORATOR"
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
      resolveActorWriteAccess,
      postComment,
      now: () => "2026-06-24T00:00:00.000Z"
    });

    expect(resolveActorWriteAccess).toHaveBeenCalledWith({ owner: "acme", repo: "demo", username: "octocat" });
    expect(createRun.mock.calls[0]![0]).toMatchObject({
      actor: { provider: "github", providerUserId: "42", handle: "octocat", writeAccess: true },
      metadata: { authorAssociation: "COLLABORATOR" }
    });
  });

  it("ignores comments without an opentag mention", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const postComment = vi.fn(async () => undefined);
    const resolveActorWriteAccess = vi.fn(async () => true);

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
      resolveActorWriteAccess,
      postComment,
      now: () => "2026-06-24T00:00:00.000Z"
    });

    expect(createRun).not.toHaveBeenCalled();
    expect(resolveActorWriteAccess).not.toHaveBeenCalled();
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

  it("uses resolved repository permission for source-thread action actors", async () => {
    const createRun = vi.fn(async () => ({ runId: "run_1" }));
    const submitThreadAction = vi.fn(async () => ({}));
    const postComment = vi.fn(async () => undefined);
    const resolveActorWriteAccess = vi.fn(async () => false);

    await handleIssueCommentCreated({
      payload: {
        comment: {
          id: 126,
          body: "apply 1",
          html_url: "https://github.com/acme/demo/issues/1#issuecomment-126",
          author_association: "COLLABORATOR"
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
          id: 99,
          login: "mallory"
        }
      },
      createRun,
      submitThreadAction,
      resolveActorWriteAccess,
      postComment,
      now: () => "2026-06-24T00:00:00.000Z"
    });

    expect(resolveActorWriteAccess).toHaveBeenCalledWith({ owner: "acme", repo: "demo", username: "mallory" });
    expect(submitThreadAction.mock.calls[0]![0]).toMatchObject({
      actor: { provider: "github", providerUserId: "99", handle: "mallory", writeAccess: false }
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
