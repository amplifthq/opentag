#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cliEntry = path.join(repoRoot, "packages/cli/dist/index.js");
const binDir =
  process.env.OPENTAG_DEV_BIN_DIR ??
  path.join(homedir(), ".local", "bin");
const commandName =
  process.platform === "win32" ? "opentag-dev.cmd" : "opentag-dev";
const shimPath = path.join(binDir, commandName);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function isPathEntryCurrentBinDir(entry) {
  if (!entry) {
    return false;
  }

  return path.resolve(entry) === path.resolve(binDir);
}

function findCommandOnPath(command) {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  const candidateNames =
    process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`] : [command];

  for (const entry of pathEntries) {
    if (!entry) {
      continue;
    }

    for (const candidateName of candidateNames) {
      const candidate = path.join(entry, candidateName);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function createShim() {
  mkdirSync(binDir, { recursive: true, mode: 0o755 });

  const shim =
    process.platform === "win32"
      ? `@echo off\r\nset OPENTAG_CLI_NAME=opentag-dev\r\nnode "${cliEntry}" %*\r\n`
      : `#!/bin/sh\nOPENTAG_CLI_NAME=opentag-dev exec node "${cliEntry}" "$@"\n`;

  writeFileSync(shimPath, shim, { mode: 0o755 });
  chmodSync(shimPath, 0o755);
}

console.log("Building @opentag/cli...");
run("corepack", ["pnpm", "--filter", "@opentag/cli...", "build"]);

createShim();

const pathHasBinDir = (process.env.PATH ?? "")
  .split(path.delimiter)
  .some(isPathEntryCurrentBinDir);
const resolvedCommand = findCommandOnPath("opentag-dev");

console.log("");
console.log("OpenTag dev CLI is ready.");
console.log(`Command: ${shimPath}`);
console.log(`Target:  ${cliEntry}`);
console.log("");
console.log("Try:");
console.log("  opentag-dev --help");
console.log("  opentag-dev config path");

if (!pathHasBinDir) {
  console.log("");
  console.log(`${binDir} is not on PATH for this shell.`);
  console.log("Add this to your shell profile, then open a new terminal:");
  console.log(`  export PATH="${binDir}:$PATH"`);
} else if (resolvedCommand && path.resolve(resolvedCommand) !== path.resolve(shimPath)) {
  console.log("");
  console.log(`Warning: your shell may resolve opentag-dev to ${resolvedCommand}.`);
  console.log(`${shimPath} should appear earlier on PATH if you want this checkout to win.`);
}
