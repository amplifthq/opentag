import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { normalizeGitLabBaseUrl } from "@opentag/gitlab";
import { DEFAULT_HERMES_PROFILE } from "@opentag/local-runtime";
import {
  buildLinearOAuthAuthorizationUrl,
  createLinearAdapterMappingDrafts,
  discoverLinearMetadata,
  exchangeLinearOAuthCode,
  type LinearMetadataSnapshot,
  type LinearOAuthTokenResponse
} from "@opentag/linear";
import { validateLarkCredentials, type LarkDomain, type RegisteredLarkPersonalAgent } from "@opentag/lark";
import {
  defaultExecutorId,
  detectExecutors,
  EXECUTOR_CATALOG,
  executorLabel,
  isExecutorId
} from "../catalogs/executors.js";
import { LANGUAGE_OPTIONS, parseCliLanguage, type CliLanguage } from "../catalogs/languages.js";
import { formatPlatformStatus, PLATFORM_CATALOG, parsePlatformId, platformById, type PlatformId } from "../catalogs/platforms.js";
import { formatSavedLarkCredentialsHint } from "../platforms/lark/display.js";
import { readLegacyLarkCredentials, type SavedLarkCredentials } from "../platforms/lark/saved-config.js";
import { DEFAULT_GITHUB_WEBHOOK_PORT, DEFAULT_GITLAB_WEBHOOK_PORT, DEFAULT_LINEAR_WEBHOOK_PORT, DEFAULT_SLACK_EVENTS_PORT, parseLocalPort } from "../platforms/ports.js";
import type { PromptAdapter, PromptOption } from "../ui/prompts.js";
import { bindingMethodHint, bindingMethodLabel, larkSetupHint, larkSetupLabel, linearAuthHint, linearAuthLabel, slackModeHint, slackModeLabel, t } from "../ui/messages.js";
import { loadSetupDefaults } from "./defaults.js";
import { formatDiscordCredentialHelp, formatGitHubTokenHelp, formatGitLabTokenHelp, formatLarkManualCredentialHelp, formatLinearOAuthInstallHelp, formatLinearTokenHelp, formatPlatformSetupGuide, formatSlackCredentialHelp, formatTelegramCredentialHelp } from "./guides.js";
import { formatSetupReview } from "./summary.js";
import type {
  BindingMethod,
  DiscordSetupInput,
  DiscordSetupMode,
  GitHubSetupInput,
  GitLabSetupInput,
  HermesSetupInput,
  LarkSetupMethod,
  LinearAuthMethod,
  LinearSetupInput,
  OpenTagSetupInput,
  SetupDefaults,
  SlackSetupInput,
  SlackSetupMode,
  TelegramSetupInput,
  TelegramSetupMode
} from "./types.js";

const DEFAULT_TELEGRAM_AGENT_ID = "opentag";
const DEFAULT_DISCORD_WEBHOOK_PATH = "/discord/interactions";

type LarkCredentialInput = {
  appId: string;
  appSecret: string;
  botOpenId?: string;
  domain: LarkDomain;
};

export type SetupCommandOptions = {
  platform?: string;
  config?: string;
  project?: string;
  executor?: string;
  language?: string;
  larkSetup?: string;
  larkAppId?: string;
  larkAppSecret?: string;
  tenant?: string;
  larkBotOpenId?: string;
  slackMode?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackAppId?: string;
  slackTeamId?: string;
  slackChannelId?: string;
  slackPort?: string;
  githubToken?: string;
  githubWebhookSecret?: string;
  githubRepository?: string;
  githubWebhookPath?: string;
  githubPort?: string;
  githubAutoCreatePr?: boolean;
  gitlabToken?: string;
  gitlabProject?: string;
  gitlabBaseUrl?: string;
  gitlabWebhookSecret?: string;
  gitlabWebhookPath?: string;
  gitlabPort?: string;
  linearAuth?: string;
  linearToken?: string;
  linearOauthClientId?: string;
  linearOauthClientSecret?: string;
  linearOauthRedirectUri?: string;
  linearOauthCode?: string;
  linearOauthAccessToken?: string;
  linearOauthRefreshToken?: string;
  linearOauthExpiresAt?: string;
  linearOauthScopes?: string;
  linearOauthState?: string;
  linearDiscoverMetadata?: boolean;
  linearDiscoveryLimit?: string;
  linearTeamId?: string;
  linearTeamKey?: string;
  linearWebhookSecret?: string;
  linearWebhookPath?: string;
  linearPort?: string;
  linearGraphqlUrl?: string;
  telegramMode?: string;
  telegramBotToken?: string;
  telegramBotId?: string;
  telegramBotUsername?: string;
  telegramSecretToken?: string;
  telegramBindingAdminUserIds?: string;
  telegramCallbackUri?: string;
  discordMode?: string;
  discordPublicKey?: string;
  discordBotToken?: string;
  discordWebhookPath?: string;
  hermesCommand?: string;
  hermesProfile?: string;
  agentProfile?: string;
  agentProfileTemplate?: string;
  binding?: string;
  force?: boolean;
  relay?: string;
  yes?: boolean;
  start?: boolean;
  service?: boolean;
};

export type SetupFlowDependencies = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  prompts: PromptAdapter;
  scanLarkPersonalAgent(input: { language: CliLanguage }): Promise<RegisteredLarkPersonalAgent>;
  validateLarkCredentials?(input: { appId: string; appSecret: string; domain: LarkDomain }): Promise<{ botOpenId: string; botName: string }>;
  exchangeLinearOAuthCode?: typeof exchangeLinearOAuthCode;
  discoverLinearMetadata?: typeof discoverLinearMetadata;
  now?: () => Date;
  defaults?: SetupDefaults;
};

function parseLarkSetupMethod(value: string): LarkSetupMethod {
  if (value === "saved" || value === "scan" || value === "manual") return value;
  throw new Error("Lark setup method must be saved, scan, or manual.");
}

function parseLarkTenant(value: string): LarkDomain {
  if (value === "lark" || value === "feishu") return value;
  throw new Error("Tenant must be feishu or lark.");
}

function parseSlackSetupMode(value: string): SlackSetupMode {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "socket_mode" || normalized === "events_api") return normalized;
  throw new Error("Slack mode must be socket_mode or events_api.");
}

function parseTelegramSetupMode(value: string): TelegramSetupMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "polling" || normalized === "webhook") return normalized;
  throw new Error("Telegram mode must be polling or webhook.");
}

function parseDiscordSetupMode(value: string): DiscordSetupMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "gateway" || normalized === "webhook") return normalized;
  throw new Error("Discord mode must be gateway or webhook.");
}

function parseLinearAuthMethod(value: string): LinearAuthMethod {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "api_key" || normalized === "oauth_app") return normalized;
  throw new Error("Linear auth must be api_key or oauth_app.");
}

function parseBindingMethod(value: string): BindingMethod {
  if (value === "default_project" || value === "bind_later") return value;
  throw new Error("Binding method must be default_project or bind_later.");
}

function parseGitHubRepository(value: string): { owner: string; repo: string } {
  const trimmed = value.trim().replace(/^github:/, "");
  const match = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error("GitHub repository must use owner/repo.");
  }

  return {
    owner: match[1]!,
    repo: match[2]!.replace(/\.git$/, "")
  };
}

function normalizeGitLabProjectPath(value: string): string {
  const trimmed = value.trim().replace(/^gitlab:/, "").replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!/^[^|/\s]+(?:\/[^|/\s]+)+$/.test(trimmed)) {
    throw new Error("GitLab project must use namespace/project, for example group/subgroup/project.");
  }
  return trimmed;
}

function parseGitLabProject(value: string): { projectPathWithNamespace: string; baseUrl?: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("GitLab project is required.");
  }

  const sshMatch = trimmed.match(/^git@([^:\s]+):(.+)$/) ?? trimmed.match(/^ssh:\/\/git@([^/\s]+)\/(.+)$/);
  if (sshMatch) {
    return {
      baseUrl: `https://${sshMatch[1]}`,
      projectPathWithNamespace: normalizeGitLabProjectPath(sshMatch[2]!)
    };
  }

  if (/^https?:\/\//.test(trimmed)) {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/^\/+/, "").split("/-/")[0] ?? "";
    return {
      baseUrl: `${parsed.protocol}//${parsed.host}`,
      projectPathWithNamespace: normalizeGitLabProjectPath(path)
    };
  }

  return {
    projectPathWithNamespace: normalizeGitLabProjectPath(trimmed)
  };
}

function parsePortInput(value: string | undefined, label: string): number | undefined {
  return value === undefined ? undefined : parseLocalPort(value, label);
}

function parsePositiveIntegerInput(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function splitLinearScopes(value: string | undefined): string[] | undefined {
  const scopes = value?.split(/[,\s]+/u).map((scope) => scope.trim()).filter(Boolean);
  return scopes?.length ? scopes : undefined;
}

function githubRepositoryFromRemote(projectPath: string): string | undefined {
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", projectPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }

  const patterns = [
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/
  ];
  for (const pattern of patterns) {
    const match = remote.match(pattern);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  }
  return undefined;
}

function gitLabProjectFromRemote(projectPath: string): { projectPathWithNamespace: string; baseUrl: string } | undefined {
  let remote: string;
  try {
    remote = execFileSync("git", ["-C", projectPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }

  try {
    const parsed = parseGitLabProject(remote);
    if (!parsed.baseUrl) return undefined;
    const hostname = new URL(parsed.baseUrl).hostname.toLowerCase();
    if (hostname === "github.com" || hostname.endsWith(".github.com") || hostname === "bitbucket.org" || hostname.endsWith(".bitbucket.org")) {
      return undefined;
    }
    return {
      projectPathWithNamespace: parsed.projectPathWithNamespace,
      baseUrl: normalizeGitLabBaseUrl(parsed.baseUrl)
    };
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function assertExistingPath(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`Path does not exist: ${path}`);
  }
  return path;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function hasHermesOptions(options: SetupCommandOptions): boolean {
  return Boolean(options.hermesCommand || options.hermesProfile);
}

function collectHermesSetup(options: SetupCommandOptions, defaults: SetupDefaults, executor: string): HermesSetupInput | undefined {
  if (executor !== "hermes") {
    if (hasHermesOptions(options)) {
      throw new Error("--hermes-command and --hermes-profile can only be used with --executor hermes.");
    }
    return undefined;
  }

  const explicitProfile = optionalTrimmed(options.hermesProfile);
  const command = optionalTrimmed(options.hermesCommand) ?? defaults.hermesCommand;
  const profile = explicitProfile ?? defaults.hermesProfile ?? DEFAULT_HERMES_PROFILE;

  return {
    ...(command ? { command } : {}),
    profile
  };
}

function collectAgentSessionProfileSetup(options: SetupCommandOptions, defaults: SetupDefaults) {
  const explicitProfile = optionalTrimmed(options.agentProfile);
  const explicitProfileTemplate = optionalTrimmed(options.agentProfileTemplate);
  const profile = explicitProfileTemplate ? explicitProfile : explicitProfile ?? defaults.agentProfile;
  const profileTemplate = explicitProfileTemplate ?? (explicitProfile ? undefined : defaults.agentProfileTemplate);
  if (!profile && !profileTemplate) return undefined;
  return {
    ...(profile ? { profile } : {}),
    ...(profileTemplate ? { profileTemplate } : {})
  };
}

function generateGitHubWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

function generateGitLabWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

function generateLinearWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

function generateLinearRelayWebhookPath(): string {
  return `/linear/webhooks/${randomBytes(12).toString("hex")}`;
}

function parseGitHubWebhookPath(value: string): string {
  const trimmed = nonEmpty(value, "GitHub webhook path");
  if (!trimmed.startsWith("/")) {
    throw new Error("GitHub webhook path must start with /.");
  }
  return trimmed;
}

function parseGitLabWebhookPath(value: string): string {
  const trimmed = nonEmpty(value, "GitLab webhook path");
  if (!trimmed.startsWith("/")) {
    throw new Error("GitLab webhook path must start with /.");
  }
  return trimmed;
}

function parseLinearWebhookPath(value: string): string {
  const trimmed = nonEmpty(value, "Linear webhook path");
  if (!trimmed.startsWith("/")) {
    throw new Error("Linear webhook path must start with /.");
  }
  return trimmed;
}

function parseTelegramBotIdFromToken(token: string): string {
  const match = token.trim().match(/^(\d+):\S+$/);
  if (!match) {
    throw new Error("Telegram bot token must look like 123456789:secret from BotFather.");
  }
  return match[1]!;
}

function parseTelegramBindingAdminUserIds(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
}

function parseWebhookPath(value: string, label: string): string {
  const trimmed = nonEmpty(value, label);
  if (!trimmed.startsWith("/")) {
    throw new Error(`${label} must start with /.`);
  }
  return trimmed;
}

function generateTelegramSecretToken(): string {
  return randomBytes(32).toString("base64url");
}

function hasManualLarkCredentials(options: SetupCommandOptions): boolean {
  return Boolean(options.larkAppId || options.larkAppSecret || options.larkBotOpenId);
}

function hasCompleteManualLarkCredentials(options: SetupCommandOptions): boolean {
  return Boolean(options.larkAppId && options.larkAppSecret);
}

function assertCompleteManualLarkCredentials(options: SetupCommandOptions): void {
  if (options.larkAppId && !options.larkAppSecret) {
    throw new Error("--lark-app-secret is required when --lark-app-id is provided.");
  }
  if (options.larkAppSecret && !options.larkAppId) {
    throw new Error("--lark-app-id is required when --lark-app-secret is provided.");
  }
}

function assertNoManualLarkCredentialFlags(options: SetupCommandOptions): void {
  if (hasManualLarkCredentials(options)) {
    throw new Error("--lark-app-id, --lark-app-secret, and --lark-bot-open-id can only be used with --lark-setup manual.");
  }
}

function findSavedLarkCredentials(defaults: SetupDefaults, projectPath: string): SavedLarkCredentials | undefined {
  return defaults.savedLarkCredentials ?? readLegacyLarkCredentials(projectPath);
}

function shouldReadSavedLarkCredentials(options: SetupCommandOptions): boolean {
  return !options.larkSetup || parseLarkSetupMethod(options.larkSetup) === "saved";
}

function loadDefaultsForSetup(options: SetupCommandOptions, configPath: string): SetupDefaults {
  try {
    return loadSetupDefaults(configPath);
  } catch (error) {
    if (options.force) {
      return {};
    }
    throw error;
  }
}

function defaultLanguage(options: SetupCommandOptions, defaults: SetupDefaults): CliLanguage {
  return options.language ? parseCliLanguage(options.language) : defaults.language ?? "en";
}

function formatPlatformStatusForSetup(language: CliLanguage, status: (typeof PLATFORM_CATALOG)[number]["status"]): string {
  if (language === "zh-CN") {
    switch (status) {
      case "setup_ready":
        return "当前设置向导可配置";
      case "setup_pending":
        return "适配器已有，设置向导待接入";
      case "experimental_setup_pending":
        return "实验适配器，设置向导待接入";
    }
  }
  return formatPlatformStatus(status);
}

function formatPlatformsForSetup(language: CliLanguage): string {
  const lines = PLATFORM_CATALOG.map((platform) => `- ${platform.label}: ${formatPlatformStatusForSetup(language, platform.status)}`);
  if (language === "zh-CN") {
    return ["当前设置向导可配置的平台：", ...lines].join("\n");
  }
  return ["This setup wizard can configure:", ...lines].join("\n");
}

function formatExecutorHint(input: {
  language: CliLanguage;
  executor: (typeof EXECUTOR_CATALOG)[number];
  available: boolean;
  current: boolean;
  selectedByDefault: boolean;
}): string {
  if (input.executor.devOnly) {
    const echoHint = input.language === "zh-CN" ? "开发测试用，不会调用真实编码代理" : "dev/test only; no real coding agent";
    return input.current ? `${input.language === "zh-CN" ? "当前选择，" : "current, "}${echoHint}` : echoHint;
  }

  const availability = input.language === "zh-CN" ? (input.available ? "已检测到" : "未检测到") : input.available ? "available" : "not found";
  const current = input.current ? (input.language === "zh-CN" ? "当前选择，" : "current, ") : "";
  const recommended = input.selectedByDefault ? (input.language === "zh-CN" ? "推荐，" : "recommended, ") : "";
  return `${current || recommended}${availability}`;
}

async function collectLanguage(options: SetupCommandOptions, defaults: SetupDefaults, prompts: PromptAdapter): Promise<CliLanguage> {
  if (options.language) {
    return parseCliLanguage(options.language);
  }
  return prompts.select({
    message: t("en", "language"),
    initialValue: defaultLanguage(options, defaults),
    options: LANGUAGE_OPTIONS.map((language) => ({
      value: language.id,
      label: language.label,
      hint: language.hint
    }))
  });
}

async function collectPlatform(options: SetupCommandOptions, defaults: SetupDefaults, prompts: PromptAdapter, language: CliLanguage): Promise<PlatformId> {
  prompts.note(formatPlatformsForSetup(language));
  const selected = options.platform
    ? parsePlatformId(options.platform)
    : await prompts.select({
        message: t(language, "platform"),
        initialValue: defaults.platform ?? "lark",
        options: PLATFORM_CATALOG.filter((platform) => platform.startable).map((platform) => ({
          value: platform.id,
          label: platform.label,
          hint: formatPlatformStatusForSetup(language, platform.status)
        }))
      });
  const descriptor = platformById(selected);
  if (!descriptor.startable) {
    throw new Error(`${descriptor.label} setup is not available in the OpenTag CLI yet.`);
  }
  const guide = formatPlatformSetupGuide(selected, language);
  if (guide) {
    prompts.note(guide);
  }
  return selected;
}

async function collectExecutor(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage,
  env: NodeJS.ProcessEnv | undefined
): Promise<string> {
  if (options.executor !== undefined) {
    const executor = options.executor.trim();
    if (executor.length === 0) {
      throw new Error("Executor id must not be empty.");
    }
    return executor;
  }
  const detections = detectExecutors(env);
  const normalizedPrevious = defaults.executor?.trim();
  if (normalizedPrevious !== undefined && normalizedPrevious.length === 0) {
    throw new Error("Executor id must not be empty.");
  }
  const previousBuiltIn = normalizedPrevious !== undefined && isExecutorId(normalizedPrevious) ? normalizedPrevious : undefined;
  // A configured custom executor can't be represented by the built-in picker,
  // so surface it as a pre-selected option: the user keeps it by default but
  // can still switch to a built-in, instead of it being silently overwritten
  // (or the prompt being skipped) on an unrelated wizard re-run.
  const customPrevious = normalizedPrevious !== undefined && previousBuiltIn === undefined ? normalizedPrevious : undefined;
  const initialValue =
    customPrevious ??
    defaultExecutorId({
      ...(previousBuiltIn ? { previous: previousBuiltIn } : {}),
      detections
    });

  const builtInOptions: Array<PromptOption<string>> = EXECUTOR_CATALOG.map((executor) => {
    const detection = detections.find((entry) => entry.id === executor.id);
    return {
      value: executor.id,
      label: executor.label,
      hint: formatExecutorHint({
        language,
        executor,
        available: detection?.available ?? false,
        current: executor.id === normalizedPrevious,
        selectedByDefault: executor.id === initialValue
      })
    };
  });

  return prompts.select({
    message: t(language, "executor"),
    initialValue,
    options: customPrevious
      ? [{ value: customPrevious, label: customPrevious, hint: t(language, "executorCustomHint") }, ...builtInOptions]
      : builtInOptions
  });
}

async function collectProjectPath(options: SetupCommandOptions, defaults: SetupDefaults, prompts: PromptAdapter, language: CliLanguage, cwd: string): Promise<string> {
  if (options.project) {
    return assertExistingPath(options.project);
  }
  const initialValue = defaults.projectPath ?? cwd;
  return prompts.text({
    message: t(language, "projectPath"),
    initialValue,
    placeholder: initialValue,
    validate(value) {
      const candidate = value.trim() || initialValue;
      if (!existsSync(candidate)) {
        return `Path does not exist: ${candidate}`;
      }
      return undefined;
    }
  });
}

async function collectLarkSetupMethod(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage,
  savedLarkCredentials: SavedLarkCredentials | undefined
): Promise<LarkSetupMethod> {
  if (options.larkSetup) {
    const setupMethod = parseLarkSetupMethod(options.larkSetup);
    if (setupMethod === "saved" && !savedLarkCredentials) {
      throw new Error("No saved Lark Personal Agent config was found. Use --lark-setup scan or --lark-setup manual.");
    }
    if (setupMethod === "scan" && options.tenant) {
      throw new Error("Tenant is detected during scan setup. Use --lark-setup manual --tenant <feishu|lark> for an existing app.");
    }
    return setupMethod;
  }
  if (hasManualLarkCredentials(options) || options.tenant) {
    return "manual";
  }
  const methods: LarkSetupMethod[] = savedLarkCredentials ? ["saved", "scan", "manual"] : ["scan", "manual"];
  const previous = defaults.larkSetupMethod && methods.includes(defaults.larkSetupMethod) ? defaults.larkSetupMethod : undefined;
  const defaultSetupMethod = savedLarkCredentials ? "saved" : "scan";
  return prompts.select({
    message: t(language, "larkSetup"),
    initialValue: savedLarkCredentials ? "saved" : previous ?? defaultSetupMethod,
    options: methods.map((method) => ({
      value: method,
      label: larkSetupLabel(language, method),
      hint:
        method === "saved" && savedLarkCredentials
          ? formatSavedLarkCredentialsHint(savedLarkCredentials, language)
          : larkSetupHint(language, method)
    }))
  });
}

async function collectLarkDomain(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage,
  setupMethod: LarkSetupMethod,
  savedLarkCredentials: SavedLarkCredentials | undefined
): Promise<LarkDomain> {
  if (setupMethod === "saved") {
    if (!savedLarkCredentials) {
      throw new Error("No saved Lark Personal Agent config was found.");
    }
    return savedLarkCredentials.domain;
  }
  // Defensive fallback: collectSetupInput skips domain collection for scan,
  // because the platform returns the real tenant after registration.
  if (setupMethod === "scan") {
    throw new Error("Tenant is detected during scan setup.");
  }
  if (options.tenant) {
    return parseLarkTenant(options.tenant);
  }
  return prompts.select({
    message: t(language, "larkDomain"),
    initialValue: defaults.larkDomain ?? "feishu",
    options: [
      { value: "feishu", label: "Feishu", hint: "feishu.cn" },
      { value: "lark", label: "Lark", hint: "larksuite.com" }
    ]
  });
}

async function collectLarkCredentials(input: {
  options: SetupCommandOptions;
  prompts: PromptAdapter;
  language: CliLanguage;
  setupMethod: LarkSetupMethod;
  domain?: LarkDomain;
  savedLarkCredentials?: SavedLarkCredentials;
  scanLarkPersonalAgent(input: { language: CliLanguage }): Promise<RegisteredLarkPersonalAgent>;
  validateLarkCredentials(input: { appId: string; appSecret: string; domain: LarkDomain }): Promise<{ botOpenId: string; botName: string }>;
}): Promise<LarkCredentialInput> {
  if (input.setupMethod === "saved") {
    if (!input.savedLarkCredentials) {
      throw new Error("No saved Lark Personal Agent config was found.");
    }
    let botOpenId = input.savedLarkCredentials.botOpenId;
    try {
      const validation = await input.validateLarkCredentials({
        appId: input.savedLarkCredentials.appId,
        appSecret: input.savedLarkCredentials.appSecret,
        domain: input.savedLarkCredentials.domain
      });
      botOpenId = validation.botOpenId;
    } catch {
      input.prompts.note(
        "Saved Lark / Feishu credentials could not be verified live; using the saved local config."
      );
    }
    return {
      appId: input.savedLarkCredentials.appId,
      appSecret: input.savedLarkCredentials.appSecret,
      domain: input.savedLarkCredentials.domain,
      ...(botOpenId ? { botOpenId } : {})
    };
  }

  if (input.setupMethod === "scan") {
    assertNoManualLarkCredentialFlags(input.options);
    const registered = await input.scanLarkPersonalAgent({ language: input.language });
    return {
      appId: registered.appId,
      appSecret: registered.appSecret,
      domain: registered.domain,
      ...(registered.botOpenId ? { botOpenId: registered.botOpenId } : {})
    };
  }

  if (!input.domain) {
    throw new Error("Tenant is required for manual setup.");
  }
  assertCompleteManualLarkCredentials(input.options);
  if (!hasCompleteManualLarkCredentials(input.options)) {
    input.prompts.note(formatLarkManualCredentialHelp(input.language, input.domain));
  }
  const appIdLabel = input.language === "zh-CN" ? "Lark 应用 ID" : "Lark App ID";
  const appSecretLabel = input.language === "zh-CN" ? "Lark 应用密钥" : "Lark App Secret";
  const appId = nonEmpty(input.options.larkAppId ?? (await input.prompts.text({ message: t(input.language, "larkAppId") })), appIdLabel);
  const appSecret = nonEmpty(
    input.options.larkAppSecret ??
      (await input.prompts.password({
        message: t(input.language, "larkAppSecret"),
        validate(value) {
          if (!value.trim()) return input.language === "zh-CN" ? "Lark 应用密钥不能为空。" : "Lark App Secret is required.";
          return undefined;
        }
      })),
    appSecretLabel
  );
  const botOpenIdInput =
    input.options.larkBotOpenId ??
    (hasCompleteManualLarkCredentials(input.options)
      ? undefined
      : await input.prompts.text({
          message: t(input.language, "larkBotOpenId"),
          placeholder: "ou_..."
        }));
  const botOpenId = optionalTrimmed(botOpenIdInput);
  const validation = await input.validateLarkCredentials({
    appId,
    appSecret,
    domain: input.domain
  });
  if (botOpenId && botOpenId !== validation.botOpenId) {
    input.prompts.note("The provided Lark bot Open ID differed from live validation; using the verified bot Open ID.");
  }
  return {
    appId,
    appSecret,
    domain: input.domain,
    botOpenId: validation.botOpenId
  };
}

async function collectSlackSetup(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage
): Promise<SlackSetupInput> {
  const derivedMode = options.slackMode
    ? parseSlackSetupMode(options.slackMode)
    : options.slackAppToken && !options.slackSigningSecret
      ? "socket_mode"
      : options.slackSigningSecret && !options.slackAppToken
        ? "events_api"
        : undefined;
  const selectedMode = derivedMode
    ? derivedMode
    : await prompts.select({
        message: t(language, "slackMode"),
        initialValue: defaults.slackMode ?? "socket_mode",
        options: (["socket_mode", "events_api"] satisfies SlackSetupMode[]).map((candidate) => ({
          value: candidate,
          label: slackModeLabel(language, candidate),
          hint: slackModeHint(language, candidate)
        }))
      });

  if (selectedMode === "socket_mode" && options.slackPort) {
    throw new Error("--slack-port can only be used with --slack-mode events_api.");
  }

  if (
    (selectedMode === "socket_mode" && (!options.slackAppToken || !options.slackBotToken)) ||
    (selectedMode === "events_api" && (!options.slackSigningSecret || !options.slackBotToken))
  ) {
    prompts.note(formatSlackCredentialHelp(language, selectedMode));
  }

  const appToken =
    selectedMode === "socket_mode"
      ? nonEmpty(
          options.slackAppToken ?? (await prompts.password({ message: t(language, "slackAppToken") })),
          "Slack App-Level Token"
        )
      : undefined;
  const signingSecret =
    selectedMode === "events_api"
      ? nonEmpty(
          options.slackSigningSecret ?? (await prompts.password({ message: t(language, "slackSigningSecret") })),
          "Slack Signing Secret"
        )
      : undefined;
  const botToken = nonEmpty(
    options.slackBotToken ?? (await prompts.password({ message: t(language, "slackBotToken") })),
    "Slack Bot User OAuth Token"
  );
  const appId = optionalTrimmed(
    options.slackAppId ??
      (await prompts.text({
        message: t(language, "slackAppId"),
        placeholder: "A..."
      }))
  );
  const teamId = nonEmpty(
    options.slackTeamId ??
      (await prompts.text({
        message: t(language, "slackTeamId"),
        placeholder: "T...",
        ...(defaults.slackTeamId ? { initialValue: defaults.slackTeamId } : {})
      })),
    "Slack Team ID"
  );
  const channelId = nonEmpty(
    options.slackChannelId ??
      (await prompts.text({
        message: t(language, "slackChannelId"),
        placeholder: "C...",
        ...(defaults.slackChannelId ? { initialValue: defaults.slackChannelId } : {})
      })),
    "Slack Channel ID"
  );
  const port =
    selectedMode === "events_api"
      ? (parsePortInput(options.slackPort, "Slack Events API port") ??
        (options.yes
          ? defaults.slackPort ?? DEFAULT_SLACK_EVENTS_PORT
          : parseLocalPort(
              await prompts.text({
                message: t(language, "slackPort"),
                initialValue: String(defaults.slackPort ?? DEFAULT_SLACK_EVENTS_PORT),
                placeholder: String(DEFAULT_SLACK_EVENTS_PORT)
              }),
              "Slack Events API port"
            )))
      : undefined;
  const bindingMethod = await collectBindingMethod(options, defaults, prompts, language, "slack");
  return {
    mode: selectedMode,
    ...(appToken ? { appToken } : {}),
    ...(signingSecret ? { signingSecret } : {}),
    botToken,
    teamId,
    channelId,
    bindingMethod,
    ...(appId ? { appId } : {}),
    ...(port ? { port } : {})
  };
}

async function collectGitHubSetup(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage,
  projectPath: string
): Promise<GitHubSetupInput> {
  const repositoryDefault =
    options.githubRepository ??
    (defaults.githubOwner && defaults.githubRepo ? `${defaults.githubOwner}/${defaults.githubRepo}` : undefined) ??
    githubRepositoryFromRemote(projectPath);
  const repositoryInput = nonEmpty(
    options.githubRepository ??
      (await prompts.text({
        message: t(language, "githubRepository"),
        ...(repositoryDefault ? { initialValue: repositoryDefault, placeholder: repositoryDefault } : { placeholder: "owner/repo" }),
        validate(value) {
          try {
            parseGitHubRepository(value);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }
      })),
    "GitHub repository"
  );
  const repository = parseGitHubRepository(repositoryInput);
  const autoCreatePullRequest =
    options.githubAutoCreatePr ??
    (options.yes
      ? defaults.githubAutoCreatePullRequest ?? false
      : await prompts.confirm({
          message: t(language, "githubAutoCreatePr"),
          initialValue: defaults.githubAutoCreatePullRequest ?? false
        }));
  if (!options.githubToken) {
    prompts.note(formatGitHubTokenHelp(language, { autoCreatePullRequest }));
  }
  const token = nonEmpty(options.githubToken ?? (await prompts.password({ message: t(language, "githubToken") })), "GitHub token");
  const webhookSecret = options.githubWebhookSecret
    ? nonEmpty(options.githubWebhookSecret, "GitHub webhook secret")
    : defaults.githubWebhookSecret ?? generateGitHubWebhookSecret();
  const port =
    parsePortInput(options.githubPort, "GitHub webhook port") ??
    (options.yes
      ? defaults.githubPort ?? DEFAULT_GITHUB_WEBHOOK_PORT
      : parseLocalPort(
          await prompts.text({
            message: t(language, "githubPort"),
            initialValue: String(defaults.githubPort ?? DEFAULT_GITHUB_WEBHOOK_PORT),
            placeholder: String(DEFAULT_GITHUB_WEBHOOK_PORT)
          }),
          "GitHub webhook port"
        ));
  return {
    token,
    webhookSecret,
    owner: repository.owner,
    repo: repository.repo,
    webhookPath: parseGitHubWebhookPath(options.githubWebhookPath ?? defaults.githubWebhookPath ?? "/github/webhooks"),
    autoCreatePullRequest,
    port
  };
}

async function collectGitLabSetup(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage,
  projectPath: string
): Promise<GitLabSetupInput> {
  const remoteDefault = gitLabProjectFromRemote(projectPath);
  const baseUrlDefault = normalizeGitLabBaseUrl(
    options.gitlabBaseUrl ?? defaults.gitlabBaseUrl ?? remoteDefault?.baseUrl ?? "https://gitlab.com"
  );
  const projectDefault = options.gitlabProject ?? defaults.gitlabProjectPathWithNamespace ?? remoteDefault?.projectPathWithNamespace;
  const projectInput = nonEmpty(
    options.gitlabProject ??
      (await prompts.text({
        message: t(language, "gitlabProject"),
        ...(projectDefault ? { initialValue: projectDefault, placeholder: projectDefault } : { placeholder: "group/project" }),
        validate(value) {
          try {
            parseGitLabProject(value);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }
      })),
    "GitLab project"
  );
  const parsedProject = parseGitLabProject(projectInput);
  const baseUrl = normalizeGitLabBaseUrl(options.gitlabBaseUrl ?? defaults.gitlabBaseUrl ?? parsedProject.baseUrl ?? baseUrlDefault);

  if (!options.gitlabToken) {
    prompts.note(formatGitLabTokenHelp(language, { baseUrl }));
  }
  const token = nonEmpty(options.gitlabToken ?? (await prompts.password({ message: t(language, "gitlabToken") })), "GitLab token");
  const webhookSecret = options.gitlabWebhookSecret
    ? nonEmpty(options.gitlabWebhookSecret, "GitLab webhook secret")
    : defaults.gitlabWebhookSecret ?? generateGitLabWebhookSecret();
  const port =
    parsePortInput(options.gitlabPort, "GitLab webhook port") ??
    (options.yes
      ? defaults.gitlabPort ?? DEFAULT_GITLAB_WEBHOOK_PORT
      : parseLocalPort(
          await prompts.text({
            message: t(language, "gitlabPort"),
            initialValue: String(defaults.gitlabPort ?? DEFAULT_GITLAB_WEBHOOK_PORT),
            placeholder: String(DEFAULT_GITLAB_WEBHOOK_PORT)
          }),
          "GitLab webhook port"
        ));

  return {
    token,
    webhookSecret,
    projectPathWithNamespace: parsedProject.projectPathWithNamespace,
    baseUrl,
    webhookPath: parseGitLabWebhookPath(options.gitlabWebhookPath ?? defaults.gitlabWebhookPath ?? "/gitlab/webhooks"),
    port
  };
}

function hasLinearOAuthOptions(options: SetupCommandOptions): boolean {
  return Boolean(
    options.linearOauthClientId ||
      options.linearOauthClientSecret ||
      options.linearOauthRedirectUri ||
      options.linearOauthCode ||
      options.linearOauthAccessToken ||
      options.linearOauthRefreshToken ||
      options.linearOauthExpiresAt ||
      options.linearOauthScopes
  );
}

function hasLinearLocalOAuthCredentialOptions(options: SetupCommandOptions): boolean {
  return Boolean(
    options.linearOauthClientId ||
      options.linearOauthClientSecret ||
      options.linearOauthCode ||
      options.linearOauthAccessToken ||
      options.linearOauthRefreshToken ||
      options.linearOauthExpiresAt
  );
}

function shouldUseHostedLinearOAuthInstall(options: SetupCommandOptions, authMethod: LinearAuthMethod): boolean {
  return Boolean(options.relay && authMethod === "oauth_app" && !hasLinearLocalOAuthCredentialOptions(options));
}

async function collectLinearAuthMethod(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage
): Promise<LinearAuthMethod> {
  if (options.linearAuth) return parseLinearAuthMethod(options.linearAuth);
  if (hasLinearOAuthOptions(options)) return "oauth_app";
  if (options.linearToken) return "api_key";
  if (options.yes) return defaults.linearAuth ?? (options.relay ? "oauth_app" : "api_key");
  const initialValue = defaults.linearAuth ?? "oauth_app";
  return await prompts.select({
    message: t(language, "linearAuth"),
    initialValue,
    options: (["oauth_app", "api_key"] as const).map((method) => ({
      value: method,
      label: linearAuthLabel(language, method),
      hint: linearAuthHint(language, method)
    }))
  });
}

function linearAccessTokenExpiresAt(input: { token: LinearOAuthTokenResponse; fallback?: string; now: () => Date }): string | undefined {
  if (input.fallback) return input.fallback;
  if (typeof input.token.expiresIn !== "number" || !Number.isFinite(input.token.expiresIn)) return undefined;
  return new Date(input.now().getTime() + input.token.expiresIn * 1000).toISOString();
}

async function collectLinearApiKeyAuth(
  options: SetupCommandOptions,
  prompts: PromptAdapter,
  language: CliLanguage
): Promise<{ token: string; auth: LinearSetupInput["auth"] }> {
  return {
    token: nonEmpty(options.linearToken ?? (await prompts.password({ message: t(language, "linearToken") })), "Linear API key"),
    auth: { method: "api_key" }
  };
}

function collectLinearHostedOAuthAuth(options: SetupCommandOptions): { token?: string; auth: LinearSetupInput["auth"] } {
  const scopes = splitLinearScopes(options.linearOauthScopes);
  return {
    auth: {
      method: "hosted_oauth_app",
      actor: "app",
      ...(scopes ? { scopes } : {})
    }
  };
}

async function collectLinearOAuthAuth(
  options: SetupCommandOptions,
  prompts: PromptAdapter,
  language: CliLanguage,
  dependencies: SetupFlowDependencies
): Promise<{ token: string; auth: LinearSetupInput["auth"] }> {
  const clientId = nonEmpty(
    options.linearOauthClientId ??
      (options.yes
        ? ""
        : await prompts.text({
            message: t(language, "linearOAuthClientId")
          })),
    "Linear OAuth client ID"
  );
  const clientSecret = optionalTrimmed(
    options.linearOauthClientSecret ??
      (options.yes
        ? undefined
        : await prompts.password({
            message: t(language, "linearOAuthClientSecret")
          }))
  );
  const redirectUri = nonEmpty(
    options.linearOauthRedirectUri ??
      (options.yes
        ? ""
        : await prompts.text({
            message: t(language, "linearOAuthRedirectUri")
          })),
    "Linear OAuth redirect URI"
  );
  const scopes = splitLinearScopes(options.linearOauthScopes);
  const state = options.linearOauthState ?? `opentag_${randomBytes(12).toString("hex")}`;
  prompts.note(
    formatLinearOAuthInstallHelp(language, {
      authorizationUrl: buildLinearOAuthAuthorizationUrl({
        clientId,
        redirectUri,
        state,
        ...(scopes ? { scopes } : {}),
        actor: "app"
      })
    })
  );

  const directAccessToken = optionalTrimmed(options.linearOauthAccessToken);
  if (directAccessToken) {
    return {
      token: directAccessToken,
      auth: {
        method: "oauth_app",
        actor: "app",
        clientId,
        ...(clientSecret ? { clientSecret } : {}),
        redirectUri,
        ...(options.linearOauthRefreshToken ? { refreshToken: nonEmpty(options.linearOauthRefreshToken, "Linear OAuth refresh token") } : {}),
        ...(options.linearOauthExpiresAt ? { accessTokenExpiresAt: options.linearOauthExpiresAt } : {}),
        ...(scopes ? { scopes } : {})
      }
    };
  }

  const code = nonEmpty(
    options.linearOauthCode ??
      (options.yes
        ? ""
        : await prompts.text({
            message: t(language, "linearOAuthCode")
          })),
    "Linear OAuth authorization code"
  );
  const token = await (dependencies.exchangeLinearOAuthCode ?? exchangeLinearOAuthCode)({
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    code,
    redirectUri
  });
  const accessTokenExpiresAt = linearAccessTokenExpiresAt({
    token,
    ...(options.linearOauthExpiresAt ? { fallback: options.linearOauthExpiresAt } : {}),
    now: dependencies.now ?? (() => new Date())
  });
  const resolvedScopes = token.scope ?? scopes;
  return {
    token: token.accessToken,
    auth: {
      method: "oauth_app",
      actor: "app",
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      redirectUri,
      ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
      ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
      ...(resolvedScopes ? { scopes: resolvedScopes } : {})
    }
  };
}

function adapterMappingsFromLinearMetadata(snapshot: LinearMetadataSnapshot): NonNullable<LinearSetupInput["mappings"]> {
  return createLinearAdapterMappingDrafts(snapshot).map((draft) => ({
    id: `linear_${draft.domain}_${draft.strategy}`,
    ...draft,
    description: `Discovered from Linear ${draft.domain} metadata during setup.`
  }));
}

function discoveredLinearTeam(input: {
  snapshot: LinearMetadataSnapshot;
  teamId?: string;
  teamKey?: string;
}): { teamId?: string; teamKey?: string } {
  const team =
    (input.teamId ? input.snapshot.teams.find((candidate) => candidate.id === input.teamId) : undefined) ??
    (input.teamKey ? input.snapshot.teams.find((candidate) => candidate.key === input.teamKey) : undefined) ??
    (input.snapshot.teams.length === 1 ? input.snapshot.teams[0] : undefined);
  return {
    ...(!input.teamId && team?.id ? { teamId: team.id } : {}),
    ...(!input.teamKey && team?.key ? { teamKey: team.key } : {})
  };
}

function formatLinearDiscoveryResult(language: CliLanguage, input: { snapshot: LinearMetadataSnapshot; mappingCount: number }): string {
  if (language === "zh-CN") {
    return `Linear metadata discovery 完成：${input.snapshot.teams.length} teams, ${input.snapshot.workflowStates.length} states, ${input.snapshot.users.length} users, ${input.snapshot.issueLabels.length} labels, ${input.mappingCount} mappings。`;
  }
  return `Linear metadata discovery completed: ${input.snapshot.teams.length} teams, ${input.snapshot.workflowStates.length} states, ${input.snapshot.users.length} users, ${input.snapshot.issueLabels.length} labels, ${input.mappingCount} mappings.`;
}

async function collectLinearDiscovery(input: {
  options: SetupCommandOptions;
  authMethod: LinearAuthMethod;
  token?: string;
  graphqlUrl?: string;
  teamId?: string;
  teamKey?: string;
  prompts: PromptAdapter;
  language: CliLanguage;
  dependencies: SetupFlowDependencies;
}): Promise<{ mappings?: LinearSetupInput["mappings"]; teamId?: string; teamKey?: string }> {
  if (!input.token) return {};
  const shouldDiscover = input.options.linearDiscoverMetadata ?? input.authMethod === "oauth_app";
  if (!shouldDiscover) return {};
  const first = parsePositiveIntegerInput(input.options.linearDiscoveryLimit, "Linear metadata discovery limit") ?? 100;
  try {
    const snapshot = await (input.dependencies.discoverLinearMetadata ?? discoverLinearMetadata)({
      token: input.token,
      ...(input.graphqlUrl ? { graphqlUrl: input.graphqlUrl } : {}),
      first
    });
    const mappings = adapterMappingsFromLinearMetadata(snapshot);
    input.prompts.note(formatLinearDiscoveryResult(input.language, { snapshot, mappingCount: mappings.length }));
    return {
      mappings,
      ...discoveredLinearTeam({ snapshot, ...(input.teamId ? { teamId: input.teamId } : {}), ...(input.teamKey ? { teamKey: input.teamKey } : {}) })
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    input.prompts.note(input.language === "zh-CN" ? `Linear metadata discovery 跳过：${detail}` : `Linear metadata discovery skipped: ${detail}`);
    return {};
  }
}

async function collectLinearSetup(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage,
  dependencies: SetupFlowDependencies
): Promise<LinearSetupInput> {
  const authMethod = await collectLinearAuthMethod(options, defaults, prompts, language);
  const graphqlUrl = optionalTrimmed(options.linearGraphqlUrl ?? defaults.linearGraphqlUrl);
  if (authMethod === "api_key" && !options.linearToken) {
    prompts.note(formatLinearTokenHelp(language));
  }
  const hostedOAuth = shouldUseHostedLinearOAuthInstall(options, authMethod);
  const auth =
    hostedOAuth
      ? collectLinearHostedOAuthAuth(options)
      : authMethod === "oauth_app"
      ? await collectLinearOAuthAuth(options, prompts, language, dependencies)
      : await collectLinearApiKeyAuth(options, prompts, language);
  const explicitTeamId = optionalTrimmed(
    options.linearTeamId ??
      (options.yes
        ? defaults.linearTeamId
        : await prompts.text({
            message: t(language, "linearTeamId"),
            ...(defaults.linearTeamId ? { initialValue: defaults.linearTeamId, placeholder: defaults.linearTeamId } : {})
          }))
  );
  const explicitTeamKey = optionalTrimmed(
    options.linearTeamKey ??
      (options.yes
        ? defaults.linearTeamKey
        : await prompts.text({
            message: t(language, "linearTeamKey"),
            ...(defaults.linearTeamKey ? { initialValue: defaults.linearTeamKey, placeholder: defaults.linearTeamKey } : {})
          }))
  );
  const discovery = await collectLinearDiscovery({
    options,
    authMethod,
    ...(auth.token ? { token: auth.token } : {}),
    ...(graphqlUrl ? { graphqlUrl } : {}),
    ...(explicitTeamId ? { teamId: explicitTeamId } : {}),
    ...(explicitTeamKey ? { teamKey: explicitTeamKey } : {}),
    prompts,
    language,
    dependencies
  });
  const teamId = explicitTeamId ?? discovery.teamId;
  const teamKey = explicitTeamKey ?? discovery.teamKey;
  const webhookSecret = hostedOAuth
    ? undefined
    : options.linearWebhookSecret
      ? nonEmpty(options.linearWebhookSecret, "Linear webhook secret")
      : defaults.linearWebhookSecret ?? generateLinearWebhookSecret();
  const port =
    parsePortInput(options.linearPort, "Linear webhook port") ??
    (options.yes
      ? defaults.linearPort ?? DEFAULT_LINEAR_WEBHOOK_PORT
      : parseLocalPort(
          await prompts.text({
            message: t(language, "linearPort"),
            initialValue: String(defaults.linearPort ?? DEFAULT_LINEAR_WEBHOOK_PORT),
            placeholder: String(DEFAULT_LINEAR_WEBHOOK_PORT)
          }),
          "Linear webhook port"
        ));

  const defaultWebhookPath = hostedOAuth ? "/linear/oauth/webhooks" : options.relay ? generateLinearRelayWebhookPath() : "/linear/webhooks";

  return {
    ...(auth.token ? { token: auth.token } : {}),
    auth: auth.auth ?? { method: "api_key" },
    ...(webhookSecret ? { webhookSecret } : {}),
    ...(teamId ? { teamId } : {}),
    ...(teamKey ? { teamKey } : {}),
    ...(graphqlUrl ? { graphqlUrl } : {}),
    webhookPath: parseLinearWebhookPath(
      options.linearWebhookPath ?? defaults.linearWebhookPath ?? defaultWebhookPath
    ),
    port,
    ...(discovery.mappings ? { mappings: discovery.mappings } : {})
  };
}

async function collectTelegramSetup(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage
): Promise<TelegramSetupInput> {
  const mode = options.telegramMode ? parseTelegramSetupMode(options.telegramMode) : defaults.telegramMode ?? "polling";
  if (!options.telegramBotToken) {
    prompts.note(formatTelegramCredentialHelp(language));
  }
  const botToken = nonEmpty(
    options.telegramBotToken ?? (await prompts.password({ message: t(language, "telegramBotToken") })),
    "Telegram bot token"
  );
  const botIdFromToken = parseTelegramBotIdFromToken(botToken);
  const botId = nonEmpty(options.telegramBotId ?? defaults.telegramBotId ?? botIdFromToken, "Telegram bot id");
  if (botId !== botIdFromToken) {
    throw new Error("Telegram bot id must match the numeric prefix of the bot token.");
  }
  const botUsername = optionalTrimmed(
    options.telegramBotUsername ??
      (options.yes
        ? defaults.telegramBotUsername
        : await prompts.text({
            message: t(language, "telegramBotUsername"),
            ...(defaults.telegramBotUsername ? { initialValue: defaults.telegramBotUsername } : { placeholder: "opentag_bot" })
          }))
  );
  const bindingAdminUserIds =
    parseTelegramBindingAdminUserIds(options.telegramBindingAdminUserIds) ??
    (options.telegramBindingAdminUserIds === undefined ? defaults.telegramBindingAdminUserIds : undefined);
  if (mode === "polling" && options.telegramSecretToken) {
    throw new Error("Telegram webhook secret token is only used with --telegram-mode webhook.");
  }
  const secretToken =
    mode === "webhook"
      ? nonEmpty(options.telegramSecretToken ?? defaults.telegramSecretToken ?? generateTelegramSecretToken(), "Telegram webhook secret token")
      : undefined;
  const callbackUri = optionalTrimmed(options.telegramCallbackUri ?? defaults.telegramCallbackUri);
  if (callbackUri) {
    // Reuse URL parsing for an actionable setup-time error instead of a later
    // config-schema failure.
    new URL(callbackUri);
  }
  return {
    mode,
    botId,
    agentId: DEFAULT_TELEGRAM_AGENT_ID,
    ...(botUsername ? { botUsername } : {}),
    botToken,
    ...(bindingAdminUserIds ? { bindingAdminUserIds } : {}),
    ...(secretToken ? { secretToken } : {}),
    ...(callbackUri ? { callbackUri } : {})
  };
}

async function collectDiscordSetup(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage
): Promise<DiscordSetupInput> {
  const mode = options.discordMode ? parseDiscordSetupMode(options.discordMode) : defaults.discordMode ?? "gateway";
  if ((mode === "webhook" && !options.discordPublicKey) || !options.discordBotToken) {
    prompts.note(formatDiscordCredentialHelp(language));
  }
  if (mode === "gateway" && options.discordPublicKey) {
    throw new Error("Discord application public key is only used with --discord-mode webhook.");
  }
  const publicKey =
    mode === "webhook"
      ? nonEmpty(
          options.discordPublicKey ??
            (await prompts.text({
              message: t(language, "discordPublicKey"),
              placeholder: "Ed25519 public key"
            })),
          "Discord application public key"
        )
      : undefined;
  const botToken = nonEmpty(
    options.discordBotToken ?? (await prompts.password({ message: t(language, "discordBotToken") })),
    "Discord bot token"
  );
  if (mode === "gateway" && options.discordWebhookPath) {
    throw new Error("Discord interactions webhook path is only used with --discord-mode webhook.");
  }
  const webhookPath =
    mode === "webhook"
      ? parseWebhookPath(options.discordWebhookPath ?? defaults.discordWebhookPath ?? DEFAULT_DISCORD_WEBHOOK_PATH, "Discord interactions webhook path")
      : undefined;
  return {
    mode,
    ...(publicKey ? { publicKey } : {}),
    botToken,
    ...(webhookPath ? { webhookPath } : {})
  };
}

async function collectBindingMethod(
  options: SetupCommandOptions,
  defaults: SetupDefaults,
  prompts: PromptAdapter,
  language: CliLanguage,
  platform: "lark" | "slack"
): Promise<BindingMethod> {
  if (options.binding) {
    const binding = parseBindingMethod(options.binding);
    if (platform === "slack" && binding === "bind_later") {
      throw new Error("Slack setup requires a channel binding. Use --binding default_project.");
    }
    return binding;
  }
  if (platform === "slack") {
    return "default_project";
  }
  const message =
    t(language, "bindingMethod");
  return prompts.select({
    message,
    initialValue: defaults.bindingMethod ?? "default_project",
    options: (["default_project", "bind_later"] satisfies BindingMethod[]).map((method) => ({
      value: method,
      label: bindingMethodLabel(language, method, platform),
      hint: bindingMethodHint(language, method, platform)
    }))
  });
}

export async function collectSetupInput(
  options: SetupCommandOptions,
  configPath: string,
  dependencies: SetupFlowDependencies
): Promise<OpenTagSetupInput> {
  const defaults = dependencies.defaults ?? loadDefaultsForSetup(options, configPath);
  const prompts = dependencies.prompts;
  const cwd = dependencies.cwd ?? process.cwd();

  prompts.intro(t(defaultLanguage(options, defaults), "intro"));

  const language = await collectLanguage(options, defaults, prompts);
  const platform = await collectPlatform(options, defaults, prompts, language);
  const executor = await collectExecutor(options, defaults, prompts, language, dependencies.env);
  const hermesSetup = collectHermesSetup(options, defaults, executor);
  const agentSessionProfile = collectAgentSessionProfileSetup(options, defaults);
  const projectPath = await collectProjectPath(options, defaults, prompts, language, cwd);
  const resolvedProjectPath = projectPath.trim() || cwd;
  const savedLarkCredentials =
    platform === "lark" && shouldReadSavedLarkCredentials(options)
      ? findSavedLarkCredentials(defaults, resolvedProjectPath)
      : undefined;
  const larkSetupMethod =
    platform === "lark" ? await collectLarkSetupMethod(options, defaults, prompts, language, savedLarkCredentials) : undefined;
  const larkDomain =
    platform === "lark" && larkSetupMethod && larkSetupMethod !== "scan"
      ? await collectLarkDomain(options, defaults, prompts, language, larkSetupMethod, savedLarkCredentials)
      : undefined;
  const larkCredentials =
    platform === "lark" && larkSetupMethod
      ? await collectLarkCredentials({
          options,
          prompts,
          language,
          setupMethod: larkSetupMethod,
          ...(larkDomain ? { domain: larkDomain } : {}),
          ...(savedLarkCredentials ? { savedLarkCredentials } : {}),
          scanLarkPersonalAgent: dependencies.scanLarkPersonalAgent,
          validateLarkCredentials: dependencies.validateLarkCredentials ?? validateLarkCredentials
        })
      : undefined;
  const larkBindingMethod = platform === "lark" ? await collectBindingMethod(options, defaults, prompts, language, "lark") : undefined;
  const slackSetup = platform === "slack" ? await collectSlackSetup(options, defaults, prompts, language) : undefined;
  const githubSetup = platform === "github" ? await collectGitHubSetup(options, defaults, prompts, language, resolvedProjectPath) : undefined;
  const gitlabSetup = platform === "gitlab" ? await collectGitLabSetup(options, defaults, prompts, language, resolvedProjectPath) : undefined;
  const linearSetup = platform === "linear" ? await collectLinearSetup(options, defaults, prompts, language, dependencies) : undefined;
  const telegramSetup = platform === "telegram" ? await collectTelegramSetup(options, defaults, prompts, language) : undefined;
  const discordSetup = platform === "discord" ? await collectDiscordSetup(options, defaults, prompts, language) : undefined;
  const larkPersistedCredentials = larkCredentials
    ? {
        appId: larkCredentials.appId,
        appSecret: larkCredentials.appSecret,
        ...(larkCredentials.botOpenId ? { botOpenId: larkCredentials.botOpenId } : {})
      }
    : undefined;

  const setupInput: OpenTagSetupInput = {
    language,
    platform,
    projectPath: resolvedProjectPath,
    executor,
    ...(hermesSetup ? { hermes: hermesSetup } : {}),
    ...(agentSessionProfile ? { agentSessionProfile } : {}),
    ...(larkPersistedCredentials && larkCredentials && larkSetupMethod && larkBindingMethod
      ? {
          lark: {
            ...larkPersistedCredentials,
            domain: larkCredentials.domain,
            setupMethod: larkSetupMethod,
            bindingMethod: larkBindingMethod,
            ...(larkSetupMethod === "saved" && savedLarkCredentials ? { savedCredentialsSource: savedLarkCredentials.source } : {})
          }
        }
      : {}),
    ...(slackSetup ? { slack: slackSetup } : {}),
    ...(githubSetup ? { github: githubSetup } : {}),
    ...(gitlabSetup ? { gitlab: gitlabSetup } : {}),
    ...(linearSetup ? { linear: linearSetup } : {}),
    ...(telegramSetup ? { telegram: telegramSetup } : {}),
    ...(discordSetup ? { discord: discordSetup } : {})
  };

  prompts.note(formatSetupReview(setupInput, configPath));
  if (!options.yes) {
    const confirmed = await prompts.confirm({
      message: t(language, "confirmSetup"),
      initialValue: true
    });
    if (!confirmed) {
      throw new Error(t(language, "cancelled"));
    }
  }
  return setupInput;
}
