import { DEFAULT_LINEAR_WEBHOOK_PORT } from "../ports.js";

export function linearLocalWebhookUrl(input: { port?: number | undefined; webhookPath?: string | undefined }): string {
  return `http://127.0.0.1:${input.port ?? DEFAULT_LINEAR_WEBHOOK_PORT}${input.webhookPath ?? "/linear/webhooks"}`;
}

export function linearPublicWebhookUrlPlaceholder(webhookPath = "/linear/webhooks"): string {
  return `https://<your-tunnel-host>${webhookPath}`;
}

export function linearWebhookSettingsUrl(): string {
  return "https://linear.app/settings/api";
}

export function linearApiSettingsUrl(): string {
  return "https://linear.app/settings/api";
}
