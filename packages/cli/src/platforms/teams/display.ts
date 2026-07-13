import { DEFAULT_DISPATCHER_PORT } from "../ports.js";

export function teamsLocalWebhookUrl(input: { webhookPath?: string | undefined; dispatcherPort?: number | undefined } = {}): string {
  return `http://127.0.0.1:${input.dispatcherPort ?? DEFAULT_DISPATCHER_PORT}${input.webhookPath ?? "/teams/messages"}`;
}

export function teamsPublicWebhookUrlPlaceholder(webhookPath = "/teams/messages"): string {
  return `https://<your-tunnel-host>${webhookPath}`;
}
