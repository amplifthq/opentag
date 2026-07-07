import { describe, expect, it } from "vitest";
import {
  OpenTagExecutorProtocolEventSchema,
  OpenTagExecutorProtocolManifestSchema,
  OpenTagExecutorRunRequestSchema
} from "../src/executor-protocol.js";

describe("OpenTag executor protocol schemas", () => {
  it("defaults manifest capabilities for stdio-jsonl protocol executors", () => {
    const manifest = OpenTagExecutorProtocolManifestSchema.parse({
      protocol: "opentag.executor.v1",
      id: "fake",
      label: "Fake",
      transport: "stdio-jsonl",
      command: "fake-agent"
    });

    expect(manifest.capabilities).toEqual({
      workspaceIsolation: "worktree",
      conversationAccess: "request",
      progressEvents: "audit",
      supportsCancel: false,
      supportsStreaming: false
    });
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
});
