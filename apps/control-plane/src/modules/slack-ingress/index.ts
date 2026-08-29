import { createHash } from "node:crypto";
import type { OpenTagSourceDeletionEvent, OpenTagSourceIngressEvent } from "@opentag/core";
import type { SourceAppDefinition, SourceThreadCommand,
  SourceThreadCommandAuthorityPorts } from "@opentag/source-app-runtime";
import { executeSourceThreadCommand } from "@opentag/source-app-runtime";
import type { RelayContentCustody } from "../source-content/index.js";
import type { SourceIngressService } from "../source-ingress/index.js";

type HttpResult = { status: number; body: unknown };
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function commandFromInteractivePayload(payload: unknown): SourceThreadCommand | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, any>;
  const action = Array.isArray(value.actions) ? value.actions[0] : null;
  const actorId = value.user?.id;
  if (!action || typeof action.action_id !== "string" || typeof actorId !== "string") return null;
  let detail: Record<string, unknown> = {};
  try { detail = typeof action.value === "string" ? JSON.parse(action.value) : {}; } catch { return null; }
  const commandId = typeof value.trigger_id === "string" ? value.trigger_id
    : `${action.action_id}:${typeof action.action_ts === "string" ? action.action_ts : "unknown"}`;
  const actor = { provider: "slack", id: actorId } as const;
  if (action.action_id === "opentag:status") return { type: "status", commandId, actor };
  if (action.action_id === "opentag:cancel" && typeof detail.reason === "string") {
    return { type: "cancel", commandId, actor, reason: detail.reason };
  }
  if ((action.action_id === "opentag:approve" || action.action_id.startsWith("opentag:permission:allow"))
    && typeof detail.actionId === "string") return { type: "approve", commandId, actor, requestId: detail.actionId };
  if ((action.action_id === "opentag:reject" || action.action_id === "opentag:permission:deny")
    && typeof detail.actionId === "string") return { type: "reject", commandId, actor, requestId: detail.actionId };
  if (action.action_id === "opentag:bind" && typeof detail.bindingDigest === "string") {
    return { type: "bind", commandId, actor, bindingDigest: detail.bindingDigest };
  }
  if (action.action_id === "opentag:unbind" && typeof detail.bindingDigest === "string") {
    return { type: "unbind", commandId, actor, bindingDigest: detail.bindingDigest };
  }
  return null;
}

export function createSlackIngress(input: {
  sourceApp: SourceAppDefinition<unknown, unknown, unknown>;
  organizationId: string; installationId: string; bindingId: string;
  sourceIngress: Pick<SourceIngressService, "reserve" | "findSourceIdentity">;
  sourceContent: Pick<RelayContentCustody, "withdraw">;
  clock: { now(): Date };
  commandAuthority?: SourceThreadCommandAuthorityPorts;
}) {
  async function verify(request: { rawBody: Uint8Array; headers: Headers; receivedAt: string }) {
    try { return await input.sourceApp.ingress.verify(request); }
    catch { return null; }
  }

  async function withdraw(event: OpenTagSourceDeletionEvent): Promise<HttpResult> {
    try {
      const original = await input.sourceIngress.findSourceIdentity({ organizationId: input.organizationId,
        installationId: input.installationId, sourceAppId: input.sourceApp.appId,
        sourceVersionRef: event.source.sourceVersionRef });
      if (!original) return { status: 404, body: { error: "source_content_unavailable" } };
      await input.sourceContent.withdraw({ schemaVersion: 1, kind: "verified_source_withdrawal",
        commandId: `slack_delete:${event.eventId}`, organizationId: input.organizationId,
        sourceVersionRef: event.source.sourceVersionRef,
        verification: { installationId: input.installationId, sourceAppId: input.sourceApp.appId,
          sourceDeliveryId: original.sourceDeliveryId,
          verifiedAt: event.verification.verifiedAt,
          evidenceDigest: event.verification.evidenceDigest } });
      return { status: 200, body: { ok: true, withdrawn: true } };
    } catch { return { status: 503, body: { error: "source_withdrawal_unavailable" } }; }
  }

  return {
    async receiveEvents(request: { rawBody: Uint8Array; headers: Headers; receivedAt: string }): Promise<HttpResult> {
      const trusted = await verify(request);
      if (!trusted) return { status: 401, body: { error: "invalid_slack_signature" } };
      const normalized = input.sourceApp.ingress.normalize(trusted);
      const payload = trusted && typeof trusted === "object" && "payload" in trusted
        ? (trusted as { payload: unknown }).payload : null;
      if (payload && typeof payload === "object" && (payload as Record<string, unknown>).type === "url_verification") {
        const challenge = (payload as Record<string, unknown>).challenge;
        return typeof challenge === "string" ? { status: 200, body: challenge }
          : { status: 400, body: { error: "invalid_challenge" } };
      }
      if (!normalized) return { status: 200, body: { ok: true, ignored: true } };
      if (normalized.trigger === "source_content_deleted") return withdraw(normalized);
      const event = normalized as Exclude<OpenTagSourceIngressEvent, OpenTagSourceDeletionEvent>;
      const threadId = event.source.thread?.id ?? event.eventId;
      const sourceVersionRef = `slack:${event.source.channel.workspace ?? "unknown"}:${event.source.channel.id}:${event.source.thread?.parentMessageId ?? threadId}`;
      const reservation = await input.sourceIngress.reserve({ organizationId: input.organizationId,
        installationId: input.installationId, bindingId: input.bindingId, sourceApp: input.sourceApp,
        sourceDeliveryId: event.eventId, sourceMessageId: event.source.thread?.parentMessageId ?? event.eventId,
        sourceVersionRef, rawDigest: digest(request.rawBody), normalizedContent: event,
        expiresAt: new Date(input.clock.now().getTime() + 7 * 86_400_000) });
      return reservation.mayAcknowledge
        ? { status: 200, body: { ok: true } }
        : { status: 503, body: { error: "source_ingress_unavailable" } };
    },

    async receiveInteractivity(request: { rawBody: Uint8Array; headers: Headers;
      receivedAt: string }): Promise<HttpResult> {
      const trusted = await verify(request);
      if (!trusted) return { status: 401, body: { error: "invalid_slack_signature" } };
      const payload = trusted && typeof trusted === "object" && "payload" in trusted
        ? (trusted as { payload: unknown }).payload : null;
      const command = commandFromInteractivePayload(payload);
      if (!command) return { status: 400, body: { error: "invalid_slack_action" } };
      const result = await executeSourceThreadCommand({ adapter: input.sourceApp,
        command, ...(input.commandAuthority ? { authority: input.commandAuthority } : {}) });
      return result.outcome === "completed" ? { status: 200, body: { ok: true } }
        : { status: 403, body: { error: result.outcome } };
    }
  };
}
