import { createHash } from "node:crypto";
import { OpenTagSourceDeletionEventSchema, type OpenTagChannelPresentationCommand,
  type OpenTagSourceIngressEvent, type SourceIngressNormalizationResult } from "@opentag/core";
import type { ProviderDeliveryResult } from "@opentag/delivery-contract";
import type { SourceAppDefinition, SourceAppInstallation } from "@opentag/source-app-runtime";
import { readSlackThreadContext } from "./context.js";
import { createSlackDeliveryAdapter, type SlackDeliveryOperation,
  type SlackDeliveryPresentation } from "./delivery-adapter.js";
import { verifySlackSignature, verifySlackTimestamp } from "./ingress.js";
import { normalizeSlackChannelMessage } from "./normalize.js";
import { createSlackActionReceiptBlocks, createSlackApprovalPromptBlocks,
  createSlackDoctorSummaryBlocks, createSlackFinalSummaryBlocks, createSlackRunStatusBlocks,
  createSlackSourceThreadStatusBlocks, renderSlackActionReceiptPresentation,
  renderSlackApprovalPrompt, renderSlackFinalSummaryPresentation,
  renderSlackRunStatusPresentation, type SlackBlock } from "./render.js";

type SlackNativeRequest = { operation: SlackDeliveryOperation; presentation: SlackDeliveryPresentation };
type VerifiedSlackInput = { payload: unknown; verifiedAt: string; evidenceDigest: string };
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export class SlackVerificationError extends Error {
  constructor(readonly kind: "missing_signature" | "stale_signature_timestamp"
    | "invalid_signature" | "malformed_payload") {
    super(kind); this.name = "SlackVerificationError";
  }
}

function render(command: OpenTagChannelPresentationCommand): SlackDeliveryPresentation {
  const presentation = command.presentation; let text: string; let blocks: SlackBlock[] | undefined;
  switch (presentation.kind) {
    case "approval_prompt": text = renderSlackApprovalPrompt(presentation); blocks = createSlackApprovalPromptBlocks(presentation); break;
    case "run_status": text = renderSlackRunStatusPresentation(presentation); blocks = createSlackRunStatusBlocks(presentation); break;
    case "final_summary": text = renderSlackFinalSummaryPresentation(presentation); blocks = createSlackFinalSummaryBlocks(presentation); break;
    case "doctor_summary": text = presentation.title; blocks = createSlackDoctorSummaryBlocks(presentation); break;
    case "source_thread_status": text = presentation.title; blocks = createSlackSourceThreadStatusBlocks(presentation); break;
    case "action_receipt": text = renderSlackActionReceiptPresentation(presentation); blocks = createSlackActionReceiptBlocks(presentation); break;
    default: text = "OpenTag update";
  }
  const certifiedBlocks = blocks?.filter((block) => block.type !== "actions");
  return { kind: "message", text, textFormat: "mrkdwn",
    ...(certifiedBlocks?.length ? { blocks: certifiedBlocks } : {}) };
}

function normalizeResult(payloadInput: unknown, botUserId: string,
  verified?: VerifiedSlackInput): SourceIngressNormalizationResult {
  const payload = payloadInput && typeof payloadInput === "object" ? payloadInput as Record<string, any> : null;
  if (!payload || payload.type !== "event_callback" || typeof payload.team_id !== "string"
    || typeof payload.event_id !== "string" || !payload.event || typeof payload.event !== "object") {
    return { kind: "malformed", code: "slack_event_envelope_malformed" };
  }
  const event = payload.event as Record<string, any>;
  if (event.type === "app_mention") {
    if (typeof event.user !== "string" || typeof event.text !== "string"
      || typeof event.ts !== "string" || typeof event.channel !== "string") {
      return { kind: "malformed", code: "slack_app_mention_malformed" };
    }
    const message = normalizeSlackChannelMessage({ teamId: payload.team_id, channelId: event.channel,
      userId: event.user, text: event.text, ts: event.ts,
      ...(typeof event.thread_ts === "string" ? { threadTs: event.thread_ts } : {}),
      eventId: payload.event_id, eventTime: typeof payload.event_time === "number" ? payload.event_time : 0,
      botUserId, binding: { teamId: payload.team_id, channelId: event.channel } });
    if (!message) return { kind: "malformed", code: "slack_app_mention_malformed" };
    const threadTs = event.thread_ts ?? event.ts;
    const thread = { provider: "slack", id: `${event.channel}:${threadTs}`, parentMessageId: threadTs };
    return { kind: "accepted", event: { ...message,
      source: { ...message.source, thread, messageId: event.ts },
      replyTarget: { ...message.replyTarget, thread } } };
  }
  const deletedTs = event.deleted_ts ?? event.previous_message?.ts;
  if (event.type === "message" && event.subtype === "message_deleted") {
    if (typeof event.channel !== "string" || typeof deletedTs !== "string") {
      return { kind: "malformed", code: "slack_deletion_malformed" };
    }
    if (!verified) return { kind: "malformed", code: "slack_deletion_unverified" };
    const verifiedAt = verified.verifiedAt;
    const threadRootTs = event.previous_message?.thread_ts ?? deletedTs;
    return { kind: "accepted", event: OpenTagSourceDeletionEventSchema.parse({ protocol: "opentag.channel.v1",
      eventId: payload.event_id, occurredAt: verifiedAt, trigger: "source_content_deleted",
      source: { provider: "slack", channel: { provider: "slack", workspace: payload.team_id, id: event.channel },
        thread: { provider: "slack", id: `${event.channel}:${threadRootTs}`, parentMessageId: threadRootTs },
        actor: { provider: "slack", id: typeof event.user === "string" ? event.user : "slack-system" },
        messageId: deletedTs, sourceVersionRef: `slack:${payload.team_id}:${event.channel}:${deletedTs}` },
      verification: { sourceDeliveryId: payload.event_id, verifiedAt,
        evidenceDigest: verified.evidenceDigest } }) };
  }
  return { kind: "unsupported" };
}

export function createSlackSourceApp(options: { installation: SourceAppInstallation;
  signingSecret: string; botUserId: string; resolveCredential(): Promise<string>;
  fetchImpl?: typeof fetch; clock?: () => number;
}): SourceAppDefinition<unknown, SlackDeliveryPresentation, SlackNativeRequest> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const adapter = createSlackDeliveryAdapter({ providerInstanceId: options.installation.appInstanceId,
    bindingDigest: options.installation.bindingDigest, providerPrincipalDigest: digest(options.botUserId),
    providerConfigGeneration: options.installation.credentialGeneration,
    providerConfigGenerationDigest: options.installation.credentialGenerationDigest,
    resolveCredential: async () => options.resolveCredential(), fetchImpl });
  const normalizePort = (input: unknown) => { const verified = input && typeof input === "object" && "payload" in input
    ? input as VerifiedSlackInput : undefined;
    return normalizeResult(verified?.payload ?? input, options.botUserId, verified); };
  return { appId: "slack", protocol: "opentag.channel.v1",
    capabilities: { threads: true, messageUpdate: true, reactions: true,
      interactiveActions: true, attachments: "metadata", authenticatedDeletion: true,
      stableSourceVersions: true }, installation: options.installation,
    ingress: {
      async verify(input) {
        const timestamp = input.headers.get("x-slack-request-timestamp");
        const signature = input.headers.get("x-slack-signature");
        const rawBody = new TextDecoder().decode(input.rawBody);
        if (!timestamp || !signature) throw new SlackVerificationError("missing_signature");
        if (!verifySlackTimestamp({ timestamp, nowMs: options.clock?.() ?? Date.now() })) {
          throw new SlackVerificationError("stale_signature_timestamp");
        }
        if (!verifySlackSignature({ signingSecret: options.signingSecret, timestamp, rawBody, signature })) {
          throw new SlackVerificationError("invalid_signature");
        }
        const contentType = input.headers.get("content-type") ?? "";
        let payload: unknown;
        try { payload = contentType.includes("application/x-www-form-urlencoded")
          ? JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "null")
          : JSON.parse(rawBody); }
        catch { throw new SlackVerificationError("malformed_payload"); }
        if (!payload || typeof payload !== "object") throw new SlackVerificationError("malformed_payload");
        return { payload, verifiedAt: input.receivedAt,
          evidenceDigest: digest(`v0:${timestamp}:${rawBody}`) } satisfies VerifiedSlackInput;
      },
      normalizeResult: normalizePort,
      normalize(input) { const result = normalizePort(input);
        return result.kind === "accepted" ? result.event : null; }
    },
    context: { readThread: (input) => readSlackThreadContext({ ...input,
      resolveCredential: options.resolveCredential, fetchImpl }) }, presentation: { render },
    delivery: {
      prepare(command) { const channelId = command.replyTarget.channel.id;
        if (!channelId) throw new Error("slack_reply_channel_missing");
        const id = command.replyTarget.thread?.id; const threadTs = id?.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
        return { operation: { kind: "create_message", channelId, ...(threadTs ? { threadTs } : {}) }, presentation: render(command) }; },
      deliver: ({ request, intent, signal }) => adapter.deliver({ ...request, intent,
        ...(signal ? { signal } : {}) }) as Promise<ProviderDeliveryResult>,
      async reconcile() { return { outcome: "outcome_unknown",
        evidenceDigest: digest("slack_reconciliation_requires_observation") } as ProviderDeliveryResult; }
    } };
}
