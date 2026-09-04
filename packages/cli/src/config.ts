import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  HostedControlRegistrationSchema,
  TrustedRelayAuthorizationV1Schema,
  assertHostedRelayAuthorization,
  canonicalHostedRelayOrigin,
  formatConfigError as formatDaemonConfigError,
  hostedRunnerAuthProblem,
  parseDaemonConfig,
  type OpenTagDaemonConfig
} from "@opentag/local-runtime";
import { z } from "zod";
import type { CliLanguage } from "./catalogs/languages.js";

// Executor ids (repository bindings and the last-used preference) accept any
// trimmed non-empty string so custom executors registered by a standalone runner
// validate; echo, codex, claude-code, cursor, opencode, hermes, and openclaw remain the documented built-ins.
const ExecutorIdSchema = z.string().trim().min(1);
const KeepWorktreeSchema = z.enum(["always", "on_failure", "never"]);
const PositiveIntegerSchema = z.number().int().positive();
const CliLanguageSchema = z.enum(["en", "zh-CN"]);

const SecretRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("env"),
      name: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      path: z.string().trim().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("keychain"),
      service: z.string().trim().min(1),
      account: z.string().trim().min(1)
    })
    .strict()
]);

export type SecretRef = z.infer<typeof SecretRefSchema>;
export type KeychainSecretRef = Extract<SecretRef, { kind: "keychain" }>;

type ExecFileSyncLike = (file: string, args: readonly string[], options: { encoding: "utf8" }) => string | Buffer;

function requireResolvedSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Secret ${label} resolved to an empty value.`);
  }
  return trimmed;
}

export function readKeychainSecret(ref: KeychainSecretRef, execFileSyncImpl: ExecFileSyncLike = execFileSync): string {
  let value: string | Buffer;
  try {
    value = execFileSyncImpl(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", ref.service, "-a", ref.account],
      { encoding: "utf8" }
    );
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
    throw new Error(
      `Secret keychain ref ${ref.service}/${ref.account} could not be resolved via macOS Keychain (/usr/bin/security). Keychain SecretRefs are only supported on macOS.${detail}`
    );
  }
  return requireResolvedSecret(String(value), `keychain ref ${ref.service}/${ref.account}`);
}

function resolveSecretRef(ref: SecretRef): string {
  if (ref.kind === "env") {
    const value = process.env[ref.name];
    if (!value) {
      throw new Error(`Secret env ref ${ref.name} is not set.`);
    }
    return requireResolvedSecret(value, `env ref ${ref.name}`);
  }
  if (ref.kind === "file") {
    let value: string;
    try {
      value = readFileSync(ref.path, "utf8");
    } catch {
      throw new Error(`Secret file ref ${ref.path} could not be resolved.`);
    }
    return requireResolvedSecret(value, `file ref ${ref.path}`);
  }
  return readKeychainSecret(ref);
}

const SecretStringSchema = z.union([z.string().min(1), SecretRefSchema]).transform((value) => {
  return typeof value === "string" ? value : resolveSecretRef(value);
});

function isLocalProcessHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost"
    || normalized === "0.0.0.0"
    || normalized === "::"
    || normalized === "::1"
    || normalized.endsWith(".localhost")
  ) return true;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 127;
}

export function assertRemotePairedRelayEndpoint(input: {
  relayUrl: string;
}): void {
  const relay = new URL(input.relayUrl);
  if (isLocalProcessHostname(relay.hostname)) {
    throw new Error("A paired Runner requires a distinct relay process; loopback and unspecified relay hosts are not allowed.");
  }
}

function assertRawRelayEndpoint(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (raw.runtime !== undefined) {
    throw new Error("Top-level runtime configuration was removed; use daemon.relayUrl.");
  }
  if (!raw.daemon || typeof raw.daemon !== "object" || Array.isArray(raw.daemon)) return;
  const daemon = raw.daemon as Record<string, unknown>;
  if (daemon.dispatcherUrl !== undefined) {
    throw new Error("daemon.dispatcherUrl was removed; use daemon.relayUrl.");
  }
  const relayUrl = z.string().url().parse(daemon.relayUrl);
  canonicalHostedRelayOrigin(relayUrl);
  assertRemotePairedRelayEndpoint({ relayUrl });
}

const RepositoryBindingSchema = z
  .object({
    projectTargetId: z.string().trim().min(1),
    provider: z.literal("github"),
    owner: z.string().min(1),
    repo: z.string().min(1),
    checkoutPath: z.string().min(1),
    defaultExecutor: ExecutorIdSchema,
    baseBranch: z.string().min(1),
    pushRemote: z.string().min(1),
    worktreeRoot: z.string().min(1),
    keepWorktree: KeepWorktreeSchema
  })
  .strict();

const HermesSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    profile: z.string().trim().min(1).optional()
  })
  .strict();

const OpenClawSchema = z
  .object({
    command: z.string().trim().min(1).optional(),
    profile: z.string().trim().min(1).optional(),
    gatewayUrl: z.string().url().optional(),
    expectedVersion: z.string().trim().min(1).optional()
  })
  .strict();

const AgentSessionProfileSchema = z
  .object({
    profile: z.string().trim().min(1).optional(),
    profileTemplate: z.string().trim().min(1).optional()
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

const AcpAgentSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().trim().min(1).optional(),
    workspaceCwd: z.literal("required"),
    sessionModeId: z.string().trim().min(1).optional(),
    supportsProfile: z.boolean().default(false),
    supportsCancel: z.boolean().default(false),
    readinessTimeoutMs: PositiveIntegerSchema.optional()
  })
  .strict();

const DaemonConfigSchema = z
  .object({
    runnerId: z.string().min(1),
    relayUrl: z.string().url(),
    repositories: z.array(RepositoryBindingSchema).default([]),
    agents: z.record(z.string(), AcpAgentSchema).optional(),
    scratchRoot: z.string().min(1).optional(),
    keepScratch: KeepWorktreeSchema.optional(),
    approvalMode: z.enum(["ask", "auto", "autonomous"]).optional(),
    hermes: HermesSchema.optional(),
    openclaw: OpenClawSchema.optional(),
    agentSessionProfile: AgentSessionProfileSchema.optional(),
    security: SecuritySchema.optional(),
    githubToken: SecretStringSchema.optional(),
    runnerToken: SecretStringSchema.optional(),
    controlRegistration: HostedControlRegistrationSchema.optional(),
    trustedRelay: TrustedRelayAuthorizationV1Schema.optional(),
    pollIntervalMs: PositiveIntegerSchema,
    heartbeatIntervalMs: PositiveIntegerSchema,
    runTimeoutMs: PositiveIntegerSchema.optional()
  })
  .strict();

const PreferencesSchema = z
  .object({
    language: CliLanguageSchema.optional(),
  })
  .strict();

const CanonicalOpenTagCliConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z
      .object({
        directory: z.string().min(1),
        databasePath: z.string().min(1),
        worktreeRoot: z.string().min(1)
      })
      .strict(),
    preferences: PreferencesSchema.optional(),
    daemon: DaemonConfigSchema
  })
  .strict()
  .superRefine((config, context) => {
    if (!config.daemon.controlRegistration) return;
    try {
      assertHostedRelayAuthorization({
        relayUrl: config.daemon.relayUrl,
        trustedRelay: config.daemon.trustedRelay
      });
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["daemon", "trustedRelay"],
        message: error instanceof Error ? error.message : "Hosted relay authorization is invalid."
      });
    }
  });

export const OpenTagCliConfigSchema = CanonicalOpenTagCliConfigSchema;

export type OpenTagCliConfig = Omit<z.infer<typeof OpenTagCliConfigSchema>, "daemon"> & {
  daemon: OpenTagDaemonConfig;
};

export type OpenTagCliPreferences = NonNullable<OpenTagCliConfig["preferences"]>;
export type OpenTagCliLanguage = CliLanguage;
export type OpenTagCliExecutor = string;

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

function formatPath(path: PropertyKey[]): string {
  return path.length ? path.map(String).join(".") : "config";
}

export function formatCliConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`).join("\n");
  }
  return formatDaemonConfigError(error);
}

function assertHostedControlRawTrust(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (!raw.daemon || typeof raw.daemon !== "object" || Array.isArray(raw.daemon)) return;
  const daemon = raw.daemon as Record<string, unknown>;
  if (daemon.controlRegistration === undefined) return;
  const relayUrl = z.string().url().parse(daemon.relayUrl);
  assertHostedRelayAuthorization({
    relayUrl,
    trustedRelay: daemon.trustedRelay === undefined
      ? undefined
      : TrustedRelayAuthorizationV1Schema.parse(daemon.trustedRelay)
  });
}

export function parseCliConfig(value: unknown): OpenTagCliConfig {
  assertRawRelayEndpoint(value);
  assertHostedControlRawTrust(value);
  const parsed = OpenTagCliConfigSchema.parse(value);
  return {
    ...parsed,
    daemon: parseDaemonConfig(parsed.daemon)
  };
}

export { hostedRunnerAuthProblem };

export function relayUrlFromConfig(config: OpenTagCliConfig): string {
  return config.daemon.relayUrl;
}

export function readCliConfig(path = defaultConfigPath()): OpenTagCliConfig {
  assertPrivateConfigFile(path);
  return parseCliConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function readCliRawConfig(path = defaultConfigPath()): unknown {
  assertPrivateConfigFile(path);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function ensurePrivateDirectory(
  path: string,
  filesystem: CliConfigFilesystemOps = CLI_CONFIG_FILESYSTEM_OPS
): void {
  const createdPath = filesystem.mkdir(path, { recursive: true, mode: 0o700 });
  if (createdPath) {
    filesystem.chmod(path, 0o700);
  }
}

export const CLI_CONFIG_DIRECTORY_DURABILITY =
  process.platform === "win32" ? "atomic_replace" : "directory_fsync";

export class CliConfigWriteOutcomeUnknownError extends Error {
  readonly code = "config_write_outcome_unknown";

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "CliConfigWriteOutcomeUnknownError";
  }
}

export type CliConfigFilesystemOps = {
  chmod(path: string, mode: number): void;
  close(file: number): void;
  fchmod(file: number, mode: number): void;
  fsync(file: number): void;
  lstat(path: string): {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
  };
  mkdir(path: string, options: { recursive: true; mode: number }): string | undefined;
  open(path: string, flags: string, mode?: number): number;
  readFile(path: string): string;
  rename(from: string, to: string): void;
  remove(path: string): void;
  stat(path: string): { mode: number };
  writeFile(
    target: string | number,
    contents: string,
    options: "utf8" | { mode: number; flag: string }
  ): void;
};

export const CLI_CONFIG_FILESYSTEM_OPS: CliConfigFilesystemOps = {
  chmod: chmodSync,
  close: closeSync,
  fchmod: fchmodSync,
  fsync: fsyncSync,
  lstat: lstatSync,
  mkdir: (path, options) => mkdirSync(path, options),
  open: openSync,
  readFile: (path) => readFileSync(path, "utf8"),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
  stat: statSync,
  writeFile: (target, contents, options) => writeFileSync(target, contents, options)
};

function combinedFailure(primary: unknown, cleanup: unknown, message: string): unknown {
  if (primary === undefined) return cleanup;
  if (cleanup === undefined) return primary;
  return new AggregateError([primary, cleanup], message, { cause: primary });
}

function releaseConfigLock(
  lockPath: string,
  lockFile: number | undefined,
  filesystem: CliConfigFilesystemOps
): unknown {
  let cleanupError: unknown;
  if (lockFile !== undefined) {
    try {
      filesystem.close(lockFile);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    filesystem.remove(lockPath);
  } catch (error) {
    cleanupError = combinedFailure(cleanupError, error, "OpenTag config lock cleanup failed.");
  }
  try {
    fsyncDirectory(dirname(lockPath), filesystem);
  } catch (error) {
    cleanupError = combinedFailure(cleanupError, error, "OpenTag config lock cleanup failed.");
  }
  return cleanupError;
}

function configLockRecord(path: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    configPath: path,
    createdAt: new Date().toISOString()
  })}\n`;
}

const MAX_CONFIG_LOCK_RECORD_BYTES = 4_096;

function readableConfigLockRecord(lockPath: string, filesystem: CliConfigFilesystemOps): string {
  try {
    const stats = filesystem.lstat(lockPath);
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || stats.size <= 0
      || stats.size > MAX_CONFIG_LOCK_RECORD_BYTES
    ) {
      throw new Error("invalid lock record file");
    }
    const raw = filesystem.readFile(lockPath).trim();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid lock record");
    }
    const record = parsed as Record<string, unknown>;
    const createdAt = record.createdAt;
    const keys = Object.keys(record).sort();
    if (
      keys.join("\u0000") !== ["configPath", "createdAt", "pid", "schemaVersion"].join("\u0000")
      || record.schemaVersion !== 1
      || typeof record.pid !== "number"
      || !Number.isSafeInteger(record.pid)
      || record.pid <= 0
      || typeof record.configPath !== "string"
      || record.configPath.length === 0
      || record.configPath.length > 4_096
      || typeof createdAt !== "string"
      || createdAt.length > 64
    ) {
      throw new Error("invalid lock record");
    }
    const createdAtMs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== createdAt) {
      throw new Error("invalid lock record");
    }
    return JSON.stringify({
      schemaVersion: 1,
      pid: record.pid,
      createdAt: new Date(createdAtMs).toISOString()
    });
  } catch {
    return JSON.stringify({ schemaVersion: 1, status: "unreadable_or_invalid" });
  }
}

function withCliConfigLock<T>(
  path: string,
  operation: () => T,
  filesystem: CliConfigFilesystemOps
): T {
  ensurePrivateDirectory(dirname(path), filesystem);
  const lockPath = `${path}.lock`;
  let lockFile: number | undefined;
  try {
    lockFile = filesystem.open(lockPath, "wx", 0o600);
    filesystem.fchmod(lockFile, 0o600);
    filesystem.writeFile(lockFile, configLockRecord(path), "utf8");
    filesystem.fsync(lockFile);
  } catch (error) {
    // If openSync failed with EEXIST, lockFile is undefined and the adjacent
    // lock belongs to another process. Never remove another writer's lock.
    const cleanupError =
      lockFile === undefined ? undefined : releaseConfigLock(lockPath, lockFile, filesystem);
    if (
      lockFile === undefined &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      const lockRecord = readableConfigLockRecord(lockPath, filesystem);
      throw new Error(
        `OpenTag config is locked by another writer at ${lockPath}. Lock record: ${lockRecord}. `
          + `Retry after that writer releases the lock. If the lock remains stale, verify the recorded process identity first; `
          + `only after confirming that exact writer is no longer running, manually delete the exact lock path ${JSON.stringify(lockPath)}. `
          + "OpenTag will not delete a lock based on PID alone.",
        { cause: combinedFailure(error, cleanupError, "OpenTag config lock acquisition failed.") }
      );
    }
    throw combinedFailure(error, cleanupError, "OpenTag config lock acquisition failed.");
  }

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  const cleanupError = releaseConfigLock(lockPath, lockFile, filesystem);
  if (operationError !== undefined) {
    const failure = combinedFailure(
      operationError,
      cleanupError,
      "OpenTag config write and lock cleanup failed."
    );
    if (operationError instanceof CliConfigWriteOutcomeUnknownError) {
      if (cleanupError === undefined) throw operationError;
      throw new CliConfigWriteOutcomeUnknownError(operationError.message, failure);
    }
    throw failure;
  }
  if (cleanupError !== undefined) {
    throw new CliConfigWriteOutcomeUnknownError(
      "OpenTag config write completed, but releasing its writer lock could not be confirmed.",
      cleanupError
    );
  }
  return result as T;
}

function replaceConfigFileDurably(
  path: string,
  contents: string,
  validateReadback: (contents: string) => void,
  filesystem: CliConfigFilesystemOps
): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let tempFile: number | undefined;
  let renamed = false;
  try {
    tempFile = filesystem.open(tempPath, "wx", 0o600);
    filesystem.fchmod(tempFile, 0o600);
    filesystem.writeFile(tempFile, contents, "utf8");
    filesystem.fsync(tempFile);
    const fileToClose = tempFile;
    tempFile = undefined;
    filesystem.close(fileToClose);
    filesystem.rename(tempPath, path);
    renamed = true;
    fsyncDirectory(dirname(path), filesystem);
    validateReadback(filesystem.readFile(path));
  } catch (error) {
    let cleanupError: unknown;
    if (tempFile !== undefined) {
      const fileToClose = tempFile;
      tempFile = undefined;
      try {
        filesystem.close(fileToClose);
      } catch (closeError) {
        cleanupError = closeError;
      }
    }
    if (!renamed) {
      try {
        filesystem.remove(tempPath);
      } catch (removeError) {
        cleanupError = combinedFailure(
          cleanupError,
          removeError,
          "OpenTag temporary config cleanup failed."
        );
      }
    }
    const failure = combinedFailure(error, cleanupError, "OpenTag config write cleanup failed.");
    if (renamed) {
      throw new CliConfigWriteOutcomeUnknownError(
        "OpenTag config was replaced, but its durable readback could not be confirmed.",
        failure
      );
    }
    throw failure;
  }
}

export function writeCliConfigAtomic(
  path: string,
  config: OpenTagCliConfig,
  filesystem: CliConfigFilesystemOps = CLI_CONFIG_FILESYSTEM_OPS
): void {
  withCliConfigLock(path, () => {
    replaceConfigFileDurably(path, `${JSON.stringify(config, null, 2)}\n`, (contents) => {
      parseCliConfig(JSON.parse(contents));
    }, filesystem);
  }, filesystem);
}

export type HostedControlConfigPatch = {
  controlRegistration: NonNullable<OpenTagDaemonConfig["controlRegistration"]>;
  relayUrl: string;
  trustedRelay?: NonNullable<OpenTagDaemonConfig["trustedRelay"]>;
  runnerToken?: string | null;
};

function requireRawConfigObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenTag config must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function fsyncDirectory(
  path: string,
  filesystem: CliConfigFilesystemOps = CLI_CONFIG_FILESYSTEM_OPS
): void {
  // Node does not expose a portable Windows directory-fsync primitive. Windows
  // therefore gets atomic replacement and readback, but not the POSIX crash-
  // durability claim represented by CLI_CONFIG_DIRECTORY_DURABILITY.
  if (CLI_CONFIG_DIRECTORY_DURABILITY === "atomic_replace") return;
  const directory = filesystem.open(path, "r");
  let fsyncError: unknown;
  try {
    filesystem.fsync(directory);
  } catch (error) {
    fsyncError = error;
  }
  let closeError: unknown;
  try {
    filesystem.close(directory);
  } catch (error) {
    closeError = error;
  }
  const failure = combinedFailure(
    fsyncError,
    closeError,
    "OpenTag directory fsync and close both failed."
  );
  if (failure !== undefined) throw failure;
}

const RawSecretValueSchema = z.union([z.string().min(1), SecretRefSchema]);

const RAW_SECRET_STRING_PATHS = [
  ["daemon", "githubToken"],
  ["daemon", "runnerToken"],
] as const satisfies readonly (readonly string[])[];

function replaceKnownRawSecretField(
  value: unknown,
  path: readonly string[],
  index = 0
): unknown {
  if (index === path.length) {
    if (value === null || value === undefined) return value;
    RawSecretValueSchema.parse(value);
    return "raw-secret-ref";
  }
  const segment = path[index]!;
  if (segment === "*") {
    if (Array.isArray(value)) {
      return value.map((entry) => replaceKnownRawSecretField(entry, path, index + 1));
    }
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceKnownRawSecretField(entry, path, index + 1)
      ])
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!(segment in record)) return value;
  return {
    ...record,
    [segment]: replaceKnownRawSecretField(record[segment], path, index + 1)
  };
}

function replaceKnownRawSecretFields(value: unknown): unknown {
  return RAW_SECRET_STRING_PATHS.reduce(
    (projected, path) => replaceKnownRawSecretField(projected, path),
    value
  );
}

export const OpenTagCliRawConfigSchema = z.preprocess(
  replaceKnownRawSecretFields,
  OpenTagCliConfigSchema
);

function validateHostedControlRawConfig(value: unknown): void {
  const raw = requireRawConfigObject(value);
  OpenTagCliRawConfigSchema.parse(raw);
  const daemon = requireRawConfigObject(raw.daemon);
  const relayUrl = z.string().url().parse(daemon.relayUrl);
  HostedControlRegistrationSchema.parse(daemon.controlRegistration);
  assertHostedRelayAuthorization({
    relayUrl,
    trustedRelay: TrustedRelayAuthorizationV1Schema.parse(daemon.trustedRelay)
  });
  if (daemon.runnerToken !== undefined) {
    RawSecretValueSchema.parse(daemon.runnerToken);
  }
}

export function writeHostedControlConfigAtomic(
  path: string,
  patch: HostedControlConfigPatch,
  filesystem: CliConfigFilesystemOps = CLI_CONFIG_FILESYSTEM_OPS
): void {
  withCliConfigLock(path, () => {
    assertPrivateConfigFile(path, filesystem);
    const raw = requireRawConfigObject(JSON.parse(filesystem.readFile(path)));
    const daemon = requireRawConfigObject(raw.daemon);
    const patchedDaemon: Record<string, unknown> = {
      ...daemon,
      relayUrl: patch.relayUrl,
      controlRegistration: patch.controlRegistration,
      trustedRelay: patch.trustedRelay ?? daemon.trustedRelay
    };
    if (patch.runnerToken === null) delete patchedDaemon.runnerToken;
    else if (patch.runnerToken !== undefined) {
      patchedDaemon.runnerToken = z.string().min(1).parse(patch.runnerToken);
    }

    const patched: Record<string, unknown> = {
      ...raw,
      daemon: patchedDaemon
    };
    validateHostedControlRawConfig(patched);
    replaceConfigFileDurably(path, `${JSON.stringify(patched, null, 2)}\n`, (contents) => {
      validateHostedControlRawConfig(JSON.parse(contents));
    }, filesystem);
  }, filesystem);
}

export function assertPrivateConfigFile(
  path: string,
  filesystem: CliConfigFilesystemOps = CLI_CONFIG_FILESYSTEM_OPS
): void {
  if (process.platform === "win32") return;
  const mode = filesystem.stat(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`OpenTag config contains secrets and must not be readable by group or others: ${path}\nFix it with: chmod 600 ${path}`);
  }
}

function redactSecretValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ref = value as { account?: unknown; kind?: unknown; name?: unknown; path?: unknown; service?: unknown };
    if (ref.kind === "env" && typeof ref.name === "string") {
      return `[env:${ref.name}]`;
    }
    if (ref.kind === "file" && typeof ref.path === "string") {
      return `[file:${ref.path}]`;
    }
    if (ref.kind === "keychain" && typeof ref.service === "string" && typeof ref.account === "string") {
      return `[keychain:${ref.service}/${ref.account}]`;
    }
  }
  return "[REDACTED]";
}

function redactValue(key: string, value: unknown): unknown {
  if (
    [
      "appPassword",
      "appSecret",
      "appToken",
      "botToken",
      "clientSecret",
      "githubToken",
      "refreshToken",
      "runnerToken",
      "secretToken",
      "signingSecret",
      "token",
      "webhookSecret"
    ].includes(key)
  ) {
    return redactSecretValue(value);
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

export function redactedCliConfigValue(value: unknown): unknown {
  return redactValue("", value);
}

export function readRedactedCliConfig(path = defaultConfigPath()): unknown {
  assertPrivateConfigFile(path);
  return redactedCliConfigValue(JSON.parse(readFileSync(path, "utf8")));
}
