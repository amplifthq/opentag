type SecretContainer = Record<string, unknown>;

function asRecord(value: unknown): SecretContainer | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as SecretContainer) : undefined;
}

function getPath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record || !(segment in record)) return undefined;
    current = record[segment];
  }
  return current;
}

function formatSecretSource(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "disabled";
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    const sources = [...new Set(value.map(formatSecretSource))];
    return `${value.length} configured (${sources.join(", ")})`;
  }
  if (typeof value === "string") {
    const ref = value.match(/^\[(env|file|keychain):(.+)]$/);
    if (ref) return `${ref[1]} ref (${ref[2]})`;
    return "inline (redacted)";
  }
  return "configured (redacted)";
}

function hasPath(root: unknown, path: string[]): boolean {
  return getPath(root, path) !== undefined;
}

export function formatSecretReadiness(redactedConfig: unknown): string[] {
  const rows: string[] = ["Secrets:"];
  const add = (label: string, path: string[], fallback?: string) => {
    const value = getPath(redactedConfig, path);
    rows.push(`  ${label}: ${value === undefined && fallback ? fallback : formatSecretSource(value)}`);
  };

  add("daemon.pairingToken", ["daemon", "pairingToken"]);
  add("daemon.runnerToken", ["daemon", "runnerToken"], "daemon.pairingToken fallback");
  if (hasPath(redactedConfig, ["daemon", "runnerTokens"])) {
    add("daemon.runnerTokens", ["daemon", "runnerTokens"]);
  }
  if (hasPath(redactedConfig, ["daemon", "githubToken"])) {
    add("daemon.githubToken", ["daemon", "githubToken"]);
  }
  if (hasPath(redactedConfig, ["daemon", "githubApplyToken"]) || hasPath(redactedConfig, ["daemon", "githubToken"])) {
    add("daemon.githubApplyToken", ["daemon", "githubApplyToken"], "daemon.githubToken fallback");
  }

  if (hasPath(redactedConfig, ["platforms", "lark"])) {
    add("platforms.lark.appSecret", ["platforms", "lark", "appSecret"]);
  }

  if (hasPath(redactedConfig, ["platforms", "slack"])) {
    add("platforms.slack.botToken", ["platforms", "slack", "botToken"]);
    if (hasPath(redactedConfig, ["platforms", "slack", "appToken"])) {
      add("platforms.slack.appToken", ["platforms", "slack", "appToken"]);
    }
    if (hasPath(redactedConfig, ["platforms", "slack", "signingSecret"])) {
      add("platforms.slack.signingSecret", ["platforms", "slack", "signingSecret"]);
    }
  }

  if (hasPath(redactedConfig, ["platforms", "github"])) {
    add("platforms.github.webhookSecret", ["platforms", "github", "webhookSecret"]);
  }

  if (hasPath(redactedConfig, ["platforms", "gitlab"])) {
    add("platforms.gitlab.token", ["platforms", "gitlab", "token"]);
    add("platforms.gitlab.webhookSecret", ["platforms", "gitlab", "webhookSecret"]);
  }

  if (hasPath(redactedConfig, ["platforms", "line"])) {
    add("platforms.line.channelSecret", ["platforms", "line", "channelSecret"]);
    add("platforms.line.channelAccessToken", ["platforms", "line", "channelAccessToken"]);
  }

  return rows;
}
