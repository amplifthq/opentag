import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { RunnerCredentialMetadataV1Schema } from "@opentag/core";
import { z } from "zod";

const BUILT_IN_EXECUTOR_IDS = ["echo", "codex", "claude-code", "cursor", "opencode", "hermes", "openclaw"] as const;
const ExecutorSchema = z.string().trim().min(1);
const KeepWorktreeSchema = z.enum(["always", "on_failure", "never"]);
const PositiveIntegerSchema = z.number().int().positive();

export const HostedControlRegistrationMetadataSchema = RunnerCredentialMetadataV1Schema.omit({
  operationId: true,
});

export type HostedControlRegistrationMetadata = z.infer<typeof HostedControlRegistrationMetadataSchema>;

const HostedControlInitialRegistrationSchema = z.object({
  kind: z.literal("hosted_control_v1"),
  state: z.literal("unpaired"),
  flow: z.literal("registration"),
  operationId: z.string().trim().min(1),
  reason: z.enum(["pending", "outcome_unknown"]),
}).strict();

const HostedControlReprovisionRegistrationSchema = z.object({
  kind: z.literal("hosted_control_v1"),
  state: z.literal("unpaired"),
  flow: z.literal("reprovision"),
  operationId: z.string().trim().min(1),
  reason: z.enum(["pending", "outcome_unknown"]),
  recoveryCredentialId: z.string().trim().min(1),
  registration: HostedControlRegistrationMetadataSchema,
}).strict();

const HostedControlRecoveryRequiredRegistrationSchema = z.object({
  kind: z.literal("hosted_control_v1"),
  state: z.literal("unpaired"),
  reason: z.literal("recovery_required"),
  registration: HostedControlRegistrationMetadataSchema,
}).strict();

const HostedControlStagedRegistrationSchema = z.object({
  kind: z.literal("hosted_control_v1"),
  state: z.literal("credential_staged"),
  operationId: z.string().trim().min(1),
  registration: HostedControlRegistrationMetadataSchema,
}).strict();

const HostedControlPairedRegistrationSchema = z.object({
  kind: z.literal("hosted_control_v1"),
  state: z.literal("paired"),
  operationId: z.string().trim().min(1),
  registration: HostedControlRegistrationMetadataSchema,
}).strict();

export const HostedControlRegistrationSchema = z.union([
  HostedControlInitialRegistrationSchema,
  HostedControlReprovisionRegistrationSchema,
  HostedControlRecoveryRequiredRegistrationSchema,
  HostedControlStagedRegistrationSchema,
  HostedControlPairedRegistrationSchema,
]);

export type HostedControlRegistration = z.infer<typeof HostedControlRegistrationSchema>;

export const TrustedRelayAuthorizationV1Schema = z.object({
  schemaVersion: z.literal(1),
  origin: z.string().trim().min(1),
  authorizedAt: z.iso.datetime({ offset: true }),
  authorizationMethod: z.literal("explicit_cli"),
}).strict().superRefine((authorization, ctx) => {
  try {
    if (canonicalHostedRelayOrigin(authorization.origin) !== authorization.origin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["origin"],
        message: "Trusted relay origin must be the exact canonical HTTPS origin.",
      });
    }
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["origin"],
      message: error instanceof Error ? error.message : "Trusted relay origin is invalid.",
    });
  }
});

export type TrustedRelayAuthorizationV1 = z.infer<typeof TrustedRelayAuthorizationV1Schema>;

export function canonicalHostedRelayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Hosted relay URL must be a valid HTTPS origin.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Hosted relay URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Hosted relay URL must not contain userinfo.");
  }
  if (url.pathname !== "/") {
    throw new Error("Hosted relay URL must be origin-only and must not contain a path.");
  }
  if (url.search) {
    throw new Error("Hosted relay URL must not contain a query.");
  }
  if (url.hash) {
    throw new Error("Hosted relay URL must not contain a fragment.");
  }
  return url.origin;
}

const HostedRelayUrlSchema = z.string().url().superRefine((value, ctx) => {
  try {
    canonicalHostedRelayOrigin(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Hosted relay URL is invalid.",
    });
  }
});

export function assertHostedRelayAuthorization(input: {
  relayUrl: string;
  trustedRelay: TrustedRelayAuthorizationV1 | undefined;
}): void {
  if (!input.trustedRelay) {
    throw new Error("Hosted Control V1 requires an explicit trustedRelay authorization before secrets or network access.");
  }
  const trusted = TrustedRelayAuthorizationV1Schema.parse(input.trustedRelay);
  const relayOrigin = canonicalHostedRelayOrigin(input.relayUrl);
  if (relayOrigin !== trusted.origin) {
    throw new Error("Hosted Control V1 relay origin does not match the explicitly trusted relay origin.");
  }
}

function defaultLocalStateDirectory(): string {
  if (process.env.OPENTAG_STATE_DIR) return resolve(process.env.OPENTAG_STATE_DIR);
  if (process.env.XDG_STATE_HOME) return resolve(process.env.XDG_STATE_HOME, "opentag");
  return join(homedir(), ".local", "state", "opentag");
}

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, "Path must be absolute.");

const SecretRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("env"), name: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("file"), path: z.string().trim().min(1) }).strict(),
  z.object({
    kind: z.literal("keychain"),
    service: z.string().trim().min(1),
    account: z.string().trim().min(1),
  }).strict(),
]);

export type SecretRef = z.infer<typeof SecretRefSchema>;
export type KeychainSecretRef = Extract<SecretRef, { kind: "keychain" }>;

type ExecFileSyncLike = (file: string, args: readonly string[], options: { encoding: "utf8" }) => string | Buffer;

function requireResolvedSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Secret ${label} resolved to an empty value.`);
  return trimmed;
}

export function readKeychainSecret(
  ref: KeychainSecretRef,
  execFileSyncImpl: ExecFileSyncLike = execFileSync,
): string {
  let value: string | Buffer;
  try {
    value = execFileSyncImpl(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", ref.service, "-a", ref.account],
      { encoding: "utf8" },
    );
  } catch {
    throw new Error(`Secret keychain ref ${ref.service}/${ref.account} could not be resolved.`);
  }
  return requireResolvedSecret(String(value), `keychain ref ${ref.service}/${ref.account}`);
}

function resolveSecretRef(ref: SecretRef): string {
  if (ref.kind === "env") {
    const value = process.env[ref.name];
    if (!value) throw new Error(`Secret env ref ${ref.name} is not set.`);
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

const SecretStringSchema = z.union([z.string().min(1), SecretRefSchema]).transform((value) =>
  typeof value === "string" ? value : resolveSecretRef(value)
);

const HermesAcpConfigSchema = z.object({
  command: z.string().trim().min(1).optional(),
  profile: z.string().trim().min(1).optional(),
}).strict();

const OpenClawAcpConfigSchema = z.object({
  command: z.string().trim().min(1).optional(),
  profile: z.string().trim().min(1).optional(),
  gatewayUrl: z.string().url().optional(),
  expectedVersion: z.string().trim().min(1).optional(),
}).strict();

const AgentSessionProfileConfigSchema = z.object({
  profile: z.string().trim().min(1).optional(),
  profileTemplate: z.string().trim().min(1).optional(),
}).strict();

const RunnerSecurityPolicySchema = z.object({
  mode: z.enum(["enforce", "audit", "off"]).optional(),
  allowedWorkspaceRoot: z.string().min(1).optional(),
  allowUnsafePrompts: z.boolean().optional(),
  extraSafeEnv: z.array(z.string().min(1)).optional(),
}).strict();

export const AcpAgentConfigSchema = z.object({
  label: z.string().trim().min(1).optional(),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().trim().min(1).optional(),
  workspaceCwd: z.literal("required"),
  sessionModeId: z.string().trim().min(1).optional(),
  supportsProfile: z.boolean().default(false),
  supportsCancel: z.boolean().default(false),
  readinessTimeoutMs: PositiveIntegerSchema.optional(),
}).strict();

export function canonicalRepositoryIdentity(input: {
  provider: string;
  owner: string;
  repo: string;
}): { provider: string; owner: string; repo: string } {
  if (input.provider.toLowerCase() !== "github") return { ...input };
  return {
    provider: "github",
    owner: input.owner.toLowerCase(),
    repo: input.repo.toLowerCase(),
  };
}

export const RepositoryBindingConfigSchema = z.object({
  projectTargetId: z.string().trim().min(1),
  provider: z.literal("github").default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1),
  checkoutPath: z.string().min(1),
  defaultExecutor: ExecutorSchema.default("echo"),
  baseBranch: z.string().min(1).default("main"),
  pushRemote: z.string().min(1).default("origin"),
  worktreeRoot: z.string().min(1).optional(),
  keepWorktree: KeepWorktreeSchema.default("on_failure"),
}).transform((binding) => ({
  ...binding,
  ...canonicalRepositoryIdentity(binding),
}));

export const OpenTagDaemonConfigSchema = z.object({
  runnerId: z.string().min(1).default("runner_local"),
  relayUrl: HostedRelayUrlSchema,
  repositories: z.array(RepositoryBindingConfigSchema).default([]),
  agents: z.record(z.string(), AcpAgentConfigSchema).default({}),
  scratchRoot: AbsolutePathSchema.default(() => join(defaultLocalStateDirectory(), "scratch")),
  keepScratch: KeepWorktreeSchema.default("on_failure"),
  approvalMode: z.enum(["ask", "auto", "autonomous"]).default("auto"),
  hermes: HermesAcpConfigSchema.optional(),
  openclaw: OpenClawAcpConfigSchema.optional(),
  agentSessionProfile: AgentSessionProfileConfigSchema.optional(),
  security: RunnerSecurityPolicySchema.optional(),
  githubToken: SecretStringSchema.optional(),
  runnerToken: SecretStringSchema.optional(),
  controlRegistration: HostedControlRegistrationSchema.optional(),
  trustedRelay: TrustedRelayAuthorizationV1Schema.optional(),
  pollIntervalMs: PositiveIntegerSchema.default(5000),
  heartbeatIntervalMs: PositiveIntegerSchema.default(15000),
  runTimeoutMs: PositiveIntegerSchema.optional(),
}).strict().superRefine((config, ctx) => {
  for (const name of Object.keys(config.agents)) {
    if (BUILT_IN_EXECUTOR_IDS.some((executorId) => executorId === name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents", name],
        message: `Configured ACP agent '${name}' cannot replace the built-in executor with the same id.`,
      });
    }
  }

  const control = config.controlRegistration;
  if (!control) {
    if (config.runnerToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runnerToken"],
        message: "An unpaired Runner must not contain a runtime runner token.",
      });
    }
    if (config.trustedRelay) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trustedRelay"],
        message: "Relay trust must be persisted with a Hosted Control V1 registration state.",
      });
    }
    return;
  }

  const tokenRequired = control.state === "credential_staged" || control.state === "paired";
  if (tokenRequired && !config.runnerToken) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runnerToken"],
      message: `Hosted Control V1 ${control.state} configuration requires a runtime runner token.`,
    });
  }
  if (!tokenRequired && config.runnerToken) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runnerToken"],
      message: `Hosted Control V1 ${control.state} configuration must not retain a runtime runner token.`,
    });
  }
  if ("registration" in control && control.registration.runnerId !== config.runnerId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["controlRegistration", "registration", "runnerId"],
      message: "Hosted Control V1 registration metadata must match daemon runnerId.",
    });
  }
});

export type RepositoryBindingConfig = z.infer<typeof RepositoryBindingConfigSchema>;
export type AgentSessionProfileConfig = z.infer<typeof AgentSessionProfileConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
export type OpenTagDaemonConfig = z.infer<typeof OpenTagDaemonConfigSchema>;

function formatPath(path: PropertyKey[]): string {
  return path.length ? path.map(String).join(".") : "config";
}

export function formatConfigError(error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }
  return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`).join("\n");
}

export function parseDaemonConfig(value: unknown): OpenTagDaemonConfig {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const relayUrl = HostedRelayUrlSchema.parse(raw.relayUrl);
    if (raw.controlRegistration !== undefined) {
      assertHostedRelayAuthorization({
        relayUrl,
        trustedRelay: raw.trustedRelay === undefined
          ? undefined
          : TrustedRelayAuthorizationV1Schema.parse(raw.trustedRelay),
      });
    }
  }
  return OpenTagDaemonConfigSchema.parse(value);
}

export function hostedRunnerAuthProblem(
  config: Pick<OpenTagDaemonConfig, "runnerId" | "runnerToken" | "controlRegistration">
): string | undefined {
  const control = config.controlRegistration;
  if (!control) return undefined;
  if (control.state === "unpaired") {
    return control.reason === "recovery_required"
      ? "Hosted Control V1 runner credential recovery is required; re-provision the runner before starting it."
      : `Hosted Control V1 runner is ${control.reason === "pending" ? "not paired" : "in an outcome-unknown pairing state"}; complete pairing or recovery before starting it.`;
  }
  if (control.state === "credential_staged") {
    return "Hosted Control V1 runner credential is staged but not committed as paired; finish local credential verification before starting it.";
  }
  if (!config.runnerToken) {
    return "Hosted Control V1 paired configuration is missing its runtime runner token; re-provision the runner before starting it.";
  }
  if (control.registration.runnerId !== config.runnerId) {
    return "Hosted Control V1 registration identity does not match daemon runnerId; correct or re-provision the runner before starting it.";
  }
  return undefined;
}

export function loadConfigFromEnv(): OpenTagDaemonConfig {
  const configPath = process.env.OPENTAG_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENTAG_CONFIG_PATH is required for the paired Runner.");
  }
  return parseDaemonConfig(JSON.parse(readFileSync(configPath, "utf8")));
}
