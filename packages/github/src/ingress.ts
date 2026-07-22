import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  parseThreadActionCommand,
  parseThreadControlCommand,
  readRequestTextWithLimit,
  type HumanEscalation,
  type OpenTagEvent
} from "@opentag/core";
import { Hono } from "hono";
import { githubPermissionHasWriteAccess, normalizeGitHubIssueComment, normalizeGitHubPullRequestReviewComment } from "./normalize.js";
import {
  createGitHubCompletionApi,
  githubCompletionEventCorrelation,
  isGitHubCompletionEventName,
  reconcileGitHubCompletionEvidence,
  type GitHubCompletionApi,
  type GitHubVerifiedPullRequestSnapshot
} from "./completion-evidence.js";

type GitHubActor = {
  id: number;
  login: string;
};

type GitHubRepository = {
  name: string;
  private: boolean;
  owner: { login: string };
};

type GitHubComment = {
  id: number;
  body: string;
  html_url: string;
  author_association?: string;
};

export type GitHubIssueCommentPayload = {
  action?: string;
  comment: GitHubComment;
  issue: { html_url: string; comments_url: string; number: number };
  repository: GitHubRepository;
  sender: GitHubActor;
  installation?: { id: number };
};

export type GitHubPullRequestReviewCommentPayload = {
  action?: string;
  comment: GitHubComment;
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
    writeAccess?: boolean;
  };
  callback: {
    provider: "github";
    uri: string;
    threadKey: string;
  };
  metadata: Record<string, unknown>;
};

export type GitHubActorWriteAccessResolver = (input: {
  owner: string;
  repo: string;
  username: string;
}) => Promise<boolean | undefined>;

export type GitHubCompletionReconciliationEscalationRequest = {
  operation: "open" | "resolve";
  escalation: Pick<HumanEscalation, "audience" | "subjectRef" | "summary" | "reason"> & {
    class: "reconciliation";
    audience: "repo_owner";
    state: "open" | "resolved";
    blocking: true;
    dedupeKey: string;
  };
  correlation: {
    provider: "github";
    deliveryId: string;
    eventName: GitHubVerifiedPullRequestSnapshot["eventName"];
    repository: { owner: string; repo: string };
    pullRequestNumbers: number[];
    headSha?: string;
  };
};

export type GitHubCompletionReconciliationEscalationRequester = (
  request: GitHubCompletionReconciliationEscalationRequest
) => Promise<void>;

export type GitHubWebhookAppInput = {
  webhookSecret: string;
  webhookPath?: string;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: GitHubThreadActionInput): Promise<unknown>;
  resolveActorWriteAccess?: GitHubActorWriteAccessResolver;
  completionApi?: GitHubCompletionApi;
  ingestCompletionEvidence?(snapshot: GitHubVerifiedPullRequestSnapshot): Promise<unknown>;
  ingestCompletionEvidenceBatch?(snapshots: GitHubVerifiedPullRequestSnapshot[]): Promise<unknown>;
  requestCompletionReconciliationEscalation?: GitHubCompletionReconciliationEscalationRequester;
  recordControlPlaneEvent?(event: {
    type: string;
    severity?: "info" | "warn" | "error";
    subject?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  maxRequestBodyBytes?: number;
  now(): string;
};

export type GitHubIngressConfig = {
  webhookSecret: string;
  dispatcherUrl: string;
  dispatcherToken?: string;
  githubToken?: string;
  requestCompletionReconciliationEscalation?: GitHubCompletionReconciliationEscalationRequester;
  fetchImpl?: typeof fetch;
  port?: number;
  hostname?: string;
  webhookPath?: string;
  maxRequestBodyBytes?: number;
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

async function recordGitHubSignatureFailure(input: {
  recordControlPlaneEvent?: GitHubWebhookAppInput["recordControlPlaneEvent"];
  webhookPath: string;
  reason: "missing_signature_header" | "invalid_signature";
  deliveryId?: string;
  hasSignature: boolean;
}): Promise<void> {
  try {
    await input.recordControlPlaneEvent?.({
      type: "security.signature_failed",
      severity: "warn",
      subject: `github:POST ${input.webhookPath}`,
      payload: {
        provider: "github",
        endpoint: `POST ${input.webhookPath}`,
        reason: input.reason,
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
        hasSignature: input.hasSignature
      }
    });
  } catch {
    // Signature rejection should not turn into a 5xx if audit reporting is unavailable.
  }
}

async function recordGitHubRequestBodyRejected(input: {
  recordControlPlaneEvent?: GitHubWebhookAppInput["recordControlPlaneEvent"];
  webhookPath: string;
  reason: "request_body_too_large" | "invalid_json_body" | "invalid_request_body";
  maxBytes?: number;
  contentLength: string | null;
  deliveryId?: string;
  eventName?: string;
}): Promise<void> {
  try {
    await input.recordControlPlaneEvent?.({
      type: "security.request_body_rejected",
      severity: "warn",
      subject: `github:POST ${input.webhookPath}`,
      payload: {
        provider: "github",
        endpoint: `POST ${input.webhookPath}`,
        reason: input.reason,
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
        contentLength: input.contentLength,
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
        ...(input.eventName ? { githubEvent: input.eventName } : {})
      }
    });
  } catch {
    // Oversized-payload rejection should still fail closed if audit reporting is unavailable.
  }
}

function parseJsonPayload(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function encodeGitHubPathSegment(value: string): string {
  return encodeURIComponent(value);
}

function hasGitHubActor(value: unknown): value is GitHubActor {
  return isRecord(value) && typeof value.id === "number" && typeof value.login === "string";
}

function hasGitHubRepository(value: unknown): value is GitHubRepository {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.private === "boolean" &&
    isRecord(value.owner) &&
    typeof value.owner.login === "string"
  );
}

function hasGitHubInstallation(value: unknown): value is { id: number } {
  return isRecord(value) && typeof value.id === "number";
}

function hasGitHubComment(value: unknown): value is GitHubComment {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.body === "string" &&
    typeof value.html_url === "string" &&
    (value.author_association === undefined || typeof value.author_association === "string")
  );
}

async function resolvePayloadActorWriteAccess(input: {
  payload: { repository: GitHubRepository; sender: GitHubActor };
  resolveActorWriteAccess?: GitHubActorWriteAccessResolver;
}): Promise<boolean | undefined> {
  if (!input.resolveActorWriteAccess) return undefined;
  try {
    return await input.resolveActorWriteAccess({
      owner: input.payload.repository.owner.login,
      repo: input.payload.repository.name,
      username: input.payload.sender.login
    });
  } catch {
    return undefined;
  }
}

async function resolveGitHubActorWriteAccessWithToken(input: {
  owner: string;
  repo: string;
  username: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean | undefined> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeGitHubPathSegment(input.owner)}/${encodeGitHubPathSegment(input.repo)}/collaborators/${encodeGitHubPathSegment(input.username)}/permission`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28"
      }
    }
  );
  if (response.status === 404) return false;
  if (!response.ok) return undefined;
  const data: unknown = await response.json();
  if (!isRecord(data) || typeof data.permission !== "string") return undefined;
  return githubPermissionHasWriteAccess(data.permission);
}

function isGitHubIssueCommentPayload(value: unknown): value is GitHubIssueCommentPayload {
  return (
    isRecord(value) &&
    (value.action === undefined || typeof value.action === "string") &&
    hasGitHubComment(value.comment) &&
    isRecord(value.issue) &&
    typeof value.issue.html_url === "string" &&
    typeof value.issue.comments_url === "string" &&
    typeof value.issue.number === "number" &&
    hasGitHubRepository(value.repository) &&
    hasGitHubActor(value.sender) &&
    (value.installation === undefined || hasGitHubInstallation(value.installation))
  );
}

function isGitHubPullRequestReviewCommentPayload(value: unknown): value is GitHubPullRequestReviewCommentPayload {
  return (
    isRecord(value) &&
    (value.action === undefined || typeof value.action === "string") &&
    hasGitHubComment(value.comment) &&
    isRecord(value.pull_request) &&
    typeof value.pull_request.html_url === "string" &&
    typeof value.pull_request.number === "number" &&
    hasGitHubRepository(value.repository) &&
    hasGitHubActor(value.sender) &&
    (value.installation === undefined || hasGitHubInstallation(value.installation))
  );
}

async function handleIssueCommentCreated(input: {
  payload: GitHubIssueCommentPayload;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: GitHubThreadActionInput): Promise<unknown>;
  resolveActorWriteAccess?: GitHubActorWriteAccessResolver;
  now(): string;
  deliveryId?: string;
  signatureVerified?: boolean;
}): Promise<void> {
  if (input.payload.action && input.payload.action !== "created") return;
  const controlCommand = parseThreadControlCommand(input.payload.comment.body);
  const actionCommand = parseThreadActionCommand(input.payload.comment.body);
  if (controlCommand || actionCommand) {
    if (input.submitThreadAction) {
      const actorWriteAccess = await resolvePayloadActorWriteAccess(input);
      await input.submitThreadAction({
        id: `${controlCommand ? "control" : "approval"}_github_comment_${input.payload.comment.id}`,
        rawText: input.payload.comment.body,
        actor: {
          provider: "github",
          providerUserId: String(input.payload.sender.id),
          handle: input.payload.sender.login,
          ...(actorWriteAccess !== undefined ? { writeAccess: actorWriteAccess } : {})
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
          commentUrl: input.payload.comment.html_url,
          ...(input.deliveryId ? { sourceDeliveryId: input.deliveryId, webhookDeliveryId: input.deliveryId } : {}),
          ...(typeof input.signatureVerified === "boolean"
            ? { webhookSignatureVerified: input.signatureVerified, signatureState: input.signatureVerified ? "verified" : "unverified" }
            : {})
        }
      });
    }
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
    ...(input.payload.comment.author_association ? { authorAssociation: input.payload.comment.author_association } : {}),
    private: input.payload.repository.private,
    receivedAt: input.now(),
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    ...(typeof input.signatureVerified === "boolean" ? { signatureVerified: input.signatureVerified } : {}),
    ...(input.payload.installation ? { installationId: input.payload.installation.id } : {})
  });

  if (event) {
    const actorWriteAccess = await resolvePayloadActorWriteAccess(input);
    if (actorWriteAccess !== undefined) {
      event.actor.writeAccess = actorWriteAccess;
    }
    await input.createRun(event);
  }
}

async function handlePullRequestReviewCommentCreated(input: {
  payload: GitHubPullRequestReviewCommentPayload;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: GitHubThreadActionInput): Promise<unknown>;
  resolveActorWriteAccess?: GitHubActorWriteAccessResolver;
  now(): string;
  deliveryId?: string;
  signatureVerified?: boolean;
}): Promise<void> {
  if (input.payload.action && input.payload.action !== "created") return;
  const owner = input.payload.repository.owner.login;
  const repo = input.payload.repository.name;
  const controlCommand = parseThreadControlCommand(input.payload.comment.body);
  const actionCommand = parseThreadActionCommand(input.payload.comment.body);
  if (controlCommand || actionCommand) {
    if (input.submitThreadAction) {
      const actorWriteAccess = await resolvePayloadActorWriteAccess(input);
      await input.submitThreadAction({
        id: `${controlCommand ? "control" : "approval"}_github_pr_review_comment_${input.payload.comment.id}`,
        rawText: input.payload.comment.body,
        actor: {
          provider: "github",
          providerUserId: String(input.payload.sender.id),
          handle: input.payload.sender.login,
          ...(actorWriteAccess !== undefined ? { writeAccess: actorWriteAccess } : {})
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
          commentUrl: input.payload.comment.html_url,
          ...(input.deliveryId ? { sourceDeliveryId: input.deliveryId, webhookDeliveryId: input.deliveryId } : {}),
          ...(typeof input.signatureVerified === "boolean"
            ? { webhookSignatureVerified: input.signatureVerified, signatureState: input.signatureVerified ? "verified" : "unverified" }
            : {})
        }
      });
    }
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
    ...(input.payload.comment.author_association ? { authorAssociation: input.payload.comment.author_association } : {}),
    private: input.payload.repository.private,
    receivedAt: input.now(),
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    ...(typeof input.signatureVerified === "boolean" ? { signatureVerified: input.signatureVerified } : {}),
    ...(input.payload.installation ? { installationId: input.payload.installation.id } : {})
  });

  if (event) {
    const actorWriteAccess = await resolvePayloadActorWriteAccess(input);
    if (actorWriteAccess !== undefined) {
      event.actor.writeAccess = actorWriteAccess;
    }
    await input.createRun(event);
  }
}

function completionReconciliationEscalationRequest(input: {
  operation: GitHubCompletionReconciliationEscalationRequest["operation"];
  eventName: GitHubVerifiedPullRequestSnapshot["eventName"];
  deliveryId: string;
  payload: unknown;
  reason: string;
  snapshots?: GitHubVerifiedPullRequestSnapshot[];
}): GitHubCompletionReconciliationEscalationRequest | null {
  const correlation = githubCompletionEventCorrelation({ eventName: input.eventName, payload: input.payload });
  if (!correlation) return null;
  const sourcePullRequestNumbers = [...new Set(correlation.pullRequestNumbers)].sort((left, right) => left - right);
  const resolvedPullRequestNumbers = [...new Set(input.snapshots?.map((snapshot) => snapshot.pullRequest.number) ?? [])]
    .sort((left, right) => left - right);
  const pullRequestNumbers = resolvedPullRequestNumbers.length > 0 ? resolvedPullRequestNumbers : sourcePullRequestNumbers;
  const subjectRef = sourcePullRequestNumbers.length === 1
    ? `github:${correlation.repository.owner}/${correlation.repository.repo}:pull_request:${sourcePullRequestNumbers[0]}`
    : correlation.headSha
      ? `github:${correlation.repository.owner}/${correlation.repository.repo}:commit:${correlation.headSha}`
      : `github:${correlation.repository.owner}/${correlation.repository.repo}:completion`;
  return {
    operation: input.operation,
    escalation: {
      class: "reconciliation",
      audience: "repo_owner",
      subjectRef,
      state: input.operation === "open" ? "open" : "resolved",
      blocking: true,
      summary: input.operation === "open"
        ? "GitHub completion evidence could not be reconciled."
        : "GitHub completion evidence reconciliation recovered.",
      reason: input.reason,
      dedupeKey: `github:completion-reconciliation:${subjectRef}`
    },
    correlation: {
      provider: "github",
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      repository: correlation.repository,
      pullRequestNumbers,
      ...(correlation.headSha ? { headSha: correlation.headSha } : {})
    }
  };
}

export function createGitHubWebhookApp(input: GitHubWebhookAppInput) {
  const app = new Hono();
  const webhookPath = input.webhookPath ?? "/github/webhooks";
  const maxRequestBodyBytes = input.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (!webhookPath.startsWith("/")) {
    throw new Error("GitHub webhook path must start with /.");
  }

  app.post(webhookPath, async (c) => {
    const signature = c.req.header("x-hub-signature-256");
    if (!signature) {
      await recordGitHubSignatureFailure({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        webhookPath,
        reason: "missing_signature_header",
        ...(c.req.header("x-github-delivery") ? { deliveryId: c.req.header("x-github-delivery")! } : {}),
        hasSignature: false
      });
      return c.json({ error: "missing_signature_header" }, 401);
    }
    let rawBody: string;
    try {
      rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes: maxRequestBodyBytes });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        await recordGitHubRequestBodyRejected({
          recordControlPlaneEvent: input.recordControlPlaneEvent,
          webhookPath,
          reason: "request_body_too_large",
          maxBytes: error.maxBytes,
          contentLength: c.req.raw.headers.get("content-length"),
          ...(c.req.header("x-github-delivery") ? { deliveryId: c.req.header("x-github-delivery")! } : {}),
          ...(c.req.header("x-github-event") ? { eventName: c.req.header("x-github-event")! } : {})
        });
        return c.json({ error: "request_body_too_large", maxBytes: error.maxBytes }, 413);
      }
      throw error;
    }
    if (!verifyGitHubSignature({ webhookSecret: input.webhookSecret, rawBody, signature })) {
      await recordGitHubSignatureFailure({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        webhookPath,
        reason: "invalid_signature",
        ...(c.req.header("x-github-delivery") ? { deliveryId: c.req.header("x-github-delivery")! } : {}),
        hasSignature: true
      });
      return c.json({ error: "invalid_signature" }, 401);
    }

    const deliveryId = c.req.header("x-github-delivery");
    const eventName = c.req.header("x-github-event");
    const payload = parseJsonPayload(rawBody);
    if (!payload || typeof payload !== "object") {
      await recordGitHubRequestBodyRejected({
        recordControlPlaneEvent: input.recordControlPlaneEvent,
        webhookPath,
        reason: "invalid_json_body",
        contentLength: c.req.raw.headers.get("content-length"),
        ...(deliveryId ? { deliveryId } : {}),
        ...(eventName ? { eventName } : {})
      });
      return c.json({ error: "invalid_json" }, 400);
    }

    if (eventName === "ping") {
      return c.json({ ok: true });
    }
    if (isGitHubCompletionEventName(eventName)) {
      if (!deliveryId) return c.json({ error: "missing_delivery_id" }, 400);
      const canIngestCompletionEvidence = Boolean(input.ingestCompletionEvidenceBatch || input.ingestCompletionEvidence);
      if (!input.completionApi && !canIngestCompletionEvidence) {
        return c.json({ ok: true, ignored: "completion_reconciliation_unconfigured" });
      }
      if (!input.completionApi || !canIngestCompletionEvidence) {
        return c.json({ error: "completion_reconciliation_unavailable" }, 503);
      }
      let snapshots: GitHubVerifiedPullRequestSnapshot[];
      try {
        snapshots = await reconcileGitHubCompletionEvidence({
          eventName,
          deliveryId,
          payload,
          api: input.completionApi,
          now: input.now
        });
        if (snapshots.length === 0) {
          return c.json({ ok: true, evidenceSnapshots: 0, ignored: "no_correlated_pull_requests" });
        }
        if (input.ingestCompletionEvidenceBatch) {
          await input.ingestCompletionEvidenceBatch(snapshots);
        } else {
          if (snapshots.length > 1) {
            throw new Error("completion_snapshot_batch_ingestion_required");
          }
          await input.ingestCompletionEvidence!(snapshots[0]!);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "completion_reconciliation_failed";
        await input.recordControlPlaneEvent?.({
          type: "github.completion_reconciliation_failed",
          severity: "warn",
          subject: `github:${deliveryId}`,
          payload: {
            provider: "github",
            deliveryId,
            eventName,
            reason
          }
        });
        if (reason === "completion_snapshot_batch_ingestion_required") {
          return c.json({
            error: "completion_snapshot_batch_ingestion_required",
            retryable: true
          }, 503);
        }
        const escalation = completionReconciliationEscalationRequest({
          operation: "open",
          eventName,
          deliveryId,
          payload,
          reason
        });
        if (escalation) {
          try {
            await input.requestCompletionReconciliationEscalation?.(escalation);
          } catch (escalationError) {
            await input.recordControlPlaneEvent?.({
              type: "github.completion_reconciliation_escalation_failed",
              severity: "error",
              subject: escalation.escalation.subjectRef,
              payload: {
                provider: "github",
                deliveryId,
                eventName,
                operation: "open",
                reason: escalationError instanceof Error ? escalationError.message : "completion_reconciliation_escalation_failed"
              }
            });
          }
        }
        return c.json({ error: "completion_reconciliation_failed" }, 503);
      }
      const resolvedEscalation = completionReconciliationEscalationRequest({
        operation: "resolve",
        eventName,
        deliveryId,
        payload,
        reason: "Authoritative GitHub completion evidence was reconciled and ingested successfully.",
        snapshots
      });
      if (resolvedEscalation && input.requestCompletionReconciliationEscalation) {
        try {
          await input.requestCompletionReconciliationEscalation(resolvedEscalation);
        } catch (error) {
          await input.recordControlPlaneEvent?.({
            type: "github.completion_reconciliation_escalation_failed",
            severity: "error",
            subject: resolvedEscalation.escalation.subjectRef,
            payload: {
              provider: "github",
              deliveryId,
              eventName,
              operation: "resolve",
              reason: error instanceof Error ? error.message : "completion_reconciliation_escalation_failed"
            }
          });
          return c.json({ error: "completion_reconciliation_escalation_unavailable" }, 503);
        }
      }
      return c.json({ ok: true, evidenceSnapshots: snapshots.length });
    }
    if (eventName === "issue_comment") {
      if (!isGitHubIssueCommentPayload(payload)) {
        await recordGitHubRequestBodyRejected({
          recordControlPlaneEvent: input.recordControlPlaneEvent,
          webhookPath,
          reason: "invalid_request_body",
          contentLength: c.req.raw.headers.get("content-length"),
          ...(deliveryId ? { deliveryId } : {}),
          eventName
        });
        return c.json({ error: "invalid_request_body" }, 400);
      }
      await handleIssueCommentCreated({
        payload,
        createRun: input.createRun,
        ...(input.submitThreadAction ? { submitThreadAction: input.submitThreadAction } : {}),
        ...(input.resolveActorWriteAccess ? { resolveActorWriteAccess: input.resolveActorWriteAccess } : {}),
        now: input.now,
        ...(deliveryId ? { deliveryId } : {}),
        signatureVerified: true
      });
      return c.json({ ok: true });
    }
    if (eventName === "pull_request_review_comment") {
      if (!isGitHubPullRequestReviewCommentPayload(payload)) {
        await recordGitHubRequestBodyRejected({
          recordControlPlaneEvent: input.recordControlPlaneEvent,
          webhookPath,
          reason: "invalid_request_body",
          contentLength: c.req.raw.headers.get("content-length"),
          ...(deliveryId ? { deliveryId } : {}),
          eventName
        });
        return c.json({ error: "invalid_request_body" }, 400);
      }
      await handlePullRequestReviewCommentCreated({
        payload,
        createRun: input.createRun,
        ...(input.submitThreadAction ? { submitThreadAction: input.submitThreadAction } : {}),
        ...(input.resolveActorWriteAccess ? { resolveActorWriteAccess: input.resolveActorWriteAccess } : {}),
        now: input.now,
        ...(deliveryId ? { deliveryId } : {}),
        signatureVerified: true
      });
      return c.json({ ok: true });
    }

    return c.json({ ok: true, ignored: "unsupported_event" });
  });

  return app;
}

export function startGitHubIngress(config: GitHubIngressConfig): GitHubIngressHandle {
  const githubToken = config.githubToken;
  const dispatcherClient = createOpenTagClient({
    dispatcherUrl: config.dispatcherUrl,
    ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {})
  });
  const port = config.port ?? 3000;
  const hostname = config.hostname ?? "127.0.0.1";
  const webhookPath = config.webhookPath ?? "/github/webhooks";
  const completionApi = githubToken
    ? createGitHubCompletionApi({ token: githubToken, ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}) })
    : undefined;
  const requestCompletionReconciliationEscalation = config.requestCompletionReconciliationEscalation
    ?? (async (request: GitHubCompletionReconciliationEscalationRequest) => {
      const response = await (config.fetchImpl ?? fetch)(
        `${config.dispatcherUrl.replace(/\/$/u, "")}/v1/completion-escalations/github`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.dispatcherToken ? { authorization: `Bearer ${config.dispatcherToken}` } : {})
          },
          body: JSON.stringify(request)
        }
      );
      if (!response.ok) {
        throw new Error(`Dispatcher rejected GitHub completion reconciliation escalation (${response.status}).`);
      }
    });
  const server = serve({
    fetch: createGitHubWebhookApp({
      webhookSecret: config.webhookSecret,
      webhookPath,
      ...(config.maxRequestBodyBytes ? { maxRequestBodyBytes: config.maxRequestBodyBytes } : {}),
      ...(githubToken
        ? {
            completionApi: completionApi!,
            async ingestCompletionEvidenceBatch(snapshots) {
              const response = await (config.fetchImpl ?? fetch)(
                `${config.dispatcherUrl.replace(/\/$/u, "")}/v1/completion-evidence/github/batch`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    ...(config.dispatcherToken ? { authorization: `Bearer ${config.dispatcherToken}` } : {})
                  },
                  body: JSON.stringify({ snapshots })
                }
              );
              if (!response.ok) throw new Error(`Dispatcher rejected GitHub completion evidence batch (${response.status}).`);
            },
            resolveActorWriteAccess: (input) =>
              resolveGitHubActorWriteAccessWithToken({
                ...input,
                token: githubToken,
                ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {})
              })
          }
        : {}),
      requestCompletionReconciliationEscalation,
      async createRun(event) {
        const runId = `run_${randomUUID()}`;
        const created = await dispatcherClient.createRun({ runId, event });
        return created.outcome === "run_created" ? { runId: created.run.id } : {};
      },
      async submitThreadAction(action) {
        await dispatcherClient.submitThreadAction(action);
      },
      async recordControlPlaneEvent(event) {
        await dispatcherClient.recordControlPlaneEvent(event);
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
