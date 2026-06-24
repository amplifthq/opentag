import type { OpenTagRunResult } from "@opentag/core";
import { renderAcknowledgement, renderFinalResult, renderProgress } from "@opentag/github";
import { createSlackFinalResultBlocks, renderSlackAcknowledgement, renderSlackFinalResult, type SlackBlock } from "@opentag/slack";
import type { CallbackMessage } from "./server.js";

export type CallbackProvider = CallbackMessage["provider"];

export type PresentedCallbackBody = {
  body: string;
  blocks?: SlackBlock[];
};

export type CallbackPresentation = {
  shouldDeliverProgress(provider: CallbackProvider): boolean;
  acknowledgement(input: { provider: CallbackProvider; runId: string }): string;
  progress(input: { provider: CallbackProvider; runId: string; message: string }): string;
  final(input: { provider: CallbackProvider; result: OpenTagRunResult }): PresentedCallbackBody;
};

export function createDefaultCallbackPresentation(): CallbackPresentation {
  return {
    shouldDeliverProgress(provider) {
      return provider !== "slack";
    },

    acknowledgement(input) {
      if (input.provider === "slack") {
        return renderSlackAcknowledgement(input.runId);
      }
      return renderAcknowledgement(input.runId);
    },

    progress(input) {
      return renderProgress({ runId: input.runId, message: input.message });
    },

    final(input) {
      if (input.provider === "slack") {
        return {
          body: renderSlackFinalResult(input.result),
          blocks: createSlackFinalResultBlocks(input.result)
        };
      }
      return { body: renderFinalResult(input.result) };
    }
  };
}
