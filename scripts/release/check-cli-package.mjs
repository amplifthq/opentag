#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildPublicPackagePlan } from "./package-plan.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packagePlan = buildPublicPackagePlan(path.join(repoRoot, "packages"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.stdio ?? "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false"
    },
    encoding: options.stdio === "pipe" ? "utf8" : undefined
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} failed with exit code ${result.status ?? 1}.`);
  }
  return result;
}

function packPackage(packageDir, packDir) {
  const before = new Set(readdirSync(packDir));
  run("corepack", ["pnpm", "--dir", path.join("packages", packageDir), "pack", "--pack-destination", packDir]);
  const created = readdirSync(packDir).filter((file) => file.endsWith(".tgz") && !before.has(file));
  if (created.length !== 1) {
    throw new Error(`Expected one tarball for packages/${packageDir}, found ${created.length}.`);
  }
  return path.join(packDir, created[0]);
}

function commandPath(cwd, command) {
  return path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? `${command}.cmd` : command);
}

function checkInstalledDoctorCommand(installDir) {
  const opentagCommand = commandPath(installDir, "opentag");
  run(opentagCommand, ["doctor", "--help"], { cwd: installDir });

  const stateDirectory = path.join(installDir, "doctor-state");
  const configPath = path.join(installDir, "doctor-config.json");
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        state: {
          directory: stateDirectory,
          databasePath: path.join(stateDirectory, "opentag.db"),
          worktreeRoot: path.join(stateDirectory, "worktrees")
        },
        runtime: { mode: "local" },
        daemon: {
          runnerId: "runner_release_check",
          dispatcherUrl: "http://127.0.0.1:9",
          repositories: [],
          pairingToken: "release_check_pairing_token",
          pollIntervalMs: 5_000,
          heartbeatIntervalMs: 15_000
        },
        platforms: {}
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  const doctor = run(opentagCommand, ["doctor", "--config", configPath], {
    cwd: installDir,
    stdio: "pipe",
    allowFailure: true
  });
  const doctorOutput = `${doctor.stdout ?? ""}\n${doctor.stderr ?? ""}`;
  if (doctor.status !== 1) {
    throw new Error(`Expected the intentionally incomplete doctor config to exit 1, received ${doctor.status ?? "no status"}.`);
  }
  for (const expected of ["OpenTag doctor", "FAIL repository config: No repositories or agents are configured."]) {
    if (!doctorOutput.includes(expected)) {
      throw new Error(`Installed opentag doctor output did not contain ${JSON.stringify(expected)}.`);
    }
  }
}

function checkInstalledAcpLaunchDefinitions(installDir) {
  const probe = `
    import { builtInAcpAgentDefinitions, builtInAcpAgentManifests } from "@opentag/runner";

    const definitions = builtInAcpAgentDefinitions();
    const manifests = builtInAcpAgentManifests({
      hermes: { command: "hermes-release-check", profile: "release-check" }
    });
    const expected = {
      codex: ["--yes", "@agentclientprotocol/codex-acp@1.1.2"],
      "claude-code": ["--yes", "@agentclientprotocol/claude-agent-acp@0.59.0"]
    };
    for (const [id, args] of Object.entries(expected)) {
      const binding = manifests[id].bindings.agent;
      if (binding.command !== "npx" || JSON.stringify(binding.args) !== JSON.stringify(args)) {
        throw new Error(\`Installed \${id} ACP Registry launch is incorrect: \${JSON.stringify(binding)}\`);
      }
      if (!definitions[id].registry?.id || !definitions[id].registry?.version) {
        throw new Error(\`Installed \${id} ACP definition has no Registry provenance.\`);
      }
    }
    const hermes = manifests.hermes.bindings.agent;
    if (hermes.command !== "hermes-release-check" || JSON.stringify(hermes.args) !== JSON.stringify(["-p", "release-check", "acp"])) {
      throw new Error(\`Installed Hermes ACP manifest is incorrect: \${JSON.stringify(hermes)}\`);
    }
  `;
  run(process.execPath, ["--input-type=module", "--eval", probe], { cwd: installDir });
}

const tempRoot = mkdtempSync(path.join(tmpdir(), "opentag-release-check-"));
const packDir = path.join(tempRoot, "packs");
const installDir = path.join(tempRoot, "install");

try {
  console.log("Building workspace packages...");
  run("corepack", ["pnpm", "build"]);

  console.log("Packing publishable packages...");
  mkdirSync(packDir, { recursive: true });
  const tarballs = packagePlan.map((entry) => packPackage(entry.directory, packDir));

  console.log("Installing packed packages into a clean npm project...");
  mkdirSync(installDir, { recursive: true });
  writeFileSync(path.join(installDir, "package.json"), "{\"private\":true,\"type\":\"module\"}\n");
  run("npm", ["install", "--no-audit", "--no-fund", ...tarballs], { cwd: installDir });

  console.log("Checking the installed opentag command...");
  run(commandPath(installDir, "opentag"), ["--help"], { cwd: installDir });
  run("npx", ["--no-install", "opentag", "--help"], { cwd: installDir });
  checkInstalledDoctorCommand(installDir);

  console.log("Checking installed ACP Registry launch definitions...");
  checkInstalledAcpLaunchDefinitions(installDir);

  console.log("");
  console.log("OpenTag CLI package check passed.");
  console.log(`Packed tarballs: ${packDir}`);
} finally {
  if (process.env.OPENTAG_KEEP_RELEASE_CHECK !== "1") {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
