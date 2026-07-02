import { projectTargetRefFromLocalPath } from "@opentag/core";
import { describe, expect, it, vi } from "vitest";
import { createAdmissionRuntime } from "../src/admission.js";

const event = {
  id: "evt_1",
  source: "github" as const,
  sourceEventId: "comment_1",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "github" as const, providerUserId: "42", handle: "octocat" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix this", intent: "fix" as const, args: {} },
  context: [],
  permissions: [{ scope: "issue:comment" as const, reason: "reply to source thread" }],
  callback: { provider: "github" as const, uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
  metadata: { owner: "acme", repo: "demo" }
};

describe("Admission Runtime", () => {
  const bindingRepo = (binding: Record<string, unknown>) =>
    ({
      getRunByEventId: async () => null,
      getRepoBinding: async () => binding,
      findActiveRunForConversation: async () => null,
      createFollowUpRequest: async () => {
        throw new Error("should not queue follow-up");
      },
      appendRunEvent: async () => undefined
    }) as never;

  const publicIssueContext = [
    { provider: "github" as const, kind: "issue" as const, uri: "https://github.com/acme/demo/issues/1", visibility: "public" as const }
  ];
  const privateIssueContext = [
    { provider: "github" as const, kind: "issue" as const, uri: "https://github.com/acme/demo/issues/1", visibility: "private" as const }
  ];
  const githubBinding = { provider: "github", owner: "acme", repo: "demo", runnerId: "runner_1" };

  it("denies public-repo runs by default when the actor has no platform-reported write access", async () => {
    const admission = createAdmissionRuntime({ repo: bindingRepo(githubBinding) });

    const result = await admission.admitRun({
      requestId: "req_public_stranger",
      event: { ...event, id: "evt_public_stranger", context: publicIssueContext }
    });

    expect(result).toMatchObject({
      outcome: "needs_human_decision",
      decision: { reasonCode: "actor_not_authorized_for_public_repo" }
    });
  });

  it("admits public-repo runs when the actor carries platform-reported write access", async () => {
    const admission = createAdmissionRuntime({ repo: bindingRepo(githubBinding) });

    const result = await admission.admitRun({
      requestId: "req_public_maintainer",
      event: {
        ...event,
        id: "evt_public_maintainer",
        actor: { ...event.actor, writeAccess: true },
        context: publicIssueContext
      }
    });

    expect(result).toMatchObject({ outcome: "start" });
  });

  it("keeps private-repo runs open to actors without reported write access", async () => {
    const admission = createAdmissionRuntime({ repo: bindingRepo(githubBinding) });

    const result = await admission.admitRun({
      requestId: "req_private_stranger",
      event: { ...event, id: "evt_private_stranger", context: privateIssueContext }
    });

    expect(result).toMatchObject({ outcome: "start" });
  });

  it("lets an explicit allowedActors list override the public-repo default", async () => {
    const admission = createAdmissionRuntime({
      repo: bindingRepo({ ...githubBinding, allowedActors: ["octocat"] })
    });

    const result = await admission.admitRun({
      requestId: "req_public_listed",
      event: {
        ...event,
        id: "evt_public_listed",
        context: publicIssueContext,
        permissions: [
          ...event.permissions,
          { scope: "repo:write" as const, reason: "commit code changes on an isolated run branch" }
        ]
      }
    });

    expect(result).toMatchObject({ outcome: "start" });
  });

  it("still rejects write-capable runs from actors outside a configured allowedActors list", async () => {
    const admission = createAdmissionRuntime({
      repo: bindingRepo({ ...githubBinding, allowedActors: ["someone-else"] })
    });

    const result = await admission.admitRun({
      requestId: "req_listed_denied",
      event: {
        ...event,
        id: "evt_listed_denied",
        context: privateIssueContext,
        permissions: [
          ...event.permissions,
          { scope: "repo:write" as const, reason: "commit code changes on an isolated run branch" }
        ]
      }
    });

    expect(result).toMatchObject({
      outcome: "needs_human_decision",
      decision: { reasonCode: "actor_not_allowed_for_write" }
    });
  });

  it("checks duplicate source events before mutable gates", async () => {
    const getRepoBinding = vi.fn(async () => {
      throw new Error("should not reach mutable gates for duplicate events");
    });
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => ({
          run: {
            id: "run_existing",
            eventId: "evt_1",
            status: "queued",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          },
          event
        }),
        getRepoBinding,
        findActiveRunForConversation: async () => null,
        createFollowUpRequest: async () => {
          throw new Error("should not queue follow-up");
        },
        appendRunEvent: async () => undefined
      } as never
    });

    const result = await admission.admitRun({ requestId: "req_1", event });

    expect(result).toMatchObject({
      outcome: "drop_duplicate",
      decision: { reasonCode: "duplicate_source_event" },
      run: { id: "run_existing" }
    });
    expect(getRepoBinding).not.toHaveBeenCalled();
  });

  it("does not duplicate active-run timeline events for replayed follow-up requests", async () => {
    const appendRunEvent = vi.fn(async () => undefined);
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => null,
        getRepoBinding: async () => ({
          provider: "github",
          owner: "acme",
          repo: "demo",
          runnerId: "runner_1"
        }),
        findActiveRunForConversation: async () => ({
          run: {
            id: "run_active",
            eventId: "evt_active",
            status: "running",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          },
          event
        }),
        createFollowUpRequest: async () => ({
          followUpRequest: {
            id: "follow_up_1",
            sourceEventId: event.id,
            conversationKey: "github:https://api.github.com/repos/acme/demo/issues/1/comments",
            activeRunId: "run_active",
            event,
            decision: {
              action: "queue_follow_up",
              reason: "active run exists",
              reasonCode: "active_run_same_thread",
              decidedAt: "2026-06-24T00:00:00.000Z",
              activeRunId: "run_active",
              eventId: event.id
            },
            status: "queued",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          },
          created: false
        }),
        appendRunEvent
      } as never
    });

    const result = await admission.admitRun({ requestId: "follow_up_1", event });

    expect(result).toMatchObject({
      outcome: "follow_up_queued",
      decision: { action: "queue_follow_up" }
    });
    expect(appendRunEvent).not.toHaveBeenCalled();
  });

  it("queues issue-scoped GitHub follow-ups against legacy repo-scoped active runs", async () => {
    const checkedConversationKeys: string[] = [];
    const issueScopedEvent = {
      ...event,
      id: "evt_issue_scoped",
      callback: {
        provider: "github" as const,
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments",
        threadKey: "acme/demo#1"
      },
      metadata: { owner: "acme", repo: "demo", issueNumber: 1 }
    };
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => null,
        getRepoBinding: async () => ({
          provider: "github",
          owner: "acme",
          repo: "demo",
          runnerId: "runner_1"
        }),
        findActiveRunForConversation: async ({ conversationKey }: { conversationKey: string }) => {
          checkedConversationKeys.push(conversationKey);
          if (conversationKey !== "github:acme/demo") return null;
          return {
            run: {
              id: "run_legacy_active",
              eventId: "evt_legacy_active",
              status: "running",
              createdAt: "2026-06-24T00:00:00.000Z",
              updatedAt: "2026-06-24T00:00:00.000Z"
            },
            event
          };
        },
        createFollowUpRequest: async () => ({
          followUpRequest: {
            id: "follow_up_legacy",
            sourceEventId: issueScopedEvent.id,
            conversationKey: "github:acme/demo#1",
            activeRunId: "run_legacy_active",
            event: issueScopedEvent,
            decision: {
              action: "queue_follow_up",
              reason: "active run exists",
              reasonCode: "active_run_same_thread",
              decidedAt: "2026-06-24T00:00:00.000Z",
              activeRunId: "run_legacy_active",
              eventId: issueScopedEvent.id
            },
            status: "queued",
            createdAt: "2026-06-24T00:00:00.000Z",
            updatedAt: "2026-06-24T00:00:00.000Z"
          },
          created: true
        }),
        appendRunEvent: async () => undefined
      } as never
    });

    const result = await admission.admitRun({ requestId: "follow_up_legacy", event: issueScopedEvent });

    expect(checkedConversationKeys).toEqual(["github:acme/demo#1", "github:acme/demo"]);
    expect(result).toMatchObject({
      outcome: "follow_up_queued",
      decision: {
        action: "queue_follow_up",
        activeRunId: "run_legacy_active"
      },
      followUpRequest: {
        activeRunId: "run_legacy_active"
      }
    });
  });

  it("admits local Project Target events through the shared project target ref", async () => {
    const localProject = projectTargetRefFromLocalPath("/Users/test/work/app");
    const getRepoBinding = vi.fn(async () => ({
      ...localProject,
      runnerId: "runner_1",
      workspacePath: "/Users/test/work/app"
    }));
    const admission = createAdmissionRuntime({
      repo: {
        getRunByEventId: async () => null,
        getRepoBinding,
        findActiveRunForConversation: async () => null,
        createFollowUpRequest: async () => {
          throw new Error("should not queue follow-up");
        },
        appendRunEvent: async () => undefined
      } as never
    });

    const result = await admission.admitRun({
      requestId: "req_local",
      event: {
        ...event,
        id: "evt_local",
        source: "lark",
        sourceEventId: "message_local",
        actor: { provider: "lark", providerUserId: "ou_user" },
        callback: { provider: "lark", uri: "lark://im/v1/messages", threadKey: "tk|oc|om" },
        metadata: { repoProvider: localProject.provider, owner: localProject.owner, repo: localProject.repo }
      }
    });

    expect(result).toMatchObject({ outcome: "start", binding: { runnerId: "runner_1" } });
    expect(getRepoBinding).toHaveBeenCalledWith(localProject);
  });
});
