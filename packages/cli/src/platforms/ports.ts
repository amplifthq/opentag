export const DEFAULT_SLACK_EVENTS_PORT = 3040;
export const DEFAULT_GITHUB_WEBHOOK_PORT = 3050;
export const DEFAULT_GITLAB_WEBHOOK_PORT = 3060;
export const DEFAULT_LINEAR_WEBHOOK_PORT = 3070;
export const DEFAULT_DISPATCHER_PORT = 3030;

export function parseLocalPort(value: string | number, label: string): number {
  const port = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }
  return port;
}
