import { createFinalSummaryPresentation, type OpenTagFinalSummaryPresentation, type OpenTagRunResult } from "@opentag/core";

export const LINE_TEXT_MESSAGE_MAX_CHARS = 5000;
export const LINE_PUSH_MAX_MESSAGES = 5;

export type LineRenderOptions = {
  auditRunId?: string;
};

export type LineTextMessage = {
  type: "text";
  text: string;
};

export type LinePushMessagePayload = {
  to: string;
  messages: LineTextMessage[];
};

export function renderLineAcknowledgement(runId: string): string {
  return `I picked this up: ${runId}`;
}

export function renderLineProgress(): string {
  return "Working...";
}

export function renderLineFinalResult(result: OpenTagRunResult, options: LineRenderOptions = {}): string {
  return renderLineFinalSummaryPresentation(
    createFinalSummaryPresentation({
      result,
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

export function renderLineFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation): string {
  const lines = [`Finished with ${presentation.outcome}.`, "", presentation.summary];

  if (presentation.verification?.length) {
    lines.push("", "Verification:");
    for (const check of presentation.verification) {
      lines.push(`- ${check.command}: ${check.outcome}`);
    }
  }

  if (presentation.nextActions?.length) lines.push("", `Next action: ${presentation.nextActions[0]}`);
  if (presentation.auditRunId) lines.push("", `Audit: opentag status --run ${presentation.auditRunId}`);

  return lines.join("\n");
}

export function chunkLineText(text: string, maxChars = LINE_TEXT_MESSAGE_MAX_CHARS): string[] {
  if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error("LINE text chunk size must be a positive integer.");
  const chars = Array.from(text);
  if (chars.length === 0) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += maxChars) {
    chunks.push(chars.slice(index, index + maxChars).join(""));
  }
  return chunks;
}

export function createLinePushMessagePayloads(input: { to: string; text: string }): LinePushMessagePayload[] {
  const messages = chunkLineText(input.text).map((text) => ({ type: "text" as const, text }));
  const payloads: LinePushMessagePayload[] = [];
  for (let index = 0; index < messages.length; index += LINE_PUSH_MAX_MESSAGES) {
    payloads.push({ to: input.to, messages: messages.slice(index, index + LINE_PUSH_MAX_MESSAGES) });
  }
  return payloads;
}
