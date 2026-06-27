import { executorLabel } from "../catalogs/executors.js";
import { platformById } from "../catalogs/platforms.js";
import type { CliLanguage } from "../catalogs/languages.js";
import type { OpenTagCliConfig } from "../config.js";
import { formatLarkPersonalAgentSummary } from "../platforms/lark/display.js";
import type { OpenTagSetupInput } from "./types.js";

function yesNo(value: boolean, language: CliLanguage): string {
  return language === "zh-CN" ? (value ? "是" : "否") : value ? "yes" : "no";
}

function larkSetupDescription(method: OpenTagSetupInput["lark"]["setupMethod"], language: CliLanguage): string {
  if (language === "zh-CN") {
    if (method === "saved") return "使用已保存的 Personal Agent";
    return method === "scan" ? "创建新的 Personal Agent" : "手动填写";
  }
  if (method === "saved") return "Saved Personal Agent";
  return method === "scan" ? "Create new Personal Agent" : "Manual credentials";
}

export function formatSetupReview(input: OpenTagSetupInput, configPath: string): string {
  const platform = platformById(input.platform);
  const larkPersonalAgent = formatLarkPersonalAgentSummary(
    {
      ...input.lark,
      ...(input.lark.savedCredentialsSource ? { source: input.lark.savedCredentialsSource } : {})
    },
    input.language
  );
  const lines =
    input.language === "zh-CN"
      ? [
          "请确认 OpenTag 配置：",
          `配置文件: ${configPath}`,
          `平台: ${platform.label}`,
          `Coding agent: ${executorLabel(input.executor)}`,
          `项目路径: ${input.projectPath}`,
          `Lark 连接方式: ${larkSetupDescription(input.lark.setupMethod, input.language)}`,
          `Personal Agent: ${larkPersonalAgent}`,
          `Lark 域名: ${input.lark.domain}`,
          `默认绑定当前项目: ${yesNo(input.lark.bindingMethod === "default_project", input.language)}`
        ]
      : [
          "Review your OpenTag setup:",
          `Config: ${configPath}`,
          `Platform: ${platform.label}`,
          `Coding agent: ${executorLabel(input.executor)}`,
          `Project path: ${input.projectPath}`,
          `Lark setup: ${larkSetupDescription(input.lark.setupMethod, input.language)}`,
          `Personal Agent: ${larkPersonalAgent}`,
          `Lark domain: ${input.lark.domain}`,
          `Default project binding: ${yesNo(input.lark.bindingMethod === "default_project", input.language)}`
        ];
  return lines.join("\n");
}

export function formatSetupComplete(config: OpenTagCliConfig, configPath: string): string {
  const repository = config.daemon.repositories[0];
  const language = config.preferences?.language ?? "en";
  if (language === "zh-CN") {
    return [
      "OpenTag 配置已保存。",
      `配置文件: ${configPath}`,
      repository ? `项目路径: ${repository.checkoutPath}` : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }
  return [
    "OpenTag config saved.",
    `Config: ${configPath}`,
    repository ? `Project path: ${repository.checkoutPath}` : undefined
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
