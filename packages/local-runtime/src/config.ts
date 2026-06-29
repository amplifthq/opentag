import { readFileSync } from "node:fs";
import { z } from "zod";

// Accept any trimmed non-empty executor id. The built-ins are echo, codex, and
// claude-code, but custom executors registered by a standalone runner are
// equally valid — config validation must not be stricter than the runtime
// dispatch (which resolves executors by id) or the dispatcher wire contract
// (executor: z.string().min(1)).
const ExecutorSchema = z.string().trim().min(1);
const KeepWorktreeSchema = z.enum(["always", "on_failure", "never"]);
const PositiveIntegerSchema = z.number().int().positive();

const ClaudeCodeExecutorConfigSchema = z.object({
  command: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  permissionMode: z.enum(["acceptEdits", "auto", "bypassPermissions", "default", "plan"]).optional(),
  dangerouslySkipPermissions: z.boolean().optional()
});

const RunnerSecurityPolicySchema = z.object({
  mode: z.enum(["enforce", "audit", "off"]).optional(),
  allowedWorkspaceRoot: z.string().min(1).optional(),
  allowUnsafePrompts: z.boolean().optional(),
  extraSafeEnv: z.array(z.string().min(1)).optional()
});

export const RepositoryBindingConfigSchema = z.object({
  provider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1),
  checkoutPath: z.string().min(1),
  defaultExecutor: ExecutorSchema.default("echo"),
  baseBranch: z.string().min(1).default("main"),
  pushRemote: z.string().min(1).default("origin"),
  worktreeRoot: z.string().min(1).optional(),
  keepWorktree: KeepWorktreeSchema.default("on_failure")
});

export const SlackChannelBindingConfigSchema = z.object({
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  repoProvider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1)
});

export const ChannelBindingConfigSchema = z.object({
  provider: z.string().min(1),
  accountId: z.string().min(1),
  conversationId: z.string().min(1),
  repoProvider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const LarkChannelBindingConfigSchema = z.object({
  tenantKey: z.string().min(1),
  chatId: z.string().min(1),
  repoProvider: z.string().min(1).default("github"),
  owner: z.string().min(1),
  repo: z.string().min(1)
});

export const OpenTagDaemonConfigSchema = z.object({
  runnerId: z.string().min(1).default("runner_local"),
  dispatcherUrl: z.string().url().default("http://localhost:3030"),
  repositories: z.array(RepositoryBindingConfigSchema).default([]),
  channelBindings: z.array(ChannelBindingConfigSchema).optional(),
  slackChannels: z.array(SlackChannelBindingConfigSchema).optional(),
  larkChannels: z.array(LarkChannelBindingConfigSchema).optional(),
  claudeCode: ClaudeCodeExecutorConfigSchema.optional(),
  security: RunnerSecurityPolicySchema.optional(),
  githubToken: z.string().min(1).optional(),
  preparePullRequestBranch: z.boolean().optional(),
  allowAutoCreatePullRequest: z.boolean().optional(),
  pairingToken: z.string().min(1).optional(),
  pollIntervalMs: PositiveIntegerSchema.default(5000),
  heartbeatIntervalMs: PositiveIntegerSchema.default(15000)
});

export type RepositoryBindingConfig = z.infer<typeof RepositoryBindingConfigSchema>;
export type ChannelBindingConfig = z.infer<typeof ChannelBindingConfigSchema>;
export type SlackChannelBindingConfig = z.infer<typeof SlackChannelBindingConfigSchema>;
export type LarkChannelBindingConfig = z.infer<typeof LarkChannelBindingConfigSchema>;
export type OpenTagDaemonConfig = z.infer<typeof OpenTagDaemonConfigSchema>;

function channelBindingIdentity(binding: Pick<ChannelBindingConfig, "provider" | "accountId" | "conversationId">): string {
  return JSON.stringify([binding.provider, binding.accountId, binding.conversationId]);
}

function formatChannelBindingIdentity(binding: Pick<ChannelBindingConfig, "provider" | "accountId" | "conversationId">): string {
  return `${binding.provider}:${binding.accountId}/${binding.conversationId}`;
}

function sameChannelBindingTarget(left: ChannelBindingConfig, right: ChannelBindingConfig): boolean {
  return left.repoProvider === right.repoProvider && left.owner === right.owner && left.repo === right.repo;
}

export function normalizeChannelBindings(config: OpenTagDaemonConfig): ChannelBindingConfig[] {
  const bindings: ChannelBindingConfig[] = [...(config.channelBindings ?? [])];

  for (const binding of config.slackChannels ?? []) {
    bindings.push({
      provider: "slack",
      accountId: binding.teamId,
      conversationId: binding.channelId,
      repoProvider: binding.repoProvider,
      owner: binding.owner,
      repo: binding.repo
    });
  }

  for (const binding of config.larkChannels ?? []) {
    bindings.push({
      provider: "lark",
      accountId: binding.tenantKey,
      conversationId: binding.chatId,
      repoProvider: binding.repoProvider,
      owner: binding.owner,
      repo: binding.repo
    });
  }

  const normalized = new Map<string, ChannelBindingConfig>();
  for (const binding of bindings) {
    const key = channelBindingIdentity(binding);
    const existing = normalized.get(key);
    if (existing && !sameChannelBindingTarget(existing, binding)) {
      throw new Error(
        `Conflicting channel binding for ${formatChannelBindingIdentity(binding)}: ${existing.repoProvider}:${existing.owner}/${existing.repo} and ${binding.repoProvider}:${binding.owner}/${binding.repo}`
      );
    }
    if (!existing) {
      normalized.set(key, binding);
    }
  }

  return [...normalized.values()];
}

export type InitConfigInput = {
  runnerId?: string;
  dispatcherUrl?: string;
  pairingToken?: string;
  owner: string;
  repo: string;
  checkoutPath: string;
  executor?: string;
  baseBranch?: string;
  pushRemote?: string;
  worktreeRoot?: string;
  keepWorktree?: string;
};

function parseNumberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function formatPath(path: Array<string | number>): string {
  return path.length ? path.join(".") : "config";
}

export function formatConfigError(error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }

  return error.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`).join("\n");
}

export function parseDaemonConfig(value: unknown): OpenTagDaemonConfig {
  const parsed = OpenTagDaemonConfigSchema.parse(value);
  normalizeChannelBindings(parsed);
  return parsed;
}

export function createInitialConfig(input: InitConfigInput): OpenTagDaemonConfig {
  return parseDaemonConfig({
    runnerId: input.runnerId ?? "runner_local",
    dispatcherUrl: input.dispatcherUrl ?? "http://localhost:3030",
    ...(input.pairingToken ? { pairingToken: input.pairingToken } : {}),
    repositories: [
      {
        provider: "github",
        owner: input.owner,
        repo: input.repo,
        checkoutPath: input.checkoutPath,
        defaultExecutor: input.executor ?? "echo",
        baseBranch: input.baseBranch ?? "main",
        pushRemote: input.pushRemote ?? "origin",
        ...(input.worktreeRoot ? { worktreeRoot: input.worktreeRoot } : {}),
        keepWorktree: input.keepWorktree ?? "on_failure"
      }
    ]
  });
}

function claudePermissionModeFromEnv(value: string | undefined) {
  if (!value) return undefined;
  const parsed = ClaudeCodeExecutorConfigSchema.shape.permissionMode.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid OPENTAG_CLAUDE_PERMISSION_MODE: ${value}`);
  }
  return parsed.data;
}

function extraSafeEnvFromEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const names = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return names.length > 0 ? names : undefined;
}

export function loadConfigFromEnv(): OpenTagDaemonConfig {
  const configPath = process.env.OPENTAG_CONFIG_PATH;
  if (configPath) {
    return parseDaemonConfig(JSON.parse(readFileSync(configPath, "utf8")));
  }

  const owner = process.env.OPENTAG_REPO_OWNER;
  const repo = process.env.OPENTAG_REPO_NAME;
  const checkoutPath = process.env.OPENTAG_WORKSPACE_PATH;
  const repositoryProvider = process.env.OPENTAG_SLACK_REPO_PROVIDER ?? "github";
  const claudePermissionMode = claudePermissionModeFromEnv(process.env.OPENTAG_CLAUDE_PERMISSION_MODE);
  const repositories =
    owner && repo && checkoutPath
      ? [
          {
            provider: repositoryProvider,
            owner,
            repo,
            checkoutPath,
            defaultExecutor: process.env.OPENTAG_DEFAULT_EXECUTOR ?? "echo",
            baseBranch: process.env.OPENTAG_BASE_BRANCH ?? "main",
            pushRemote: process.env.OPENTAG_PUSH_REMOTE ?? "origin",
            ...(process.env.OPENTAG_WORKTREE_ROOT ? { worktreeRoot: process.env.OPENTAG_WORKTREE_ROOT } : {}),
            keepWorktree: process.env.OPENTAG_KEEP_WORKTREE ?? "on_failure"
          }
        ]
      : [];

  const config = {
    runnerId: process.env.OPENTAG_RUNNER_ID ?? "runner_local",
    dispatcherUrl: process.env.OPENTAG_DISPATCHER_URL ?? "http://localhost:3030",
    repositories,
    ...(process.env.OPENTAG_SLACK_TEAM_ID && process.env.OPENTAG_SLACK_CHANNEL_ID && owner && repo
      ? {
          slackChannels: [
            {
              teamId: process.env.OPENTAG_SLACK_TEAM_ID,
              channelId: process.env.OPENTAG_SLACK_CHANNEL_ID,
              repoProvider: repositoryProvider,
              owner,
              repo
            }
          ]
        }
      : {}),
    ...(process.env.OPENTAG_LARK_TENANT_KEY && process.env.OPENTAG_LARK_CHAT_ID && owner && repo
      ? {
          larkChannels: [
            {
              tenantKey: process.env.OPENTAG_LARK_TENANT_KEY,
              chatId: process.env.OPENTAG_LARK_CHAT_ID,
              repoProvider: repositoryProvider,
              owner,
              repo
            }
          ]
        }
      : {}),
    ...(process.env.OPENTAG_CLAUDE_COMMAND ||
    process.env.OPENTAG_CLAUDE_MODEL ||
    process.env.OPENTAG_CLAUDE_PERMISSION_MODE ||
    process.env.OPENTAG_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS
      ? {
          claudeCode: {
            ...(process.env.OPENTAG_CLAUDE_COMMAND ? { command: process.env.OPENTAG_CLAUDE_COMMAND } : {}),
            ...(process.env.OPENTAG_CLAUDE_MODEL ? { model: process.env.OPENTAG_CLAUDE_MODEL } : {}),
            ...(claudePermissionMode ? { permissionMode: claudePermissionMode } : {}),
            ...(process.env.OPENTAG_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS
              ? { dangerouslySkipPermissions: process.env.OPENTAG_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "true" }
              : {})
          }
        }
      : {}),
    ...(process.env.OPENTAG_SECURITY_MODE ||
    process.env.OPENTAG_ALLOWED_WORKSPACE_ROOT ||
    process.env.OPENTAG_ALLOW_UNSAFE_PROMPTS ||
    process.env.OPENTAG_EXTRA_SAFE_ENV
      ? {
          security: {
            ...(process.env.OPENTAG_SECURITY_MODE
              ? { mode: process.env.OPENTAG_SECURITY_MODE as "enforce" | "audit" | "off" }
              : {}),
            ...(process.env.OPENTAG_ALLOWED_WORKSPACE_ROOT
              ? { allowedWorkspaceRoot: process.env.OPENTAG_ALLOWED_WORKSPACE_ROOT }
              : {}),
            ...(process.env.OPENTAG_ALLOW_UNSAFE_PROMPTS
              ? { allowUnsafePrompts: process.env.OPENTAG_ALLOW_UNSAFE_PROMPTS === "true" }
              : {}),
            ...(extraSafeEnvFromEnv(process.env.OPENTAG_EXTRA_SAFE_ENV)
              ? { extraSafeEnv: extraSafeEnvFromEnv(process.env.OPENTAG_EXTRA_SAFE_ENV) }
              : {})
          }
        }
      : {}),
    ...(process.env.OPENTAG_GITHUB_TOKEN ? { githubToken: process.env.OPENTAG_GITHUB_TOKEN } : {}),
    ...(process.env.OPENTAG_PREPARE_PR_BRANCH ? { preparePullRequestBranch: process.env.OPENTAG_PREPARE_PR_BRANCH === "true" } : {}),
    ...(process.env.OPENTAG_ALLOW_AUTO_CREATE_PR ? { allowAutoCreatePullRequest: process.env.OPENTAG_ALLOW_AUTO_CREATE_PR === "true" } : {}),
    ...(process.env.OPENTAG_PAIRING_TOKEN ? { pairingToken: process.env.OPENTAG_PAIRING_TOKEN } : {}),
    ...(process.env.OPENTAG_POLL_INTERVAL_MS ? { pollIntervalMs: parseNumberFromEnv("OPENTAG_POLL_INTERVAL_MS") } : {}),
    ...(process.env.OPENTAG_HEARTBEAT_INTERVAL_MS
      ? { heartbeatIntervalMs: parseNumberFromEnv("OPENTAG_HEARTBEAT_INTERVAL_MS") }
      : {})
  };
  return parseDaemonConfig(config);
}
