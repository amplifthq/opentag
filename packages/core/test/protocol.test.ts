import { describe, expect, it } from "vitest";
import {
  assembleContextPacketFromEvent,
  conversationKeysFromEvent,
  contextPacketFromEvent,
  defaultRunEventMetadata,
  protocolRunFieldsFromEvent,
  workThreadFromEvent
} from "../src/protocol.js";
import { ContextPacketSchema, type OpenTagEvent } from "../src/schema.js";

const slackEvent: OpenTagEvent = {
  id: "evt_slack_mention_1",
  source: "slack",
  sourceEventId: "Ev123",
  receivedAt: "2026-06-24T00:00:00.000Z",
  actor: { provider: "slack", providerUserId: "U123", handle: "alice", organizationId: "T123" },
  target: { mention: "@opentag", agentId: "opentag" },
  command: { rawText: "fix the flaky test", intent: "fix", args: {} },
  context: [
    { provider: "slack", kind: "message", uri: "slack://team/T123/channel/C123/message/1710000000.000100", visibility: "organization" },
    { provider: "github", kind: "repo", uri: "https://github.com/acme/demo", visibility: "organization" }
  ],
  workItem: {
    provider: "slack",
    kind: "thread",
    externalId: "T123|C123|1710000000.000100",
    uri: "slack://team/T123/channel/C123/thread/1710000000.000100",
    ownerContainer: {
      provider: "github",
      id: "acme/demo",
      uri: "https://github.com/acme/demo"
    }
  },
  permissions: [
    { scope: "chat:postMessage", reason: "reply to source thread" },
    { scope: "repo:write", reason: "commit on isolated branch" },
    { scope: "pr:create", reason: "open a pull request" }
  ],
  callback: { provider: "slack", uri: "https://slack.com/api/chat.postMessage", threadKey: "T123|C123|1710000000.000100" },
  metadata: { teamId: "T123", channelId: "C123", owner: "acme", repo: "demo", repoProvider: "github" }
};

describe("protocol helpers", () => {
  it("derives a work thread for a repository-bound Slack event", () => {
    const thread = workThreadFromEvent(slackEvent);

    expect(thread).toMatchObject({
      workItemReference: {
        provider: "slack",
        kind: "thread",
        externalId: "T123|C123|1710000000.000100"
      },
      primaryAnchor: {
        provider: "slack",
        controlPlane: true,
        canApprove: true
      }
    });
  });

  it("keeps only the exact Slack callback conversation key", () => {
    expect(conversationKeysFromEvent(slackEvent)).toEqual([
      "slack:T123|C123|1710000000.000100",
    ]);
  });

  it("does not invent a canonical work item when only a Slack thread is known", () => {
    const { workItem: _workItem, ...eventWithoutWorkItem } = slackEvent;
    const unboundSlackEvent: OpenTagEvent = {
      ...eventWithoutWorkItem,
      id: "evt_slack_1",
      source: "slack",
      sourceEventId: "Ev123",
      actor: { provider: "slack", providerUserId: "U123", handle: "U123", organizationId: "T123" },
      context: [
        { provider: "slack", kind: "message", uri: "slack://team/T123/channel/C123/message/1710000000.000100", visibility: "organization" },
        { kind: "text", uri: "<@U999> fix this", visibility: "organization" }
      ],
      permissions: [{ scope: "chat:postMessage", reason: "reply in Slack thread" }],
      callback: {
        provider: "slack",
        uri: "https://slack.com/api/chat.postMessage",
        threadKey: "T123|C123|1710000000.000100"
      },
      metadata: { owner: "acme", repo: "demo", repoProvider: "github" }
    };

    expect(workThreadFromEvent(unboundSlackEvent)).toBeUndefined();
    expect(protocolRunFieldsFromEvent(unboundSlackEvent)).toMatchObject({
      contextPacket: {
        summary: "fix the flaky test"
      }
    });
  });

  it("builds a context packet with assembly metadata and write-scope risk", () => {
    const packet = contextPacketFromEvent(slackEvent);

    expect(packet.sourcePointers).toHaveLength(2);
    expect(packet.intent).toMatchObject({
      rawText: "fix the flaky test",
      normalizedIntent: "fix",
      requestedBy: { provider: "slack", providerUserId: "U123", handle: "alice" }
    });
    expect(packet.sources?.map((source) => source.role)).toEqual(["primary", "supporting"]);
    expect(packet.assembly?.stages).toEqual(["collect", "classify", "filter", "preserve", "summarize", "budget", "emit"]);
    expect(packet.risks?.[0]).toContain("repo:write");
    expect(packet.exclusions?.[0]).toContain("explicit capability");
  });

  it("emits a schema-valid packet when the command rawText is empty", () => {
    const emptyRawTextEvent: OpenTagEvent = {
      ...slackEvent,
      command: { ...slackEvent.command, rawText: "" }
    };

    const packet = contextPacketFromEvent(emptyRawTextEvent);

    // OpenTagCommandSchema.rawText allows "" but ContextPacketIntentSchema.rawText
    // is min length 1. The packet must remain valid so the store does not accept it
    // on write (createRun) and then throw on read (runFromRow parse).
    // `intent` is optional on ContextPacketSchema, so assert it is defined before
    // dereferencing to keep the test type-checking cleanly under strictNullChecks.
    expect(packet.intent).toBeDefined();
    expect(packet.intent?.rawText).toBe(packet.summary);
    expect(() => ContextPacketSchema.parse(packet)).not.toThrow();
  });

  it("falls back to summary when the command rawText is whitespace-only", () => {
    const whitespaceRawTextEvent: OpenTagEvent = {
      ...slackEvent,
      command: { ...slackEvent.command, rawText: "   " }
    };

    const packet = contextPacketFromEvent(whitespaceRawTextEvent);

    // A whitespace-only rawText is functionally empty: it must fall back to the
    // non-empty summary rather than being treated as truthy and stored as-is.
    expect(packet.intent).toBeDefined();
    expect(packet.intent?.rawText).toBe(packet.summary);
    expect(packet.intent?.rawText.trim().length).toBeGreaterThan(0);
    expect(() => ContextPacketSchema.parse(packet)).not.toThrow();
  });

  it("applies context packet budget as an explicit assembly stage", () => {
    const packet = assembleContextPacketFromEvent(
      {
        ...slackEvent,
        context: [
          ...slackEvent.context,
          { provider: "github", kind: "repo", uri: "https://github.com/acme/demo", visibility: "public" },
          { kind: "url", uri: "https://example.com/background", visibility: "public" }
        ]
      },
      "2026-06-24T00:00:00.000Z",
      { budgetTokens: 500 }
    );

    expect(packet.sourcePointers).toHaveLength(1);
    expect(packet.assembly?.budgetTokens).toBe(500);
    expect(packet.assembly?.stages).toContain("budget");
  });

  it("allows context packet assembly hooks to customize stages", () => {
    const packet = assembleContextPacketFromEvent(slackEvent, "2026-06-24T00:00:00.000Z", {
      hooks: {
        collect({ pointers }) {
          return pointers.slice(0, 1);
        },
        summarize({ summary }) {
          return `Hooked: ${summary}`;
        },
        preserve({ facts }) {
          return [...facts, { text: "hook-added fact" }];
        }
      }
    });

    expect(packet.summary).toBe("Hooked: fix the flaky test");
    expect(packet.sourcePointers).toHaveLength(1);
    expect(packet.facts?.map((fact) => fact.text)).toContain("hook-added fact");
  });

  it("shares default run event metadata across runtime layers", () => {
    expect(defaultRunEventMetadata("delivery.intent.queued")).toEqual({
      visibility: "audit",
      importance: "normal"
    });
    expect(defaultRunEventMetadata("delivery.activation_blocked")).toEqual({
      visibility: "human",
      importance: "blocking"
    });
    expect(defaultRunEventMetadata("run.waiting_for_permission")).toEqual({
      visibility: "audit",
      importance: "blocking"
    });
    expect(defaultRunEventMetadata("run.created")).toEqual({
      visibility: "audit",
      importance: "low"
    });
  });

});
