#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = new Set(process.argv.slice(2));
const smokeOnly = args.has("--smoke");
if (!process.env.OPENTAG_TEST_DATABASE_URL) {
  console.error("team-relay certification requires OPENTAG_TEST_DATABASE_URL; PostgreSQL evidence may not be skipped");
  process.exit(2);
}

const files = smokeOnly ? [
  "apps/control-plane/test/slack-team-profile.e2e.postgres.test.ts",
  "packages/local-runtime/test/paired-relay-recovery.test.ts",
] : [
  "apps/control-plane/test/slack-team-profile.e2e.postgres.test.ts",
  "apps/control-plane/test/slack-ingress.postgres.test.ts",
  "apps/control-plane/test/source-ingress-crash-boundaries.postgres.test.ts",
  "apps/control-plane/test/hosted-run-races.postgres.test.ts",
  "apps/control-plane/test/provider-delivery-crash-boundaries.postgres.test.ts",
  "apps/control-plane/test/projection-outbox.postgres.test.ts",
  "packages/local-runtime/test/paired-relay-recovery.test.ts",
  "packages/local-runtime/test/control-v1.test.ts",
  "packages/local-runtime/test/publication-control-v1.test.ts",
];

console.log("Team relay certification: local deterministic proof only.");
console.log("No provider credentials are read and no real Slack/GitHub/provider canary is contacted.");
console.log("Real provider/canary proof remains a separate, explicitly authorized operation.");
const result = spawnSync("corepack", ["pnpm", "vitest", "run", ...files], {
  cwd: root,
  env: {
    ...process.env,
    SLACK_BOT_TOKEN: "",
    SLACK_SIGNING_SECRET: "",
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
  },
  stdio: "inherit",
});
if (result.error) {
  console.error(`unable to start deterministic certification: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
