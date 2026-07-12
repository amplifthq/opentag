import { describe, expect, it } from "vitest";
import {
  OpenTagChannelInboundMessageSchema,
  OpenTagChannelPresentationCommandSchema
} from "../src/channel-protocol.js";

const replyTarget = {
  channel: { provider: "chat", id: "channel-42", workspace: "tenant-7" },
  thread: { provider: "chat", id: "thread-99", parentMessageId: "message-1" }
} as const;

describe("opentag.channel.v1", () => {
  it("parses a normalized source-thread inbound message", () => {
    const event = OpenTagChannelInboundMessageSchema.parse({
      protocol: "opentag.channel.v1",
      eventId: "event-1",
      occurredAt: "2026-07-12T09:30:00+08:00",
      trigger: "bound_thread_reply",
      source: {
        kind: "channel_message",
        channel: replyTarget.channel,
        thread: replyTarget.thread,
        actor: { provider: "chat", id: "actor-3", displayName: "Ming" }
      },
      text: "continue the run",
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "brief.md",
          mediaType: "text/markdown",
          uri: "provider://attachment-1"
        }
      ],
      replyTarget
    });

    expect(event.source.thread?.id).toBe("thread-99");
    expect(event.replyTarget.purpose).toBe("all");
    expect(event.attachments[0]?.kind).toBe("file");
  });

  it.each([
    {
      kind: "run_card",
      runId: "run-1",
      state: "running",
      title: "Investigate incident",
      summary: "Checking recent deployment changes.",
      detailLevel: "balanced"
    },
    {
      kind: "approval_prompt",
      runId: "run-1",
      approvalId: "approval-1",
      proposalHash: "sha256:abc123",
      title: "Deploy the verified build?",
      summary: "This will update the production service.",
      decisions: ["allow_once", "allow_run", "deny"]
    },
    {
      kind: "action_receipt",
      runId: "run-1",
      actionId: "action-1",
      state: "succeeded",
      summary: "Deployment completed.",
      receiptRef: "receipt-77"
    },
    {
      kind: "final_summary",
      runId: "run-1",
      conclusion: "completed",
      summary: "Incident mitigated.",
      artifacts: [{ id: "artifact-1", title: "Incident report", uri: "opentag://artifact-1" }]
    }
  ] as const)("parses a $kind outbound presentation command", (presentation) => {
    const command = OpenTagChannelPresentationCommandSchema.parse({
      protocol: "opentag.channel.v1",
      commandId: `command-${presentation.kind}`,
      replyTarget,
      operation: presentation.kind === "run_card" ? "update" : "reply",
      presentation
    });

    expect(command.presentation.kind).toBe(presentation.kind);
    expect(command.replyTarget.channel.provider).toBe("chat");
  });

  it("rejects provider-specific payloads from the core presentation contract", () => {
    expect(() =>
      OpenTagChannelPresentationCommandSchema.parse({
        protocol: "opentag.channel.v1",
        commandId: "command-1",
        replyTarget,
        operation: "update",
        presentation: {
          kind: "run_card",
          runId: "run-1",
          state: "running",
          title: "Working",
          slackBlocks: []
        }
      })
    ).toThrow();
  });
});
