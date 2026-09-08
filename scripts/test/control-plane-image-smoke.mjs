import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const image = process.argv[2];
if (!image || !/^[a-z0-9][a-z0-9./:@_-]+$/iu.test(image) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/test/control-plane-image-smoke.mjs <image>");
}
const directory = await mkdtemp(join(tmpdir(), "opentag-image-smoke-"));
const prefix = `opentag-image-smoke-${randomBytes(6).toString("hex")}`;
const containers = [];
let networkCreated = false;
const secret = () => randomBytes(32).toString("hex");
const command = ["node", "apps/control-plane/dist/index.js", "container"];
const docker = async (...args) => {
  try {
    const result = await execute("docker", args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    // Never echo env-file contents, database details, or arbitrary container logs.
    throw new Error(`image_smoke_docker_${args[0]}_failed`);
  }
};
const envFile = async (name, env) => {
  const path = join(directory, name);
  await writeFile(path, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
    { mode: 0o600 });
  return path;
};
const wait = async (probe) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(250);
  }
  throw new Error("image_smoke_wait_timeout");
};
const start = async (name, args) => {
  const target = `${prefix}-${name}`;
  await docker("run", "--detach", "--name", target, "--network", prefix, ...args);
  containers.push(target);
  return target;
};
let primaryError;
try {
  const inspect = JSON.parse(await docker("image", "inspect", image))[0];
  assert.equal(inspect.Config.User, "opentag");
  const revision = inspect.Config.Labels["org.opencontainers.image.revision"];
  assert.match(revision, /^[a-f0-9]{40}$/u);
  assert.ok(inspect.Config.Env.includes(`OPENTAG_RELEASE_SHA=${revision}`));
  await docker("network", "create", "--internal", prefix);
  networkCreated = true;
  const password = secret();
  const pgEnv = await envFile("postgres.env", { POSTGRES_USER: "opentag", POSTGRES_DB: "opentag",
    POSTGRES_PASSWORD: password, PGDATA: "/var/lib/postgresql/data/pgdata" });
  const pg = await start("postgres", ["--network-alias", "postgres", "--env-file", pgEnv,
    "--tmpfs", "/var/lib/postgresql/data:rw", "postgres:17-alpine"]);
  const env = {
    DATABASE_URL: `postgresql://opentag:${password}@postgres:5432/opentag`,
    OPENTAG_ENVIRONMENT: "staging", OPENTAG_PUBLIC_URL: "https://relay.example.test",
    OPENTAG_BOOTSTRAP_ORGANIZATION_ID: "org_smoke", OPENTAG_BOOTSTRAP_ORGANIZATION_NAME: "Image smoke",
    OPENTAG_BOOTSTRAP_PAIRING_TOKEN: secret(), OPENTAG_FENCING_TOKEN_SECRET: secret(),
    OPENTAG_LOGIN_THROTTLE_SECRET: secret(), OPENTAG_RELAY_CONTENT_KEY_VERSION: "v1",
    OPENTAG_CONTAINER_RELAY_CONTENT_KEK: secret(),
    OPENTAG_CONTAINER_SLACK_SIGNING_SECRET: secret(), OPENTAG_CONTAINER_SLACK_BOT_TOKEN: `xoxb-${secret()}`,
    OPENTAG_CONTAINER_CONTROL_PLANE_URL: "http://control-plane:3000",
    OPENTAG_BOOTSTRAP_ADMIN_EMAIL: "owner@example.test", OPENTAG_BOOTSTRAP_ADMIN_NAME: "Owner",
    OPENTAG_BOOTSTRAP_ADMIN_PASSWORD: secret(),
    OPENTAG_SLACK_INSTALLATION_ID: "slack_primary", OPENTAG_SLACK_BINDING_ID: "slack_primary_binding",
    OPENTAG_SLACK_ROUTE_IDENTITY: secret(), OPENTAG_SLACK_PROJECT_TARGET_ID: "github_primary",
    OPENTAG_SLACK_TEAM_ID: "T_SMOKE", OPENTAG_SLACK_APP_ID: "A_SMOKE", OPENTAG_SLACK_CHANNEL_ID: "C_SMOKE",
    OPENTAG_SLACK_BOT_USER_ID: "U_BOT", OPENTAG_SLACK_MEMBER_USER_IDS: "U_OWNER",
  };
  const file = await envFile("relay.env", env);
  const jobsEnv = { ...env };
  delete jobsEnv.OPENTAG_BOOTSTRAP_ADMIN_PASSWORD;
  const jobsFile = await envFile("jobs.env", jobsEnv);
  const jobs = await start("jobs", ["--env-file", jobsFile, image, ...command, "jobs"]);
  await wait(async () => (await docker("logs", jobs)).includes("control_plane_container_waiting"));
  assert.ok(!(await docker("logs", jobs)).includes("control_plane_container_starting"));
  const api = await start("api", ["--network-alias", "control-plane", "--env-file", file,
    image, ...command, "serve"]);
  const ready = async () => {
    try {
      return (await docker("exec", api, "node", "--input-type=module", "-e",
        "console.log((await fetch('http://127.0.0.1:3000/readyz',{signal:AbortSignal.timeout(3000)})).ok)")) === "true";
    }
    catch { return false; }
  };
  await wait(ready);
  const capabilities = JSON.parse(await docker("exec", api, "node", "--input-type=module", "-e",
    "console.log(JSON.stringify(await (await fetch('http://127.0.0.1:3000/v1/relay/capabilities')).json()))"));
  assert.equal(capabilities.deployment.releaseSha, revision);
  await wait(async () => (await docker("logs", jobs)).includes("control_plane_container_starting"));
  const sql = (statement) => docker("exec", pg, "psql", "-U", "opentag", "-d", "opentag",
    "-At", "-v", "ON_ERROR_STOP=1", "-c", statement);
  const snapshot = () => sql(`SELECT json_build_object(
    'owners',(SELECT count(*) FROM cp_membership WHERE role='owner'),
    'bindings',(SELECT count(*) FROM cp_slack_binding),
    'binding',(SELECT binding_digest FROM cp_slack_binding LIMIT 1),
    'owner_hash',(SELECT password_hash FROM cp_operator LIMIT 1),
    'migrations',(SELECT count(*) FROM control_plane_migrations))::text`);
  const before = await snapshot();
  assert.equal(JSON.parse(before).owners, 1);
  assert.equal(JSON.parse(before).bindings, 1);
  await docker("restart", api, jobs);
  await wait(ready);
  assert.equal(await snapshot(), before, "restart must preserve owner, binding, and migration identity");
  assert.equal(JSON.parse(await docker("inspect", jobs))[0].State.Running, true);

  await docker("stop", api, jobs);
  await sql("INSERT INTO control_plane_migrations(name,checksum) VALUES('retired-schema.sql','test')");
  const rejected = await start("rejected", ["--env-file", file, image, ...command, "serve"]);
  assert.equal(await docker("wait", rejected), "1");
  const logs = await docker("logs", rejected);
  assert.ok(!logs.includes("control_plane_container_starting"));
  for (const value of [password, env.OPENTAG_BOOTSTRAP_ADMIN_PASSWORD,
    env.OPENTAG_CONTAINER_RELAY_CONTENT_KEK, env.OPENTAG_CONTAINER_SLACK_BOT_TOKEN]) {
    assert.ok(!logs.includes(value), "failure logs must not expose secrets");
  }
  console.log(`Control Plane image smoke passed: ${revision}; bootstrap, jobs gate, restart, retired-schema rejection.`);
} catch (error) {
  primaryError = error;
  for (const container of containers) {
    try {
      const result = await execute("docker", ["logs", container], { timeout: 5_000 });
      for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
        if (/^control_plane_container_(failed|waiting|starting)\b/u.test(line)) console.error(line);
      }
    } catch { console.error("image_smoke_diagnostics_unavailable"); }
  }
} finally {
  const failures = [];
  for (const container of containers.reverse()) {
    try { await docker("rm", "--force", "--volumes", container); }
    catch { failures.push("container"); }
  }
  if (networkCreated) {
    try { await docker("network", "rm", prefix); }
    catch { failures.push("network"); }
  }
  await rm(directory, { recursive: true, force: true });
  if (failures.length) throw new Error(`image_smoke_cleanup_failed:${failures.join(",")}`);
}
if (primaryError) throw primaryError;
