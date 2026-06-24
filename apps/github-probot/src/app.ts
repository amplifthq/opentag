import { createOpenTagClient } from "@opentag/client";
import type { OpenTagEvent } from "@opentag/core";
import { normalizeGitHubIssueComment, normalizeGitHubPullRequestReviewComment, renderAcknowledgement } from "@opentag/github";
import type { Probot } from "probot";

type IssueCommentPayload = {
  comment: { id: number; body: string; html_url: string };
  issue: { html_url: string; comments_url: string; number: number };
  repository: { name: string; private: boolean; owner: { login: string } };
  sender: { id: number; login: string };
  installation?: { id: number };
};

type PullRequestReviewCommentPayload = {
  comment: { id: number; body: string; html_url: string };
  pull_request: { html_url: string; number: number };
  repository: { name: string; private: boolean; owner: { login: string } };
  sender: { id: number; login: string };
  installation?: { id: number };
};

export async function handleIssueCommentCreated(input: {
  payload: IssueCommentPayload;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  postComment(body: string): Promise<void>;
  now(): string;
  dispatcherOwnsCallbacks?: boolean;
}): Promise<void> {
  const event = normalizeGitHubIssueComment({
    id: String(input.payload.comment.id),
    commentBody: input.payload.comment.body,
    commentUrl: input.payload.comment.html_url,
    apiCommentsUrl: input.payload.issue.comments_url,
    issueUrl: input.payload.issue.html_url,
    issueNumber: input.payload.issue.number,
    owner: input.payload.repository.owner.login,
    repo: input.payload.repository.name,
    actorId: input.payload.sender.id,
    actorLogin: input.payload.sender.login,
    private: input.payload.repository.private,
    receivedAt: input.now(),
    ...(input.payload.installation ? { installationId: input.payload.installation.id } : {})
  });

  if (!event) return;

  const { runId } = await input.createRun(event);
  if (!input.dispatcherOwnsCallbacks) {
    await input.postComment(renderAcknowledgement(runId));
  }
}

export async function handlePullRequestReviewCommentCreated(input: {
  payload: PullRequestReviewCommentPayload;
  createRun(event: OpenTagEvent): Promise<{ runId: string }>;
  postComment(body: string): Promise<void>;
  now(): string;
  dispatcherOwnsCallbacks?: boolean;
}): Promise<void> {
  const owner = input.payload.repository.owner.login;
  const repo = input.payload.repository.name;
  const event = normalizeGitHubPullRequestReviewComment({
    id: String(input.payload.comment.id),
    commentBody: input.payload.comment.body,
    commentUrl: input.payload.comment.html_url,
    pullRequestUrl: input.payload.pull_request.html_url,
    apiCommentsUrl: `https://api.github.com/repos/${owner}/${repo}/issues/${input.payload.pull_request.number}/comments`,
    owner,
    repo,
    pullRequestNumber: input.payload.pull_request.number,
    actorId: input.payload.sender.id,
    actorLogin: input.payload.sender.login,
    private: input.payload.repository.private,
    receivedAt: input.now(),
    ...(input.payload.installation ? { installationId: input.payload.installation.id } : {})
  });

  if (!event) return;

  const { runId } = await input.createRun(event);
  if (!input.dispatcherOwnsCallbacks) {
    await input.postComment(renderAcknowledgement(runId));
  }
}

async function createDispatcherRun(input: { event: OpenTagEvent; log: { warn(data: unknown, message: string): void } }): Promise<{ runId: string }> {
  const dispatcherUrl = process.env.OPENTAG_DISPATCHER_URL;
  const runId = `run_${input.event.source}_${input.event.sourceEventId}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!dispatcherUrl) {
    input.log.warn({ runId, event: input.event }, "OPENTAG_DISPATCHER_URL is not set; run was not dispatched");
    return { runId };
  }

  await createOpenTagClient({
    dispatcherUrl,
    ...(process.env.OPENTAG_DISPATCHER_TOKEN ? { pairingToken: process.env.OPENTAG_DISPATCHER_TOKEN } : {})
  }).createRun({
    runId,
    event: input.event
  });
  return { runId };
}

export function createOpenTagProbotApp(app: Probot): void {
  app.on("issue_comment.created", async (context) => {
    await handleIssueCommentCreated({
      payload: context.payload as IssueCommentPayload,
      createRun: async (event) => createDispatcherRun({ event, log: context.log }),
      postComment: async (body) => {
        await context.octokit.rest.issues.createComment(context.issue({ body }));
      },
      now: () => new Date().toISOString(),
      dispatcherOwnsCallbacks: process.env.OPENTAG_DISPATCHER_OWNS_CALLBACKS === "true"
    });
  });

  app.on("pull_request_review_comment.created", async (context) => {
    const payload = context.payload as PullRequestReviewCommentPayload;
    await handlePullRequestReviewCommentCreated({
      payload,
      createRun: async (event) => createDispatcherRun({ event, log: context.log }),
      postComment: async (body) => {
        await context.octokit.rest.issues.createComment({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          issue_number: payload.pull_request.number,
          body
        });
      },
      now: () => new Date().toISOString(),
      dispatcherOwnsCallbacks: process.env.OPENTAG_DISPATCHER_OWNS_CALLBACKS === "true"
    });
  });
}
