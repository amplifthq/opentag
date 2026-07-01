import { describe, expect, it } from "vitest";
import { createAgentSessionProfileForEvent, resolveAgentSessionProfile, sanitizeAgentSessionProfileId } from "../src/session-profile.js";

describe("AgentSessionProfile", () => {
  it("derives a stable source-thread profile from event metadata and Project Target", () => {
    const profile = createAgentSessionProfileForEvent({
      runId: "run_1",
      event: {
        id: "evt_1",
        source: "slack",
        sourceEventId: "Ev1",
        receivedAt: "2026-06-29T00:00:00.000Z",
        actor: { provider: "slack", providerUserId: "U123", handle: "octocat" },
        target: { mention: "@opentag", agentId: "opentag" },
        command: { rawText: "fix this", intent: "fix", args: {} },
        context: [],
        permissions: [{ scope: "repo:write", reason: "edit the local checkout" }],
        callback: { provider: "slack", uri: "https://slack.example/callback" },
        metadata: { repoProvider: "github", owner: "acme", repo: "demo", teamId: "T123", channelId: "C456" }
      },
      metadata: { provider: "slack", accountId: "T123", conversationId: "C456", owner: "acme", repo: "demo" },
      template: "opentag-{provider}-{accountId}-{conversationId}-{owner}-{repo}-{actorId}"
    });

    expect(profile).toMatchObject({
      id: "opentag-slack-T123-C456-acme-demo-U123",
      sourceProvider: "slack",
      projectTarget: "github:acme/demo",
      accountId: "T123",
      conversationId: "C456",
      actorId: "U123"
    });
  });

  it("resolves explicit executor templates while preserving a fallback session identity", () => {
    const fallback = {
      id: "opentag-slack-T123-C456-acme-demo-U123",
      template: "fallback",
      sourceProvider: "slack",
      projectTarget: "github:acme/demo"
    };

    expect(
      resolveAgentSessionProfile({
        profileTemplate: "custom-{provider}-{owner}/{repo}",
        metadata: { provider: "slack", owner: "acme", repo: "demo", runId: "run_1" },
        fallback
      })
    ).toMatchObject({
      id: "custom-slack-acme-demo",
      sourceProvider: "slack"
    });
    expect(sanitizeAgentSessionProfileId("OpenTag / unsafe path")).toBe("OpenTag-unsafe-path");
  });

  it("lets a generic profile template use Project Target and actor identity", () => {
    expect(
      resolveAgentSessionProfile({
        profileTemplate: "agent-{provider}-{projectTarget}-{actorId}",
        metadata: { provider: "slack", accountId: "T123", conversationId: "C456", runId: "run_1" },
        projectTargetRef: { provider: "github", owner: "acme", repo: "demo" },
        actorId: "U123"
      })
    ).toMatchObject({
      id: "agent-slack-github-acme-demo-U123",
      sourceProvider: "slack",
      projectTarget: "github:acme/demo",
      accountId: "T123",
      conversationId: "C456",
      actorId: "U123"
    });
  });
});
