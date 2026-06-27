import { executorLabel } from "../catalogs/executors.js";
import { platformById } from "../catalogs/platforms.js";
import type { CliLanguage } from "../catalogs/languages.js";
import type { OpenTagCliConfig } from "../config.js";
import type { OpenTagSetupInput } from "./types.js";

function yesNo(value: boolean, language: CliLanguage): string {
  return language === "zh-CN" ? (value ? "是" : "否") : value ? "yes" : "no";
}

export function formatSetupReview(input: OpenTagSetupInput, configPath: string): string {
  const platform = platformById(input.platform);
  const lines =
    input.language === "zh-CN"
      ? [
          "请确认 OpenTag 配置：",
          `配置文件: ${configPath}`,
          `平台: ${platform.label}`,
          `Coding agent: ${executorLabel(input.executor)}`,
          `项目路径: ${input.projectPath}`,
          `Lark 连接方式: ${input.lark.setupMethod === "scan" ? "扫码" : "手动填写"}`,
          `Lark 域名: ${input.lark.domain}`,
          `默认绑定当前项目: ${yesNo(input.lark.bindingMethod === "default_project", input.language)}`
        ]
      : [
          "Review your OpenTag setup:",
          `Config: ${configPath}`,
          `Platform: ${platform.label}`,
          `Coding agent: ${executorLabel(input.executor)}`,
          `Project path: ${input.projectPath}`,
          `Lark setup: ${input.lark.setupMethod === "scan" ? "Scan QR code" : "Manual credentials"}`,
          `Lark domain: ${input.lark.domain}`,
          `Default project binding: ${yesNo(input.lark.bindingMethod === "default_project", input.language)}`
        ];
  return lines.join("\n");
}

export function formatSetupComplete(config: OpenTagCliConfig, configPath: string): string {
  const repository = config.daemon.repositories[0];
  return [
    `OpenTag config written to ${configPath}`,
    repository ? `Project Target: ${repository.provider}:${repository.owner}/${repository.repo}` : undefined,
    "Run `opentag start` to start OpenTag."
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
