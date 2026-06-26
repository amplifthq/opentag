import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatConfigError as formatDaemonConfigError, parseDaemonConfig, type OpenTagDaemonConfig } from "@opentag/local-runtime";
import { z } from "zod";

const ExecutorSchema = z.enum(["echo", "codex", "claude-code"]);
const KeepWorktreeSchema = z.enum(["always", "on_failure", "never"]);
const PositiveIntegerSchema = z.number().int().positive();

const RepositoryBindingSchema = z
  .object({
    provider: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    checkoutPath: z.string().min(1),
    defaultExecutor: ExecutorSchema,
    baseBranch: z.string().min(1),
    pushRemote: z.string().min(1),
    worktreeRoot: z.string().min(1),
    keepWorktree: KeepWorktreeSchema
  })
  .strict();

const ChannelBindingSchema = z
  .object({
    provider: z.string().min(1),
    accountId: z.string().min(1),
    conversationId: z.string().min(1),
    repoProvider: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

const ClaudeCodeSchema = z
  .object({
    command: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permissionMode: z.enum(["acceptEdits", "auto", "bypassPermissions", "default", "plan"]).optional(),
    dangerouslySkipPermissions: z.boolean().optional()
  })
  .strict();

const SecuritySchema = z
  .object({
    mode: z.enum(["enforce", "audit", "off"]).optional(),
    allowedWorkspaceRoot: z.string().min(1).optional(),
    allowUnsafePrompts: z.boolean().optional(),
    extraSafeEnv: z.array(z.string().min(1)).optional()
  })
  .strict();

const DaemonConfigSchema = z
  .object({
    runnerId: z.string().min(1),
    dispatcherUrl: z.string().url(),
    repositories: z.array(RepositoryBindingSchema).min(1),
    channelBindings: z.array(ChannelBindingSchema).optional(),
    claudeCode: ClaudeCodeSchema.optional(),
    security: SecuritySchema.optional(),
    githubToken: z.string().min(1).optional(),
    allowAutoCreatePullRequest: z.boolean().optional(),
    pairingToken: z.string().min(1),
    pollIntervalMs: PositiveIntegerSchema,
    heartbeatIntervalMs: PositiveIntegerSchema
  })
  .strict();

const LarkPlatformSchema = z
  .object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    domain: z.enum(["lark", "feishu"]),
    botOpenId: z.string().min(1).optional()
  })
  .strict();

export const OpenTagCliConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z
      .object({
        directory: z.string().min(1),
        databasePath: z.string().min(1),
        worktreeRoot: z.string().min(1)
      })
      .strict(),
    daemon: DaemonConfigSchema,
    platforms: z
      .object({
        lark: LarkPlatformSchema.optional()
      })
      .strict()
  })
  .strict();

export type OpenTagCliConfig = Omit<z.infer<typeof OpenTagCliConfigSchema>, "daemon"> & {
  daemon: OpenTagDaemonConfig;
};

export type PathEnvironment = Partial<
  Record<"OPENTAG_CONFIG_PATH" | "OPENTAG_CONFIG_HOME" | "OPENTAG_STATE_DIR" | "XDG_CONFIG_HOME" | "XDG_STATE_HOME", string>
>;

function configHome(env: PathEnvironment, home = homedir()): string {
  if (env.OPENTAG_CONFIG_HOME) return resolve(env.OPENTAG_CONFIG_HOME);
  if (env.XDG_CONFIG_HOME) return resolve(env.XDG_CONFIG_HOME, "opentag");
  return join(home, ".config", "opentag");
}

export function defaultConfigPath(env: PathEnvironment = process.env, home = homedir()): string {
  if (env.OPENTAG_CONFIG_PATH) return resolve(env.OPENTAG_CONFIG_PATH);
  return join(configHome(env, home), "config.json");
}

export function defaultStateDirectory(env: PathEnvironment = process.env, home = homedir()): string {
  if (env.OPENTAG_STATE_DIR) return resolve(env.OPENTAG_STATE_DIR);
  if (env.XDG_STATE_HOME) return resolve(env.XDG_STATE_HOME, "opentag");
  return join(home, ".local", "state", "opentag");
}

function formatPath(path: Array<string | number>): string {
  return path.length ? path.join(".") : "config";
}

export function formatCliConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`).join("\n");
  }
  return formatDaemonConfigError(error);
}

export function parseCliConfig(value: unknown): OpenTagCliConfig {
  const parsed = OpenTagCliConfigSchema.parse(value);
  return {
    ...parsed,
    daemon: parseDaemonConfig(parsed.daemon)
  };
}

export function readCliConfig(path = defaultConfigPath()): OpenTagCliConfig {
  return parseCliConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

export function writeCliConfigAtomic(path: string, config: OpenTagCliConfig): void {
  ensurePrivateDirectory(dirname(path));
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function assertPrivateConfigFile(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`OpenTag config must not be readable by group or others: ${path}`);
  }
}

function redactValue(key: string, value: unknown): unknown {
  if (["appSecret", "pairingToken", "githubToken"].includes(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue("", entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryKey, entryValue)]));
  }
  return value;
}

export function redactedCliConfig(config: OpenTagCliConfig): unknown {
  return redactValue("", config);
}
