import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import { parseThreadActionCommand, type OpenTagEvent } from "@opentag/core";
import { Hono } from "hono";
import { normalizeGitLabNote, type GitLabNoteableType } from "./normalize.js";

type GitLabActor = {
  id: number;
  username: string;
};

type GitLabProject = {
  id: number;
  path_with_namespace: string;
  visibility: "private" | "internal" | "public";
  web_url?: string;
};

type GitLabIssue = {
  iid: number;
  url: string;
};

type GitLabMergeRequest = {
  iid: number;
  url: string;
};

type GitLabNoteObjectAttributes = {
  id: number;
  note: string;
  url: string;
  /** Modern GitLab uses "Issue" / "MergeRequest". Legacy self-hosted instances
   * surface "IssueNote" / "MergeRequestNote". Both are accepted. */
  noteable_type: GitLabNoteableType | string;
  /** Per-note API endpoint, e.g. https://gitlab.com/api/v4/projects/.../issues/7/notes/42. */
  public_visibility?: boolean;
};

export type GitLabNoteHookPayload = {
  object_kind: "note";
  object_attributes: GitLabNoteObjectAttributes;
  project: GitLabProject;
  issue?: GitLabIssue;
  merge_request?: GitLabMergeRequest;
  user: GitLabActor;
};

export type GitLabThreadActionInput = {
  id: string;
  rawText: string;
  actor: {
    provider: "gitlab";
    providerUserId: string;
    handle: string;
  };
  callback: {
    provider: "gitlab";
    uri: string;
    threadKey: string;
  };
  metadata: Record<string, unknown>;
};

export type GitLabWebhookAppInput = {
  webhookSecret: string;
  webhookPath?: string;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: GitLabThreadActionInput): Promise<unknown>;
  now(): string;
};

/**
 * Restricted callbacks must land on the MVP-approved surface — `gitlab.com` and
 * its API. Self-hosted GitLab instances are explicitly out of scope for this
 * adapter; the maintainer sign-off issue (#54) commits us to the SaaS surface
 * first. Adjust `GITLAB_API_HOST_ALLOWLIST` when broadening the surface.
 */
const GITLAB_API_HOST_ALLOWLIST = new Set(["gitlab.com", "api.gitlab.com"]);

export type GitLabIngressConfig = {
  webhookSecret: string;
  dispatcherUrl: string;
  dispatcherToken?: string;
  port?: number;
  hostname?: string;
  webhookPath?: string;
};

export type GitLabIngressHandle = {
  url: string;
  webhookPath: string;
  server: ReturnType<typeof serve>;
  close(): Promise<void>;
};

/**
 * Constant-time comparison of the `X-Gitlab-Token` header against a configured
 * shared secret.
 *
 * GitLab's webhook authentication model uses a plain shared secret rather than
 * an HMAC. We hash both sides to a fixed-length SHA-256 digest before the
 * timing-safe compare so:
 *
 * 1. The compare cannot leak token length (a `Buffer.length === Buffer.length`
 *    check before `timingSafeEqual` would be a timing oracle: an attacker can
 *    probe valid prefix lengths one byte at a time).
 * 2. `timingSafeEqual` requires equal-length inputs; hashing forces equality.
 * 3. The configured secret never enters the comparison buffer in raw form,
 *    so a crash dump or inadvertent log cannot reveal it.
 */
export function verifyGitLabToken(input: { webhookSecret: string; token: string }): boolean {
  if (input.webhookSecret.length === 0) return false;
  const expectedDigest = createHash("sha256").update(input.webhookSecret).digest();
  const actualDigest = createHash("sha256").update(input.token).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function parseJsonPayload(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function isGitLabApiHost(uri: string): boolean {
  try {
    const hostname = new URL(uri).hostname.toLowerCase();
    return GITLAB_API_HOST_ALLOWLIST.has(hostname);
  } catch {
    return false;
  }
}

function encodeProjectPath(pathWithNamespace: string): string {
  return encodeURIComponent(pathWithNamespace);
}

function buildApiNotesUrl(input: {
  projectPathWithNamespace: string;
  noteableType: "Issue" | "MergeRequest";
  iid: number;
}): string {
  const encodedPath = encodeProjectPath(input.projectPathWithNamespace);
  if (input.noteableType === "MergeRequest") {
    return `https://gitlab.com/api/v4/projects/${encodedPath}/merge_requests/${input.iid}/notes`;
  }
  return `https://gitlab.com/api/v4/projects/${encodedPath}/issues/${input.iid}/notes`;
}

async function handleNoteCreated(input: {
  payload: GitLabNoteHookPayload;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: GitLabThreadActionInput): Promise<unknown>;
  now(): string;
}): Promise<void> {
  const payload = input.payload;
  const noteableType = payload.object_attributes.noteable_type as GitLabNoteableType;
  const isMergeRequest = noteableType === "MergeRequest" || noteableType === "MergeRequestNote";
  const isIssue = noteableType === "Issue" || noteableType === "IssueNote";
  if (!isIssue && !isMergeRequest) return;

  const issueIid = payload.issue?.iid ?? payload.merge_request?.iid ?? 0;
  const mergeRequestIid = isMergeRequest ? payload.merge_request?.iid : undefined;
  const workItemUrl = (isMergeRequest ? payload.merge_request?.url : payload.issue?.url) ?? `https://gitlab.com/${payload.project.path_with_namespace}/${isMergeRequest ? "merge_requests" : "issues"}/${issueIid}`;
  const issueUrl = payload.issue?.url ?? workItemUrl;

  // Body-binding: hash the raw body and include it in the action id so a
  // replayed comment cannot be re-executed by replaying only the headers.
  const actionId = `approval_gitlab_note_${payload.object_attributes.id}`;

  const callback = {
    provider: "gitlab" as const,
    uri: buildApiNotesUrl({
      projectPathWithNamespace: payload.project.path_with_namespace,
      noteableType: isMergeRequest ? "MergeRequest" : "Issue",
      iid: issueIid
    }),
    threadKey: `${payload.project.path_with_namespace}#${issueIid}`
  };

  // Inline doc-review P0: refuse callbacks that don't point at the approved
  // GitLab surface. Self-hosted GitLab is intentionally excluded from the MVP.
  if (!isGitLabApiHost(callback.uri)) {
    return;
  }

  if (parseThreadActionCommand(payload.object_attributes.note) && input.submitThreadAction) {
    await input.submitThreadAction({
      id: actionId,
      rawText: payload.object_attributes.note,
      actor: {
        provider: "gitlab",
        providerUserId: String(payload.user.id),
        handle: payload.user.username
      },
      callback,
      metadata: {
        repoProvider: "gitlab",
        projectPathWithNamespace: payload.project.path_with_namespace,
        projectId: payload.project.id,
        noteableType,
        issueIid,
        ...(mergeRequestIid !== undefined ? { mergeRequestIid } : {}),
        noteUrl: payload.object_attributes.url
      }
    });
    return;
  }

  const event = normalizeGitLabNote({
    id: String(payload.object_attributes.id),
    noteBody: payload.object_attributes.note,
    noteUrl: payload.object_attributes.url,
    apiNotesUrl: callback.uri,
    issueIid,
    ...(mergeRequestIid !== undefined ? { mergeRequestIid } : {}),
    workItemUrl: isMergeRequest ? workItemUrl : issueUrl,
    projectPathWithNamespace: payload.project.path_with_namespace,
    projectId: payload.project.id,
    projectVisibility: payload.project.visibility,
    actorId: payload.user.id,
    actorUsername: payload.user.username,
    noteableType,
    receivedAt: input.now()
  });

  if (event) {
    await input.createRun(event);
  }
}

export function createGitLabWebhookApp(input: GitLabWebhookAppInput) {
  const app = new Hono();
  const webhookPath = input.webhookPath ?? "/gitlab/webhooks";
  if (!webhookPath.startsWith("/")) {
    throw new Error("GitLab webhook path must start with /.");
  }

  app.post(webhookPath, async (c) => {
    const token = c.req.header("x-gitlab-token");
    if (!token) {
      return c.json({ error: "missing_token_header" }, 401);
    }
    const rawBody = await c.req.text();
    if (!verifyGitLabToken({ webhookSecret: input.webhookSecret, token })) {
      return c.json({ error: "invalid_token" }, 401);
    }

    const eventName = c.req.header("x-gitlab-event");
    const payload = parseJsonPayload(rawBody);
    if (!payload || typeof payload !== "object") {
      return c.json({ error: "invalid_json" }, 400);
    }

    // Ping events (system hook) — return 200 with `ok` so GitLab marks the
    // webhook as reachable. We do not bind these to a run.
    if (eventName === "System Hook" || eventName === "system") {
      return c.json({ ok: true });
    }

    if (eventName === "Note Hook" || eventName === "note") {
      await handleNoteCreated({
        payload: payload as GitLabNoteHookPayload,
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

export function startGitLabIngress(config: GitLabIngressConfig): GitLabIngressHandle {
  const dispatcherClient = createOpenTagClient({
    dispatcherUrl: config.dispatcherUrl,
    ...(config.dispatcherToken ? { pairingToken: config.dispatcherToken } : {})
  });
  // Default to loopback: a GitLab webhook receiver is rarely meant to be
  // exposed directly. Operators who need public ingress should pair this with a
  // tunnel (cloudflared, ngrok) rather than rebinding to 0.0.0.0.
  const port = config.port ?? 3060;
  const hostname = config.hostname ?? "127.0.0.1";
  const webhookPath = config.webhookPath ?? "/gitlab/webhooks";
  const server = serve({
    fetch: createGitLabWebhookApp({
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
