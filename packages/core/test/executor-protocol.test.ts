import { describe, expect, it } from "vitest";
import {
  OpenTagExecutorProtocolEventSchema,
  OpenTagExecutorRunRequestSchema,
  replyDeliveryPurposeForExecutorEventType,
  selectReplyTargetsForExecutorEventType
} from "../src/executor-protocol.js";
import {
  OpenTagIntegrationManifestSchema,
  selectReplyTargetsForPurpose,
  type OpenTagReplyTargetRef
} from "../src/integration-protocol.js";

describe("OpenTag executor protocol schemas", () => {
  it("models integration manifests with an executor role and stdio-jsonl binding", () => {
    const manifest = OpenTagIntegrationManifestSchema.parse({
      protocol: "opentag.integration.v1",
      id: "fake",
      label: "Fake",
      bindings: {
        executorStdio: {
          kind: "stdio-jsonl",
          command: "fake-agent"
        }
      },
      roles: {
        executor: {
          protocol: "opentag.executor.v1",
          profile: "stdio-jsonl-basic",
          binding: "executorStdio"
        }
      }
    });

    expect(manifest.bindings.executorStdio.args).toEqual([]);
    expect(manifest.roles.executor?.capabilities).toEqual({
      workspaceIsolation: "worktree",
      conversationAccess: "request",
      progressEvents: "audit",
      supportsCancel: false,
      supportsStreaming: false
    });
  });

  it("rejects executor roles that reference missing bindings", () => {
    expect(() =>
      OpenTagIntegrationManifestSchema.parse({
        protocol: "opentag.integration.v1",
        id: "fake",
        label: "Fake",
        bindings: {
          other: {
            kind: "stdio-jsonl",
            command: "fake-agent"
          }
        },
        roles: {
          executor: {
            protocol: "opentag.executor.v1",
            profile: "stdio-jsonl-basic",
            binding: "missing"
          }
        }
      })
    ).toThrow("missing binding");
  });

  it("models run requests with explicit workspace and per-run session fields", () => {
    const request = OpenTagExecutorRunRequestSchema.parse({
      protocol: "opentag.executor.v1",
      runId: "run_1",
      workspace: {
        path: "/tmp/opentag/run_1",
        baseBranch: "main",
        branchName: "opentag/run_1",
        isolation: "worktree"
      },
      session: {
        scope: "run",
        key: "opentag:fake:run_1"
      },
      command: { rawText: "fix this", intent: "fix", args: {} },
      source: {
        kind: "channel_message",
        channel: { provider: "slack", id: "C123" },
        thread: { provider: "slack", id: "171234.5678" },
        actor: { provider: "slack", id: "U123", displayName: "Ada" }
      },
      targets: {
        repo: { provider: "github", owner: "amplifthq", name: "opentag", defaultBranch: "main" },
        changeRequest: { provider: "github", id: "79", number: 79, title: "Add protocol executor" },
        context: [{ provider: "github", kind: "thread", id: "issue-comment-1", url: "https://example.test/comment" }]
      },
      replyTo: [{ channel: { provider: "slack", id: "C123" }, thread: { provider: "slack", id: "171234.5678" } }],
      context: [],
      sourceControl: {
        owner: "opentag",
        forbiddenCommands: ["git add", "git commit", "git push", "gh pr create"]
      }
    });

    expect(request.workspace.path).toBe("/tmp/opentag/run_1");
    expect(request.session.key).toContain("run_1");
    expect(request.permissions).toEqual([]);
    expect(request.metadata).toEqual({});
    expect(request.source?.channel?.provider).toBe("slack");
    expect(request.targets?.repo?.name).toBe("opentag");
    expect(request.replyTo[0]?.purpose).toBe("all");
  });

  it("selects every reply target whose purpose matches the delivery", () => {
    const replyTo: OpenTagReplyTargetRef[] = [
      { channel: { provider: "slack", id: "all-1" }, purpose: "all" },
      { channel: { provider: "slack", id: "progress-1" }, purpose: "progress" },
      { channel: { provider: "github", id: "final" }, purpose: "final" },
      { channel: { provider: "github", id: "all-2" }, purpose: "all" },
      { channel: { provider: "github", id: "error" }, purpose: "error" },
      { channel: { provider: "slack", id: "progress-2" }, purpose: "progress" },
      { channel: { provider: "slack", id: "approval" }, purpose: "approval" },
      { channel: { provider: "slack", id: "progress-3" }, purpose: "progress" }
    ];

    expect(selectReplyTargetsForPurpose(replyTo, "progress").map((target) => target.channel.id)).toEqual([
      "all-1",
      "progress-1",
      "all-2",
      "progress-2",
      "progress-3"
    ]);
    expect(selectReplyTargetsForPurpose(replyTo, "final").map((target) => target.channel.id)).toEqual([
      "all-1",
      "final",
      "all-2"
    ]);
    expect(selectReplyTargetsForPurpose(replyTo, "error").map((target) => target.channel.id)).toEqual([
      "all-1",
      "all-2",
      "error"
    ]);
    expect(selectReplyTargetsForPurpose(replyTo, "approval").map((target) => target.channel.id)).toEqual([
      "all-1",
      "all-2",
      "approval"
    ]);
  });

  it("maps executor events to canonical reply delivery purposes", () => {
    expect(replyDeliveryPurposeForExecutorEventType("started")).toBe("progress");
    expect(replyDeliveryPurposeForExecutorEventType("progress")).toBe("progress");
    expect(replyDeliveryPurposeForExecutorEventType("completed")).toBe("final");
    expect(replyDeliveryPurposeForExecutorEventType("failed")).toBe("error");

    const replyTo: OpenTagReplyTargetRef[] = [
      { channel: { provider: "slack", id: "all-1" }, purpose: "all" },
      { channel: { provider: "slack", id: "progress" }, purpose: "progress" },
      { channel: { provider: "github", id: "final-1" }, purpose: "final" },
      { channel: { provider: "slack", id: "all-2" }, purpose: "all" },
      { channel: { provider: "github", id: "error" }, purpose: "error" },
      { channel: { provider: "github", id: "final-2" }, purpose: "final" }
    ];
    expect(selectReplyTargetsForExecutorEventType(replyTo, "completed").map((target) => target.channel.id)).toEqual([
      "all-1",
      "final-1",
      "all-2",
      "final-2"
    ]);
  });

  it("requires completed events to acknowledge the actual workspace", () => {
    expect(
      OpenTagExecutorProtocolEventSchema.parse({
        type: "completed",
        message: "done",
        actualWorkspacePath: "/tmp/opentag/run_1",
        summary: "Finished.",
        verification: [{ outcome: "passed", command: "test", summary: "Tests passed." }],
        artifacts: [],
        risks: []
      })
    ).toMatchObject({
      type: "completed",
      actualWorkspacePath: "/tmp/opentag/run_1",
      verification: [{ outcome: "passed" }]
    });

    expect(() =>
      OpenTagExecutorProtocolEventSchema.parse({
        type: "completed",
        message: "done",
        summary: "Finished."
      })
    ).toThrow();
  });

  it("accepts RFC 3339 event timestamps with explicit timezone offsets", () => {
    expect(
      OpenTagExecutorProtocolEventSchema.parse({
        type: "started",
        message: "started outside UTC",
        at: "2026-07-07T19:00:00+02:00"
      })
    ).toMatchObject({
      type: "started",
      at: "2026-07-07T19:00:00+02:00"
    });
  });
});
