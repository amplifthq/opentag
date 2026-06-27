export function githubLocalWebhookUrl(input: { port?: number | undefined; webhookPath?: string | undefined }): string {
  return `http://localhost:${input.port ?? 3000}${input.webhookPath ?? "/github/webhooks"}`;
}

export function githubPublicWebhookUrlPlaceholder(webhookPath = "/github/webhooks"): string {
  return `https://<your-tunnel-host>${webhookPath}`;
}

export function githubWebhooksSettingsUrl(input: { owner: string; repo: string }): string {
  return `https://github.com/${input.owner}/${input.repo}/settings/hooks`;
}
