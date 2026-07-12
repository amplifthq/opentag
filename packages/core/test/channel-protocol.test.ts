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
      kind: "run_status",
      runId: "run-1",
      state: "running",
      message: "Checking recent deployment changes.",
      detailVisibility: "source_thread"
    },
    {
      kind: "approval_prompt",
      runId: "run-1",
      approvalId: "approval-1",
      proposalId: "proposal-1",
      intentId: "intent-action-1",
      actionId: "action-1",
      proposalHash: "sha256:abc123",
      title: "Deploy the verified build?",
      summary: "This will update the production service.",
      target: { provider: "deploy", connectionId: "deploy:prod", operation: "update", resource: "service:web", resourceVersion: "build-42" },
      decisions: ["allow_once", "allow_run", "deny"]
    },
    {
      kind: "action_receipt",
      title: "Deployment completed",
      actions: [
        {
          index: 1,
          title: "Deploy the verified build",
          state: "ready_to_apply",
          targetLabel: "production service",
          visibleDecisions: ["apply", "reject"],
          primaryDecision: "apply"
        }
      ],
      auditRunId: "run-1"
    },
    {
      kind: "final_summary",
      outcome: "success",
      summary: "Incident mitigated.",
      artifacts: [{ kind: "report", title: "Incident report", uri: "opentag://artifact-1" }],
      verification: [{ command: "verify-incident", outcome: "passed" }],
      result: {
        conclusion: "success",
        summary: "Incident mitigated.",
        artifacts: [{ kind: "report", title: "Incident report", uri: "opentag://artifact-1" }],
        verification: [{ command: "verify-incident", outcome: "passed" }]
      }
    }
  ] as const)("parses a $kind outbound presentation command", (presentation) => {
    const command = OpenTagChannelPresentationCommandSchema.parse({
      protocol: "opentag.channel.v1",
      commandId: `command-${presentation.kind}`,
      replyTarget,
      operation: presentation.kind === "run_status" ? "update" : "reply",
      presentation
    });

    expect(command.presentation.kind).toBe(presentation.kind);
    expect(command.replyTarget.channel.provider).toBe("chat");
  });

  it("does not carry provider-specific payloads into the normalized command", () => {
    const command = OpenTagChannelPresentationCommandSchema.parse({
      protocol: "opentag.channel.v1",
      commandId: "command-1",
      replyTarget,
      operation: "update",
      presentation: {
        kind: "run_status",
        runId: "run-1",
        state: "running",
        message: "Working",
        slackBlocks: []
      }
    });

    expect(command.presentation).not.toHaveProperty("slackBlocks");
  });
});
