import { describe, expect, it } from "vitest";
import { OpenTagEventSchema } from "../src/schema.js";

describe("OpenTagEventSchema", () => {
  it("accepts a valid GitHub event", () => {
    const parsed = OpenTagEventSchema.parse({
      id: "evt_1",
      source: "github",
      sourceEventId: "12345",
      receivedAt: "2026-06-24T00:00:00.000Z",
      actor: {
        provider: "github",
        providerUserId: "42",
        handle: "octocat"
      },
      target: {
        mention: "@opentag",
        agentId: "opentag"
      },
      command: {
        rawText: "fix this",
        intent: "fix",
        args: {}
      },
      context: [
        {
          kind: "github.issue",
          uri: "https://github.com/acme/demo/issues/1",
          visibility: "public"
        }
      ],
      permissions: [
        {
          scope: "issue:comment",
          reason: "reply to source thread"
        }
      ],
      callback: {
        provider: "github",
        uri: "https://api.github.com/repos/acme/demo/issues/1/comments"
      },
      metadata: {}
    });

    expect(parsed.source).toBe("github");
  });

  it("accepts the current public executor hints", () => {
    for (const executorHint of ["claude-code", "codex", "hermes", "openclaw", "custom"]) {
      expect(
        OpenTagEventSchema.parse({
          id: `evt_${executorHint}`,
          source: "github",
          sourceEventId: `comment_${executorHint}`,
          receivedAt: "2026-06-24T00:00:00.000Z",
          actor: { provider: "github", providerUserId: "42" },
          target: {
            mention: "@opentag",
            agentId: "opentag",
            executorHint
          },
          command: { rawText: "run this", intent: "run", args: {} },
          context: [],
          permissions: [{ scope: "runner:local", reason: "execute locally" }],
          callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
          metadata: { owner: "acme", repo: "demo" }
        }).target.executorHint
      ).toBe(executorHint);
    }
  });

  it("rejects the retired oh-my-pi executor hint", () => {
    expect(() =>
      OpenTagEventSchema.parse({
        id: "evt_old_executor",
        source: "github",
        sourceEventId: "comment_old_executor",
        receivedAt: "2026-06-24T00:00:00.000Z",
        actor: { provider: "github", providerUserId: "42" },
        target: {
          mention: "@opentag",
          agentId: "opentag",
          executorHint: "oh-my-pi"
        },
        command: { rawText: "run this", intent: "run", args: {} },
        context: [],
        permissions: [{ scope: "runner:local", reason: "execute locally" }],
        callback: { provider: "github", uri: "https://api.github.com/repos/acme/demo/issues/1/comments" },
        metadata: { owner: "acme", repo: "demo" }
      })
    ).toThrow();
  });
});
