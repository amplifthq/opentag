import type { CliLanguage } from "../catalogs/languages.js";
import type { BindingMethod, LarkSetupMethod, SlackSetupMode } from "../setup/types.js";

type MessageKey =
  | "intro"
  | "language"
  | "platform"
  | "executor"
  | "executorCustomHint"
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
  | "slackPort"
  | "githubRepository"
  | "githubToken"
  | "githubWebhookSecret"
  | "githubPort"
  | "githubAutoCreatePr"
  | "gitlabProject"
  | "gitlabToken"
  | "gitlabPort"
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
    executorCustomHint: "Currently configured custom executor",
    projectPath: "Which project should OpenTag use?",
    larkSetup: "How should OpenTag connect to Lark / Feishu?",
    larkDomain: "Which Lark / Feishu tenant is this existing app for?",
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
    slackPort: "Local Slack Events API port",
    githubRepository: "GitHub repository (owner/repo)",
    githubToken: "GitHub token for comments and `apply 1` pull requests",
    githubWebhookSecret: "GitHub webhook secret",
    githubPort: "Local GitHub webhook port",
    githubAutoCreatePr: "Create pull requests immediately after runs? (advanced)",
    gitlabProject: "GitLab project (group/project or group/subgroup/project)",
    gitlabToken: "GitLab access token for source-thread replies",
    gitlabPort: "Local GitLab webhook port",
    bindingMethod: "How should Lark chats bind to this project?",
    confirmSetup: "Write this OpenTag config?",
    cancelled: "OpenTag setup cancelled.",
    complete: "OpenTag setup complete."
  },
  "zh-CN": {
    intro: "OpenTag 设置",
    language: "Language / 语言",
    platform: "OpenTag 要监听哪个平台？",
    executor: "OpenTag 要使用哪个编码代理？",
    executorCustomHint: "当前配置的自定义执行器",
    projectPath: "OpenTag 要使用哪个项目？",
    larkSetup: "OpenTag 要如何连接 Lark/飞书？",
    larkDomain: "这个已有应用属于哪个 Lark/飞书租户？",
    larkAppId: "Lark 应用 ID",
    larkAppSecret: "Lark 应用密钥",
    larkBotOpenId: "Lark 机器人 Open ID（可选）",
    slackMode: "OpenTag 要如何连接 Slack？",
    slackAppToken: "Slack App-Level Token",
    slackSigningSecret: "Slack Signing Secret",
    slackBotToken: "Slack Bot User OAuth Token",
    slackAppId: "Slack App ID（可选）",
    slackTeamId: "Slack Team ID",
    slackChannelId: "Slack Channel ID",
    slackPort: "本地 Slack Events API 端口",
    githubRepository: "GitHub 仓库（owner/repo）",
    githubToken: "GitHub token（用于回写评论和 apply 1 创建 PR）",
    githubWebhookSecret: "GitHub webhook secret",
    githubPort: "本地 GitHub webhook 端口",
    githubAutoCreatePr: "run 结束后立刻自动创建 pull request 吗？（高级选项）",
    gitlabProject: "GitLab 项目（group/project 或 group/subgroup/project）",
    gitlabToken: "GitLab access token（用于回写 source thread）",
    gitlabPort: "本地 GitLab webhook 端口",
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
    if (method === "saved") return "使用已保存的个人代理应用";
    return method === "scan" ? "扫码创建个人代理应用（保存平台返回的真实租户）" : "手动填写 Lark/飞书应用凭据";
  }
  if (method === "saved") return "Use saved Personal Agent";
  return method === "scan" ? "Create Personal Agent by QR (save returned tenant)" : "Manual Lark / Feishu credentials";
}

export function larkSetupHint(language: CliLanguage, method: LarkSetupMethod): string {
  if (language === "zh-CN") {
    if (method === "saved") return "推荐，不需要重新扫码";
    return method === "scan" ? "链接可能从飞书 bootstrap 开始，最终保存真实 Lark/飞书租户" : "使用已有自建应用，并手动选择租户";
  }
  if (method === "saved") return "Recommended; no new scan";
  return method === "scan" ? "May start on Feishu bootstrap; saves the real returned tenant" : "Use an existing app and choose its tenant";
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
