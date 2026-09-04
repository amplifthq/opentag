import { relayUrlFromConfig, type OpenTagCliConfig } from "./config.js";
import {
  canonicalHostedRelayOrigin,
} from "@opentag/local-runtime";
export {
  TrustedRelayAuthorizationV1Schema,
  assertHostedRelayAuthorization,
  canonicalHostedRelayOrigin,
  type TrustedRelayAuthorizationV1
} from "@opentag/local-runtime";

export type RelaySecurityCheck = {
  status: "ok" | "warn" | "fail";
  name: string;
  message: string;
};

export function assertRelayTransportAllowed(relayUrl: string): void {
  canonicalHostedRelayOrigin(relayUrl);
}

export function relayTrustWarning(relayUrl: string): string {
  return [
    `Security: only pair with a relay you operate or trust (${relayUrl}).`,
    "The relay can see run metadata, command text, and progress, and it controls which queued runs this local runner claims."
  ].join("\n");
}

export function relaySecurityChecksFromConfig(config: OpenTagCliConfig): RelaySecurityCheck[] {
  const relayUrl = relayUrlFromConfig(config);
  let relay: URL;
  try {
    relay = new URL(relayUrl);
  } catch {
    return [{ status: "fail", name: "relay URL", message: "Relay URL is malformed; fix daemon.relayUrl." }];
  }
  const checks: RelaySecurityCheck[] = [];

  if (relay.protocol === "https:") {
    checks.push({ status: "ok", name: "relay transport", message: "HTTPS is enabled." });
  } else {
    checks.push({ status: "fail", name: "relay transport", message: "The paired Control Plane origin must use HTTPS." });
  }

  checks.push({
    status: "warn",
    name: "relay trust",
    message: "Use only a relay you operate or trust; the relay is the remote control plane for this local runner."
  });

  checks.push(
    config.daemon.runnerToken
      ? {
          status: "ok",
          name: "relay token scope",
          message:
            "Runner calls use the scoped daemon.runnerToken; registration and runtime authorities remain separate."
        }
      : {
          status: "warn",
          name: "relay token scope",
          message:
            "The Runner is not paired with a scoped runtime credential yet."
        }
  );

  checks.push({
    status: "ok",
    name: "Project Target allowlist",
    message: `${config.daemon.repositories.length} local Project Target(s) configured; the runner refuses unlisted targets before executor startup.`
  });

  if (!config.daemon.security) {
    checks.push({
      status: "warn",
      name: "runner security policy",
      message: "No explicit daemon.security policy is configured; consider setting allowedWorkspaceRoot for relay-backed runners."
    });
  }

  return checks;
}

export function formatRelaySecurityChecks(checks: RelaySecurityCheck[]): string[] {
  if (!checks.length) return [];
  return ["Relay Security:", ...checks.map((check) => `  ${check.status.toUpperCase()} ${check.name}: ${check.message}`)];
}
