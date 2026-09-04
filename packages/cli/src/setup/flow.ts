import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DEFAULT_HERMES_PROFILE } from "@opentag/local-runtime";
import {
  defaultExecutorId,
  detectExecutors,
  EXECUTOR_CATALOG,
} from "../catalogs/executors.js";
import {
  LANGUAGE_OPTIONS,
  parseCliLanguage,
  type CliLanguage,
} from "../catalogs/languages.js";
import { t } from "../ui/messages.js";
import type { PromptAdapter } from "../ui/prompts.js";
import { formatGitHubTokenHelp, formatRunnerSetupGuide } from "./guides.js";
import { formatSetupReview } from "./summary.js";
import type {
  GitHubSetupInput,
  OpenTagSetupInput,
} from "./types.js";

export type SetupCommandOptions = {
  config?: string;
  project?: string;
  executor?: string;
  language?: string;
  githubRepository?: string;
  projectTargetId?: string;
  hermesCommand?: string;
  hermesProfile?: string;
  agentProfile?: string;
  agentProfileTemplate?: string;
  relay?: string;
  yes?: boolean;
  start?: boolean;
  service?: boolean;
};

export type SetupFlowDependencies = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  prompts: PromptAdapter;
};

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

async function collectBootstrapPairingToken(input: {
  options: SetupCommandOptions;
  prompts: PromptAdapter;
  language: CliLanguage;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const configured = optionalTrimmed(input.env.OPENTAG_BOOTSTRAP_PAIRING_TOKEN);
  if (configured) return configured;
  if (input.options.yes) {
    throw new Error(
      "OPENTAG_BOOTSTRAP_PAIRING_TOKEN is required for non-interactive setup."
    );
  }
  return nonEmpty(
    await input.prompts.password({
      message: input.language === "zh-CN"
        ? "Control Plane bootstrap pairing token"
        : "Control Plane bootstrap pairing token"
    }),
    "Control Plane bootstrap pairing token"
  );
}

function parseGitHubRepository(value: string): { owner: string; repo: string } {
  const normalized = value.trim().replace(/^github:/u, "").replace(/\.git$/u, "");
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(normalized);
  if (!match) throw new Error("GitHub Project Target must use owner/repo.");
  return { owner: match[1]!, repo: match[2]! };
}

function inferGitHubRepository(projectPath: string): string | undefined {
  try {
    const remote = execFileSync(
      "git",
      ["-C", projectPath, "remote", "get-url", "origin"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(remote);
    return match ? `${match[1]}/${match[2]}` : undefined;
  } catch {
    return undefined;
  }
}

async function collectLanguage(
  options: SetupCommandOptions,
  prompts: PromptAdapter,
): Promise<CliLanguage> {
  if (options.language) return parseCliLanguage(options.language);
  if (options.yes) return "en";
  return prompts.select({
    message: t("en", "language"),
    initialValue: "en",
    options: LANGUAGE_OPTIONS.map((item) => ({
      value: item.id,
      label: item.label,
      hint: item.hint,
    })),
  });
}

async function collectExecutor(
  options: SetupCommandOptions,
  prompts: PromptAdapter,
  language: CliLanguage,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (options.executor) return nonEmpty(options.executor, "Executor");
  const detections = detectExecutors(env);
  if (options.yes) {
    return defaultExecutorId({ detections });
  }
  const available = EXECUTOR_CATALOG.filter((item) =>
    detections.find((candidate) => candidate.id === item.id)?.available);
  const catalog = available.length > 0 ? available : EXECUTOR_CATALOG;
  const initial = defaultExecutorId({ detections });
  return prompts.select({
    message: t(language, "executor"),
    initialValue: catalog.some((item) => item.id === initial)
      ? initial as never
      : catalog[0]!.id,
    options: catalog.map((item) => ({ value: item.id, label: item.label })),
  });
}

async function collectProjectPath(
  options: SetupCommandOptions,
  prompts: PromptAdapter,
  language: CliLanguage,
  cwd: string,
): Promise<string> {
  const fallback = cwd;
  const value = options.project ?? (options.yes
    ? fallback
    : await prompts.text({
        message: t(language, "projectPath"),
        initialValue: fallback,
      }));
  const projectPath = nonEmpty(value, "Project path");
  if (!existsSync(projectPath)) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }
  return projectPath;
}

async function collectGitHubSetup(input: {
  options: SetupCommandOptions;
  prompts: PromptAdapter;
  language: CliLanguage;
  projectPath: string;
}): Promise<GitHubSetupInput> {
  input.prompts.note(formatGitHubTokenHelp(input.language));
  const repositoryDefault = inferGitHubRepository(input.projectPath);
  const repository = input.options.githubRepository ?? repositoryDefault
    ?? (input.options.yes
      ? ""
      : await input.prompts.text({
          message: t(input.language, "githubRepository"),
          ...(repositoryDefault ? { initialValue: repositoryDefault } : {}),
        }));
  const parsed = parseGitHubRepository(repository);
  if (input.options.yes && !optionalTrimmed(input.options.projectTargetId)) {
    throw new Error("--project-target-id is required for non-interactive setup.");
  }
  const projectTargetId = nonEmpty(
    input.options.projectTargetId ?? await input.prompts.text({
      message: t(input.language, "projectTargetId"),
    }),
    "Project Target ID",
  );
  const token = input.options.yes
    ? undefined
    : optionalTrimmed(await input.prompts.password({
        message: `${t(input.language, "githubToken")} (optional)`,
      }));
  return {
    projectTargetId,
    ...(token ? { token } : {}),
    owner: parsed.owner,
    repo: parsed.repo,
  };
}

export async function collectSetupInput(
  options: SetupCommandOptions,
  configPath: string,
  dependencies: SetupFlowDependencies,
): Promise<OpenTagSetupInput> {
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const defaultLanguage = options.language
    ? parseCliLanguage(options.language)
    : "en";
  dependencies.prompts.intro(t(defaultLanguage, "intro"));
  const language = await collectLanguage(options, dependencies.prompts);
  dependencies.prompts.note(formatRunnerSetupGuide(language));
  const projectPath = await collectProjectPath(
    options,
    dependencies.prompts,
    language,
    cwd,
  );
  const executor = await collectExecutor(
    options,
    dependencies.prompts,
    language,
    env,
  );
  const github = await collectGitHubSetup({
    options,
    prompts: dependencies.prompts,
    language,
    projectPath,
  });
  const bootstrapPairingToken = await collectBootstrapPairingToken({
    options,
    prompts: dependencies.prompts,
    language,
    env,
  });
  const hermesCommand = optionalTrimmed(options.hermesCommand);
  const agentProfile = optionalTrimmed(options.agentProfile);
  const agentProfileTemplate = optionalTrimmed(options.agentProfileTemplate);
  const result: OpenTagSetupInput = {
    language,
    relayUrl: nonEmpty(options.relay ?? "", "Relay URL"),
    bootstrapPairingToken,
    projectPath,
    executor,
    github,
    ...(executor === "hermes" ? {
      hermes: {
        ...(hermesCommand ? { command: hermesCommand } : {}),
        profile: optionalTrimmed(options.hermesProfile) ?? DEFAULT_HERMES_PROFILE,
      },
    } : {}),
    ...(agentProfile || agentProfileTemplate ? {
      agentSessionProfile: {
        ...(agentProfile ? { profile: agentProfile } : {}),
        ...(agentProfileTemplate ? { profileTemplate: agentProfileTemplate } : {}),
      },
    } : {}),
  };
  dependencies.prompts.note(formatSetupReview(result, configPath));
  if (!options.yes) {
    const accepted = await dependencies.prompts.confirm({
      message: t(language, "confirmSetup"),
      initialValue: true,
    });
    if (!accepted) throw new Error(t(language, "cancelled"));
  }
  return result;
}
