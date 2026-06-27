import { DEFAULT_GITHUB_WEBHOOK_PORT } from "../ports.js";

export function githubLocalWebhookUrl(input: { port?: number | undefined; webhookPath?: string | undefined }): string {
  return `http://127.0.0.1:${input.port ?? DEFAULT_GITHUB_WEBHOOK_PORT}${input.webhookPath ?? "/github/webhooks"}`;
}

export function githubPublicWebhookUrlPlaceholder(webhookPath = "/github/webhooks"): string {
  return `https://<your-tunnel-host>${webhookPath}`;
}

export function githubWebhooksSettingsUrl(input: { owner: string; repo: string }): string {
  return `https://github.com/${input.owner}/${input.repo}/settings/hooks`;
}
