import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { createOpenTagClient } from "@opentag/client";
import { parseThreadActionCommand, type OpenTagEvent } from "@opentag/core";
import { Hono } from "hono";
import { normalizeGitLabNote, type GitLabNoteableType, type GitLabVisibility } from "./normalize.js";

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

/** Subset of a GitLab `Note Hook` webhook payload the ingress handler
 * actually reads. The handler does not consume the full GitLab schema
 * (notes can carry dozens of optional fields like `repository`,
 * `object_attributes.created_at`, `object_attributes.updated_at`, etc.) —
 * only the fields below are validated, persisted, or routed. The shape
 * predicate `isGitLabNoteHookPayload` enforces this minimal shape before the
 * handler proceeds. */
export type GitLabNoteHookPayload = {
  object_kind: "note";
  object_attributes: GitLabNoteObjectAttributes;
  project: GitLabProject;
  issue?: GitLabIssue;
  merge_request?: GitLabMergeRequest;
  user: GitLabActor;
};

/** Input passed to the optional `submitThreadAction` callback when a GitLab
 * note matches `parseThreadActionCommand` (i.e. `apply N`, `approve N`, etc.).
 * Mirrors the GitHub / Slack `submitThreadAction` shape from sibling adapters
 * so a single dispatcher consumer can dispatch across providers. */
export type GitLabThreadActionInput = {
  /** Idempotency key for the apply-all decision. Includes the body hash so
   * redeliveries of the same payload collapse to the same id. */
  id: string;
  /** Raw comment body that triggered the thread action. */
  rawText: string;
  actor: {
    provider: "gitlab";
    providerUserId: string;
    handle: string;
  };
  callback: {
    provider: "gitlab";
    /** REST URL the dispatcher can POST a follow-up note through. */
    uri: string;
    /** Conversation identifier; encodes work-item kind so issue and MR
     * threads in the same project do not collide. */
    threadKey: string;
  };
  metadata: Record<string, unknown>;
};

/** Construction input for `createGitLabWebhookApp`. The handler is created
 * once and routes each incoming webhook to either `createRun` (mention path)
 * or `submitThreadAction` (apply/approve path) depending on the parsed
 * command. */
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

/** Configuration for `startGitLabIngress`. Bundles the dispatcher pairing
 * info with the local HTTP receiver settings. `port` defaults to `3060` to
 * avoid the GitHub default `3050`; `hostname` defaults to `127.0.0.1` so the
 * receiver is loopback-only by default (operators pair with a tunnel rather
 * than re-binding to `0.0.0.0`). */
export type GitLabIngressConfig = {
  /** Shared secret GitLab's webhook will present in `X-Gitlab-Token`. */
  webhookSecret: string;
  /** Base URL of the paired OpenTag dispatcher (e.g. `http://127.0.0.1:8787`). */
  dispatcherUrl: string;
  /** Optional pairing token presented to the dispatcher as `Authorization`. */
  dispatcherToken?: string;
  /** TCP port; defaults to `3060` to avoid clash with the GitHub adapter. */
  port?: number;
  /** Bind hostname; defaults to `127.0.0.1` (loopback only). */
  hostname?: string;
  /** HTTP path the webhook is mounted at; defaults to `/gitlab/webhooks`. */
  webhookPath?: string;
};

/** Opaque handle returned by `startGitLabIngress`. Holds the running server
 * plus the resolved URL and webhook path. `close()` shuts down the server
 * and resolves once the underlying socket has fully closed. */
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

/** Conservative cap on webhook body size. GitLab Note Hooks are well under 64 KiB
 * in practice; the 1 MiB ceiling is a defence-in-depth limit so an authenticated
 * caller (or a misconfigured downstream) cannot push arbitrarily large payloads
 * into the JSON parser. The cap is enforced via the `Content-Length` header
 * before reading the body, so the body is never buffered for oversized requests. */
const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

/** Path-with-namespace guard for `WorkItemReference.ownerContainer.id` and
 * `callback.threadKey`. Both fields flow the raw `project.path_with_namespace`
 * through to `callbackConversationKey` (`packages/core/src/protocol.ts:387-389`),
 * so a `|` in the value would be a delimiter-injection surface and whitespace
 * would corrupt the conversational identity.
 *
 * GitLab documents `project.path_with_namespace` as the full hierarchical
 * path with arbitrary subgroup depth (`group/subgroup/project`, `g1/g2/g3/p`,
 * etc.). The regex permits one or more `/`-separated segments and forbids
 * `|`, `/`, and whitespace inside any segment on the adapter side so a
 * hand-crafted payload cannot escape the convention. The trailing `+` on the
 * non-capturing group enforces "at least one slash" — a single-segment
 * identifier would not be a valid `path_with_namespace` per the GitLab API.
 */
const PROJECT_PATH_NAMESPACE_PATTERN = /^[^|\/\s]+(?:\/[^|\/\s]+)+$/;

/** Shape predicate for a GitLab Note Hook payload. The handler
 * (`handleNoteCreated`) reads every field listed below; a signed payload
 * missing any of them would otherwise leak `undefined` into the dispatched
 * event (e.g. a callback URL synthesised from `undefined`) or collapse the
 * conversation identity onto an `iid = 0` lane. The predicate is intentionally
 * permissive about `object_attributes.noteable_type` membership because
 * Snippet/Commit/etc. notes are silently ignored (return `200 { ok: true }`)
 * downstream per MVP scope and must continue to pass shape validation — the
 * type itself is checked (string, non-empty) but its value is not constrained
 * here.
 *
 * Returns `false` if any of:
 * 1. `value` is not an object, or `object_kind !== "note"`.
 * 2. `object_attributes` is not an object, or any of `note` (non-empty string),
 *    `id` (number), `url` (non-empty string), `noteable_type` (non-empty
 *    string) is missing or wrong-typed.
 * 3. `project` is not an object, or `id` (number), `visibility` (one of
 *    `private | internal | public`), or `path_with_namespace` (non-empty
 *    string matching `PROJECT_PATH_NAMESPACE_PATTERN`) is missing or wrong-typed.
 * 4. `user` is not an object, or `id` (number) or `username` (non-empty string)
 *    is missing or wrong-typed.
 *
 * Noteable-type membership is NOT checked here — see the file-level rationale.
 * Integrity of `issue` / `merge_request` (positive iid + non-empty URL for the
 * matching supported type) is checked in `handleNoteCreated`, not here.
 */
const GITLAB_PROJECT_VISIBILITY_VALUES = new Set<GitLabVisibility>(["private", "internal", "public"]);

function isGitLabNoteHookPayload(value: unknown): value is GitLabNoteHookPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.object_kind !== "note") return false;

  const attrs = v.object_attributes;
  if (!attrs || typeof attrs !== "object") return false;
  const a = attrs as Record<string, unknown>;
  if (typeof a.note !== "string" || a.note.length === 0) return false;
  if (typeof a.id !== "number") return false;
  if (typeof a.url !== "string" || a.url.length === 0) return false;
  if (typeof a.noteable_type !== "string" || a.noteable_type.length === 0) return false;

  const project = v.project;
  if (!project || typeof project !== "object") return false;
  const p = project as Record<string, unknown>;
  if (typeof p.id !== "number") return false;
  if (typeof p.visibility !== "string" || !GITLAB_PROJECT_VISIBILITY_VALUES.has(p.visibility as GitLabVisibility)) return false;
  if (typeof p.path_with_namespace !== "string") return false;
  if (!PROJECT_PATH_NAMESPACE_PATTERN.test(p.path_with_namespace)) return false;

  const user = v.user;
  if (!user || typeof user !== "object") return false;
  const u = user as Record<string, unknown>;
  if (typeof u.id !== "number") return false;
  if (typeof u.username !== "string" || u.username.length === 0) return false;

  return true;
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
  rawBody: string;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: GitLabThreadActionInput): Promise<unknown>;
  now(): string;
}): Promise<{ ok: true } | { ok: false; reason: "invalid_payload" }> {
  const payload = input.payload;
  const noteableType = payload.object_attributes.noteable_type as GitLabNoteableType;
  const isMergeRequest = noteableType === "MergeRequest" || noteableType === "MergeRequestNote";
  const isIssue = noteableType === "Issue" || noteableType === "IssueNote";
  if (!isIssue && !isMergeRequest) return { ok: true };

  // Supported-note integrity check. Real GitLab Note Hook payloads always
  // carry a positive `issue.iid` (or `merge_request.iid`) AND a non-empty
  // matching URL. The shape predicate (U2) does not require them because
  // noteable types outside MVP scope (Snippet/Commit/etc.) legitimately omit
  // both. The supported types are gated here instead, with a clean 422 so
  // GitLab marks the delivery as permanently failed rather than retrying.
  const matchingIid = isMergeRequest ? payload.merge_request?.iid : payload.issue?.iid;
  const matchingUrl = isMergeRequest ? payload.merge_request?.url : payload.issue?.url;
  if (typeof matchingIid !== "number" || matchingIid <= 0 || typeof matchingUrl !== "string" || matchingUrl.length === 0) {
    return { ok: false, reason: "invalid_payload" };
  }

  const issueIid = matchingIid;
  const mergeRequestIid = isMergeRequest ? matchingIid : undefined;
  const workItemUrl = matchingUrl;
  const issueUrl = isMergeRequest ? undefined : matchingUrl;

  // Idempotency key: `actionId` includes the first 12 hex chars of
  // `sha256(rawBody)` so that two otherwise-identical comments whose body
  // differs cannot collide in the dispatcher's `apply all` decision flow, and
  // so the same body produces the same id across redeliveries. The 12-hex
  // width matches the dispatcher's own `stableHash` (server.ts:264) for
  // cross-package field-width uniformity. This is NOT replay protection —
  // GitLab suppresses literal retries on 5xx itself; the body hash is for
  // idempotency of the apply-all decision.
  const bodyHash = createHash("sha256").update(input.rawBody).digest("hex").slice(0, 12);
  const actionId = `approval_gitlab_note_${payload.object_attributes.id}_${bodyHash}`;

  const callback = {
    provider: "gitlab" as const,
    uri: buildApiNotesUrl({
      projectPathWithNamespace: payload.project.path_with_namespace,
      noteableType: isMergeRequest ? "MergeRequest" : "Issue",
      iid: issueIid
    }),
    threadKey: `${payload.project.path_with_namespace}|${isMergeRequest ? "merge_request" : "issue"}|${issueIid}`
  };

  // Inline doc-review P0: refuse callbacks that don't point at the approved
  // GitLab surface. Self-hosted GitLab is intentionally excluded from the MVP.
  if (!isGitLabApiHost(callback.uri)) {
    return { ok: true };
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
    return { ok: true };
  }

  const event = normalizeGitLabNote({
    id: String(payload.object_attributes.id),
    noteBody: payload.object_attributes.note,
    noteUrl: payload.object_attributes.url,
    apiNotesUrl: callback.uri,
    issueIid,
    ...(mergeRequestIid !== undefined ? { mergeRequestIid } : {}),
    workItemUrl: isMergeRequest ? workItemUrl : issueUrl ?? workItemUrl,
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
  return { ok: true };
}

/** Construct a Hono application that exposes a single `POST` route at
 * `webhookPath` for GitLab Note Hook deliveries. The handler enforces:
 *
 * 1. A `Content-Length` cap of 1 MiB before any body read (returns `413`
 *    `payload_too_large` for declared payloads above the limit).
 * 2. The `X-Gitlab-Token` header is present and matches `webhookSecret`
 *    via `verifyGitLabToken` before the body is read (returns `401`).
 * 3. The parsed JSON conforms to the `GitLabNoteHookPayload` shape predicate
 *    (returns `422` `invalid_payload` on shape failure).
 * 4. Note Hook events are routed through `handleNoteCreated`; System Hook
 *    pings return `200 { ok: true }` so GitLab marks the webhook reachable.
 *
 * The returned `Hono` instance is the application — mount it via `serve`
 * (Hono node adapter), Vercel/Workers, or any other Hono-compatible host.
 */
export function createGitLabWebhookApp(input: GitLabWebhookAppInput) {
  const app = new Hono();
  const webhookPath = input.webhookPath ?? "/gitlab/webhooks";
  if (!webhookPath.startsWith("/")) {
    throw new Error("GitLab webhook path must start with /.");
  }

  app.post(webhookPath, async (c) => {
    const contentLengthHeader = c.req.header("content-length");
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared >= MAX_WEBHOOK_BODY_BYTES) {
        return c.json({ error: "payload_too_large" }, 413);
      }
    }

    const token = c.req.header("x-gitlab-token");
    if (!token) {
      return c.json({ error: "missing_token_header" }, 401);
    }
    if (!verifyGitLabToken({ webhookSecret: input.webhookSecret, token })) {
      return c.json({ error: "invalid_token" }, 401);
    }
    const rawBody = await c.req.text();

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
      if (!isGitLabNoteHookPayload(payload)) {
        return c.json({ error: "invalid_payload" }, 422);
      }
      const result = await handleNoteCreated({
        payload,
        rawBody,
        createRun: input.createRun,
        ...(input.submitThreadAction ? { submitThreadAction: input.submitThreadAction } : {}),
        now: input.now
      });
      if (!result.ok) {
        return c.json({ error: result.reason }, 422);
      }
      return c.json({ ok: true });
    }

    return c.json({ ok: true, ignored: "unsupported_event" });
  });

  return app;
}

/** Start a long-running GitLab webhook receiver bound to a paired
 * OpenTag dispatcher. Wires:
 *
 * 1. A `@opentag/client` for forwarding `createRun` / `submitThreadAction`
 *    calls to the dispatcher.
 * 2. The Hono webhook app from `createGitLabWebhookApp`, served via the Hono
 *    node adapter on `config.port` (default `3060`) at `config.hostname`
 *    (default `127.0.0.1`, loopback-only).
 *
 * Callers should keep the returned handle and call `close()` on shutdown so
 * the underlying socket releases cleanly. The `server` field is exposed for
 * diagnostic access; treat it as opaque.
 */
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
