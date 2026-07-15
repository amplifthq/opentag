import { nodeCommandRunner, type CommandResult, type CommandRunner } from "./command.js";

export const DEFAULT_HERMES_PROFILE = "opentag";

export type HermesProfileReadiness = {
  ready: boolean;
  reason?: string;
};

function commandOutput(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

export async function probeHermesProfile(input: {
  runner?: CommandRunner;
  hermesCommand?: string;
  profile?: string;
  cwd: string;
}): Promise<HermesProfileReadiness> {
  const runner = input.runner ?? nodeCommandRunner;
  const hermesCommand = input.hermesCommand ?? "hermes";
  const profile = input.profile ?? DEFAULT_HERMES_PROFILE;

  try {
    const result = await runner.run(hermesCommand, ["-p", profile, "--version"], { cwd: input.cwd });
    if (result.exitCode === 0) return { ready: true };

    const detail = commandOutput(result) || `command exited with code ${result.exitCode}`;
    return {
      ready: false,
      reason:
        `Hermes profile '${profile}' is not ready: ${detail} ` +
        `Create it with \`hermes profile create ${profile}\` or configure daemon.hermes.profile to an existing dedicated profile.`
    };
  } catch (error) {
    return {
      ready: false,
      reason: `Hermes CLI is not available: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
