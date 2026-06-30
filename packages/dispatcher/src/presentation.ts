import type { ActionReceiptContext, OpenTagRunResult } from "@opentag/core";
import { renderAcknowledgement, renderFinalResult, renderProgress } from "@opentag/github";
import { renderLarkAcknowledgement, renderLarkFinalResult } from "@opentag/lark";
import { createSlackFinalResultBlocks, renderSlackAcknowledgement, renderSlackFinalResult, type SlackBlock } from "@opentag/slack";
import { renderTelegramAcknowledgement, renderTelegramFinalResult, renderTelegramProgress } from "@opentag/telegram";
import type { CallbackMessage } from "./server.js";

export type CallbackProvider = CallbackMessage["provider"];

export type PresentedCallbackBody = {
  body: string;
  blocks?: SlackBlock[];
};

export type CallbackPresentation = {
  shouldDeliverAcknowledgement(provider: CallbackProvider): boolean;
  shouldDeliverProgress(provider: CallbackProvider): boolean;
  acknowledgement(input: { provider: CallbackProvider; runId: string }): string;
  progress(input: { provider: CallbackProvider; runId: string; message: string }): string;
  final(input: { provider: CallbackProvider; result: OpenTagRunResult; runId?: string; receiptContext?: ActionReceiptContext }): PresentedCallbackBody;
};

export function createDefaultCallbackPresentation(): CallbackPresentation {
  return {
    shouldDeliverAcknowledgement(provider) {
      return provider !== "lark" && provider !== "slack";
    },

    shouldDeliverProgress(provider) {
      return provider !== "slack" && provider !== "lark";
    },

    acknowledgement(input) {
      if (input.provider === "slack") {
        return renderSlackAcknowledgement(input.runId);
      }
      if (input.provider === "lark") {
        return renderLarkAcknowledgement(input.runId);
      }
      if (input.provider === "telegram") {
        return renderTelegramAcknowledgement(input.runId);
      }
      return renderAcknowledgement(input.runId);
    },

    progress(input) {
      if (input.provider === "telegram") {
        return renderTelegramProgress(input.message);
      }
      return renderProgress({ runId: input.runId, message: input.message });
    },

    final(input) {
      const renderOptions = {
        ...(input.receiptContext ? { receiptContext: input.receiptContext } : {}),
        ...((input.provider === "github" || input.provider === "slack") && input.runId ? { auditRunId: input.runId } : {})
      };
      if (input.provider === "slack") {
        return {
          body: renderSlackFinalResult(input.result, renderOptions),
          blocks: createSlackFinalResultBlocks(input.result, renderOptions)
        };
      }
      if (input.provider === "lark") {
        return { body: renderLarkFinalResult(input.result) };
      }
      if (input.provider === "telegram") {
        return { body: renderTelegramFinalResult(input.result) };
      }
      return { body: renderFinalResult(input.result, renderOptions) };
    }
  };
}
