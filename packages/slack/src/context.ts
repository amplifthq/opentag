import type { OpenTagReplyTargetRef } from "@opentag/core";

type SlackHistoryMessage = { ts?: unknown; thread_ts?: unknown; text?: unknown; files?: unknown };

export async function readSlackThreadContext(input: {
  replyTarget: OpenTagReplyTargetRef; maxMessages: 20; maxDecodedBytes: 65536;
  resolveCredential(): Promise<string>; fetchImpl: typeof fetch;
}): Promise<{ messages: unknown[]; truncated: boolean; decodedBytes: number }> {
  const channelId = input.replyTarget.channel.id;
  const threadId = input.replyTarget.thread?.id;
  const separator = threadId?.indexOf(":") ?? -1;
  const threadTs = separator >= 0 ? threadId!.slice(separator + 1) : threadId;
  if (!channelId || !threadTs) return { messages: [], truncated: false, decodedBytes: 0 };
  const token = await input.resolveCredential();
  const url = new URL("https://slack.com/api/conversations.replies");
  url.searchParams.set("channel", channelId); url.searchParams.set("ts", threadTs);
  url.searchParams.set("limit", String(input.maxMessages + 1));
  const response = await input.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json() as { ok?: unknown; messages?: unknown };
  if (body.ok !== true || !Array.isArray(body.messages)) throw new Error("slack_context_unavailable");
  const sameThread = (body.messages as SlackHistoryMessage[]).filter((message) =>
    typeof message.ts === "string" && (message.ts === threadTs || message.thread_ts === threadTs));
  const messages: unknown[] = []; let decodedBytes = 0;
  let truncated = sameThread.length > input.maxMessages;
  for (const message of sameThread.slice(0, input.maxMessages)) {
    const candidate = { ts: message.ts,
      ...(typeof message.text === "string" ? { text: message.text } : {}),
      ...(Array.isArray(message.files) ? { attachments: message.files.map((file) => {
        const value = file && typeof file === "object" ? file as Record<string, unknown> : {};
        return { ...(typeof value.id === "string" ? { id: value.id } : {}),
          ...(typeof value.name === "string" ? { name: value.name } : {}),
          ...(typeof value.mimetype === "string" ? { mediaType: value.mimetype } : {}) };
      }) } : {}) };
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (decodedBytes + bytes > input.maxDecodedBytes) { truncated = true; break; }
    messages.push(candidate); decodedBytes += bytes;
  }
  return { messages, truncated, decodedBytes };
}
