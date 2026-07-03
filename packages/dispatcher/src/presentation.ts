import {
  createFinalSummaryPresentation,
  createRunStatusPresentation,
  platformCapabilityForProvider,
  renderOpenTagPresentationPlainText,
  shouldDeliverCallbackProgress,
  shouldDeliverCallbackRunStatus,
  type ActionReceiptContext,
  type OpenTagActionReceiptPresentation,
  type OpenTagDoctorSummaryPresentation,
  type OpenTagFinalSummaryPresentation,
  type OpenTagPresentation,
  type OpenTagRunResult,
  type OpenTagRunStatusPresentation,
  type OpenTagSourceThreadStatusPresentation
} from "@opentag/core";
import { renderAcknowledgement, renderFinalSummaryPresentation, renderProgress } from "@opentag/github";
import {
  renderAcknowledgement as renderGitLabAcknowledgement,
  renderFinalSummaryPresentation as renderGitLabFinalSummaryPresentation,
  renderProgress as renderGitLabProgress
} from "@opentag/gitlab";
import {
  createLarkActionReceiptCard,
  createLarkDoctorSummaryCard,
  createLarkFinalSummaryCard,
  createLarkRunStatusCard,
  createLarkSourceThreadStatusCard,
  renderLarkActionReceiptPresentation,
  renderLarkFinalSummaryPresentation,
  renderLarkRunStatusPresentation
} from "@opentag/lark";
import { renderLineAcknowledgement, renderLineFinalSummaryPresentation, renderLineProgress } from "@opentag/line";
import {
  createSlackActionReceiptBlocks,
  createSlackDoctorSummaryBlocks,
  createSlackFinalSummaryBlocks,
  createSlackSourceThreadStatusBlocks,
  renderSlackActionReceiptPresentation,
  renderSlackAcknowledgement,
  renderSlackFinalSummaryPresentation,
  type SlackBlock
} from "@opentag/slack";
import { renderTelegramAcknowledgement, renderTelegramFinalSummaryPresentation, renderTelegramProgress } from "@opentag/telegram";
import type { CallbackMessage } from "./server.js";

export type CallbackProvider = CallbackMessage["provider"];
export type LarkRenderLocale = "en-US" | "zh-CN";

export type PresentedCallbackBody = {
  body: string;
  blocks?: SlackBlock[];
  rich?: CallbackMessage["rich"];
};

export type CallbackPresentation = {
  shouldDeliverAcknowledgement(provider: CallbackProvider): boolean;
  shouldDeliverStatusUpdate(provider: CallbackProvider): boolean;
  shouldDeliverRunStatusUpdate?(input: { provider: CallbackProvider; state: OpenTagRunStatusPresentation["state"] }): boolean;
  shouldDeliverProgress(provider: CallbackProvider): boolean;
  runStatusPresentation(input: {
    runId: string;
    state: OpenTagRunStatusPresentation["state"];
    message?: string;
    nextAction?: string;
    detailVisibility?: OpenTagRunStatusPresentation["detailVisibility"];
  }): OpenTagRunStatusPresentation;
  acknowledgementPresentation(input: { runId: string }): OpenTagRunStatusPresentation;
  progressPresentation(input: { runId: string; message: string }): OpenTagRunStatusPresentation;
  finalPresentation(input: { result: OpenTagRunResult; runId?: string; receiptContext?: ActionReceiptContext }): OpenTagFinalSummaryPresentation;
  render(input: { provider: CallbackProvider; presentation: OpenTagPresentation; larkRenderLocale?: LarkRenderLocale }): PresentedCallbackBody;
  acknowledgement(input: { provider: CallbackProvider; runId: string }): string;
  runStatus(input: {
    provider: CallbackProvider;
    runId: string;
    state: OpenTagRunStatusPresentation["state"];
    message?: string;
    nextAction?: string;
    detailVisibility?: OpenTagRunStatusPresentation["detailVisibility"];
    larkRenderLocale?: LarkRenderLocale;
  }): PresentedCallbackBody;
  progress(input: { provider: CallbackProvider; runId: string; message: string }): string;
  final(input: {
    provider: CallbackProvider;
    result: OpenTagRunResult;
    runId?: string;
    receiptContext?: ActionReceiptContext;
    larkRenderLocale?: LarkRenderLocale;
  }): PresentedCallbackBody;
};

function renderRunStatus(provider: CallbackProvider, presentation: OpenTagRunStatusPresentation): PresentedCallbackBody {
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "lark") {
    return {
      body: renderLarkRunStatusPresentation(presentation),
      rich: {
        provider: "lark",
        payload: createLarkRunStatusCard(presentation)
      }
    };
  }

  if (presentation.state === "received") {
    if (provider === "slack") {
      return { body: renderSlackAcknowledgement(presentation.runId) };
    }
    if (provider === "telegram") {
      return { body: renderTelegramAcknowledgement(presentation.runId) };
    }
    if (provider === "gitlab") {
      return { body: renderGitLabAcknowledgement(presentation.runId) };
    }
    if (provider === "line") {
      return { body: renderLineAcknowledgement(presentation.runId) };
    }
    return { body: renderAcknowledgement(presentation.runId) };
  }

  const message = presentation.message ?? presentation.nextAction ?? presentation.state;
  if (provider === "telegram") {
    return { body: renderTelegramProgress(message) };
  }
  if (provider === "gitlab") {
    return { body: renderGitLabProgress({ runId: presentation.runId, message }) };
  }
  if (provider === "line") {
    return { body: renderLineProgress() };
  }
  return { body: renderProgress({ runId: presentation.runId, message }) };
}

function supportsRichPresentation(provider: CallbackProvider): boolean {
  return platformCapabilityForProvider(provider)?.supportsRichPresentation === true;
}

function renderFinalSummary(provider: CallbackProvider, presentation: OpenTagFinalSummaryPresentation, options: { larkRenderLocale?: LarkRenderLocale } = {}): PresentedCallbackBody {
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body: renderSlackFinalSummaryPresentation(presentation),
      blocks: createSlackFinalSummaryBlocks(presentation)
    };
  }
  if (canRenderRich && provider === "lark") {
    const larkOptions = options.larkRenderLocale ? { locale: options.larkRenderLocale } : {};
    const renderFinalSummaryWithOptions = renderLarkFinalSummaryPresentation as (
      presentation: OpenTagFinalSummaryPresentation,
      options?: { locale?: LarkRenderLocale }
    ) => string;
    const createFinalSummaryCardWithOptions = createLarkFinalSummaryCard as (
      presentation: OpenTagFinalSummaryPresentation,
      options?: { locale?: LarkRenderLocale }
    ) => ReturnType<typeof createLarkFinalSummaryCard>;
    return {
      body: renderFinalSummaryWithOptions(presentation, larkOptions),
      rich: {
        provider: "lark",
        payload: createFinalSummaryCardWithOptions(presentation, larkOptions)
      }
    };
  }
  if (provider === "telegram") {
    return { body: renderTelegramFinalSummaryPresentation(presentation) };
  }
  if (provider === "gitlab") {
    return { body: renderGitLabFinalSummaryPresentation(presentation) };
  }
  if (provider === "line") {
    return { body: renderLineFinalSummaryPresentation(presentation) };
  }
  return { body: renderFinalSummaryPresentation(presentation) };
}

function renderDoctorSummary(provider: CallbackProvider, presentation: OpenTagDoctorSummaryPresentation): PresentedCallbackBody {
  const body = renderOpenTagPresentationPlainText(presentation);
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body,
      blocks: createSlackDoctorSummaryBlocks(presentation)
    };
  }
  if (canRenderRich && provider === "lark") {
    return {
      body,
      rich: {
        provider: "lark",
        payload: createLarkDoctorSummaryCard(presentation)
      }
    };
  }
  return { body };
}

function renderSourceThreadStatus(provider: CallbackProvider, presentation: OpenTagSourceThreadStatusPresentation): PresentedCallbackBody {
  const body = renderOpenTagPresentationPlainText(presentation);
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body,
      blocks: createSlackSourceThreadStatusBlocks(presentation)
    };
  }
  if (canRenderRich && provider === "lark") {
    return {
      body,
      rich: {
        provider: "lark",
        payload: createLarkSourceThreadStatusCard(presentation)
      }
    };
  }
  return { body };
}

function renderActionReceipt(provider: CallbackProvider, presentation: OpenTagActionReceiptPresentation, options: { larkRenderLocale?: LarkRenderLocale } = {}): PresentedCallbackBody {
  const body =
    provider === "slack"
      ? renderSlackActionReceiptPresentation(presentation)
      : provider === "lark"
        ? renderLarkActionReceiptPresentation(presentation)
        : renderOpenTagPresentationPlainText(presentation);
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body,
      blocks: createSlackActionReceiptBlocks(presentation)
    };
  }
  if (canRenderRich && provider === "lark") {
    return {
      body,
      rich: {
        provider: "lark",
        payload: createLarkActionReceiptCard(presentation)
      }
    };
  }
  return { body };
}

export function createDefaultCallbackPresentation(): CallbackPresentation {
  return {
    shouldDeliverAcknowledgement(provider) {
      return shouldDeliverCallbackRunStatus(provider);
    },

    shouldDeliverStatusUpdate(provider) {
      return shouldDeliverCallbackRunStatus(provider);
    },

    shouldDeliverRunStatusUpdate(input) {
      if (input.provider === "lark" && input.state === "running") return false;
      return this.shouldDeliverStatusUpdate(input.provider);
    },

    shouldDeliverProgress(provider) {
      return shouldDeliverCallbackProgress(provider);
    },

    runStatusPresentation(input) {
      return createRunStatusPresentation({
        runId: input.runId,
        state: input.state,
        ...(input.message ? { message: input.message } : {}),
        ...(input.nextAction ? { nextAction: input.nextAction } : {}),
        ...(input.detailVisibility ? { detailVisibility: input.detailVisibility } : {})
      });
    },

    acknowledgementPresentation(input) {
      return this.runStatusPresentation({
        runId: input.runId,
        state: "received",
        detailVisibility: "source_thread"
      });
    },

    progressPresentation(input) {
      return this.runStatusPresentation({
        runId: input.runId,
        state: "running",
        message: input.message,
        detailVisibility: "audit"
      });
    },

    finalPresentation(input) {
      return createFinalSummaryPresentation({
        result: input.result,
        ...(input.receiptContext ? { receiptContext: input.receiptContext } : {}),
        ...(input.runId ? { auditRunId: input.runId } : {})
      });
    },

    render(input) {
      if (input.presentation.kind === "run_status") {
        return renderRunStatus(input.provider, input.presentation);
      }
      if (input.presentation.kind === "final_summary") {
        return renderFinalSummary(input.provider, input.presentation, {
          ...(input.larkRenderLocale ? { larkRenderLocale: input.larkRenderLocale } : {})
        });
      }
      if (input.presentation.kind === "doctor_summary") {
        return renderDoctorSummary(input.provider, input.presentation);
      }
      if (input.presentation.kind === "source_thread_status") {
        return renderSourceThreadStatus(input.provider, input.presentation);
      }
      if (input.presentation.kind === "action_receipt") {
        return renderActionReceipt(input.provider, input.presentation, {
          ...(input.larkRenderLocale ? { larkRenderLocale: input.larkRenderLocale } : {})
        });
      }
      return {
        body: renderOpenTagPresentationPlainText(input.presentation)
      };
    },

    acknowledgement(input) {
      return this.render({ provider: input.provider, presentation: this.acknowledgementPresentation({ runId: input.runId }) }).body;
    },

    runStatus(input) {
      return this.render({
        provider: input.provider,
        ...(input.larkRenderLocale ? { larkRenderLocale: input.larkRenderLocale } : {}),
        presentation: this.runStatusPresentation({
          runId: input.runId,
          state: input.state,
          ...(input.message ? { message: input.message } : {}),
          ...(input.nextAction ? { nextAction: input.nextAction } : {}),
          ...(input.detailVisibility ? { detailVisibility: input.detailVisibility } : {})
        })
      });
    },

    progress(input) {
      return this.runStatus({
        provider: input.provider,
        runId: input.runId,
        state: "running",
        message: input.message,
        detailVisibility: "audit"
      }).body;
    },

    final(input) {
      return this.render({
        provider: input.provider,
        ...(input.larkRenderLocale ? { larkRenderLocale: input.larkRenderLocale } : {}),
        presentation: this.finalPresentation({
          result: input.result,
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.receiptContext ? { receiptContext: input.receiptContext } : {})
        })
      });
    }
  };
}
