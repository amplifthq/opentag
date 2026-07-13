/** threadKey = `serviceUrl|conversationId|activityId`. Segments must not contain `|`.
 * Teams service URLs and conversation ids (e.g. `19:...@thread.tacv2;messageid=<root>`)
 * contain no `|`, so the split is unambiguous. */
export function encodeTeamsThreadKey(input: {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
}): string {
  return [input.serviceUrl, input.conversationId, input.activityId].join("|");
}

export function parseTeamsThreadKey(threadKey: string): {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
} {
  const parts = threadKey.split("|");
  if (parts.length !== 3 || !parts.every(Boolean)) {
    throw new Error(`Invalid Teams thread key: ${threadKey}`);
  }
  const [serviceUrl, conversationId, activityId] = parts as [string, string, string];
  return { serviceUrl, conversationId, activityId };
}
