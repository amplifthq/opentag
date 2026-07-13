#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPublicPackagePlan } from "./package-plan.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

try {
  const plan = buildPublicPackagePlan(path.join(repoRoot, "packages"));
  console.log(`Publication set is consistent (${plan.length} public packages).`);
  for (const entry of plan) {
    console.log(`- ${entry.packageJson.name}@${entry.packageJson.version} (packages/${entry.directory})`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
