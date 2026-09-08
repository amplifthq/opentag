import { lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { RelayCapabilitiesResponseV1Schema } from "@opentag/control-protocol";
import { parseAdminBootstrapConfig, parseControlPlaneConfig, parseSlackBootstrapConfig } from "./config.js";
import { checkPostgresReadiness, createPostgresRuntime } from "./database/postgres.js";
type CommandRunner = typeof import("./index.js").main;

const SECRET_DIRECTORY = "/run/secrets";
const secretFiles = {
  OPENTAG_CONTAINER_RELAY_CONTENT_KEK: "opentag_relay_content_kek",
  OPENTAG_CONTAINER_SLACK_SIGNING_SECRET: "opentag_slack_signing_secret",
  OPENTAG_CONTAINER_SLACK_BOT_TOKEN: "opentag_slack_bot_token",
} as const;
const credential = z.string().min(1).max(4096)
  .refine((value) => value === value.trim()
    && Buffer.byteLength(value, "utf8") <= 4096
    && !/[\r\n\0\ufffd]/u.test(value) && !value.startsWith("replace-with-"));
const ContainerSecretsSchema = z.object({
  OPENTAG_CONTAINER_RELAY_CONTENT_KEK: z.string().regex(/^[a-f0-9]{64}$/iu),
  OPENTAG_CONTAINER_SLACK_SIGNING_SECRET: credential,
  OPENTAG_CONTAINER_SLACK_BOT_TOKEN: credential,
});
const ContainerRoleSchema = z.enum(["serve", "jobs"]);
type ContainerRole = z.infer<typeof ContainerRoleSchema>;

// Runtime code continues to consume file references. Only this container
// boundary accepts platform-injected values, and removes them from its env.
export async function prepareContainerEnvironment(
  input: NodeJS.ProcessEnv,
  secretDirectory = SECRET_DIRECTORY,
): Promise<NodeJS.ProcessEnv> {
  const parsed = ContainerSecretsSchema.safeParse(input);
  for (const name of Object.keys(secretFiles)) delete input[name];
  if (!parsed.success) throw new Error("container_secrets_invalid");
  const env = { ...input };
  const references = {
    OPENTAG_RELAY_CONTENT_KEK_FILE: join(secretDirectory, secretFiles.OPENTAG_CONTAINER_RELAY_CONTENT_KEK),
    OPENTAG_SLACK_SIGNING_SECRET_REF: `file:${join(secretDirectory, secretFiles.OPENTAG_CONTAINER_SLACK_SIGNING_SECRET)}`,
    OPENTAG_SLACK_BOT_TOKEN_REF: `file:${join(secretDirectory, secretFiles.OPENTAG_CONTAINER_SLACK_BOT_TOKEN)}`,
  };
  for (const [name, value] of Object.entries(references)) {
    if (env[name] !== undefined && env[name] !== value) {
      throw new Error("container_secret_reference_conflict");
    }
    env[name] = value;
  }
  env.OPENTAG_PORT ??= env.PORT;
  parseControlPlaneConfig(env);
  try {
    await mkdir(secretDirectory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw new Error("container_secret_directory_unavailable");
    }
  }
  const directory = await lstat(secretDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || (directory.mode & 0o777) !== 0o700
    || (process.getuid && directory.uid !== process.getuid())) {
    throw new Error("container_secret_directory_unsafe");
  }
  for (const name of Object.keys(secretFiles) as Array<keyof typeof secretFiles>) {
    const path = join(secretDirectory, secretFiles[name]);
    const content = Buffer.from(parsed.data[name], "utf8");
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | constants.O_NOFOLLOW, 0o400);
      await file.writeFile(content);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw new Error("container_secret_file_unavailable");
      }
      // Restarts may see an existing file. Never replace a mounted secret or
      // silently rotate a key: only the exact private regular file is reusable.
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await existing.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o400
          || stat.size !== content.length
          || (process.getuid && stat.uid !== process.getuid())
          || !(await existing.readFile()).equals(content)) {
          throw new Error("container_secret_file_conflict");
        }
      } finally {
        await existing.close();
      }
    } finally {
      await file?.close();
      content.fill(0);
    }
  }
  return env;
}

export async function waitForContainerDependency(
  probe: () => Promise<boolean>,
  options: { signal: AbortSignal; pollMs?: number },
): Promise<void> {
  while (true) {
    options.signal.throwIfAborted();
    if (await probe()) return;
    await delay(options.pollMs ?? 1_000, undefined, { signal: options.signal });
  }
}

export async function containerControlPlaneReady(input: {
  origin: string; releaseSha: string; signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const origin = new URL(input.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username
    || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("container_control_plane_url_invalid");
  }
  const request = input.fetchImpl ?? fetch;
  try {
    const options = { signal: AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]),
      redirect: "error" as const };
    const ready = await request(new URL("/readyz", origin), options);
    if (!ready.ok) { await ready.body?.cancel(); return false; }
    const state = z.object({ status: z.literal("ready") }).safeParse(await ready.json());
    if (!state.success) return false;
    const response = await request(new URL("/v1/relay/capabilities", origin), options);
    if (!response.ok) { await response.body?.cancel(); return false; }
    const capabilities = RelayCapabilitiesResponseV1Schema.safeParse(await response.json());
    return capabilities.success && capabilities.data.deployment.releaseSha === input.releaseSha;
  } catch {
    // Both requests are read-only observations. A missing or malformed response
    // keeps jobs waiting; the bounded startup deadline makes failure visible.
    return false;
  }
}

export async function startContainerRole(input: {
  role: ContainerRole; env: NodeJS.ProcessEnv; signal: AbortSignal;
  runCommand: CommandRunner;
  waitForDatabase: () => Promise<void>;
  waitForControlPlane: () => Promise<void>;
}): Promise<void> {
  const run = input.runCommand;
  if (input.role === "serve") {
    // Validate every bootstrap input before migrations can mutate the database.
    parseAdminBootstrapConfig(input.env);
    parseSlackBootstrapConfig(input.env);
    await input.waitForDatabase();
    for (const command of ["migrate", "bootstrap-admin", "bootstrap-slack"]) {
      input.signal.throwIfAborted();
      let abort = () => {};
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("container_startup_cancelled"));
          input.signal.addEventListener("abort", abort, { once: true });
          if (input.signal.aborted) abort();
        });
        await Promise.race([run({ argv: [command], env: input.env }), cancelled]);
      } catch {
        throw new Error(`container_${command.replaceAll("-", "_")}_failed`);
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
    }
  } else {
    await input.waitForControlPlane();
  }
  input.signal.throwIfAborted();
  // Long-running roles do not need the owner's bootstrap password.
  delete input.env.OPENTAG_BOOTSTRAP_ADMIN_PASSWORD;
  await run({ argv: [input.role], env: input.env });
}

export async function containerMain(input: {
  argv: readonly string[]; env: NodeJS.ProcessEnv; runCommand: CommandRunner;
}): Promise<void> {
  const role = ContainerRoleSchema.parse(input.argv[0]);
  if (input.argv.length !== 1) throw new Error("container_role_invalid");
  const env = await prepareContainerEnvironment(input.env);
  const config = parseControlPlaneConfig(env);
  const deadline = AbortSignal.timeout(300_000);
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort();
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  const signal = AbortSignal.any([deadline, interrupted.signal]);
  const wait = async (dependency: string, probe: () => Promise<boolean>) => {
    console.info("control_plane_container_waiting", { dependency });
    try { await waitForContainerDependency(probe, { signal }); }
    catch { throw new Error(`container_${dependency}_wait_failed`); }
  };
  try {
    await startContainerRole({ role, env, signal,
      waitForDatabase: async () => {
        const postgres = createPostgresRuntime({ databaseUrl: config.databaseUrl, poolMax: 1 });
        try { await wait("database", async () => (await checkPostgresReadiness(postgres.pool)).ready); }
        finally { await postgres.close(); }
      },
      waitForControlPlane: async () => {
        const origin = env.OPENTAG_CONTAINER_CONTROL_PLANE_URL;
        if (!origin) throw new Error("container_control_plane_url_missing");
        await wait("control_plane", () => containerControlPlaneReady({
          origin, releaseSha: config.releaseSha, signal,
        }));
      },
      runCommand: async (command) => {
        if (command?.argv?.[0] === role) {
          delete input.env.OPENTAG_BOOTSTRAP_ADMIN_PASSWORD;
          process.off("SIGTERM", interrupt);
          process.off("SIGINT", interrupt);
          console.info("control_plane_container_starting", { role, releaseSha: config.releaseSha });
        }
        await input.runCommand(command);
      },
    });
  } finally {
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
  }
}
