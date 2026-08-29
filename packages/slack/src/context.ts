import type { OpenTagReplyTargetRef } from "@opentag/core";

type SlackHistoryMessage = { ts?: unknown; thread_ts?: unknown; text?: unknown; files?: unknown };
type SlackHistoryPage = { ok?: unknown; messages?: unknown;
  response_metadata?: { next_cursor?: unknown } };

function sanitize(message: SlackHistoryMessage) {
  return { ts: message.ts,
    ...(typeof message.text === "string" ? { text: message.text } : {}),
    ...(Array.isArray(message.files) ? { attachments: message.files.map((file) => {
      const value = file && typeof file === "object" ? file as Record<string, unknown> : {};
      return { ...(typeof value.id === "string" ? { id: value.id } : {}),
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(typeof value.mimetype === "string" ? { mediaType: value.mimetype } : {}) };
    }) } : {}) };
}

export async function readSlackThreadContext(input: {
  replyTarget: OpenTagReplyTargetRef; sourceMessageId: string;
  maxMessages: 20; maxDecodedBytes: 65536;
  resolveCredential(): Promise<string>; fetchImpl: typeof fetch;
}): Promise<{ messages: unknown[]; truncated: boolean; decodedBytes: number }> {
  const channelId = input.replyTarget.channel.id;
  const threadId = input.replyTarget.thread?.id;
  const separator = threadId?.indexOf(":") ?? -1;
  const threadTs = separator >= 0 ? threadId!.slice(separator + 1) : threadId;
  if (!channelId || !threadTs || !input.sourceMessageId) {
    return { messages: [], truncated: false, decodedBytes: 0 };
  }
  const token = await input.resolveCredential();
  const collected: SlackHistoryMessage[] = [];
  let cursor = ""; let foundTrigger = false; let pages = 0;
  do {
    const url = new URL("https://slack.com/api/conversations.replies");
    url.searchParams.set("channel", channelId); url.searchParams.set("ts", threadTs);
    url.searchParams.set("limit", "100"); if (cursor) url.searchParams.set("cursor", cursor);
    const response = await input.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as SlackHistoryPage;
    if (body.ok !== true || !Array.isArray(body.messages)) throw new Error("slack_context_unavailable");
    for (const message of body.messages as SlackHistoryMessage[]) {
      if (typeof message.ts !== "string"
        || (message.ts !== threadTs && message.thread_ts !== threadTs)) continue;
      collected.push(message);
      if (message.ts === input.sourceMessageId) { foundTrigger = true; break; }
    }
    cursor = typeof body.response_metadata?.next_cursor === "string"
      ? body.response_metadata.next_cursor : "";
    pages += 1;
  } while (!foundTrigger && cursor && pages < 10 && collected.length < 1_000);
  if (!foundTrigger) throw new Error("slack_context_trigger_not_found");
  const triggerIndex = collected.findIndex((message) => message.ts === input.sourceMessageId);
  const selected = collected.slice(Math.max(0, triggerIndex - input.maxMessages), triggerIndex + 1)
    .map(sanitize);
  const retained: unknown[] = []; let decodedBytes = 0;
  let truncated = triggerIndex >= input.maxMessages;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const candidate = selected[index]!;
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (decodedBytes + bytes > input.maxDecodedBytes) { truncated = true; continue; }
    retained.push(candidate); decodedBytes += bytes;
  }
  retained.reverse();
  return { messages: retained, truncated, decodedBytes };
}
