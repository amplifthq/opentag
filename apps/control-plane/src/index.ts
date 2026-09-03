import { fileURLToPath } from "node:url";
import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  parseAdminBootstrapConfig,
  parseControlPlaneConfig,
  parseSlackBootstrapConfig,
} from "./config.js";
import {
  loadSqlMigrations,
  runMigrations,
} from "./database/migrations.js";
import { createPostgresRuntime } from "./database/postgres.js";
import { startNodeServer } from "./node-server.js";
import { runJobLoop, runOneJob } from "./modules/jobs/worker.js";
import { createControlPlaneRuntime } from "./runtime.js";
import { bootstrapSlackInstallation } from "./modules/slack-installation-bootstrap/index.js";
import type { ControlPlaneConfig } from "./config.js";
import type { SqlMigration } from "./database/migrations.js";

export function createEnvironmentSlackSecretResolver(
  env: Record<string, string | undefined>,
  options: { fileRoot?: string } = {},
) {
  const fileRoot = resolve(options.fileRoot ?? "/run/secrets");
  return { async resolve(reference: string) {
    const environmentMatch = reference.match(/^env:([A-Z][A-Z0-9_]*)$/u);
    if (environmentMatch) {
      const value = env[environmentMatch[1]!];
      if (!value) throw new Error("slack_secret_unavailable");
      return value;
    }
    const fileMatch = reference.match(/^file:(\/.*)$/u);
    if (!fileMatch) throw new Error("slack_secret_reference_unsupported");
    const path = resolve(fileMatch[1]!);
    if (dirname(path) !== fileRoot) {
      throw new Error("slack_secret_reference_unsupported");
    }
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.size < 1 || metadata.size > 4096) {
        throw new Error("invalid secret file");
      }
      const bytes = await readFile(path);
      let value = bytes.toString("utf8");
      if (value.endsWith("\n")) value = value.slice(0, -1);
      if (value.endsWith("\r")) value = value.slice(0, -1);
      if (!value || value.length > 4096 || value.includes("\0") || value.includes("\ufffd")) {
        throw new Error("invalid secret file");
      }
      return value;
    } catch {
      throw new Error("slack_secret_unavailable");
    }
  } };
}

export function createProductionControlPlaneRuntime(input: {
  config: ControlPlaneConfig; migrations: readonly SqlMigration[];
  env: Record<string, string | undefined>;
  postgres?: NonNullable<Parameters<typeof createControlPlaneRuntime>[0]["postgres"]>;
}) {
  return createControlPlaneRuntime({ config: input.config, migrations: input.migrations,
    slackSecrets: createEnvironmentSlackSecretResolver(input.env),
    ...(input.postgres ? { postgres: input.postgres } : {}) });
}

const migrationDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export async function main(input: {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
} = {}): Promise<void> {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const command = argv[0] ?? "serve";
  const config = parseControlPlaneConfig(env);
  const migrations = await loadSqlMigrations(migrationDirectory);

  if (command === "migrate") {
    const postgres = createPostgresRuntime({
      databaseUrl: config.databaseUrl,
      poolMax: 1,
    });
    try {
      await runMigrations(postgres.pool, migrations);
    } finally {
      await postgres.close();
    }
    return;
  }

  if (command === "bootstrap-admin") {
    const runtime = createProductionControlPlaneRuntime({ config, migrations, env });
    try {
      const admin = parseAdminBootstrapConfig(env);
      const outcome = await runtime.identity.provisionOwner({
        organizationId: config.bootstrapOrganizationId,
        organizationName: config.bootstrapOrganizationName,
        email: admin.email,
        displayName: admin.displayName,
        password: admin.password,
      });
      if (outcome.kind === "conflict") {
        throw new Error("bootstrap_admin_conflict");
      }
    } finally {
      await runtime.close();
    }
    return;
  }

  if (command === "bootstrap-slack") {
    const postgres = createPostgresRuntime({
      databaseUrl: config.databaseUrl,
      poolMax: 2,
    });
    try {
      const outcome = await bootstrapSlackInstallation({
        pool: postgres.pool,
        organizationId: config.bootstrapOrganizationId,
        config: parseSlackBootstrapConfig(env),
        secrets: createEnvironmentSlackSecretResolver(env),
      });
      if (outcome.kind === "conflict") {
        throw new Error(`bootstrap_slack_${outcome.reason}`);
      }
      console.log(`Slack installation bootstrap ${outcome.kind}: binding=${outcome.bindingDigest}; credentialGeneration=${outcome.credentialGeneration}`);
    } finally {
      await postgres.close();
    }
    return;
  }

  if (command === "jobs") {
    const runtime = createProductionControlPlaneRuntime({ config, migrations, env });
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    process.once("SIGTERM", abort);
    process.once("SIGINT", abort);
    try {
      const readiness = await runtime.application.fetch(
        new Request(`${config.publicOrigin}/readyz`),
      );
      if (!readiness.ok) throw new Error("control_plane_not_ready");
      const workerInput = {
        queue: runtime.jobs,
        workerId: `jobs_${process.pid}`,
        handlers: runtime.jobHandlers,
        retryDelayMs: config.jobRetryDelayMs,
        clock: { now: () => new Date() },
        beforeClaim: async () => {
          await runtime.scheduleJobs();
          await runtime.sourceIngressWorker?.processNext();
        },
      };
      if (argv.includes("--once")) {
        await runOneJob(workerInput);
      } else {
        await runJobLoop({
          ...workerInput,
          pollIntervalMs: config.jobPollIntervalMs,
          signal: abortController.signal,
        });
      }
    } finally {
      process.off("SIGTERM", abort);
      process.off("SIGINT", abort);
      await runtime.close();
    }
    return;
  }

  if (command !== "serve") {
    throw new Error("unsupported_control_plane_command");
  }

  const runtime = createProductionControlPlaneRuntime({ config, migrations, env });
  const server = startNodeServer({
    application: runtime.application,
    consoleAssetsDirectory: fileURLToPath(new URL("./console", import.meta.url)),
    host: config.host,
    port: config.port,
    drain: runtime.close,
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
