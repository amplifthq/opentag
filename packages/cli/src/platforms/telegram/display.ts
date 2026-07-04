import { DEFAULT_DISPATCHER_PORT } from "../ports.js";

export function telegramLocalWebhookUrl(input: { botId: string; dispatcherPort?: number | undefined }): string {
  return `http://127.0.0.1:${input.dispatcherPort ?? DEFAULT_DISPATCHER_PORT}/telegram/events/${encodeURIComponent(input.botId)}`;
}

export function telegramPublicWebhookUrlPlaceholder(input: { botId: string }): string {
  return `https://<your-tunnel-host>/telegram/events/${encodeURIComponent(input.botId)}`;
}

export function telegramSetWebhookUrl(input: { botToken: string; publicWebhookUrl: string; secretToken?: string | undefined }): string {
  const url = new URL(`https://api.telegram.org/bot${input.botToken}/setWebhook`);
  url.searchParams.set("url", input.publicWebhookUrl);
  if (input.secretToken) {
    url.searchParams.set("secret_token", input.secretToken);
  }
  return url.toString();
}
