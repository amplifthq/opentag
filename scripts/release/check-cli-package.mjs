#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  "lark",
  "slack",
  "dispatcher",
  "local-runtime",
  "cli"
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.stdio ?? "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false"
    }
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
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

const tempRoot = mkdtempSync(path.join(tmpdir(), "opentag-release-check-"));
const packDir = path.join(tempRoot, "packs");
const installDir = path.join(tempRoot, "install");

try {
  console.log("Building workspace packages...");
  run("corepack", ["pnpm", "build"]);

  console.log("Packing publishable packages...");
  mkdirSync(packDir, { recursive: true });
  const tarballs = packageDirs.map((packageDir) => packPackage(packageDir, packDir));

  console.log("Installing packed packages into a clean npm project...");
  mkdirSync(installDir, { recursive: true });
  writeFileSync(path.join(installDir, "package.json"), "{\"private\":true,\"type\":\"module\"}\n");
  run("npm", ["install", "--no-audit", "--no-fund", ...tarballs], { cwd: installDir });

  console.log("Checking the installed opentag command...");
  run(commandPath(installDir, "opentag"), ["--help"], { cwd: installDir });
  run("npx", ["--no-install", "opentag", "--help"], { cwd: installDir });

  console.log("");
  console.log("OpenTag CLI package check passed.");
  console.log(`Packed tarballs: ${packDir}`);
} finally {
  if (process.env.OPENTAG_KEEP_RELEASE_CHECK !== "1") {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
