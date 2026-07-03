import { DEFAULT_DISPATCHER_PORT } from "../ports.js";

export function discordLocalInteractionsUrl(input: { webhookPath?: string | undefined; dispatcherPort?: number | undefined } = {}): string {
  return `http://127.0.0.1:${input.dispatcherPort ?? DEFAULT_DISPATCHER_PORT}${input.webhookPath ?? "/discord/interactions"}`;
}

export function discordPublicInteractionsUrlPlaceholder(webhookPath = "/discord/interactions"): string {
  return `https://<your-tunnel-host>${webhookPath}`;
}
