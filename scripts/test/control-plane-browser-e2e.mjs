import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = join(root, "deploy/compose/compose.yaml");
const migrationFileCount = (await readdir(
  join(root, "apps/control-plane/migrations"),
)).filter((file) => file.endsWith(".sql")).length;
const suffix = `${Date.now()}${process.pid}`;
const projectName = `opentag-e2e-${process.pid}-${Date.now()}`.toLowerCase();
const runId = suffix.slice(-12);

const randomSecret = () => randomBytes(32).toString("hex");

const reservePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.unref();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("e2e_port_unavailable"));
      return;
    }
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

const run = (command, args, options = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio:
      options.capture || options.input !== undefined
        ? ["pipe", "pipe", "pipe"]
        : "inherit",
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout?.on("data", (chunk) => { stdoutChunks.push(Buffer.from(chunk)); });
  child.stderr?.on("data", (chunk) => { stderrChunks.push(Buffer.from(chunk)); });
  if (child.stdin) child.stdin.end(options.input);
  let settled = false;
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    reject(error);
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    const stdoutBytes = Buffer.concat(stdoutChunks);
    const stderrBytes = Buffer.concat(stderrChunks);
    const stdout = stdoutBytes.toString("utf8");
    const stderr = stderrBytes.toString("utf8");
    if (code === 0) {
      resolveRun({ stdout, stdoutBytes, stderr, stderrBytes });
      return;
    }
    reject(new Error(
      `${command} ${args.join(" ")} failed (${signal ?? code})${stderr ? `\n${stderr}` : ""}`,
    ));
  });
});

const waitForReady = async (url, timeoutMs = 180_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unreachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      lastStatus = `${response.status}`;
      if (response.ok) return;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : "unreachable";
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`control_plane_not_ready:${lastStatus}`);
};

const waitForRestartedJob = async (compose, jobId, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastState = "missing";
  while (Date.now() < deadline) {
    const result = await run("docker", [
      ...compose,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "opentag",
      "-d",
      "opentag",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `SELECT job.state || '|' ||
         (SELECT count(*) FROM cp_job_settlement settlement
          WHERE settlement.job_id = job.job_id)
       FROM cp_job job WHERE job.job_id = '${jobId}';`,
    ], { capture: true });
    lastState = result.stdout.trim() || "missing";
    if (lastState === "succeeded|1") return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`restarted_jobs_not_settled:${lastState}`);
};

const port = await reservePort();
const temporaryDirectory = await mkdtemp(join(tmpdir(), "opentag-control-plane-e2e-"));
const environmentFile = join(temporaryDirectory, ".env");
const relayContentKekFile = join(temporaryDirectory, "relay-content-kek");
const slackSigningSecretFile = join(temporaryDirectory, "slack-signing-secret");
const slackBotTokenFile = join(temporaryDirectory, "slack-bot-token");
const baseUrl = `http://127.0.0.1:${port}`;
const adminEmail = `owner-${runId}@example.test`;
const adminPassword = `E2e-owner-${randomSecret()}`;
const pairingToken = `pair_${randomSecret()}`;
const recoveryToken = `recovery_${randomSecret()}`;
const postgresPassword = randomSecret();
const fencingTokenSecret = randomSecret();
const loginThrottleSecret = randomSecret();
const slackSigningSecret = `signing_${randomSecret()}`;
const compose = [
  "compose",
  "--project-name",
  projectName,
  "--env-file",
  environmentFile,
  "-f",
  composeFile,
];

let primaryError;
try {
  await chmod(temporaryDirectory, 0o700);
  // File-backed Compose secrets retain the source file's host ownership on
  // native Linux. The private parent directory scopes this readable mount to
  // the disposable E2E run while allowing the non-root container user to read it.
  await writeFile(relayContentKekFile, randomBytes(32), { mode: 0o644 });
  await writeFile(slackSigningSecretFile, slackSigningSecret, { mode: 0o644 });
  await writeFile(slackBotTokenFile, `xoxb-${randomSecret()}`, { mode: 0o644 });
  await writeFile(environmentFile, [
    `POSTGRES_PASSWORD=${postgresPassword}`,
    `OPENTAG_RELAY_CONTENT_KEK_SOURCE_FILE=${relayContentKekFile}`,
    `OPENTAG_SLACK_SIGNING_SECRET_SOURCE_FILE=${slackSigningSecretFile}`,
    `OPENTAG_SLACK_BOT_TOKEN_SOURCE_FILE=${slackBotTokenFile}`,
    "OPENTAG_BOOTSTRAP_ORGANIZATION_ID=org_e2e",
    "OPENTAG_BOOTSTRAP_ORGANIZATION_NAME=OpenTag E2E",
    `OPENTAG_BOOTSTRAP_PAIRING_TOKEN=${pairingToken}`,
    `OPENTAG_RECOVERY_PAIRING_TOKEN=${recoveryToken}`,
    `OPENTAG_PUBLIC_URL=${baseUrl}`,
    "OPENTAG_ENVIRONMENT=local",
    "OPENTAG_RELEASE_SHA=local",
    `OPENTAG_FENCING_TOKEN_SECRET=${fencingTokenSecret}`,
    `OPENTAG_LOGIN_THROTTLE_SECRET=${loginThrottleSecret}`,
    "OPENTAG_LOGIN_NETWORK_THROTTLE_MODE=direct-peer",
    `OPENTAG_BOOTSTRAP_ADMIN_EMAIL=${adminEmail}`,
    "OPENTAG_BOOTSTRAP_ADMIN_NAME=OpenTag E2E Owner",
    `OPENTAG_BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}`,
    `OPENTAG_SLACK_INSTALLATION_ID=slack_installation_${runId}`,
    `OPENTAG_SLACK_BINDING_ID=slack_binding_${runId}`,
    `OPENTAG_SLACK_ROUTE_IDENTITY=slack_route_${runId}`,
    `OPENTAG_SLACK_PROJECT_TARGET_ID=slack_target_${runId}`,
    "OPENTAG_SLACK_PUBLICATION_MODE=proposal_only",
    "OPENTAG_SLACK_TEAM_ID=T_E2E",
    "OPENTAG_SLACK_APP_ID=A_E2E",
    "OPENTAG_SLACK_CHANNEL_ID=C_E2E",
    "OPENTAG_SLACK_BOT_USER_ID=U_BOT_E2E",
    "OPENTAG_SLACK_MEMBER_USER_IDS=U_ADMIN_E2E,U_APPROVER_E2E,U_MEMBER_E2E,U_OPERATOR_E2E",
    "OPENTAG_SLACK_OPERATOR_USER_IDS=U_OPERATOR_E2E",
    "OPENTAG_SLACK_APPROVER_USER_ID=U_APPROVER_E2E",
    "OPENTAG_SLACK_ADMIN_USER_IDS=U_ADMIN_E2E",
    `OPENTAG_PORT=${port}`,
    "",
  ].join("\n"), { mode: 0o600 });
  console.log(`[control-plane-e2e] starting isolated Compose project ${projectName}`);
  await run("docker", [...compose, "up", "-d", "--build"]);
  await waitForReady(`${baseUrl}/readyz`);

  const nodeOptions = [process.env.NODE_OPTIONS, "--conditions=development"]
    .filter(Boolean)
    .join(" ");
  await run("corepack", [
    "pnpm",
    "--dir",
    "apps/control-plane",
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.config.ts",
  ], {
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      OPENTAG_E2E_ADMIN_EMAIL: adminEmail,
      OPENTAG_E2E_ADMIN_PASSWORD: adminPassword,
      OPENTAG_E2E_BASE_URL: baseUrl,
      OPENTAG_E2E_PAIRING_TOKEN: pairingToken,
      OPENTAG_E2E_RUN_ID: runId,
    },
  });

  await run("corepack", [
    "pnpm",
    "exec",
    "tsx",
    "scripts/test/control-plane-compose-smoke.ts",
  ], {
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      OPENTAG_SMOKE_URL: baseUrl,
      OPENTAG_SMOKE_RUNNER_ID: `runner_e2e_${runId}`,
      OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_e2e",
      OPENTAG_BOOTSTRAP_PAIRING_TOKEN: pairingToken,
      OPENTAG_RECOVERY_PAIRING_TOKEN: recoveryToken,
      OPENTAG_BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      OPENTAG_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      OPENTAG_SMOKE_SLACK_SIGNING_SECRET: slackSigningSecret,
      OPENTAG_SMOKE_SLACK_ROUTE_IDENTITY: `slack_route_${runId}`,
      OPENTAG_SMOKE_SLACK_PROJECT_TARGET_ID: `slack_target_${runId}`,
      OPENTAG_SMOKE_SLACK_TEAM_ID: "T_E2E",
      OPENTAG_SMOKE_SLACK_APP_ID: "A_E2E",
      OPENTAG_SMOKE_SLACK_CHANNEL_ID: "C_E2E",
      OPENTAG_SMOKE_SLACK_BOT_USER_ID: "U_BOT_E2E",
      OPENTAG_SMOKE_SLACK_ACTOR_USER_ID: "U_OPERATOR_E2E",
    },
  });

  const verification = await run("docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "opentag",
    "-d",
    "opentag",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `SELECT
      (SELECT count(*) FROM cp_runner WHERE runner_id = 'runner_e2e_${runId}'),
      (SELECT count(*) FROM cp_project_target WHERE project_target_id = 'slack_target_${runId}'),
      (SELECT count(*) FROM cp_api_key WHERE label = 'browser-e2e-${runId}' AND revoked_at IS NOT NULL),
      (SELECT count(*) FROM cp_slack_installation slack
       JOIN cp_source_app_installation installation USING(organization_id, installation_id)
       JOIN cp_source_binding binding USING(organization_id, installation_id)
       WHERE slack.installation_id = 'slack_installation_${runId}'
         AND binding.binding_id = 'slack_binding_${runId}'
         AND slack.signing_secret_ref = 'file:/run/secrets/opentag_slack_signing_secret'
         AND slack.bot_token_ref = 'file:/run/secrets/opentag_slack_bot_token'
         AND installation.binding_digest = binding.binding_digest),
      (SELECT count(DISTINCT job_kind) FROM cp_job
       WHERE job_kind IN ('hosted-attempt-reconciliation', 'runner-readiness-retention')
         AND state = 'succeeded');`,
  ], { capture: true });
  if (verification.stdout.trim() !== "1|1|1|1|2") {
    throw new Error(`persistent_e2e_state_mismatch:${verification.stdout.trim()}`);
  }
  console.log("[control-plane-e2e] PostgreSQL persistence verified: 1|1|1|1|2");

  await run("docker", [...compose, "restart", "control-plane", "jobs"]);
  await waitForReady(`${baseUrl}/readyz`);
  const restartedJobId = `e2e-restart-retention-${runId}`;
  await run("docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "opentag",
    "-d",
    "opentag",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `INSERT INTO cp_job(
       job_id, organization_id, job_kind, payload, request_digest,
       state, available_at, attempt_count, max_attempts, created_at, updated_at
     ) VALUES(
       '${restartedJobId}', NULL, 'runner-readiness-retention', '{}'::jsonb,
       'e2e-restart-${runId}', 'pending', clock_timestamp(), 0, 1,
       clock_timestamp(), clock_timestamp()
     );`,
  ], { capture: true });
  await waitForRestartedJob(compose, restartedJobId);
  console.log(
    "[control-plane-e2e] HTTP readiness and restarted jobs settlement verified",
  );

  await run("docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "opentag",
    "-d",
    "opentag",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "UPDATE cp_organization SET display_name = 'OpenTag E2E 恢复 🚀' "
      + "WHERE organization_id = 'org_e2e';",
  ], { capture: true });

  const backup = await run("docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "pg_dump",
    "-U",
    "opentag",
    "-d",
    "opentag",
    "--format=plain",
    "--no-owner",
    "--no-privileges",
  ], { capture: true });
  await run("docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "createdb",
    "-U",
    "opentag",
    "opentag_restore",
  ], { capture: true });
  await run("docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "opentag",
    "-d",
    "opentag_restore",
    "-v",
    "ON_ERROR_STOP=1",
  ], { capture: true, input: backup.stdoutBytes });
  const restored = await run("docker", [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "opentag",
    "-d",
    "opentag_restore",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `SELECT
      (SELECT count(*) FROM cp_runner WHERE runner_id = 'runner_e2e_${runId}'),
      (SELECT count(*) FROM cp_project_target WHERE project_target_id = 'target_e2e_${runId}'),
      (SELECT count(*) FROM cp_slack_installation
       WHERE installation_id = 'slack_installation_${runId}'),
      (SELECT count(*) FROM control_plane_migrations),
      (SELECT count(*) FROM cp_organization
       WHERE organization_id = 'org_e2e'
         AND display_name = 'OpenTag E2E 恢复 🚀');`,
  ], { capture: true });
  const expectedRestoredState = `1|1|1|${migrationFileCount}|1`;
  if (restored.stdout.trim() !== expectedRestoredState) {
    throw new Error(`restored_e2e_state_mismatch:${restored.stdout.trim()}`);
  }
  console.log(
    "[control-plane-e2e] byte-safe backup and fresh-database restore verified: "
      + expectedRestoredState,
  );
} catch (error) {
  primaryError = error;
  try {
    await run("docker", [...compose, "logs", "--no-color", "--tail", "200"]);
  } catch (logsError) {
    console.error("[control-plane-e2e] could not collect Compose logs", logsError);
  }
} finally {
  try {
    await run("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
  } catch (cleanupError) {
    if (!primaryError) primaryError = cleanupError;
    else console.error("[control-plane-e2e] cleanup also failed", cleanupError);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

if (primaryError) throw primaryError;
await Promise.all([
  rm(join(root, "test-results/control-plane"), { recursive: true, force: true }),
  rm(join(root, "playwright-report/control-plane"), { recursive: true, force: true }),
]);
console.log(
  "[control-plane-e2e] browser, Control V1, HTTP, jobs, restart, and PostgreSQL restore journeys passed",
);
