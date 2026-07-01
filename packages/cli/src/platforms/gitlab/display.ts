import { DEFAULT_GITLAB_WEBHOOK_PORT } from "../ports.js";

export function gitlabLocalWebhookUrl(input: { port?: number | undefined; webhookPath?: string | undefined }): string {
  return `http://127.0.0.1:${input.port ?? DEFAULT_GITLAB_WEBHOOK_PORT}${input.webhookPath ?? "/gitlab/webhooks"}`;
}

export function gitlabPublicWebhookUrlPlaceholder(webhookPath = "/gitlab/webhooks"): string {
  return `https://<your-tunnel-host>${webhookPath}`;
}

export function gitlabProjectWebhooksSettingsUrl(input: { projectPathWithNamespace: string }): string {
  const trimmed = input.projectPathWithNamespace.replace(/^\/+|\/+$/g, "");
  return `https://gitlab.com/${trimmed}/-/hooks`;
}

export function gitlabPersonalAccessTokensSettingsUrl(): string {
  return "https://gitlab.com/-/user_settings/personal_access_tokens";
}
