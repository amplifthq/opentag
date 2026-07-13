#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildPublicPackagePlan } from "./package-plan.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packagePlan = buildPublicPackagePlan(path.join(repoRoot, "packages"));

function parseArgs(argv) {
  const options = {
    dryRun: false,
    skipCheck: false,
    otp: undefined,
    tag: "next"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--skip-check") {
      options.skipCheck = true;
      continue;
    }
    if (arg === "--otp") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--otp requires a value.");
      }
      options.otp = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--otp=")) {
      options.otp = arg.slice("--otp=".length);
      continue;
    }
    if (arg === "--tag") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--tag requires a value.");
      }
      options.tag = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--tag=")) {
      options.tag = arg.slice("--tag=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: corepack pnpm release:publish -- [options]

Publishes OpenTag public packages to npm in dependency order.

Options:
  --dry-run       Run pnpm publish without publishing to npm.
  --skip-check    Skip corepack pnpm release:check.
  --otp <code>    Pass an npm two-factor one-time password.
  --tag <tag>     Publish dist-tag. Defaults to next.
  -h, --help      Show this help.
`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.stdio ?? "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ...options.env,
      npm_config_audit: "false",
      npm_config_fund: "false"
    },
    encoding: options.stdio === "pipe" ? "utf8" : undefined
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function runOutput(command, args, options = {}) {
  const result = run(command, args, { ...options, stdio: "pipe", allowFailure: true });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    status: result.status
  };
}

function registryVersion(packageSpec) {
  const result = runOutput("npm", ["view", packageSpec, "version"]);
  if (result.ok) {
    return result.stdout || undefined;
  }
  if (/\bE404\b/.test(result.stderr)) {
    return undefined;
  }

  throw new Error(
    `npm registry lookup failed for ${packageSpec}:\n${result.stderr || `npm exited with status ${result.status ?? "unknown"}`}`
  );
}

function publishedVersionExists(packageName, version) {
  return registryVersion(`${packageName}@${version}`) === version;
}

function publishedVersionForTag(packageName, tag) {
  return registryVersion(`${packageName}@${tag}`);
}

function printGitContext({ dryRun }) {
  const branch = runOutput("git", ["branch", "--show-current"]);
  const status = runOutput("git", ["status", "--short"]);
  if (branch.ok && branch.stdout) {
    console.log(`Git branch: ${branch.stdout}`);
  }
  if (!dryRun && branch.stdout !== "main") {
    console.error(`Release refused: npm publication must run from main, not ${branch.stdout || "a detached or unknown ref"}.`);
    process.exit(1);
  }
  if (status.ok && status.stdout) {
    console.error("Release refused: the git working tree has local changes.");
    console.error("Commit or stash the changes, then rerun release:publish from the intended commit.");
    process.exit(1);
  }
}

function checkNpmAccess() {
  const whoami = runOutput("npm", ["whoami"]);
  if (!whoami.ok) {
    console.error("npm is not logged in. Run `npm login` first.");
    process.exit(whoami.status ?? 1);
  }

  console.log(`npm user: ${whoami.stdout}`);
  run("npm", ["org", "ls", "opentag"]);
}

const options = parseArgs(process.argv.slice(2));

console.log("OpenTag local npm publish");
printGitContext(options);
checkNpmAccess();

if (!options.skipCheck) {
  console.log("");
  console.log("Running release preflight...");
  run("corepack", ["pnpm", "release:check"]);
}

console.log("");
console.log(options.dryRun ? "Dry-run publishing packages..." : "Publishing packages...");

for (const { directory: packageDir, packageJson } of packagePlan) {
  const packageName = packageJson.name;
  const version = packageJson.version;

  if (publishedVersionExists(packageName, version)) {
    const taggedVersion = publishedVersionForTag(packageName, options.tag);
    if (taggedVersion !== version) {
      console.error(
        `Release refused: ${packageName}@${version} already exists, but dist-tag ${options.tag} points to ${taggedVersion ?? "nothing"}.`
      );
      console.error(`Repair it explicitly with: npm dist-tag add ${packageName}@${version} ${options.tag}`);
      process.exit(1);
    }
    console.log(`Skipping ${packageName}@${version}; it is already published with dist-tag ${options.tag}.`);
    continue;
  }

  console.log(`${options.dryRun ? "Dry-run publishing" : "Publishing"} ${packageName}@${version}...`);
  const args = ["pnpm", "publish", "--access", "public", "--tag", options.tag];
  if (options.dryRun) {
    args.push("--dry-run", "--no-git-checks");
  }
  if (options.otp) {
    args.push("--otp", options.otp);
  }
  run("corepack", args, { cwd: path.join(repoRoot, "packages", packageDir) });
}

console.log("");
console.log(options.dryRun ? "OpenTag npm publish dry run passed." : "OpenTag npm publish completed.");
