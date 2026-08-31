import {
  createFinalSummaryPresentation,
  createRunStatusPresentation,
  OpenTagSourceThreadProjectionPresentationSchema,
  platformCapabilityForProvider,
  renderOpenTagPresentationPlainText,
  shouldDeliverProgressPresentation,
  shouldDeliverRunStatusPresentation,
  type ActionReceiptContext,
  type OpenTagActionReceiptPresentation,
  type OpenTagApprovalPromptPresentation,
  type OpenTagDoctorSummaryPresentation,
  type OpenTagFinalSummaryPresentation,
  type OpenTagPresentation,
  type OpenTagRunResult,
  type OpenTagRunStatusPresentation,
  type OpenTagSourceThreadProjectionPresentation,
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
  createLarkApprovalPromptCard,
  createLarkDoctorSummaryCard,
  createLarkFinalSummaryCard,
  createLarkRunStatusCard,
  createLarkSourceThreadStatusCard,
  renderLarkActionReceiptPresentation,
  renderLarkApprovalPrompt,
  renderLarkFinalSummaryPresentation,
  renderLarkRunStatusPresentation
} from "@opentag/lark";
import {
  renderAcknowledgement as renderLinearAcknowledgement,
  renderFinalSummaryPresentation as renderLinearFinalSummaryPresentation,
  renderProgress as renderLinearProgress
} from "@opentag/linear";
import {
  createSlackActionReceiptBlocks,
  createSlackApprovalPromptBlocks,
  createSlackDoctorSummaryBlocks,
  createSlackFinalSummaryBlocks,
  createSlackRunStatusBlocks,
  createSlackSourceThreadStatusBlocks,
  createSlackTeamRelayProjectionBlocks,
  markdownToSlackMrkdwn,
  renderSlackActionReceiptPresentation,
  renderSlackApprovalPrompt,
  renderSlackAcknowledgement,
  renderSlackFinalSummaryPresentation,
  renderSlackRunStatusPresentation,
  renderSlackTeamRelayProjection,
  type SlackBlock
} from "@opentag/slack";
import {
  createTelegramFinalSummaryReplyMarkup,
  createTelegramMessageRich,
  createTelegramRunStatusReplyMarkup,
  renderTelegramAcknowledgement,
  renderTelegramFinalSummaryPresentation,
  renderTelegramProgress
} from "@opentag/telegram";
export type LarkRenderLocale = "en-US" | "zh-CN";

export type PresentedProviderBody = { body: string; blocks?: SlackBlock[]; rich?: { provider: string; payload: unknown } };

type TeamRelayState = OpenTagSourceThreadProjectionPresentation["state"];
const TEAM_RELAY_COPY: Record<TeamRelayState, { title: string; summary: string;
  runOutcome: OpenTagSourceThreadProjectionPresentation["runOutcome"] }> = {
  waiting_for_runner: { title: "Waiting for your paired Runner",
    summary: "OpenTag will start automatically if the paired Runner becomes eligible before the claim deadline.", runOutcome: "pending" },
  assigned: { title: "Assigned", summary: "A paired Runner has claimed this Run.", runOutcome: "pending" },
  running: { title: "Running", summary: "The paired Runner has reported a current running receipt.", runOutcome: "pending" },
  waiting_for_approval: { title: "Waiting for approval", summary: "An exact current action needs approval before execution can continue.", runOutcome: "pending" },
  publication_pending: { title: "Publication approval required", summary: "The governed Candidate is ready, but publication has not been approved or observed.", runOutcome: "pending" },
  proposal_ready: { title: "Proposal ready", summary: "The governed proposal is complete. No publication is claimed.", runOutcome: "succeeded" },
  ready_for_review: { title: "Ready for review", summary: "The exact draft pull request publication was observed.", runOutcome: "succeeded" },
  failed: { title: "Failed", summary: "The Run failed under its completion contract.", runOutcome: "failed" },
  cancelled: { title: "Cancelled", summary: "The Run was cancelled and cannot be revived by this projection.", runOutcome: "cancelled" },
  interrupted: { title: "Interrupted", summary: "The Run was interrupted; unresolved effects remain governed separately.", runOutcome: "interrupted" },
  timed_out: { title: "Timed out", summary: "The Run reached its canonical deadline.", runOutcome: "timed_out" }
};

export function composeTeamRelayThreadProjection(input: {
  runId: string; generation: number; state: TeamRelayState;
  controls: OpenTagSourceThreadProjectionPresentation["controls"];
  providerDelivery?: { state: "pending" | "accepted" | "rejected" | "outcome_unknown" | "attention";
    reasonCode?: NonNullable<OpenTagSourceThreadProjectionPresentation["providerDelivery"]>["reasonCode"] };
}): OpenTagSourceThreadProjectionPresentation {
  const copy = TEAM_RELAY_COPY[input.state];
  const deliveryMessage = input.providerDelivery?.state === "outcome_unknown"
    ? "Slack status delivery outcome is unknown."
    : input.providerDelivery?.state === "attention" || input.providerDelivery?.state === "rejected"
      ? "Slack status delivery needs attention."
      : input.providerDelivery?.state === "pending" ? "Slack status delivery is pending."
        : input.providerDelivery?.state === "accepted" ? "Slack status delivery was accepted." : undefined;
  return OpenTagSourceThreadProjectionPresentationSchema.parse({
    kind: "source_thread_projection", runId: input.runId, generation: input.generation,
    state: input.state, ...copy, controls: input.controls,
    ...(input.providerDelivery && deliveryMessage ? { providerDelivery: {
      state: input.providerDelivery.state,
      ...(input.providerDelivery.reasonCode ? { reasonCode: input.providerDelivery.reasonCode } : {}),
      message: deliveryMessage
    } } : {})
  });
}

export type ProviderPresentation = {
  shouldDeliverAcknowledgement(provider: string): boolean;
  shouldDeliverStatusUpdate(provider: string): boolean;
  shouldDeliverRunStatusUpdate?(input: { provider: string; state: OpenTagRunStatusPresentation["state"] }): boolean;
  shouldDeliverProgress(provider: string): boolean;
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
  render(input: { provider: string; presentation: OpenTagPresentation; larkRenderLocale?: LarkRenderLocale }): PresentedProviderBody;
  acknowledgement(input: { provider: string; runId: string }): string;
  runStatus(input: {
    provider: string;
    runId: string;
    state: OpenTagRunStatusPresentation["state"];
    message?: string;
    nextAction?: string;
    detailVisibility?: OpenTagRunStatusPresentation["detailVisibility"];
    larkRenderLocale?: LarkRenderLocale;
  }): PresentedProviderBody;
  progress(input: { provider: string; runId: string; message: string }): string;
  final(input: {
    provider: string;
    result: OpenTagRunResult;
    runId?: string;
    receiptContext?: ActionReceiptContext;
    larkRenderLocale?: LarkRenderLocale;
  }): PresentedProviderBody;
};

function renderRunStatus(provider: string, presentation: OpenTagRunStatusPresentation): PresentedProviderBody {
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body: renderSlackRunStatusPresentation(presentation),
      blocks: createSlackRunStatusBlocks(presentation)
    };
  }
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
      return {
        body: renderTelegramAcknowledgement(presentation.runId),
        rich: createTelegramMessageRich({ replyMarkup: createTelegramRunStatusReplyMarkup(presentation.runId) })
      };
    }
    if (provider === "gitlab") {
      return { body: renderGitLabAcknowledgement(presentation.runId) };
    }
    if (provider === "linear") {
      return { body: renderLinearAcknowledgement(presentation.runId) };
    }
    return { body: renderAcknowledgement(presentation.runId) };
  }

  const message = presentation.message ?? presentation.nextAction ?? presentation.state;
  if (provider === "telegram") {
    return {
      body: renderTelegramProgress(message, { runId: presentation.runId }),
      rich: createTelegramMessageRich({ replyMarkup: createTelegramRunStatusReplyMarkup(presentation.runId) })
    };
  }
  if (provider === "gitlab") {
    return { body: renderGitLabProgress({ runId: presentation.runId, message }) };
  }
  if (provider === "linear") {
    return { body: renderLinearProgress({ runId: presentation.runId, message }) };
  }
  return { body: renderProgress({ runId: presentation.runId, message }) };
}

function supportsRichPresentation(provider: string): boolean {
  return platformCapabilityForProvider(provider)?.supportsRichPresentation === true;
}

function renderFinalSummary(provider: string, presentation: OpenTagFinalSummaryPresentation, options: { larkRenderLocale?: LarkRenderLocale } = {}): PresentedProviderBody {
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
    const replyMarkup = createTelegramFinalSummaryReplyMarkup(presentation);
    return {
      body: renderTelegramFinalSummaryPresentation(presentation),
      rich: createTelegramMessageRich({
        ...(replyMarkup ? { replyMarkup } : {})
      })
    };
  }
  if (provider === "gitlab") {
    return { body: renderGitLabFinalSummaryPresentation(presentation) };
  }
  if (provider === "linear") {
    return { body: renderLinearFinalSummaryPresentation(presentation) };
  }
  return { body: renderFinalSummaryPresentation(presentation) };
}

function renderDoctorSummary(provider: string, presentation: OpenTagDoctorSummaryPresentation): PresentedProviderBody {
  const body = renderOpenTagPresentationPlainText(presentation);
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body: markdownToSlackMrkdwn(body),
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

function renderSourceThreadStatus(provider: string, presentation: OpenTagSourceThreadStatusPresentation): PresentedProviderBody {
  const body = renderOpenTagPresentationPlainText(presentation);
  const canRenderRich = supportsRichPresentation(provider);
  if (canRenderRich && provider === "slack") {
    return {
      body: markdownToSlackMrkdwn(body),
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

function renderActionReceipt(provider: string, presentation: OpenTagActionReceiptPresentation, options: { larkRenderLocale?: LarkRenderLocale } = {}): PresentedProviderBody {
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

function renderApprovalPrompt(provider: string, presentation: OpenTagApprovalPromptPresentation): PresentedProviderBody {
  if (supportsRichPresentation(provider) && provider === "slack") {
    return { body: renderSlackApprovalPrompt(presentation), blocks: createSlackApprovalPromptBlocks(presentation) };
  }
  if (supportsRichPresentation(provider) && provider === "lark") {
    return {
      body: renderLarkApprovalPrompt(presentation),
      rich: { provider: "lark", payload: createLarkApprovalPromptCard(presentation) }
    };
  }
  return { body: renderOpenTagPresentationPlainText(presentation) };
}

export function createDefaultProviderPresentation(): ProviderPresentation {
  return {
    shouldDeliverAcknowledgement(provider) {
      return shouldDeliverRunStatusPresentation(provider);
    },

    shouldDeliverStatusUpdate(provider) {
      if (provider === "slack" || provider === "lark") return true;
      return shouldDeliverRunStatusPresentation(provider);
    },

    shouldDeliverRunStatusUpdate(input) {
      return this.shouldDeliverStatusUpdate(input.provider);
    },

    shouldDeliverProgress(provider) {
      return shouldDeliverProgressPresentation(provider);
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
      if (input.presentation.kind === "approval_prompt") {
        return renderApprovalPrompt(input.provider, input.presentation);
      }
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
      if (input.presentation.kind === "source_thread_projection") {
        if (input.provider === "slack") return {
          body: renderSlackTeamRelayProjection(input.presentation),
          blocks: createSlackTeamRelayProjectionBlocks(input.presentation)
        };
        return { body: renderOpenTagPresentationPlainText(input.presentation) };
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
