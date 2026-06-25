import type { OpenTagRunResult } from "@opentag/core";

function nextActionSummary(result: OpenTagRunResult): string | undefined {
  if (!result.nextAction) return undefined;
  if (typeof result.nextAction === "string") return result.nextAction;
  return result.nextAction.summary;
}

export function renderTelegramAcknowledgement(runId: string): string {
  return `I picked this up: ${runId}`;
}

export function renderTelegramProgress(message: string): string {
  if (/starting claude --print|thinking/i.test(message)) {
    return "Thinking...";
  }

  return "Working...";
}

export function renderTelegramFinalResult(result: OpenTagRunResult): string {
  const lines = [`Finished with ${result.conclusion}.`, "", result.summary];

  if (result.verification?.length) {
    lines.push("", "Verification:");
    for (const check of result.verification) {
      lines.push(`- ${check.command}: ${check.outcome}`);
    }
  }

  const nextAction = nextActionSummary(result);
  if (nextAction) {
    lines.push("", `Next action: ${nextAction}`);
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
