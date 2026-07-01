import {
  createDoctorSummaryPresentation,
  createSourceThreadStatusPresentation,
  parseProjectTargetRef,
  renderOpenTagPresentationPlainText,
  type OpenTagDoctorSummaryPresentation,
  type OpenTagEvent,
  type OpenTagSourceThreadStatusPresentation
} from "@opentag/core";
import type { CreateRunResult } from "@opentag/client";
import { type LarkChannelBinding, normalizeLarkMessage, stripLarkMention } from "./normalize.js";
import { createLarkDoctorSummaryCard, createLarkSourceThreadStatusCard, type LarkCard } from "./render.js";

export type LarkMention = { key?: string; id?: { open_id?: string }; name?: string };

// Flattened `im.message.receive_v1` payload as delivered by the SDK EventDispatcher (header fields + message/sender on the top level). All optional (external input).
export type LarkInboundMessageEvent = {
  event_id?: string;
  event_type?: string;
  create_time?: string;
  tenant_key?: string;
  app_id?: string;
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
    tenant_key?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: LarkMention[];
  };
};

export type LarkMessageHandlerConfig = {
  agentId: string;
  botOpenId?: string;
  callbackUri?: string;
  defaultRepoBinding?: { repoProvider: string; owner: string; repo: string };
  resolveChannelBinding(input: { tenantKey: string; chatId: string }): Promise<LarkChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<CreateRunResult>;
  // Self-service binding from within Lark (`/bind owner/repo`); optional so tests can omit it.
  bindChannel?(input: { tenantKey: string; chatId: string; repoProvider: string; owner: string; repo: string }): Promise<void>;
  // Explicit self-service unbinding; callers should keep any admin checks at the hosting boundary.
  unbindChannel?(input: { tenantKey: string; chatId: string }): Promise<void>;
  canManageBinding?(input: LarkBindingManagementContext): Promise<boolean> | boolean;
  // Explicit cancellation from within Lark. No runId means cancel the active run for this chat's Project Target.
  stopRun?(input: { tenantKey: string; chatId: string; runId?: string; requestedBy: string }): Promise<LarkStopRunResult>;
  // Optional redacted status/doctor renderers for hosting apps that can inspect richer runtime state.
  status?(input: LarkSelfServiceContext): Promise<LarkSelfServiceReply | string>;
  doctor?(input: LarkSelfServiceContext): Promise<LarkSelfServiceReply | string>;
  // Reply into the originating thread (onboarding hints, bind confirmations); optional.
  reply?(input: { messageId: string; text: string; card?: LarkCard }): Promise<void>;
  // OpenTag dispatcher callbacks can acknowledge accepted runs through provider-native receipts.
  // When that lifecycle callback is enabled, avoid also posting the legacy ingress text acknowledgement.
  suppressRunCreatedReply?: boolean;
  now?(): number;
};

export type LarkSelfServiceReply = {
  text: string;
  card?: LarkCard;
};

export type LarkSelfServiceContext = {
  tenantKey: string;
  chatId: string;
  messageId: string;
  binding: LarkChannelBinding | null;
};

export type LarkBindingManagementContext = {
  action: "bind" | "unbind";
  tenantKey: string;
  chatId: string;
  chatType: string;
  senderOpenId: string;
  senderUserId?: string;
  senderUnionId?: string;
  messageId: string;
  eventId: string;
};

export type LarkStopRunResult =
  | { outcome: "cancelled"; runId: string }
  | { outcome: "not_found"; runId?: string }
  | { outcome: "already_terminal"; runId: string };

export type LarkMessageHandlerOutcome = {
  status:
    | "created"
    | "bound"
    | "unbound"
    | "self_service_help"
    | "self_service_status"
    | "self_service_doctor"
    | "self_service_stop"
    | "self_service_stop_unavailable"
    | "ignored_non_text"
    | "ignored_invalid_payload"
    | "ignored_group_requires_bot_open_id"
    | "ignored_not_addressed"
    | "ignored_bind_usage"
    | "ignored_bind_unavailable"
    | "ignored_bind_unauthorized"
    | "ignored_unbind_usage"
    | "ignored_unbind_unavailable"
    | "ignored_unbind_unauthorized"
    | "ignored_unbound_chat"
    | "ignored_empty_command"
    | "follow_up_queued"
    | "needs_human_decision";
  runId?: string;
  followUpRequestId?: string;
  reason?: string;
  tenantKey?: string;
  chatId?: string;
};

const BIND_USAGE =
  "Usage: /bind <owner>/<repo> — e.g. /bind amplifthq/opentag (or /bind github:amplifthq/opentag).";
const UNBIND_USAGE =
  "Usage: /unbind confirm — disconnects this chat from its current Project Target. This does not remove local checkout allowlists or repository bindings.";
const UNBOUND_HINT =
  "This chat isn't connected to a Project Target yet. @-mention me with `/bind <owner>/<repo>` to connect it — e.g. /bind amplifthq/opentag.";
const HELP_TEXT = [
  "OpenTag commands:",
  "- /bind <owner>/<repo> or /bind <provider>:<owner>/<repo> connects this chat to a Project Target.",
  "- /unbind confirm disconnects this chat from its current Project Target; it never deletes local checkout config.",
  "- /status shows the current Project Target, active-run guidance, queued follow-ups, and the next safe action.",
  "- /doctor shows a redacted readiness summary for this source container.",
  "- /stop [run_id] requests cancellation for the active chat run or the specified run; this connector will not treat stop as a successful completion.",
  "Project Targets never use absolute local paths. Keep local checkout paths in runner config and allowlists.",
  "Group chats must @-mention the bot before commands or runs."
].join("\n");
const STOP_UNAVAILABLE_TEXT = [
  "Run cancellation from this Lark ingress is not configured.",
  "OpenTag will not treat a stop request as a successful completion. Use `opentag status --run <run_id>` for audit detail, or `opentag service stop` if you need to stop the local background service."
].join("\n");
const BINDING_AUTH_DENIED_TEXT =
  "Only an authorized Lark binding manager can change this chat's Project Target. Ask an admin to run the command or update local OpenTag channel bindings.";

type DefaultRepoBinding = NonNullable<LarkMessageHandlerConfig["defaultRepoBinding"]>;

function bindingFromDefault(input: { tenantKey: string; chatId: string; binding: DefaultRepoBinding }): LarkChannelBinding {
  return {
    tenantKey: input.tenantKey,
    chatId: input.chatId,
    repoProvider: input.binding.repoProvider,
    owner: input.binding.owner,
    repo: input.binding.repo
  };
}

function shouldMigrateLegacyLocalBinding(input: {
  existing: LarkChannelBinding;
  defaultBinding: DefaultRepoBinding;
}): boolean {
  return (
    input.defaultBinding.repoProvider === "local" &&
    input.defaultBinding.owner.startsWith("path_") &&
    input.existing.repoProvider === "local" &&
    input.existing.owner === "local" &&
    input.existing.repo === input.defaultBinding.repo
  );
}

function extractText(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function mentionsBot(mentions: LarkMention[] | undefined, botOpenId: string): boolean {
  return (mentions ?? []).some((mention) => mention.id?.open_id === botOpenId);
}

function formatProjectTarget(binding: LarkChannelBinding): string {
  return `${binding.repoProvider}:${binding.owner}/${binding.repo}`;
}

function normalizeSelfServiceReply(reply: LarkSelfServiceReply | string): LarkSelfServiceReply {
  return typeof reply === "string" ? { text: reply } : reply;
}

function parseSelfServiceCommand(command: string): "help" | "status" | "doctor" | null {
  const trimmed = command.trim();
  if (/^\/help(\s|$)/.test(trimmed)) return "help";
  if (/^\/status(\s|$)/.test(trimmed)) return "status";
  if (/^\/doctor(\s|$)/.test(trimmed)) return "doctor";
  return null;
}

function statusPresentation(input: {
  tenantKey: string;
  chatId: string;
  binding: LarkChannelBinding | null;
}): OpenTagSourceThreadStatusPresentation {
  if (!input.binding) {
    return createSourceThreadStatusPresentation({
      title: "OpenTag status:",
      sourceContainer: `lark:${input.tenantKey}/${input.chatId}`,
      bindingState: "unbound",
      nextAction: UNBOUND_HINT,
      detailHint: "active run and queued follow-up status are unavailable until this chat is bound."
    });
  }
  return createSourceThreadStatusPresentation({
    title: "OpenTag status:",
    sourceContainer: `lark:${input.tenantKey}/${input.chatId}`,
    projectTarget: formatProjectTarget(input.binding),
    bindingState: "bound",
    nextAction: "send a follow-up in this thread, or check `opentag status --run <run_id>` locally for audit detail.",
    stopHint: "cancellation is explicit and is not reported as successful completion; timeout policy is surfaced in status/audit.",
    detailHint: "at most one run is active per Project Target + source thread; new same-thread requests queue behind it."
  });
}

function statusReply(input: { tenantKey: string; chatId: string; binding: LarkChannelBinding | null }): LarkSelfServiceReply {
  const presentation = statusPresentation(input);
  return {
    text: renderOpenTagPresentationPlainText(presentation),
    card: createLarkSourceThreadStatusCard(presentation)
  };
}

function doctorPresentation(input: {
  tenantKey: string;
  chatId: string;
  binding: LarkChannelBinding | null;
}): OpenTagDoctorSummaryPresentation {
  return createDoctorSummaryPresentation({
    title: "OpenTag doctor (redacted):",
    checks: [
      { status: "ok", name: "Source container", message: `lark:${input.tenantKey}/${input.chatId}` },
      {
        status: input.binding ? "ok" : "warn",
        name: "Project Target",
        message: input.binding ? formatProjectTarget(input.binding) : "not bound"
      },
      { status: "ok", name: "Secrets", message: "redacted. Use env/file/keychain SecretRef entries in local config instead of sharing secrets in chat." },
      {
        status: "warn",
        name: "Runtime readiness",
        message: "check `opentag service status` locally; launchd running is not the same as connector ready."
      },
      { status: "ok", name: "Source-thread output", message: "concise final replies by default; detailed process stays in audit/status." }
    ]
  });
}

function doctorReply(input: { tenantKey: string; chatId: string; binding: LarkChannelBinding | null }): LarkSelfServiceReply {
  const presentation = doctorPresentation(input);
  return {
    text: renderOpenTagPresentationPlainText(presentation),
    card: createLarkDoctorSummaryCard(presentation)
  };
}

function formatFollowUpQueuedText(input: { activeRunId?: string; followUpRequestId: string; reason?: string }): string {
  return [
    "Queued as a follow-up.",
    input.activeRunId ? `- Active run: ${input.activeRunId}` : "- Active run: currently in this source thread.",
    `- Follow-up request: ${input.followUpRequestId}`,
    input.reason ? `- Reason: ${input.reason}` : "- Reason: another run is already active for this thread.",
    "- Next action: wait for the active run final reply, or inspect locally with `opentag status --run <run_id>`.",
    "- Stop/timeout: cancellation is explicit and will not be treated as successful completion; timeout details are recorded in audit/status."
  ].join("\n");
}

function formatRunReceivedText(runId: string): string {
  return [
    `Received. Run: ${runId}.`,
    "- Use `/status` in this chat for active-run and queue state.",
    `- Use \`opentag status --run ${runId}\` locally for audit detail.`
  ].join("\n");
}

function parseStopCommand(command: string): { runId?: string } | null {
  const match = command.trim().match(/^\/stop(?:\s+(\S+))?\s*$/);
  if (!match) return null;
  return match[1] ? { runId: match[1] } : {};
}

function formatStopResultText(result: LarkStopRunResult): string {
  if (result.outcome === "cancelled") {
    return [
      `Cancellation requested for run ${result.runId}.`,
      "- OpenTag will not treat this stop request as a successful completion.",
      "- The local executor may need a moment to observe the cancellation; further nonessential completion writes are suppressed."
    ].join("\n");
  }
  if (result.outcome === "already_terminal") {
    return `Run ${result.runId} is already finished. OpenTag will not change its final result.`;
  }
  return result.runId
    ? `Run ${result.runId} was not found or is no longer cancelable.`
    : "No active run was found for this chat and Project Target.";
}

// Parse `/bind owner/repo` (or `/bind provider:owner/repo`). null = not a bind command; {ok:false} = malformed.
function parseBindCommand(
  command: string
): { ok: true; repoProvider: string; owner: string; repo: string } | { ok: false } | null {
  if (!/^\/bind(\s|$)/.test(command)) return null;
  const match = command.match(/^\/bind\s+(\S+)\s*$/);
  if (!match) return { ok: false };
  try {
    const ref = parseProjectTargetRef(match[1] as string);
    return { ok: true, repoProvider: ref.provider, owner: ref.owner, repo: ref.repo };
  } catch {
    return { ok: false };
  }
}

function parseUnbindCommand(command: string): { ok: true } | { ok: false } | null {
  if (!/^\/unbind(\s|$)/.test(command)) return null;
  return /^\/unbind\s+confirm\s*$/.test(command) ? { ok: true } : { ok: false };
}

async function canManageLarkBinding(
  config: LarkMessageHandlerConfig,
  context: LarkBindingManagementContext
): Promise<boolean> {
  if (config.canManageBinding) return config.canManageBinding(context);
  return context.chatType === "p2p";
}

// Handle one inbound Lark message: group messages must @-mention the bot, then handle /bind, resolve binding, normalize, create a run.
export function createLarkMessageHandler(config: LarkMessageHandlerConfig) {
  return async function handleLarkMessage(data: LarkInboundMessageEvent): Promise<LarkMessageHandlerOutcome> {
    const message = data.message;
    if (!message || message.message_type !== "text") {
      return { status: "ignored_non_text" };
    }

    const tenantKey = data.tenant_key ?? data.sender?.tenant_key;
    const chatId = message.chat_id;
    const messageId = message.message_id;
    const eventId = data.event_id;
    const senderOpenId = data.sender?.sender_id?.open_id;
    if (!tenantKey || !chatId || !messageId || !eventId || !senderOpenId) {
      return { status: "ignored_invalid_payload" };
    }

    // Group messages must @-mention the bot before triggering a (write-capable) run; p2p is exempt.
    const chatType = message.chat_type ?? "group";
    const isDirect = chatType === "p2p";
    if (!isDirect) {
      if (!config.botOpenId) {
        return { status: "ignored_group_requires_bot_open_id", tenantKey, chatId };
      }
      if (!mentionsBot(message.mentions, config.botOpenId)) {
        return { status: "ignored_not_addressed", tenantKey, chatId };
      }
    }

    const command = stripLarkMention(extractText(message.content));

    // Self-service binding: connect this chat to a Project Target without leaving Lark.
    const bindRequest = parseBindCommand(command);
    if (bindRequest && !config.bindChannel) {
      return { status: "ignored_bind_unavailable", tenantKey, chatId };
    }
    if (bindRequest && config.bindChannel) {
      if (!bindRequest.ok) {
        await config.reply?.({ messageId, text: BIND_USAGE });
        return { status: "ignored_bind_usage", tenantKey, chatId };
      }
      const authorized = await canManageLarkBinding(config, {
        action: "bind",
        tenantKey,
        chatId,
        chatType,
        senderOpenId,
        ...(data.sender?.sender_id?.user_id ? { senderUserId: data.sender.sender_id.user_id } : {}),
        ...(data.sender?.sender_id?.union_id ? { senderUnionId: data.sender.sender_id.union_id } : {}),
        messageId,
        eventId
      });
      if (!authorized) {
        await config.reply?.({ messageId, text: BINDING_AUTH_DENIED_TEXT });
        return { status: "ignored_bind_unauthorized", tenantKey, chatId };
      }
      await config.bindChannel({
        tenantKey,
        chatId,
        repoProvider: bindRequest.repoProvider,
        owner: bindRequest.owner,
        repo: bindRequest.repo
      });
      await config.reply?.({
        messageId,
        text: `Connected this chat to Project Target ${bindRequest.repoProvider}:${bindRequest.owner}/${bindRequest.repo}. @-mention me with a task to start a run.`
      });
      return { status: "bound", tenantKey, chatId };
    }

    const unbindRequest = parseUnbindCommand(command);
    if (unbindRequest && !config.unbindChannel) {
      return { status: "ignored_unbind_unavailable", tenantKey, chatId };
    }
    if (unbindRequest && config.unbindChannel) {
      if (!unbindRequest.ok) {
        await config.reply?.({ messageId, text: UNBIND_USAGE });
        return { status: "ignored_unbind_usage", tenantKey, chatId };
      }
      const authorized = await canManageLarkBinding(config, {
        action: "unbind",
        tenantKey,
        chatId,
        chatType,
        senderOpenId,
        ...(data.sender?.sender_id?.user_id ? { senderUserId: data.sender.sender_id.user_id } : {}),
        ...(data.sender?.sender_id?.union_id ? { senderUnionId: data.sender.sender_id.union_id } : {}),
        messageId,
        eventId
      });
      if (!authorized) {
        await config.reply?.({ messageId, text: BINDING_AUTH_DENIED_TEXT });
        return { status: "ignored_unbind_unauthorized", tenantKey, chatId };
      }
      const binding = await config.resolveChannelBinding({ tenantKey, chatId });
      if (!binding) {
        await config.reply?.({ messageId, text: UNBOUND_HINT });
        return { status: "ignored_unbound_chat", tenantKey, chatId };
      }
      await config.unbindChannel({ tenantKey, chatId });
      await config.reply?.({
        messageId,
        text: `Disconnected this chat from Project Target ${formatProjectTarget(binding)}. @-mention me with \`/bind <owner>/<repo>\` to connect a new target.`
      });
      return { status: "unbound", tenantKey, chatId };
    }

    if (command.trim().length === 0) {
      return { status: "ignored_empty_command", tenantKey, chatId };
    }

    const stopRequest = parseStopCommand(command);
    if (stopRequest) {
      if (!config.stopRun) {
        await config.reply?.({ messageId, text: STOP_UNAVAILABLE_TEXT });
        return { status: "self_service_stop_unavailable", tenantKey, chatId };
      }
      const result = await config.stopRun({
        tenantKey,
        chatId,
        ...(stopRequest.runId ? { runId: stopRequest.runId } : {}),
        requestedBy: `lark:${senderOpenId}`
      });
      await config.reply?.({ messageId, text: formatStopResultText(result) });
      return { status: "self_service_stop", ...(result.runId ? { runId: result.runId } : {}), tenantKey, chatId };
    }

    const selfServiceCommand = parseSelfServiceCommand(command);
    if (selfServiceCommand === "help") {
      await config.reply?.({ messageId, text: HELP_TEXT });
      return { status: "self_service_help", tenantKey, chatId };
    }
    if (selfServiceCommand === "status" || selfServiceCommand === "doctor") {
      const binding = await config.resolveChannelBinding({ tenantKey, chatId });
      const context: LarkSelfServiceContext = { tenantKey, chatId, messageId, binding };
      const reply =
        selfServiceCommand === "status"
          ? normalizeSelfServiceReply(await (config.status?.(context) ?? Promise.resolve(statusReply({ tenantKey, chatId, binding }))))
          : normalizeSelfServiceReply(await (config.doctor?.(context) ?? Promise.resolve(doctorReply({ tenantKey, chatId, binding }))));
      await config.reply?.({ messageId, text: reply.text, ...(reply.card ? { card: reply.card } : {}) });
      return { status: selfServiceCommand === "status" ? "self_service_status" : "self_service_doctor", tenantKey, chatId };
    }

    let binding = await config.resolveChannelBinding({ tenantKey, chatId });
    if (binding && config.defaultRepoBinding && config.bindChannel) {
      if (shouldMigrateLegacyLocalBinding({ existing: binding, defaultBinding: config.defaultRepoBinding })) {
        await config.bindChannel({
          tenantKey,
          chatId,
          repoProvider: config.defaultRepoBinding.repoProvider,
          owner: config.defaultRepoBinding.owner,
          repo: config.defaultRepoBinding.repo
        });
        binding = bindingFromDefault({ tenantKey, chatId, binding: config.defaultRepoBinding });
      }
    }
    if (!binding) {
      if (config.defaultRepoBinding && config.bindChannel) {
        await config.bindChannel({
          tenantKey,
          chatId,
          repoProvider: config.defaultRepoBinding.repoProvider,
          owner: config.defaultRepoBinding.owner,
          repo: config.defaultRepoBinding.repo
        });
        binding = bindingFromDefault({ tenantKey, chatId, binding: config.defaultRepoBinding });
      } else {
        await config.reply?.({ messageId, text: UNBOUND_HINT });
        return { status: "ignored_unbound_chat", tenantKey, chatId };
      }
    }

    const parsedTime = data.create_time ? Number(data.create_time) : Number.NaN;
    const eventTimeMs = Number.isFinite(parsedTime) ? parsedTime : (config.now?.() ?? Date.now());

    const event = normalizeLarkMessage({
      tenantKey,
      chatId,
      chatType: message.chat_type ?? "group",
      senderOpenId,
      text: extractText(message.content),
      messageId,
      ...(message.root_id ? { rootId: message.root_id } : {}),
      eventId,
      eventTimeMs,
      agentId: config.agentId,
      ...(config.botOpenId ? { botOpenId: config.botOpenId } : {}),
      ...(config.callbackUri ? { callbackUri: config.callbackUri } : {}),
      binding
    });
    if (!event) {
      return { status: "ignored_empty_command" };
    }

    const result = await config.createRun(event);
    if (result.outcome === "run_created") {
      if (!result.idempotentReplay && !config.suppressRunCreatedReply) {
        await config.reply?.({ messageId, text: formatRunReceivedText(result.run.id) });
      }
      return { status: "created", runId: result.run.id, tenantKey, chatId };
    }
    if (result.outcome === "follow_up_queued") {
      await config.reply?.({
        messageId,
        text: formatFollowUpQueuedText({
          followUpRequestId: result.followUpRequest.id,
          ...(result.decision.activeRunId ? { activeRunId: result.decision.activeRunId } : {}),
          reason: result.decision.reason
        })
      });
      return {
        status: "follow_up_queued",
        followUpRequestId: result.followUpRequest.id,
        ...(result.decision.activeRunId ? { runId: result.decision.activeRunId } : {}),
        reason: result.decision.reason,
        tenantKey,
        chatId
      };
    }
    return {
      status: "needs_human_decision",
      reason: result.decision.reason,
      tenantKey,
      chatId
    };
  };
}
