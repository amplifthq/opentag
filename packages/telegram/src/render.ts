import { createFinalSummaryPresentation, type OpenTagFinalSummaryPresentation, type OpenTagRunResult } from "@opentag/core";

export type TelegramRenderOptions = {
  auditRunId?: string;
};

export function renderTelegramAcknowledgement(runId: string): string {
  return `I picked this up: ${runId}`;
}

export function renderTelegramProgress(message: string): string {
  if (/starting claude --print|thinking/i.test(message)) {
    return "Thinking...";
  }

  return "Working...";
}

export function renderTelegramFinalResult(result: OpenTagRunResult, options: TelegramRenderOptions = {}): string {
  return renderTelegramFinalSummaryPresentation(
    createFinalSummaryPresentation({
      result,
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

export function renderTelegramFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation): string {
  const lines = [`Finished with ${presentation.outcome}.`, "", presentation.summary];

  if (presentation.verification?.length) {
    lines.push("", "Verification:");
    for (const check of presentation.verification) {
      lines.push(`- ${check.command}: ${check.outcome}`);
    }
  }

  if (presentation.artifacts?.length) {
    lines.push("", "Artifacts:");
    const visibleArtifacts = presentation.artifacts.slice(0, 4);
    for (const artifact of visibleArtifacts) {
      lines.push(`- ${artifact.kind ? `${artifact.kind}: ` : ""}${artifact.title}: ${artifact.uri}`);
    }
    const remaining = presentation.artifacts.length - visibleArtifacts.length;
    if (remaining > 0) {
      lines.push(`+${remaining} more artifact(s) in audit/status.`);
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

export type TelegramSendMessagePayload = {
  chat_id: string;
  text: string;
  reply_to_message_id?: number;
  message_thread_id?: number;
  allow_sending_without_reply?: boolean;
};

export type TelegramSendMessageDraftPayload = {
  chat_id: string;
  text: string;
  draft_id: number;
  message_thread_id?: number;
};

export function createTelegramSendMessagePayload(input: {
  chatId: string;
  text: string;
  replyToMessageId?: number;
  messageThreadId?: number;
}): TelegramSendMessagePayload {
  return {
    chat_id: input.chatId,
    text: input.text,
    ...(input.replyToMessageId ? { reply_to_message_id: input.replyToMessageId, allow_sending_without_reply: true } : {}),
    ...(input.messageThreadId ? { message_thread_id: input.messageThreadId } : {})
  };
}

export function createTelegramSendMessageDraftPayload(input: {
  chatId: string;
  text: string;
  draftId: number;
  messageThreadId?: number;
}): TelegramSendMessageDraftPayload {
  return {
    chat_id: input.chatId,
    text: input.text,
    draft_id: input.draftId,
    ...(input.messageThreadId ? { message_thread_id: input.messageThreadId } : {})
  };
}
