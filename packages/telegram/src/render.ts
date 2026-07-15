import { createFinalSummaryPresentation, type OpenTagFinalSummaryPresentation, type OpenTagRunResult } from "@opentag/core";

export type TelegramRenderOptions = {
  auditRunId?: string;
};

export const TELEGRAM_STATUS_TITLE = "📌 OpenTag status";
export const TELEGRAM_DOCTOR_TITLE = "🩺 OpenTag doctor (redacted)";

export type TelegramParseMode = "HTML";

export type TelegramInlineKeyboardButton = {
  text: string;
  url?: string;
  callback_data?: string;
  copy_text?: { text: string };
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

export type TelegramMessageRichPayload = {
  parseMode?: TelegramParseMode;
  replyMarkup?: TelegramInlineKeyboardMarkup;
};

export type TelegramMessageRich = {
  provider: "telegram";
  payload: TelegramMessageRichPayload;
};

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateTelegramText(value: string, maxLength = 900): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function code(value: string): string {
  return `<code>${escapeTelegramHtml(value)}</code>`;
}

function compactIdentifier(value: string): string {
  return value.length > 28 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value;
}

function bold(value: string): string {
  return `<b>${escapeTelegramHtml(value)}</b>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTelegramInlineKeyboardMarkup(value: unknown): value is TelegramInlineKeyboardMarkup {
  if (!isRecord(value) || !Array.isArray(value.inline_keyboard)) return false;
  return value.inline_keyboard.every(
    (row) =>
      Array.isArray(row) &&
      row.every(
        (button) =>
          isRecord(button) &&
          typeof button.text === "string" &&
          (button.url === undefined || typeof button.url === "string") &&
          (button.callback_data === undefined || typeof button.callback_data === "string") &&
          (button.copy_text === undefined || (isRecord(button.copy_text) && typeof button.copy_text.text === "string"))
      )
  );
}

export function telegramMessageRichPayloadFromUnknown(value: unknown): TelegramMessageRichPayload | null {
  if (!isRecord(value)) return null;
  const parseMode = value.parseMode === "HTML" ? value.parseMode : undefined;
  const replyMarkup = isTelegramInlineKeyboardMarkup(value.replyMarkup) ? value.replyMarkup : undefined;
  if (!parseMode && !replyMarkup) return null;
  return {
    ...(parseMode ? { parseMode } : {}),
    ...(replyMarkup ? { replyMarkup } : {})
  };
}

export function createTelegramMessageRich(input: TelegramMessageRichPayload = {}): TelegramMessageRich {
  return {
    provider: "telegram",
    payload: {
      parseMode: input.parseMode ?? "HTML",
      ...(input.replyMarkup ? { replyMarkup: input.replyMarkup } : {})
    }
  };
}

function copyTextButton(text: string, value: string): TelegramInlineKeyboardButton {
  return { text, copy_text: { text: value } };
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function compactButtonText(value: string, maxLength = 28): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export function createTelegramRunStatusReplyMarkup(runId: string): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [[copyTextButton("Copy run id", runId), copyTextButton("Copy audit", `opentag status --run ${runId}`)]]
  };
}

export function createTelegramFinalSummaryReplyMarkup(presentation: OpenTagFinalSummaryPresentation): TelegramInlineKeyboardMarkup | undefined {
  const rows: TelegramInlineKeyboardButton[][] = [];
  if (presentation.auditRunId) {
    rows.push([
      copyTextButton("Copy run id", presentation.auditRunId),
      copyTextButton("Copy audit", `opentag status --run ${presentation.auditRunId}`)
    ]);
  }

  const actionButtons = (presentation.actions ?? []).slice(0, 2).flatMap((action) =>
    action.visibleDecisions
      .filter((decision) => decision === "apply" || decision === "reject" || decision === "continue")
      .slice(0, 2)
      .map((decision) => copyTextButton(`Copy ${decision} ${action.index}`, `${decision} ${action.index}`))
  );
  for (let index = 0; index < actionButtons.length; index += 2) {
    rows.push(actionButtons.slice(index, index + 2));
  }

  const urlButtons: TelegramInlineKeyboardButton[] = [];
  if (presentation.result.createdPullRequestUrl && isPublicHttpUrl(presentation.result.createdPullRequestUrl)) {
    urlButtons.push({ text: "Open PR", url: presentation.result.createdPullRequestUrl });
  }
  for (const artifact of presentation.artifacts ?? []) {
    if (urlButtons.length >= 2) break;
    if (isPublicHttpUrl(artifact.uri)) {
      urlButtons.push({ text: compactButtonText(`Open ${artifact.kind ?? artifact.title}`), url: artifact.uri });
    }
  }
  for (let index = 0; index < urlButtons.length; index += 2) {
    rows.push(urlButtons.slice(index, index + 2));
  }

  return rows.length ? { inline_keyboard: rows } : undefined;
}

export function renderTelegramAcknowledgement(runId: string): string {
  return [bold("OpenTag picked this up"), `Run: ${code(compactIdentifier(runId))}`, `Status: ${bold("received")}`].join("\n");
}

export function renderTelegramProgress(message: string, options: { runId?: string } = {}): string {
  const heading = /starting acp agent|thinking/i.test(message) ? "OpenTag is thinking" : "OpenTag is working";
  const lines = [bold(heading), ...(options.runId ? [`Run: ${code(compactIdentifier(options.runId))}`] : []), `Status: ${bold("running")}`];
  if (/starting acp agent|thinking/i.test(message)) {
    return lines.join("\n");
  }

  return [...lines, "", escapeTelegramHtml(truncateTelegramText(message, 240))].join("\n");
}

export function renderTelegramFinalResult(result: OpenTagRunResult, options: TelegramRenderOptions = {}): string {
  return renderTelegramFinalSummaryPresentation(
    createFinalSummaryPresentation({
      result,
      ...(options.auditRunId ? { auditRunId: options.auditRunId } : {})
    })
  );
}

function telegramOutcomeHeading(outcome: string): string {
  switch (outcome) {
    case "success":
      return "OpenTag finished";
    case "failure":
      return "OpenTag failed";
    case "needs_human":
      return "OpenTag needs input";
    case "cancelled":
      return "OpenTag stopped";
    case "interrupted":
      return "OpenTag interrupted";
    case "timed_out":
      return "OpenTag timed out";
    default:
      return "OpenTag finished";
  }
}

function telegramVerificationSummary(presentation: OpenTagFinalSummaryPresentation): string | undefined {
  const checks = presentation.verification ?? [];
  if (!checks.length) return undefined;
  const passed = checks.filter((check) => check.outcome === "passed").length;
  if (passed === checks.length) {
    return checks.length === 1 ? `${checks[0]?.command}: passed` : `${checks.length} checks passed`;
  }
  return checks
    .slice(0, 3)
    .map((check) => `${check.command}: ${check.outcome}`)
    .join("; ");
}

function telegramArtifactSummary(presentation: OpenTagFinalSummaryPresentation): string | undefined {
  const artifacts = presentation.artifacts ?? [];
  if (!artifacts.length) return undefined;
  const publicUrlCount = artifacts.filter((artifact) => isPublicHttpUrl(artifact.uri)).length;
  const localCount = artifacts.length - publicUrlCount;
  const parts = [
    `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} available`,
    ...(publicUrlCount ? [`${publicUrlCount} openable link${publicUrlCount === 1 ? "" : "s"}`] : []),
    ...(localCount ? [`${localCount} local-only item${localCount === 1 ? "" : "s"} via audit`] : [])
  ];
  return parts.join(" · ");
}

export function renderTelegramFinalSummaryPresentation(presentation: OpenTagFinalSummaryPresentation): string {
  const verificationSummary = telegramVerificationSummary(presentation);
  const artifactSummary = telegramArtifactSummary(presentation);
  const lines = [
    bold(telegramOutcomeHeading(presentation.outcome)),
    [`Status: ${bold(presentation.outcome)}`, ...(presentation.auditRunId ? [`Run: ${code(compactIdentifier(presentation.auditRunId))}`] : [])].join(
      " · "
    ),
    `Summary: ${escapeTelegramHtml(truncateTelegramText(presentation.summary, 320))}`
  ];

  if (verificationSummary) {
    lines.push(`Verification: ${escapeTelegramHtml(verificationSummary)}`);
  }

  if (artifactSummary) {
    lines.push(`Artifacts: ${escapeTelegramHtml(artifactSummary)}`);
  }

  if (presentation.actions?.length) {
    const actionSummary = presentation.actions
      .slice(0, 3)
      .map((action) => `${action.index}. ${action.title}`)
      .join("; ");
    lines.push(`${presentation.actionReceiptTitle ?? "Actions"}: ${escapeTelegramHtml(truncateTelegramText(actionSummary, 260))}`);
  }

  if (presentation.nextActions?.length) {
    lines.push(`Next: ${escapeTelegramHtml(truncateTelegramText(presentation.nextActions[0] as string, 260))}`);
  }

  return lines.join("\n");
}

export type TelegramSendMessagePayload = {
  chat_id: string;
  text: string;
  parse_mode?: TelegramParseMode;
  reply_markup?: TelegramInlineKeyboardMarkup;
  reply_to_message_id?: number;
  message_thread_id?: number;
  allow_sending_without_reply?: boolean;
};

export type TelegramEditMessageTextPayload = {
  chat_id: string;
  message_id: number;
  text: string;
  parse_mode?: TelegramParseMode;
  reply_markup?: TelegramInlineKeyboardMarkup;
};

export function createTelegramSendMessagePayload(input: {
  chatId: string;
  text: string;
  rich?: TelegramMessageRichPayload;
  replyToMessageId?: number;
  messageThreadId?: number;
}): TelegramSendMessagePayload {
  return {
    chat_id: input.chatId,
    text: input.text,
    ...(input.rich?.parseMode ? { parse_mode: input.rich.parseMode } : {}),
    ...(input.rich?.replyMarkup ? { reply_markup: input.rich.replyMarkup } : {}),
    ...(input.replyToMessageId ? { reply_to_message_id: input.replyToMessageId, allow_sending_without_reply: true } : {}),
    ...(input.messageThreadId ? { message_thread_id: input.messageThreadId } : {})
  };
}

export function createTelegramEditMessageTextPayload(input: {
  chatId: string;
  messageId: number;
  text: string;
  rich?: TelegramMessageRichPayload;
}): TelegramEditMessageTextPayload {
  return {
    chat_id: input.chatId,
    message_id: input.messageId,
    text: input.text,
    ...(input.rich?.parseMode ? { parse_mode: input.rich.parseMode } : {}),
    ...(input.rich?.replyMarkup ? { reply_markup: input.rich.replyMarkup } : {})
  };
}
