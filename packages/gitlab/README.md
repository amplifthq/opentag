# @opentag/gitlab

GitLab adapter helpers for OpenTag.

Use this package to turn GitLab issue and merge request notes into `OpenTagEvent` objects and to render GitLab-friendly callback text.

## Install

```bash
pnpm add @opentag/gitlab
```

## Exports

- `normalizeGitLabNote`: converts a GitLab Note Hook payload into an `OpenTagEvent`. Handles both `noteable_type: "Issue"` and `noteable_type: "MergeRequest"`.
- `verifyGitLabToken`: constant-time comparison of the `X-Gitlab-Token` header against a configured shared secret. Both inputs are hashed to SHA-256 digests before `timingSafeEqual` so token lengths never leak.
- `createGitLabWebhookApp`, `startGitLabIngress`: Hono-based local webhook receiver bound to loopback by default.

## Example

```ts
import { normalizeGitLabNote } from "@opentag/gitlab";

const event = normalizeGitLabNote({
  id: String(payload.object_attributes.id),
  noteBody: payload.object_attributes.note,
  noteUrl: payload.object_attributes.url,
  apiNotesUrl: `https://gitlab.com/api/v4/projects/${encodedPath}/issues/${payload.issue.iid}/notes`,
  issueIid: payload.issue.iid,
  issueUrl: payload.issue.url,
  projectPathWithNamespace: payload.project.path_with_namespace,
  projectId: payload.project.id,
  projectVisibility: payload.project.visibility,
  actorId: payload.user.id,
  actorUsername: payload.user.username,
  noteableType: payload.object_attributes.noteable_type,
  receivedAt: new Date().toISOString()
});

if (event) {
  // Send event to @opentag/client or your own OpenTag-compatible control plane.
}
```

## Authentication

GitLab notes are delivered via the `Note Hook` event with the `X-Gitlab-Token` header containing a shared secret. Compare tokens with `verifyGitLabToken` rather than raw equality — `verifyGitLabToken` hashes both sides to SHA-256 digests before timing-safe comparison so it does not leak token length.

## Visibility

GitLab visibility levels are `"private" | "internal" | "public"`. We map `private` and `internal` to `ContextPointer.visibility: "private"` and `public` to `"public"`; the MVP does not yet wire `organization` visibility.

## Stability

Normalizer input shapes are intentionally small and provider-specific. Prefer adding optional fields over changing existing fields.
