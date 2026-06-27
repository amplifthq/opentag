import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { LarkDomain, RegisteredLarkPersonalAgent } from "@opentag/lark";
import {
  defaultExecutorId,
  detectExecutors,
  EXECUTOR_CATALOG,
  executorLabel,
  parseExecutorId,
  type ExecutorId
} from "../catalogs/executors.js";
import { LANGUAGE_OPTIONS, parseCliLanguage, type CliLanguage } from "../catalogs/languages.js";
import { formatPlatformStatus, PLATFORM_CATALOG, parsePlatformId, platformById, type PlatformId } from "../catalogs/platforms.js";
import { formatSavedLarkCredentialsHint } from "../platforms/lark/display.js";
import { readLegacyLarkCredentials, type SavedLarkCredentials } from "../platforms/lark/saved-config.js";
import type { PromptAdapter } from "../ui/prompts.js";
import { bindingMethodHint, bindingMethodLabel, larkSetupHint, larkSetupLabel, slackModeHint, slackModeLabel, t } from "../ui/messages.js";
import { loadSetupDefaults } from "./defaults.js";
import { formatPlatformSetupGuide } from "./guides.js";
import { formatSetupReview } from "./summary.js";
import type { BindingMethod, GitHubSetupInput, LarkSetupMethod, OpenTagSetupInput, SetupDefaults, SlackSetupInput, SlackSetupMode } from "./types.js";

type LarkCredentialInput = {
  appId: string;
  appSecret: string;
  botOpenId?: string;
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
  larkDomain?: string;
  larkBotOpenId?: string;
  slackMode?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackAppId?: string;
  slackTeamId?: string;
  slackChannelId?: string;
  githubToken?: string;
  githubWebhookSecret?: string;
  githubRepository?: string;
  githubWebhookPath?: string;
  githubAutoCreatePr?: boolean;
  binding?: string;
  force?: boolean;
  yes?: boolean;
  start?: boolean;
};

export type SetupFlowDependencies = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  prompts: PromptAdapter;
  scanLarkPersonalAgent(input: { domain: LarkDomain }): Promise<RegisteredLarkPersonalAgent>;
  defaults?: SetupDefaults;
};

function parseLarkSetupMethod(value: string): LarkSetupMethod {
  if (value === "saved" || value === "scan" || value === "manual") return value;
  throw new Error("Lark setup method must be saved, scan, or manual.");
}

function parseLarkDomain(value: string): LarkDomain {
  if (value === "lark" || value === "feishu") return value;
  throw new Error("Lark domain must be lark or feishu.");
}

function parseSlackSetupMode(value: string): SlackSetupMode {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "socket_mode" || normalized === "events_api") return normalized;
  throw new Error("Slack mode must be socket_mode or events_api.");
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

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function generateGitHubWebhookSecret(): string {
  return randomBytes(32).toString("hex");
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

function defaultLanguage(options: SetupCommandOptions, defaults: SetupDefaults): CliLanguage {
  return options.language ? parseCliLanguage(options.language) : defaults.language ?? "en";
}

function formatPlatformStatusForSetup(language: CliLanguage, status: (typeof PLATFORM_CATALOG)[number]["status"]): string {
  if (language === "zh-CN") {
    switch (status) {
      case "setup_ready":
        return "这个 setup 向导现在可配置";
      case "setup_pending":
        return "适配器已有，setup 向导待接入";
      case "experimental_setup_pending":
        return "实验适配器，setup 向导待接入";
    }
  }
  return formatPlatformStatus(status);
}

function formatPlatformsForSetup(language: CliLanguage): string {
  const lines = PLATFORM_CATALOG.map((platform) => `- ${platform.label}: ${formatPlatformStatusForSetup(language, platform.status)}`);
  if (language === "zh-CN") {
    return ["这个 setup 向导当前可配置的平台：", ...lines].join("\n");
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
    const echoHint = input.language === "zh-CN" ? "开发测试用，不会调用真实 coding agent" : "dev/test only; no real coding agent";
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
): Promise<ExecutorId> {
  if (options.executor) {
    return parseExecutorId(options.executor);
  }
  const detections = detectExecutors(env);
  const previous = defaults.executor;
  const initialValue = defaultExecutorId({
    ...(previous ? { previous } : {}),
    detections
  });

  return prompts.select({
    message: t(language, "executor"),
    initialValue,
    options: EXECUTOR_CATALOG.map((executor) => {
      const detection = detections.find((entry) => entry.id === executor.id);
      return {
        value: executor.id,
        label: executor.label,
        hint: formatExecutorHint({
          language,
          executor,
          available: detection?.available ?? false,
          current: executor.id === previous,
          selectedByDefault: executor.id === initialValue
        })
      };
    })
  });
}

async function collectProjectPath(options: SetupCommandOptions, defaults: SetupDefaults, prompts: PromptAdapter, language: CliLanguage, cwd: string): Promise<string> {
  if (options.project) {
    return options.project;
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
    return setupMethod;
  }
  if (hasManualLarkCredentials(options)) {
    return "manual";
  }
  const methods: LarkSetupMethod[] = savedLarkCredentials ? ["saved", "scan", "manual"] : ["scan", "manual"];
  const previous = defaults.larkSetupMethod && methods.includes(defaults.larkSetupMethod) ? defaults.larkSetupMethod : undefined;
  return prompts.select({
    message: t(language, "larkSetup"),
    initialValue: savedLarkCredentials ? "saved" : previous ?? "scan",
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
  if (options.larkDomain) {
    return parseLarkDomain(options.larkDomain);
  }
  return prompts.select({
    message: t(language, "larkDomain"),
    initialValue: defaults.larkDomain ?? "lark",
    options: [
      { value: "lark", label: "Lark", hint: "larksuite.com" },
      { value: "feishu", label: "Feishu", hint: "feishu.cn" }
    ]
  });
}

async function collectLarkCredentials(input: {
  options: SetupCommandOptions;
  prompts: PromptAdapter;
  language: CliLanguage;
  setupMethod: LarkSetupMethod;
  domain: LarkDomain;
  savedLarkCredentials?: SavedLarkCredentials;
  scanLarkPersonalAgent(input: { domain: LarkDomain }): Promise<RegisteredLarkPersonalAgent>;
}): Promise<LarkCredentialInput> {
  if (input.setupMethod === "saved") {
    if (!input.savedLarkCredentials) {
      throw new Error("No saved Lark Personal Agent config was found.");
    }
    return {
      appId: input.savedLarkCredentials.appId,
      appSecret: input.savedLarkCredentials.appSecret,
      ...(input.savedLarkCredentials.botOpenId ? { botOpenId: input.savedLarkCredentials.botOpenId } : {})
    };
  }

  if (input.setupMethod === "scan") {
    assertNoManualLarkCredentialFlags(input.options);
    const registered = await input.scanLarkPersonalAgent({ domain: input.domain });
    return {
      appId: registered.appId,
      appSecret: registered.appSecret,
      ...(registered.botOpenId ? { botOpenId: registered.botOpenId } : {})
    };
  }

  assertCompleteManualLarkCredentials(input.options);
  const appId = nonEmpty(input.options.larkAppId ?? (await input.prompts.text({ message: t(input.language, "larkAppId") })), "Lark App ID");
  const appSecret = nonEmpty(
    input.options.larkAppSecret ??
      (await input.prompts.password({
        message: t(input.language, "larkAppSecret"),
        validate(value) {
          if (!value.trim()) return "Lark App Secret is required.";
          return undefined;
        }
      })),
    "Lark App Secret"
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
  return {
    appId,
    appSecret,
    ...(botOpenId ? { botOpenId } : {})
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
  const bindingMethod = await collectBindingMethod(options, defaults, prompts, language, "slack");
  return {
    mode: selectedMode,
    ...(appToken ? { appToken } : {}),
    ...(signingSecret ? { signingSecret } : {}),
    botToken,
    teamId,
    channelId,
    bindingMethod,
    ...(appId ? { appId } : {})
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
            parseGitHubRepository(value || repositoryDefault || "");
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }
      })),
    "GitHub repository"
  );
  const repository = parseGitHubRepository(repositoryInput);
  const token = nonEmpty(options.githubToken ?? (await prompts.password({ message: t(language, "githubToken") })), "GitHub token");
  const webhookSecret = options.githubWebhookSecret ? nonEmpty(options.githubWebhookSecret, "GitHub webhook secret") : generateGitHubWebhookSecret();
  const autoCreatePullRequest =
    options.githubAutoCreatePr ??
    (options.yes
      ? false
      : await prompts.confirm({
          message: t(language, "githubAutoCreatePr"),
          initialValue: defaults.githubAutoCreatePullRequest ?? false
        }));
  return {
    token,
    webhookSecret,
    owner: repository.owner,
    repo: repository.repo,
    webhookPath: options.githubWebhookPath ?? "/github/webhooks",
    autoCreatePullRequest
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
    return parseBindingMethod(options.binding);
  }
  const message =
    platform === "slack"
      ? language === "zh-CN"
        ? "Slack channel 要如何绑定到这个项目？"
        : "How should Slack channels bind to this project?"
      : t(language, "bindingMethod");
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
  const defaults = dependencies.defaults ?? loadSetupDefaults(configPath);
  const prompts = dependencies.prompts;
  const cwd = dependencies.cwd ?? process.cwd();

  prompts.intro(t(defaultLanguage(options, defaults), "intro"));

  const language = await collectLanguage(options, defaults, prompts);
  const platform = await collectPlatform(options, defaults, prompts, language);
  const executor = await collectExecutor(options, defaults, prompts, language, dependencies.env);
  const projectPath = await collectProjectPath(options, defaults, prompts, language, cwd);
  const resolvedProjectPath = projectPath.trim() || cwd;
  const savedLarkCredentials = platform === "lark" ? findSavedLarkCredentials(defaults, resolvedProjectPath) : undefined;
  const larkSetupMethod =
    platform === "lark" ? await collectLarkSetupMethod(options, defaults, prompts, language, savedLarkCredentials) : undefined;
  const larkDomain =
    platform === "lark" && larkSetupMethod
      ? await collectLarkDomain(options, defaults, prompts, language, larkSetupMethod, savedLarkCredentials)
      : undefined;
  const larkCredentials =
    platform === "lark" && larkSetupMethod && larkDomain
      ? await collectLarkCredentials({
          options,
          prompts,
          language,
          setupMethod: larkSetupMethod,
          domain: larkDomain,
          ...(savedLarkCredentials ? { savedLarkCredentials } : {}),
          scanLarkPersonalAgent: dependencies.scanLarkPersonalAgent
        })
      : undefined;
  const larkBindingMethod = platform === "lark" ? await collectBindingMethod(options, defaults, prompts, language, "lark") : undefined;
  const slackSetup = platform === "slack" ? await collectSlackSetup(options, defaults, prompts, language) : undefined;
  const githubSetup = platform === "github" ? await collectGitHubSetup(options, defaults, prompts, language, resolvedProjectPath) : undefined;

  const setupInput: OpenTagSetupInput = {
    language,
    platform,
    projectPath: resolvedProjectPath,
    executor,
    ...(larkCredentials && larkDomain && larkSetupMethod && larkBindingMethod
      ? {
          lark: {
            ...larkCredentials,
            domain: larkDomain,
            setupMethod: larkSetupMethod,
            bindingMethod: larkBindingMethod,
            ...(larkSetupMethod === "saved" && savedLarkCredentials ? { savedCredentialsSource: savedLarkCredentials.source } : {})
          }
        }
      : {}),
    ...(slackSetup ? { slack: slackSetup } : {}),
    ...(githubSetup ? { github: githubSetup } : {})
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
