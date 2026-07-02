import { DEFAULT_GITLAB_WEBHOOK_PORT } from "../ports.js";

function normalizedBaseUrl(baseUrl = "https://gitlab.com"): string {
  return baseUrl.replace(/\/+$/g, "");
}

export function gitlabLocalWebhookUrl(input: { port?: number | undefined; webhookPath?: string | undefined }): string {
  return `http://127.0.0.1:${input.port ?? DEFAULT_GITLAB_WEBHOOK_PORT}${input.webhookPath ?? "/gitlab/webhooks"}`;
}

export function gitlabPublicWebhookUrlPlaceholder(webhookPath = "/gitlab/webhooks"): string {
  return `https://<your-tunnel-host>${webhookPath}`;
}

export function gitlabProjectWebhooksSettingsUrl(input: { projectPathWithNamespace: string; baseUrl?: string }): string {
  const trimmed = input.projectPathWithNamespace.replace(/^\/+|\/+$/g, "");
  return `${normalizedBaseUrl(input.baseUrl)}/${trimmed}/-/hooks`;
}

export function gitlabPersonalAccessTokensSettingsUrl(baseUrl = "https://gitlab.com"): string {
  return `${normalizedBaseUrl(baseUrl)}/-/user_settings/personal_access_tokens`;
}
