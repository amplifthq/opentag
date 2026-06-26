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
