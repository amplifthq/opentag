import { createHash } from "node:crypto";
import { parseThreadActionCommand, readRequestTextWithLimit, RequestBodyTooLargeError, type OpenTagEvent } from "@opentag/core";
import { Hono } from "hono";
import { extractTeamsMessage, normalizeTeamsActivity, type TeamsChannelBinding } from "./normalize.js";
import { encodeTeamsThreadKey } from "./thread-key.js";
import type { TeamsAuthResult } from "./auth.js";

export type TeamsThreadActionInput = {
  id: string;
  rawText: string;
  actor: { provider: "teams"; providerUserId: string; handle: string };
  callback: { provider: "teams"; uri: string; threadKey: string };
  metadata: Record<string, unknown>;
};

export type TeamsWebhookAppInput = {
  authenticator: { verify(input: { authorizationHeader: string | undefined; bodyServiceUrl: string }): Promise<TeamsAuthResult> };
  webhookPath?: string;
  resolveChannelBinding(input: { tenantId: string; conversationId: string }): Promise<TeamsChannelBinding | null>;
  createRun(event: OpenTagEvent): Promise<{ runId?: string }>;
  submitThreadAction?(action: TeamsThreadActionInput): Promise<unknown>;
  /** Posts a plain notice back to a conversation (unbound / failure paths). */
  notifyConversation?(input: { serviceUrl: string; conversationId: string; text: string }): Promise<void>;
  onBackgroundError?(error: unknown): void;
  now(): string;
};

const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

function parseJsonPayload(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function actionId(activityId: string, rawBody: string): string {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex").slice(0, 12);
  return `approval_teams_${activityId}_${bodyHash}`;
}

export function createTeamsWebhookApp(input: TeamsWebhookAppInput) {
  const app = new Hono();
  const webhookPath = input.webhookPath ?? "/teams/messages";
  if (!webhookPath.startsWith("/")) {
    throw new Error("Teams webhook path must start with /.");
  }
  const reportBackgroundError =
    input.onBackgroundError ??
    ((error: unknown) => {
      console.error("Teams webhook background task failed:", error);
    });
  const safelyReport = (error: unknown) => {
    try {
      reportBackgroundError(error);
    } catch (reportError) {
      console.error("Teams webhook background error reporter failed:", reportError);
    }
  };

  app.post(webhookPath, async (c) => {
    let rawBody: string;
    try {
      rawBody = await readRequestTextWithLimit(c.req.raw, { maxBytes: MAX_WEBHOOK_BODY_BYTES });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return c.json({ error: "payload_too_large" }, 413);
      }
      throw error;
    }

    const payload = parseJsonPayload(rawBody);
    if (!payload) {
      return c.json({ error: "invalid_json" }, 400);
    }

    const bodyServiceUrl = typeof payload.serviceUrl === "string" ? payload.serviceUrl : "";
    const auth = await input.authenticator.verify({
      authorizationHeader: c.req.header("authorization"),
      bodyServiceUrl
    });
    if (!auth.ok) {
      return c.json({ error: "unauthorized", reason: auth.reason }, 401);
    }

    const message = extractTeamsMessage(payload);
    // Non-actionable activities (not a channel message / not addressed / no text)
    // are acknowledged with 200 so Bot Framework does not retry.
    if (!message || !message.text.trim()) {
      return c.body(null, 200);
    }

    const deferred = (work: () => Promise<void>, failureNotice: string) => {
      void Promise.resolve()
        .then(work)
        .catch((error) => {
          safelyReport(error);
          input
            .notifyConversation?.({ serviceUrl: message.serviceUrl, conversationId: message.conversationId, text: failureNotice })
            .catch(safelyReport);
        });
    };

    if (parseThreadActionCommand(message.text)) {
      const submitThreadAction = input.submitThreadAction;
      if (!submitThreadAction) {
        deferred(async () => {
          await input.notifyConversation?.({
            serviceUrl: message.serviceUrl,
            conversationId: message.conversationId,
            text: "Thread actions are not supported on this dispatcher."
          });
        }, "Sorry, that action couldn't be processed. Please try again.");
        return c.body(null, 200);
      }
      const action: TeamsThreadActionInput = {
        id: actionId(message.activityId, rawBody),
        rawText: message.text,
        actor: { provider: "teams", providerUserId: message.userId, handle: message.userName ?? message.userId },
        callback: {
          provider: "teams",
          uri: message.serviceUrl,
          threadKey: encodeTeamsThreadKey({
            serviceUrl: message.serviceUrl,
            conversationId: message.conversationId,
            activityId: message.activityId
          })
        },
        metadata: {
          repoProvider: "teams",
          tenantId: message.tenantId,
          conversationId: message.conversationId,
          ...(message.teamId ? { teamId: message.teamId } : {}),
          ...(message.channelId ? { channelId: message.channelId } : {})
        }
      };
      deferred(async () => {
        await submitThreadAction(action);
      }, "Sorry, that action couldn't be processed. Please try again.");
      return c.body(null, 200);
    }

    deferred(async () => {
      const binding = await input.resolveChannelBinding({ tenantId: message.tenantId, conversationId: message.conversationId });
      if (!binding) {
        await input.notifyConversation?.({
          serviceUrl: message.serviceUrl,
          conversationId: message.conversationId,
          text: "This channel is not bound to a repository. Bind it before mentioning OpenTag."
        });
        return;
      }
      const event = normalizeTeamsActivity({
        activityId: message.activityId,
        serviceUrl: message.serviceUrl,
        conversationId: message.conversationId,
        tenantId: message.tenantId,
        ...(message.teamId ? { teamId: message.teamId } : {}),
        ...(message.channelId ? { channelId: message.channelId } : {}),
        userId: message.userId,
        ...(message.userName ? { userName: message.userName } : {}),
        text: message.text,
        binding,
        receivedAt: input.now()
      });
      if (event) {
        await input.createRun(event);
      }
    }, "Sorry, OpenTag couldn't start this run. Please try again.");

    return c.body(null, 200);
  });

  return app;
}
