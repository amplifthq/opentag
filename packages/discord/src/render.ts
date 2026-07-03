import { createFinalSummaryPresentation, type OpenTagFinalSummaryPresentation, type OpenTagRunResult } from "@opentag/core";

export type DiscordRenderOptions = {
  auditRunId?: string;
};

export function renderDiscordAcknowledgement(runId: string): string {
  return `Received. OpenTag is working.\nRun: ${runId}`;
}

export function renderDiscordProgress(message: string): string {
  if (/starting codex|starting claude --print|thinking/i.test(message)) {
    return "Thinking...";
  }

  return "Working...";
}

export function renderDiscordFinalResult(result: OpenTagRunResult, options: DiscordRenderOptions = {}): string {
  return renderDiscordFinalSummaryPresentation(
    createFinalSummaryPresentation({
      result,
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

export function renderDiscordFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation): string {
  const lines = [`Finished with ${presentation.outcome}.`, "", presentation.summary];

  if (presentation.verification?.length) {
    lines.push("", "Verification:");
    for (const check of presentation.verification) {
      lines.push(`- ${check.command}: ${check.outcome}`);
    }
  }

  if (presentation.nextActions?.length) {
    lines.push("", `Next action: ${presentation.nextActions[0]}`);
  }
  if (presentation.auditRunId) {
    lines.push("", `Audit: opentag status --run ${presentation.auditRunId}`);
  }

  return lines.join("\n");
}

export type DiscordSendMessagePayload = {
  content: string;
  message_reference?: { message_id: string };
};

/** REST body for `POST /channels/{id}/messages`; `replyToMessageId` posts as a
 * reply via `message_reference`. */
export function createDiscordSendMessagePayload(input: {
  content: string;
  replyToMessageId?: string;
}): DiscordSendMessagePayload {
  return {
    content: input.content,
    ...(input.replyToMessageId ? { message_reference: { message_id: input.replyToMessageId } } : {})
  };
}
