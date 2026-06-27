import { executorLabel } from "../catalogs/executors.js";
import { platformById } from "../catalogs/platforms.js";
import type { CliLanguage } from "../catalogs/languages.js";
import type { OpenTagCliConfig } from "../config.js";
import { formatLarkPersonalAgentSummary } from "../platforms/lark/display.js";
import type { LarkSetupMethod, OpenTagSetupInput } from "./types.js";

function yesNo(value: boolean, language: CliLanguage): string {
  return language === "zh-CN" ? (value ? "是" : "否") : value ? "yes" : "no";
}

function larkSetupDescription(method: LarkSetupMethod, language: CliLanguage): string {
  if (language === "zh-CN") {
    if (method === "saved") return "使用已保存的 Personal Agent";
    return method === "scan" ? "创建新的 Personal Agent" : "手动填写";
  }
  if (method === "saved") return "Saved Personal Agent";
  return method === "scan" ? "Create new Personal Agent" : "Manual credentials";
}

export function formatSetupReview(input: OpenTagSetupInput, configPath: string): string {
  const platform = platformById(input.platform);
  const commonLines =
    input.language === "zh-CN"
      ? [
          "请确认 OpenTag 配置：",
          `配置文件: ${configPath}`,
          `平台: ${platform.label}`,
          `Coding agent: ${executorLabel(input.executor)}`,
          `项目路径: ${input.projectPath}`
        ]
      : [
          "Review your OpenTag setup:",
          `Config: ${configPath}`,
          `Platform: ${platform.label}`,
          `Coding agent: ${executorLabel(input.executor)}`,
          `Project path: ${input.projectPath}`
        ];

  const platformLines: string[] = [];
  if (input.lark) {
    const larkPersonalAgent = formatLarkPersonalAgentSummary(
      {
        ...input.lark,
        ...(input.lark.savedCredentialsSource ? { source: input.lark.savedCredentialsSource } : {})
      },
      input.language
    );
    platformLines.push(
      ...(input.language === "zh-CN"
        ? [
            `Lark 连接方式: ${larkSetupDescription(input.lark.setupMethod, input.language)}`,
            `Personal Agent: ${larkPersonalAgent}`,
            `Lark 域名: ${input.lark.domain}`,
            `默认绑定当前项目: ${yesNo(input.lark.bindingMethod === "default_project", input.language)}`
          ]
        : [
            `Lark setup: ${larkSetupDescription(input.lark.setupMethod, input.language)}`,
            `Personal Agent: ${larkPersonalAgent}`,
            `Lark domain: ${input.lark.domain}`,
            `Default project binding: ${yesNo(input.lark.bindingMethod === "default_project", input.language)}`
          ])
    );
  }
  if (input.slack) {
    const slackConnectionLines =
      input.slack.mode === "socket_mode"
        ? input.language === "zh-CN"
          ? ["Slack 连接方式: 本地 Socket Mode", "Slack 入站: 通过 Slack WebSocket，不需要公网 URL"]
          : ["Slack connection: Local Socket Mode", "Slack ingress: Slack WebSocket; no public URL required"]
        : input.language === "zh-CN"
          ? ["Slack 连接方式: 公网 Events API", `Slack Events URL: http://localhost:${input.slack.port ?? 3040}/slack/events`]
          : ["Slack connection: Public Events API", `Slack Events URL: http://localhost:${input.slack.port ?? 3040}/slack/events`];
    platformLines.push(
      ...(input.language === "zh-CN"
        ? [
            ...slackConnectionLines,
            `Slack Team ID: ${input.slack.teamId}`,
            `Slack Channel ID: ${input.slack.channelId}`,
            `默认绑定当前项目: ${yesNo(input.slack.bindingMethod === "default_project", input.language)}`
          ]
        : [
            ...slackConnectionLines,
            `Slack Team ID: ${input.slack.teamId}`,
            `Slack Channel ID: ${input.slack.channelId}`,
            `Default project binding: ${yesNo(input.slack.bindingMethod === "default_project", input.language)}`
          ])
    );
  }
  if (input.github) {
    platformLines.push(
      ...(input.language === "zh-CN"
        ? [
            `GitHub 仓库: ${input.github.owner}/${input.github.repo}`,
            `GitHub Webhook URL: http://localhost:${input.github.port ?? 3000}${input.github.webhookPath}`
          ]
        : [
            `GitHub repository: ${input.github.owner}/${input.github.repo}`,
            `GitHub Webhook URL: http://localhost:${input.github.port ?? 3000}${input.github.webhookPath}`
          ])
    );
  }
  const lines = [...commonLines, ...platformLines];
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
