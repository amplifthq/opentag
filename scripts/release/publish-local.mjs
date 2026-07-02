#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageDirs = [
  "core",
  "client",
  "telegram",
  "runner",
  "store",
  "github",
  "gitlab",
  "lark",
  "slack",
  "dispatcher",
  "local-runtime",
  "cli"
];

function parseArgs(argv) {
  const options = {
    dryRun: false,
    skipCheck: false,
    otp: undefined,
    tag: "latest"
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
  --tag <tag>     Publish dist-tag. Defaults to latest.
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

function readPackage(packageDir) {
  const packagePath = path.join(repoRoot, "packages", packageDir, "package.json");
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function publishedVersionExists(packageName, version) {
  const result = runOutput("npm", ["view", `${packageName}@${version}`, "version"]);
  return result.ok && result.stdout === version;
}

function printGitContext() {
  const branch = runOutput("git", ["branch", "--show-current"]);
  const status = runOutput("git", ["status", "--short"]);
  if (branch.ok && branch.stdout) {
    console.log(`Git branch: ${branch.stdout}`);
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
printGitContext();
checkNpmAccess();

if (!options.skipCheck) {
  console.log("");
  console.log("Running release preflight...");
  run("corepack", ["pnpm", "release:check"]);
}

console.log("");
console.log(options.dryRun ? "Dry-run publishing packages..." : "Publishing packages...");

for (const packageDir of packageDirs) {
  const packageJson = readPackage(packageDir);
  const packageName = packageJson.name;
  const version = packageJson.version;

  if (publishedVersionExists(packageName, version)) {
    console.log(`Skipping ${packageName}@${version}; it is already published.`);
    continue;
  }

  console.log(`${options.dryRun ? "Dry-run publishing" : "Publishing"} ${packageName}@${version}...`);
  const args = ["pnpm", "publish", "--access", "public", "--tag", options.tag];
  if (options.dryRun) {
    args.push("--dry-run");
  }
  if (options.otp) {
    args.push("--otp", options.otp);
  }
  run("corepack", args, { cwd: path.join(repoRoot, "packages", packageDir) });
}

console.log("");
console.log(options.dryRun ? "OpenTag npm publish dry run passed." : "OpenTag npm publish completed.");
