import { spawnSync } from "node:child_process";

const command = process.env.OPENTAG_HERMES_COMMAND?.trim() || "hermes";
const profile = process.env.OPENTAG_HERMES_SMOKE_PROFILE?.trim();

if (!profile) {
  console.error(
    "Set OPENTAG_HERMES_SMOKE_PROFILE to a pre-existing Hermes profile. This smoke test never creates or changes profiles."
  );
  process.exit(2);
}

function run(args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}:\n${output}`);
  }
  return output;
}

const versionOutput = run(["--version"]);
if (!/Hermes Agent v0\.18\.2\b/.test(versionOutput)) {
  throw new Error(`Expected Hermes Agent v0.18.2, received:\n${versionOutput}`);
}

const profileOutput = run(["-p", profile, "--version"]);
if (!/Hermes Agent v0\.18\.2\b/.test(profileOutput)) {
  throw new Error(`The profile-scoped version probe returned an unexpected version:\n${profileOutput}`);
}

console.log(`Verified Hermes Agent v0.18.2 accepts -p ${profile} --version for a pre-existing profile.`);
