import { execFile } from "node:child_process";

const OPENCLAW_PREFLIGHT_TIMEOUT_MS = 15_000;

export type OpenClawCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type OpenClawCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<OpenClawCommandResult>;

export type OpenClawCompatibilityOptions = {
  command: string;
  profile?: string;
  gatewayUrl?: string;
  expectedVersion?: string;
  run?: OpenClawCommandRunner;
};

function runBoundedCommand(command: string, args: string[], timeoutMs: number): Promise<OpenClawCommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr)
        });
      }
    );
  });
}

export function parseOpenClawCliVersion(output: string): string | undefined {
  return /^OpenClaw\s+([^\s]+)/mu.exec(output.trim())?.[1];
}

function gatewayVersion(output: string): { ready: boolean; version?: string } | undefined {
  try {
    const status = JSON.parse(output) as {
      gateway?: { version?: unknown };
      rpc?: { ok?: unknown; version?: unknown; server?: { version?: unknown } };
    };
    const version = status.rpc?.server?.version ?? status.rpc?.version ?? status.gateway?.version;
    return {
      ready: status.rpc?.ok === true,
      ...(typeof version === "string" && version.trim() ? { version: version.trim() } : {})
    };
  } catch {
    return undefined;
  }
}

function profileLabel(profile: string | undefined): string {
  return profile ? `profile '${profile}'` : "the ambient profile";
}

export async function checkOpenClawCompatibility(
  options: OpenClawCompatibilityOptions
): Promise<{ ready: boolean; reason?: string }> {
  const run = options.run ?? runBoundedCommand;
  const cli = await run(options.command, ["--version"], OPENCLAW_PREFLIGHT_TIMEOUT_MS);
  const cliVersion = cli.exitCode === 0 ? parseOpenClawCliVersion(cli.stdout) : undefined;
  if (!cliVersion) {
    return {
      ready: false,
      reason: "OpenClaw CLI version could not be verified before ACP startup; install a compatible CLI and retry."
    };
  }
  if (options.expectedVersion && cliVersion !== options.expectedVersion) {
    return {
      ready: false,
      reason: `OpenClaw CLI ${cliVersion} does not match expected ${options.expectedVersion}; upgrade the CLI and Gateway or select a compatible profile.`
    };
  }

  const gatewayArgs = [
    ...(options.profile ? ["--profile", options.profile] : []),
    "gateway",
    "status",
    "--json",
    ...(options.gatewayUrl ? ["--url", options.gatewayUrl] : [])
  ];
  const gateway = await run(options.command, gatewayArgs, OPENCLAW_PREFLIGHT_TIMEOUT_MS);
  const status = gateway.exitCode === 0 ? gatewayVersion(gateway.stdout) : undefined;
  if (!status?.ready || !status.version) {
    return {
      ready: false,
      reason: `OpenClaw CLI ${cliVersion} could not verify Gateway compatibility for ${profileLabel(options.profile)}; upgrade the CLI and Gateway or select a compatible profile. OpenTag did not rewrite or downgrade the profile.`
    };
  }
  if (status.version !== cliVersion) {
    return {
      ready: false,
      reason: `OpenClaw Gateway ${status.version} is incompatible with CLI ${cliVersion}; upgrade both to the same version or select a compatible profile.`
    };
  }
  return { ready: true };
}

export function createOpenClawPreflight(
  options: Omit<OpenClawCompatibilityOptions, "run">
): () => Promise<{ ready: boolean; reason?: string }> {
  return () => checkOpenClawCompatibility(options);
}
