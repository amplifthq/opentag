import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import { parseThreadActionCommand, type OpenTagEvent } from "@opentag/core";
import { Hono } from "hono";
import { normalizeGitHubIssueComment, normalizeGitHubPullRequestReviewComment } from "./normalize.js";

type GitHubActor = {
  id: number;
  login: string;
};

type GitHubRepository = {
  name: string;
  private: boolean;
  owner: { login: string };
};

export type GitHubIssueCommentPayload = {
  action?: string;
  comment: { id: number; body: string; html_url: string };
  issue: { html_url: string; comments_url: string; number: number };
  repository: GitHubRepository;
  sender: GitHubActor;
  installation?: { id: number };
};

export type GitHubPullRequestReviewCommentPayload = {
  action?: string;
  comment: { id: number; body: string; html_url: string };
  pull_request: { html_url: string; number: number };
  repository: GitHubRepository;
  sender: GitHubActor;
  installation?: { id: number };
};

export type GitHubThreadActionInput = {
  id: string;
  rawText: string;
  actor: {
    provider: "github";
    providerUserId: string;
    handle: string;
  };
  callback: {
    provider: "github";
    uri: string;
    threadKey: string;
  };
  metadata: Record<string, unknown>;
};

export type GitHubWebhookAppInput = {
  webhookSecret: string;
  webhookPath?: string;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: GitHubThreadActionInput): Promise<unknown>;
  now(): string;
};

export type GitHubIngressConfig = {
  webhookSecret: string;
  dispatcherUrl: string;
  dispatcherToken?: string;
  port?: number;
  hostname?: string;
  webhookPath?: string;
};

export type GitHubIngressHandle = {
  url: string;
  webhookPath: string;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
};

export function computeGitHubSignature(input: { webhookSecret: string; rawBody: string }): string {
  const digest = createHmac("sha256", input.webhookSecret).update(input.rawBody).digest("hex");
  return `sha256=${digest}`;
}

export function verifyGitHubSignature(input: {
  webhookSecret: string;
  rawBody: string;
  signature: string;
}): boolean {
  const expected = computeGitHubSignature(input);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(input.signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function parseJsonPayload(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

async function handleIssueCommentCreated(input: {
  payload: GitHubIssueCommentPayload;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: GitHubThreadActionInput): Promise<unknown>;
  now(): string;
}): Promise<void> {
  if (input.payload.action && input.payload.action !== "created") return;
  if (parseThreadActionCommand(input.payload.comment.body) && input.submitThreadAction) {
    await input.submitThreadAction({
      id: `approval_github_comment_${input.payload.comment.id}`,
      rawText: input.payload.comment.body,
      actor: {
        provider: "github",
        providerUserId: String(input.payload.sender.id),
        handle: input.payload.sender.login
      },
      callback: {
        provider: "github",
        uri: input.payload.issue.comments_url,
        threadKey: `${input.payload.repository.owner.login}/${input.payload.repository.name}#${input.payload.issue.number}`
      },
      metadata: {
        repoProvider: "github",
        owner: input.payload.repository.owner.login,
        repo: input.payload.repository.name,
        issueNumber: input.payload.issue.number,
        commentUrl: input.payload.comment.html_url
      }
    });
    return;
  }

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

  if (event) {
    await input.createRun(event);
  }
}

async function handlePullRequestReviewCommentCreated(input: {
  payload: GitHubPullRequestReviewCommentPayload;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: GitHubThreadActionInput): Promise<unknown>;
  now(): string;
}): Promise<void> {
  if (input.payload.action && input.payload.action !== "created") return;
  const owner = input.payload.repository.owner.login;
  const repo = input.payload.repository.name;
  if (parseThreadActionCommand(input.payload.comment.body) && input.submitThreadAction) {
    await input.submitThreadAction({
      id: `approval_github_pr_review_comment_${input.payload.comment.id}`,
      rawText: input.payload.comment.body,
      actor: {
        provider: "github",
        providerUserId: String(input.payload.sender.id),
        handle: input.payload.sender.login
      },
      callback: {
        provider: "github",
        uri: `https://api.github.com/repos/${owner}/${repo}/issues/${input.payload.pull_request.number}/comments`,
        threadKey: `${owner}/${repo}#${input.payload.pull_request.number}`
      },
      metadata: {
        repoProvider: "github",
        owner,
        repo,
        pullRequestNumber: input.payload.pull_request.number,
        commentUrl: input.payload.comment.html_url
      }
    });
    return;
  }

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

  if (event) {
    await input.createRun(event);
  }
}

export function createGitHubWebhookApp(input: GitHubWebhookAppInput) {
  const app = new Hono();
  const webhookPath = input.webhookPath ?? "/github/webhooks";
  if (!webhookPath.startsWith("/")) {
    throw new Error("GitHub webhook path must start with /.");
  }

  app.post(webhookPath, async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    if (!signature) {
      return c.json({ error: "missing_signature_header" }, 401);
    }
    const rawBody = await c.req.text();
    if (!verifyGitHubSignature({ webhookSecret: input.webhookSecret, rawBody, signature })) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    const eventName = c.req.header("x-github-event");
    const payload = parseJsonPayload(rawBody);
    if (!payload || typeof payload !== "object") {
      return c.json({ error: "invalid_json" }, 400);
    }

    if (eventName === "ping") {
      return c.json({ ok: true });
    }
    if (eventName === "issue_comment") {
      await handleIssueCommentCreated({
        payload: payload as GitHubIssueCommentPayload,
        createRun: input.createRun,
        ...(input.submitThreadAction ? { submitThreadAction: input.submitThreadAction } : {}),
        now: input.now
      });
      return c.json({ ok: true });
    }
    if (eventName === "pull_request_review_comment") {
      await handlePullRequestReviewCommentCreated({
        payload: payload as GitHubPullRequestReviewCommentPayload,
        createRun: input.createRun,
        ...(input.submitThreadAction ? { submitThreadAction: input.submitThreadAction } : {}),
        now: input.now
      });
      return c.json({ ok: true });
    }

    return c.json({ ok: true, ignored: "unsupported_event" });
  });

  return app;
}

export function startGitHubIngress(config: GitHubIngressConfig): GitHubIngressHandle {
  const dispatcherClient = createOpenTagClient({
    dispatcherUrl: config.dispatcherUrl,
    ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {})
  });
  const port = config.port ?? 3000;
  const hostname = config.hostname ?? "127.0.0.1";
  const webhookPath = config.webhookPath ?? "/github/webhooks";
  const server = serve({
    fetch: createGitHubWebhookApp({
      webhookSecret: config.webhookSecret,
      webhookPath,
      async createRun(event) {
        const runId = `run_${randomUUID()}`;
        const created = await dispatcherClient.createRun({ runId, event });
        return created.outcome === "run_created" ? { runId: created.run.id } : {};
      },
      async submitThreadAction(action) {
        await dispatcherClient.submitThreadAction(action);
      },
      now: () => new Date().toISOString()
    }).fetch,
    port,
    hostname
  });

  return {
    url: `http://${hostname}:${port}`,
    webhookPath,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
