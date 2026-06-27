import type { CliLanguage } from "../catalogs/languages.js";
import type { BindingMethod, LarkSetupMethod, SlackSetupMode } from "../setup/types.js";

type MessageKey =
  | "intro"
  | "language"
  | "platform"
  | "executor"
  | "projectPath"
  | "larkSetup"
  | "larkDomain"
  | "larkAppId"
  | "larkAppSecret"
  | "larkBotOpenId"
  | "slackMode"
  | "slackAppToken"
  | "slackSigningSecret"
  | "slackBotToken"
  | "slackAppId"
  | "slackTeamId"
  | "slackChannelId"
  | "githubRepository"
  | "githubToken"
  | "githubWebhookSecret"
  | "githubAutoCreatePr"
  | "bindingMethod"
  | "confirmSetup"
  | "cancelled"
  | "complete";

const MESSAGES: Record<CliLanguage, Record<MessageKey, string>> = {
  en: {
    intro: "OpenTag setup",
    language: "Language / 语言",
    platform: "Where should OpenTag listen?",
    executor: "Which coding agent should OpenTag use?",
    projectPath: "Which project should OpenTag use?",
    larkSetup: "How should OpenTag connect to Lark / Feishu?",
    larkDomain: "Which Lark domain should OpenTag use?",
    larkAppId: "Lark App ID",
    larkAppSecret: "Lark App Secret",
    larkBotOpenId: "Lark Bot Open ID (optional)",
    slackMode: "How should OpenTag connect to Slack?",
    slackAppToken: "Slack App-Level Token",
    slackSigningSecret: "Slack Signing Secret",
    slackBotToken: "Slack Bot User OAuth Token",
    slackAppId: "Slack App ID (optional)",
    slackTeamId: "Slack Team ID",
    slackChannelId: "Slack Channel ID",
    githubRepository: "GitHub repository (owner/repo)",
    githubToken: "GitHub token for comments and pull requests",
    githubWebhookSecret: "GitHub webhook secret",
    githubAutoCreatePr: "Allow OpenTag to create pull requests when runs change files?",
    bindingMethod: "How should Lark chats bind to this project?",
    confirmSetup: "Write this OpenTag config?",
    cancelled: "OpenTag setup cancelled.",
    complete: "OpenTag setup complete."
  },
  "zh-CN": {
    intro: "OpenTag 设置",
    language: "Language / 语言",
    platform: "OpenTag 要监听哪个平台？",
    executor: "OpenTag 要使用哪个 coding agent？",
    projectPath: "OpenTag 要使用哪个项目？",
    larkSetup: "OpenTag 要如何连接 Lark / 飞书？",
    larkDomain: "OpenTag 要使用哪个 Lark 域名？",
    larkAppId: "Lark App ID",
    larkAppSecret: "Lark App Secret",
    larkBotOpenId: "Lark Bot Open ID（可选）",
    slackMode: "OpenTag 要如何连接 Slack？",
    slackAppToken: "Slack App-Level Token",
    slackSigningSecret: "Slack Signing Secret",
    slackBotToken: "Slack Bot User OAuth Token",
    slackAppId: "Slack App ID（可选）",
    slackTeamId: "Slack Team ID",
    slackChannelId: "Slack Channel ID",
    githubRepository: "GitHub 仓库（owner/repo）",
    githubToken: "GitHub token（用于回写评论和创建 PR）",
    githubWebhookSecret: "GitHub webhook secret",
    githubAutoCreatePr: "当 run 修改了文件时，允许 OpenTag 自动创建 pull request 吗？",
    bindingMethod: "Lark 群聊要如何绑定到这个项目？",
    confirmSetup: "写入这份 OpenTag 配置？",
    cancelled: "OpenTag 设置已取消。",
    complete: "OpenTag 设置完成。"
  }
};

export function t(language: CliLanguage, key: MessageKey): string {
  return MESSAGES[language][key];
}

export function larkSetupLabel(language: CliLanguage, method: LarkSetupMethod): string {
  if (language === "zh-CN") {
    if (method === "saved") return "使用已保存的 Personal Agent";
    return method === "scan" ? "创建新的 Personal Agent" : "手动填写 App ID / Secret";
  }
  if (method === "saved") return "Use saved Personal Agent";
  return method === "scan" ? "Create a new Personal Agent" : "Manual credentials";
}

export function larkSetupHint(language: CliLanguage, method: LarkSetupMethod): string {
  if (language === "zh-CN") {
    if (method === "saved") return "推荐，不需要重新扫码";
    return method === "scan" ? "没有已保存配置时使用" : "已有自建应用时使用";
  }
  if (method === "saved") return "Recommended; no new scan";
  return method === "scan" ? "Use when no saved app exists" : "Use an existing app";
}

export function slackModeLabel(language: CliLanguage, mode: SlackSetupMode): string {
  if (language === "zh-CN") {
    return mode === "socket_mode" ? "本地 Socket Mode（推荐）" : "公网 Events API";
  }
  return mode === "socket_mode" ? "Local Socket Mode (Recommended)" : "Public Events API";
}

export function slackModeHint(language: CliLanguage, mode: SlackSetupMode): string {
  if (language === "zh-CN") {
    return mode === "socket_mode" ? "适合本机运行，不需要公网 URL" : "适合云端部署或 tunnel 测试";
  }
  return mode === "socket_mode" ? "Best for this computer; no public URL" : "Best for hosted OpenTag or tunnel testing";
}

export function bindingMethodLabel(language: CliLanguage, method: BindingMethod, platform: "lark" | "slack" = "lark"): string {
  if (language === "zh-CN") {
    if (method === "default_project") return "默认使用这个项目";
    return platform === "slack" ? "稍后在 OpenTag 配置里绑定" : "稍后在 Lark 里用 /bind 绑定";
  }
  if (method === "default_project") return "Use this project by default";
  return platform === "slack" ? "Bind later from OpenTag config" : "Bind later from Lark with /bind";
}

export function bindingMethodHint(language: CliLanguage, method: BindingMethod, platform: "lark" | "slack" = "lark"): string {
  if (language === "zh-CN") {
    if (method === "default_project") return "推荐，最快跑通";
    return platform === "slack" ? "适合先只保存 Slack 连接" : "适合多个项目";
  }
  if (method === "default_project") return "Recommended";
  return platform === "slack" ? "Use when you only want to save the Slack connection first" : "Best for multiple projects";
}
