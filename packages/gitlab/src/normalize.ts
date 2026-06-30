import { parseOpenTagMention, type ContextPointer, type OpenTagCommand, type OpenTagEvent, type PermissionGrant, type WorkItemReference } from "@opentag/core";

/** `object_attributes.noteable_type` discriminator from a GitLab Note Hook
 * payload. The modern API surfaces `"Issue"` and `"MergeRequest"`; legacy
 * self-hosted instances (and some web-UI event names) surface the older
 * `"IssueNote"` / `"MergeRequestNote"` aliases. Other values (`"Snippet"`,
 * `"Commit"`, `"WikiPage"`, `"Design"`, `"alert"`, `"Epic"`) reach the
 * handler but are intentionally ignored by `normalizeGitLabNote` (returns
 * `null`) — they are part of the union for type-safety on the ingress
 * boundary, not for processing. */
export type GitLabNoteableType = "Issue" | "MergeRequest" | "Snippet" | "Commit" | "WikiPage" | "Design" | "alert" | "Epic" | "IssueNote" | "MergeRequestNote";

/** GitLab project visibility tier. The adapter collapses `"private"` and
 * `"internal"` to `ContextPointer.visibility: "private"` because the OpenTag
 * two-level model only distinguishes public evidence from non-public;
 * `"internal"` (any logged-in GitLab user) cannot serve as public evidence. */
export type GitLabVisibility = "private" | "internal" | "public";

/** Normalizer input. Mirrors the fields a GitLab Note Hook payload carries,
 * extracted by the ingress handler and passed in already-decoded. Field
 * meanings:
 *
 * - `id` — the GitLab `object_attributes.id` (string-coerced for cross-system
 *   compatibility); becomes `sourceEventId` on the event so the dispatcher can
 *   dedup redeliveries.
 * - `noteBody` — the raw note text; the `@opentag` mention parser runs on this.
 * - `noteUrl` — GitLab HTML URL for the comment (rendered as a `kind: comment`
 *   context pointer).
 * - `apiNotesUrl` — pre-built REST URL to POST the reply back through
 *   (`https://gitlab.com/api/v4/projects/.../issues/{iid}/notes` or
 *   `merge_requests/{iid}/notes`).
 * - `issueIid` / `mergeRequestIid` — project-scoped issue or MR iid. For MR
 *   notes the ingress handler passes both; for issue notes only `issueIid`.
 * - `workItemUrl` — HTML URL of the issue or MR (rendered as a
 *   `kind: issue | merge_request` context pointer).
 * - `projectPathWithNamespace` — raw `acme/demo` form; URL-encoding happens
 *   only at API-endpoint construction.
 * - `projectId` / `projectVisibility` — for `metadata.projectId` and the
 *   public/private collapse in context pointers.
 * - `actorId` / `actorUsername` — string-coerced into `actor.providerUserId`
 *   and `actor.handle`.
 * - `noteableType` — see `GitLabNoteableType`.
 * - `receivedAt` — ISO-8601 timestamp the note was received by OpenTag.
 */
export type GitLabNoteInput = {
  /** Source-event identifier; becomes `sourceEventId` on the emitted event. */
  id: string;
  /** Raw comment body — the `@opentag` mention parser runs on this. */
  noteBody: string;
  /** GitLab HTML URL of the comment; rendered as a `kind: comment` context pointer. */
  noteUrl: string;
  /** Pre-built REST URL the dispatcher can POST a reply through. */
  apiNotesUrl: string;
  /** For Issue notes: the issue iid within the project. */
  issueIid: number;
  /** For MR notes: the merge request iid within the project. */
  mergeRequestIid?: number;
  /** HTML URL of the issue or merge request the note was posted on. */
  workItemUrl: string;
  /** Raw, slash-separated project path (e.g. `acme/demo`). Encoding for API
   * URLs happens at the URL-construction site, not here; this value remains a
   * human-readable identifier that propagates into `WorkItemReference.ownerContainer.id`
   * and `callback.threadKey`. */
  projectPathWithNamespace: string;
  /** GitLab numeric project id. Carried into metadata for cross-system lookups. */
  projectId: number;
  /** Project visibility tier; collapsed to the OpenTag public/private model. */
  projectVisibility: GitLabVisibility;
  /** GitLab user id of the comment author. String-coerced into `actor.providerUserId`. */
  actorId: number;
  /** GitLab username of the comment author. Carried into `actor.handle`. */
  actorUsername: string;
  /** Discriminator from `object_attributes.noteable_type`. */
  noteableType: GitLabNoteableType;
  /** ISO-8601 timestamp the note was received by OpenTag. */
  receivedAt: string;
};

function permissionsForIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions: PermissionGrant[] = [
    {
      scope: "issue:comment",
      reason: "reply to the source GitLab thread"
    },
    {
      scope: "runner:local",
      reason: "execute the run on a paired local daemon"
    }
  ];
  if (intent === "fix" || intent === "run") {
    permissions.push(
      {
        scope: "repo:read",
        reason: "inspect the repository in the paired local checkout"
      },
      {
        scope: "repo:write",
        reason: "commit code changes on an isolated run branch"
      },
      {
        scope: "pr:create",
        reason: "open a merge request for completed code changes"
      }
    );
  }
  return permissions;
}

function permissionsForMergeRequestIntent(intent: OpenTagCommand["intent"]): PermissionGrant[] {
  const permissions = permissionsForIntent(intent);
  if (intent === "review") {
    permissions.push({
      scope: "pr:update",
      reason: "request reviewers on the source merge request after explicit approval"
    });
  }
  return permissions;
}

function contextPointersForCommand(command: OpenTagCommand, visibility: "public" | "private"): ContextPointer[] {
  const context: ContextPointer[] = [];

  for (const reference of command.parsed?.references ?? []) {
    if (reference.kind === "url") {
      context.push({
        kind: "url",
        uri: reference.uri,
        visibility,
        title: reference.title ?? "Command URL reference"
      });
      continue;
    }

    if (reference.kind === "file" || reference.kind === "path" || reference.kind === "line" || reference.kind === "range") {
      context.push({
        kind: "file",
        uri: reference.uri,
        ...(reference.line ? { line: reference.line } : {}),
        ...(reference.startLine ? { startLine: reference.startLine } : {}),
        ...(reference.endLine ? { endLine: reference.endLine } : {}),
        visibility,
        title: referenceTitle(reference)
      });
    }
  }

  return context;
}

function referenceTitle(reference: NonNullable<OpenTagCommand["parsed"]>["references"][number]): string {
  return reference.title ?? "Command file reference";
}

function normalizedVisibility(visibility: GitLabVisibility): "public" | "private" {
  // GitLab's three-level visibility collapses to the OpenTag two-level model:
  // "internal" (logged-in GitLab users only) cannot serve as public evidence.
  return visibility === "public" ? "public" : "private";
}

function gitlabWorkItem(input: {
  pathWithNamespace: string;
  kind: "issue" | "merge_request";
  iid: number;
  uri: string;
}): WorkItemReference {
  // The work-item-kind prefix on `externalId` is intentional: the dispatcher
  // admission gate (`packages/dispatcher/src/admission.ts:162-165`) and proposal
  // lookup (`packages/dispatcher/src/server.ts:386-423`) key off
  // `callbackConversationKey` derived from `callback.threadKey`. Without the
  // kind prefix, issue #N and MR !N in the same project produce identical
  // conversation keys and collide in the dispatcher lane.
  return {
    provider: "gitlab",
    kind: input.kind,
    externalId: `${input.pathWithNamespace}|${input.kind}|${input.iid}`,
    uri: input.uri,
    ownerContainer: {
      provider: "gitlab",
      id: input.pathWithNamespace,
      uri: `https://gitlab.com/${input.pathWithNamespace}`
    }
  };
}

function commandMetadata(command: OpenTagCommand): Record<string, unknown> {
  if (!command.parsed) return {};
  return {
    commandParser: command.parsed.version,
    commandDiagnostics: command.parsed.diagnostics,
    ...(command.parsed.approval ? { approval: command.parsed.approval } : {}),
    ...(command.parsed.network ? { network: command.parsed.network } : {})
  };
}

/**
 * Normalizes a GitLab `Note Hook` payload into an `OpenTagEvent`. Returns `null`
 * if the note body does not contain an `@opentag` mention.
 *
 * GitLab delivers issue notes and merge request notes through the same `Note Hook`
 * event and disambiguates them via `object_attributes.noteable_type`. The MVP
 * accepts both; other noteable types are ignored (returns `null`).
 */
export function normalizeGitLabNote(input: GitLabNoteInput): OpenTagEvent | null {
  const mention = parseOpenTagMention(input.noteBody);
  if (!mention.matched) return null;

  const isMergeRequest =
    input.noteableType === "MergeRequest" || input.noteableType === "MergeRequestNote";
  // GitLab also surfaces legacy noteable types "IssueNote" / "MergeRequestNote"
  // in some self-hosted instances; treat them the same as the modern types.
  const isIssue = input.noteableType === "Issue" || input.noteableType === "IssueNote";
  if (!isIssue && !isMergeRequest) return null;

  const command = {
    rawText: mention.rawText,
    intent: mention.intent,
    args: mention.args,
    ...(mention.parsed ? { parsed: mention.parsed } : {})
  };

  const visibility = normalizedVisibility(input.projectVisibility);
  const contextKind = isMergeRequest ? "merge_request" : "issue";

  const grantPermissions = isMergeRequest ? permissionsForMergeRequestIntent : permissionsForIntent;
  const iid = isMergeRequest ? (input.mergeRequestIid ?? input.issueIid) : input.issueIid;

  return {
    id: `evt_gitlab_note_${input.id}`,
    source: "gitlab",
    sourceEventId: input.id,
    receivedAt: input.receivedAt,
    actor: {
      provider: "gitlab",
      providerUserId: String(input.actorId),
      handle: input.actorUsername
    },
    target: {
      mention: "@opentag",
      agentId: "opentag",
      ...(mention.parsed?.executorHint ? { executorHint: mention.parsed.executorHint } : {})
    },
    command,
    context: [
      {
        provider: "gitlab",
        kind: contextKind,
        uri: input.workItemUrl,
        visibility
      },
      {
        provider: "gitlab",
        kind: "comment",
        uri: input.noteUrl,
        visibility
      },
      ...contextPointersForCommand(command, visibility)
    ],
    workItem: gitlabWorkItem({
      pathWithNamespace: input.projectPathWithNamespace,
      kind: isMergeRequest ? "merge_request" : "issue",
      iid,
      uri: input.workItemUrl
    }),
    permissions: grantPermissions(mention.intent),
    callback: {
      provider: "gitlab",
      uri: input.apiNotesUrl,
      threadKey: `${input.projectPathWithNamespace}|${contextKind}|${iid}`
    },
    metadata: {
      repoProvider: "gitlab",
      projectPathWithNamespace: input.projectPathWithNamespace,
      projectId: input.projectId,
      projectVisibility: input.projectVisibility,
      issueIid: input.issueIid,
      ...(isMergeRequest ? { mergeRequestIid: input.mergeRequestIid ?? input.issueIid } : {}),
      noteableType: input.noteableType,
      ...commandMetadata(command)
    }
  };
}
