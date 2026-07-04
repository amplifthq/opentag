import type { LarkDomain } from "@opentag/lark";
import type { CliLanguage } from "../catalogs/languages.js";
import { platformById, platformSetupGuideUrl, type PlatformId } from "../catalogs/platforms.js";
import type { SlackSetupMode } from "./types.js";

export const OFFICIAL_SETUP_LINKS = {
  githubTokenPage: "https://github.com/settings/personal-access-tokens/new",
  githubTokenDocs: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
  githubWebhookDocs: "https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks",
  slackApps: "https://api.slack.com/apps",
  slackSocketModeDocs: "https://docs.slack.dev/apis/events-api/using-socket-mode/",
  slackQuickstartDocs: "https://docs.slack.dev/quickstart/",
  slackSigningSecretDocs: "https://docs.slack.dev/authentication/verifying-requests-from-slack/",
  larkConsole: "https://open.larksuite.com/app",
  feishuConsole: "https://open.feishu.cn/app",
  larkAppIdDocs: "https://open.larksuite.com/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-app-id",
  larkWebSocketDocs: "https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket",
  feishuWebSocketDocs: "https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/use-websocket?lang=zh-CN",
  gitlabTokenPage: "https://gitlab.com/-/user_settings/personal_access_tokens",
  gitlabTokenDocs: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
  gitlabWebhookEventsDocs: "https://docs.gitlab.com/user/project/integrations/webhook_events/",
  gitlabNotesApiDocs: "https://docs.gitlab.com/api/notes/",
  gitlabMergeRequestsApiDocs: "https://docs.gitlab.com/api/merge_requests/",
  telegramBotApiDocs: "https://core.telegram.org/bots/api",
  telegramBotFather: "https://t.me/BotFather",
  discordApplications: "https://discord.com/developers/applications",
  discordInteractionsOverview: "https://docs.discord.com/developers/interactions/overview",
  discordGatewayEventsDocs: "https://docs.discord.com/developers/events/gateway-events#interaction-create",
  discordApplicationCommands: "https://docs.discord.com/developers/interactions/application-commands"
} as const;

function setupNeeds(platform: PlatformId, language: CliLanguage): string[] {
  if (language === "zh-CN") {
    switch (platform) {
      case "lark":
        return ["Lark 推荐手动配置自建应用", "飞书可以扫码创建个人代理应用", "手动配置时需要应用 ID 和应用密钥"];
      case "slack":
        return ["推荐本地使用 Socket Mode", "Socket Mode 需要 Slack App-Level Token 和 Bot User OAuth Token", "Events API 需要 Slack Signing Secret 和公网 Request URL", "开启 Interactivity & Shortcuts 以支持 Apply 1 按钮", "Slack bot scopes 需要 app_mentions:read、chat:write、reactions:write、channels:history", "订阅 bot events: app_mention、message.channels", "Slack Team ID", "Slack Channel ID", "测试前需要把 Slack app 邀请进目标 channel"];
      case "github":
        return ["GitHub 仓库 owner/repo", "GitHub token（用于回写评论；你回复 apply 1 后也用于创建 PR）", "OpenTag 会自动生成 webhook secret", "本地 webhook 端口，默认 3050", "需要一个公网 tunnel 转发 GitHub webhook"];
      case "gitlab":
        return ["GitLab 项目 path_with_namespace，例如 group/project", "GitLab access token（用于回写 issue/MR note；你回复 apply 1 后也用于创建 MR）", "OpenTag 会自动生成 webhook secret", "本地 webhook 端口，默认 3060", "需要一个公网 tunnel 转发 GitLab Note Hook"];
      case "telegram":
        return ["Telegram bot token（从 BotFather 获取）", "OpenTag 会从 bot token 推导 bot id", "默认使用 getUpdates polling，不需要公网 tunnel", "可选 bot username（群聊里用于 @botname 或 /opentag@botname）", "高级 webhook 模式才需要公网 HTTPS tunnel 和 secret token"];
      case "discord":
        return ["Discord Bot Token（Bot 页面，用于 Gateway 连接和回写频道消息）", "默认使用 Gateway 接收 INTERACTION_CREATE，不需要公网 tunnel", "注册 /opentag slash command", "高级 webhook 模式才需要 Application Public Key 和 Interactions Endpoint URL"];
    }
  }

  switch (platform) {
    case "lark":
      return ["Manual setup is recommended for Lark", "Feishu can use QR-created Personal Agent", "manual setup needs an App ID and App Secret"];
    case "slack":
      return ["Socket Mode is recommended for local OpenTag", "Socket Mode needs a Slack App-Level Token and Bot User OAuth Token", "Events API needs a Slack Signing Secret and public Request URL", "Enable Interactivity & Shortcuts for Apply 1 buttons", "Slack bot scopes need app_mentions:read, chat:write, reactions:write, channels:history", "Subscribe to bot events: app_mention, message.channels", "Slack Team ID", "Slack Channel ID", "Invite the Slack app to the target channel before testing"];
    case "github":
      return ["GitHub repository owner/repo", "GitHub token for comments and PR creation after you reply `apply 1`", "OpenTag generates the webhook secret", "Local webhook port, default 3050", "A public tunnel is required for GitHub webhook delivery"];
    case "gitlab":
      return ["GitLab project path_with_namespace, for example group/project", "GitLab access token for issue/MR note replies and MR creation after you reply `apply 1`", "OpenTag generates the webhook secret", "Local webhook port, default 3060", "A public tunnel is required for GitLab Note Hook delivery"];
    case "telegram":
      return ["Telegram bot token from BotFather", "OpenTag derives the bot id from the bot token", "Default getUpdates polling does not need a public tunnel", "Optional bot username for @botname or /opentag@botname in group chats", "Advanced webhook mode needs a public HTTPS tunnel and secret token"];
    case "discord":
      return ["Discord Bot Token from the Bot page for Gateway connection and channel replies", "Default Gateway delivery does not need a public tunnel", "A registered /opentag slash command", "Advanced webhook mode needs an Application Public Key and Interactions Endpoint URL"];
  }
}

function officialSetupLinks(platform: PlatformId, language: CliLanguage): string[] {
  if (language === "zh-CN") {
    switch (platform) {
      case "lark":
        return [
          `Lark 开发者后台: ${OFFICIAL_SETUP_LINKS.larkConsole}`,
          `飞书开发者后台: ${OFFICIAL_SETUP_LINKS.feishuConsole}`
        ];
      case "slack":
        return [
          `Slack App 管理页: ${OFFICIAL_SETUP_LINKS.slackApps}`,
          `Socket Mode 官方文档: ${OFFICIAL_SETUP_LINKS.slackSocketModeDocs}`
        ];
      case "github":
        return [
          `GitHub token 创建页: ${OFFICIAL_SETUP_LINKS.githubTokenPage}`,
          `Repository webhook 官方文档: ${OFFICIAL_SETUP_LINKS.githubWebhookDocs}`
        ];
      case "gitlab":
        return [
          `GitLab token 创建页: ${OFFICIAL_SETUP_LINKS.gitlabTokenPage}`,
          `GitLab webhook 事件文档: ${OFFICIAL_SETUP_LINKS.gitlabWebhookEventsDocs}`,
          `GitLab Notes API 文档: ${OFFICIAL_SETUP_LINKS.gitlabNotesApiDocs}`,
          `GitLab Merge Requests API 文档: ${OFFICIAL_SETUP_LINKS.gitlabMergeRequestsApiDocs}`
        ];
      case "telegram":
        return [
          `Telegram BotFather: ${OFFICIAL_SETUP_LINKS.telegramBotFather}`,
          `Telegram Bot API / getUpdates: ${OFFICIAL_SETUP_LINKS.telegramBotApiDocs}`,
          `Telegram Bot API / setWebhook（高级 webhook 模式）: ${OFFICIAL_SETUP_LINKS.telegramBotApiDocs}`
        ];
      case "discord":
        return [
          `Discord Developer Portal: ${OFFICIAL_SETUP_LINKS.discordApplications}`,
          `Discord Gateway docs: ${OFFICIAL_SETUP_LINKS.discordGatewayEventsDocs}`,
          `Discord Interactions Endpoint 文档（高级 webhook 模式）: ${OFFICIAL_SETUP_LINKS.discordInteractionsOverview}`,
          `Discord slash command 文档: ${OFFICIAL_SETUP_LINKS.discordApplicationCommands}`
        ];
    }
  }

  switch (platform) {
    case "lark":
      return [
        `Lark Developer Console: ${OFFICIAL_SETUP_LINKS.larkConsole}`,
        `Feishu Developer Console: ${OFFICIAL_SETUP_LINKS.feishuConsole}`
      ];
    case "slack":
      return [
        `Slack app settings: ${OFFICIAL_SETUP_LINKS.slackApps}`,
        `Socket Mode docs: ${OFFICIAL_SETUP_LINKS.slackSocketModeDocs}`
      ];
    case "github":
      return [
        `GitHub token page: ${OFFICIAL_SETUP_LINKS.githubTokenPage}`,
        `Repository webhook docs: ${OFFICIAL_SETUP_LINKS.githubWebhookDocs}`
      ];
    case "gitlab":
      return [
        `GitLab token page: ${OFFICIAL_SETUP_LINKS.gitlabTokenPage}`,
        `GitLab webhook event docs: ${OFFICIAL_SETUP_LINKS.gitlabWebhookEventsDocs}`,
        `GitLab Notes API docs: ${OFFICIAL_SETUP_LINKS.gitlabNotesApiDocs}`,
        `GitLab Merge Requests API docs: ${OFFICIAL_SETUP_LINKS.gitlabMergeRequestsApiDocs}`
      ];
    case "telegram":
      return [
        `Telegram BotFather: ${OFFICIAL_SETUP_LINKS.telegramBotFather}`,
        `Telegram Bot API / getUpdates: ${OFFICIAL_SETUP_LINKS.telegramBotApiDocs}`,
        `Telegram Bot API / setWebhook (advanced webhook mode): ${OFFICIAL_SETUP_LINKS.telegramBotApiDocs}`
      ];
    case "discord":
      return [
        `Discord Developer Portal: ${OFFICIAL_SETUP_LINKS.discordApplications}`,
        `Discord Gateway docs: ${OFFICIAL_SETUP_LINKS.discordGatewayEventsDocs}`,
        `Discord Interactions Endpoint docs (advanced webhook mode): ${OFFICIAL_SETUP_LINKS.discordInteractionsOverview}`,
        `Discord slash command docs: ${OFFICIAL_SETUP_LINKS.discordApplicationCommands}`
      ];
  }
}

export function formatPlatformSetupGuide(platform: PlatformId, language: CliLanguage): string | undefined {
  const url = platformSetupGuideUrl(platform, language);
  if (!url) return undefined;

  const descriptor = platformById(platform);
  const needs = setupNeeds(platform, language);
  const officialLinks = officialSetupLinks(platform, language);
  if (language === "zh-CN") {
    return [
      `${descriptor.label} 配置教程:`,
      url,
      "",
      "官方入口:",
      ...officialLinks.map((item) => `- ${item}`),
      "",
      "继续填写前，先打开教程确认这些值在哪里拿：",
      ...needs.map((item) => `- ${item}`)
    ].join("\n");
  }

  return [
    `${descriptor.label} setup guide:`,
    url,
    "",
    "Official setup pages:",
    ...officialLinks.map((item) => `- ${item}`),
    "",
    "Open the guide before filling in these values:",
    ...needs.map((item) => `- ${item}`)
  ].join("\n");
}

export function formatLarkManualCredentialHelp(language: CliLanguage, domain: LarkDomain): string {
  const consoleUrl = domain === "feishu" ? OFFICIAL_SETUP_LINKS.feishuConsole : OFFICIAL_SETUP_LINKS.larkConsole;
  const websocketDocs = domain === "feishu" ? OFFICIAL_SETUP_LINKS.feishuWebSocketDocs : OFFICIAL_SETUP_LINKS.larkWebSocketDocs;
  if (language === "zh-CN") {
    return [
      "手动 Lark/飞书凭据在哪里拿:",
      `- 开发者后台: ${consoleUrl}`,
      "- 应用 ID 和应用密钥: 打开你的应用，进入凭证与基础信息（Credentials & Basic Info）",
      "- 事件接收方式: 使用长连接（WebSocket）",
      `- 长连接官方文档: ${websocketDocs}`,
      "",
      "如果你没有自建应用，建议返回选择扫码创建个人代理应用。"
    ].join("\n");
  }

  return [
    "Where to find manual Lark / Feishu credentials:",
    `- Developer console: ${consoleUrl}`,
    "- App ID / App Secret: open your app, then go to Credentials & Basic Info",
    "- Event delivery mode: use long connection / WebSocket",
    `- WebSocket docs: ${websocketDocs}`,
    "",
    "If you do not already manage a self-built app, use QR scan instead."
  ].join("\n");
}

export function formatSlackCredentialHelp(language: CliLanguage, mode: SlackSetupMode): string {
  if (language === "zh-CN") {
    const modeSpecific =
      mode === "socket_mode"
        ? [
            `- Socket Mode 官方文档: ${OFFICIAL_SETUP_LINKS.slackSocketModeDocs}`,
            "- Slack App-Level Token: Basic Information -> App-Level Tokens -> Generate Token and Scopes，scope 选 connections:write",
            "- Interactivity & Shortcuts: 打开 Interactivity；Socket Mode 不需要 Request URL"
          ]
        : [
            `- Signing Secret 官方文档: ${OFFICIAL_SETUP_LINKS.slackSigningSecretDocs}`,
            "- Slack Signing Secret: Basic Information -> App Credentials",
            "- Event Subscriptions Request URL: 填你的公网 tunnel，例如 https://<your-tunnel>/slack/events",
            "- Interactivity & Shortcuts Request URL: 填同一个 https://<your-tunnel>/slack/events"
          ];
    return [
      "Slack 这些值在哪里拿:",
      `- Slack App 管理页: ${OFFICIAL_SETUP_LINKS.slackApps}`,
      ...modeSpecific,
      "- Slack Bot User OAuth Token: OAuth & Permissions -> Bot User OAuth Token",
      "- Bot Token Scopes: app_mentions:read, chat:write, reactions:write, channels:history",
      "- Bot Events: app_mention, message.channels",
      "- Team ID / Channel ID: 用浏览器打开 Slack channel，从地址里复制 T... 和 C...",
      "- 测试前在目标 channel 里运行 /invite @你的 App 名称，把 app 邀请进 channel"
    ].join("\n");
  }

  const modeSpecific =
    mode === "socket_mode"
      ? [
          `- Socket Mode docs: ${OFFICIAL_SETUP_LINKS.slackSocketModeDocs}`,
          "- Slack App-Level Token: Basic Information -> App-Level Tokens -> Generate Token and Scopes, then add connections:write",
          "- Interactivity & Shortcuts: turn Interactivity on; Socket Mode does not need a Request URL"
        ]
      : [
          `- Signing Secret docs: ${OFFICIAL_SETUP_LINKS.slackSigningSecretDocs}`,
          "- Slack Signing Secret: Basic Information -> App Credentials",
          "- Event Subscriptions Request URL: use your public tunnel, for example https://<your-tunnel>/slack/events",
          "- Interactivity & Shortcuts Request URL: use the same https://<your-tunnel>/slack/events"
        ];
  return [
    "Where to find these Slack values:",
    `- Slack app settings: ${OFFICIAL_SETUP_LINKS.slackApps}`,
    ...modeSpecific,
    "- Slack Bot User OAuth Token: OAuth & Permissions -> Bot User OAuth Token",
    "- Bot Token Scopes: app_mentions:read, chat:write, reactions:write, channels:history",
    "- Bot Events: app_mention, message.channels",
    "- Team ID / Channel ID: open the Slack channel in a browser and copy the T... and C... values from the URL",
    "- Before testing, run /invite @your app name in the target channel so Slack sends mentions to the app"
  ].join("\n");
}

export function formatGitHubTokenHelp(language: CliLanguage, input: { autoCreatePullRequest: boolean }): string {
  if (language === "zh-CN") {
    const permissions =
      input.autoCreatePullRequest
        ? ["- Issues: Read and write", "- Pull requests: Read and write", "- Contents: Read and write"]
        : ["- Issues: Read and write", "- Pull requests: Read and write", "- Contents: 默认 apply 1 流程不需要；run branch 会使用本机 git remote 凭据推送"];
    return [
      "GitHub token 在哪里创建:",
      `- 直接打开: ${OFFICIAL_SETUP_LINKS.githubTokenPage}`,
      `- 官方教程: ${OFFICIAL_SETUP_LINKS.githubTokenDocs}`,
      "",
      "推荐创建 fine-grained personal access token，只授权当前仓库。需要权限:",
      ...permissions,
      "",
      "GitHub 只会展示 token 一次，创建后马上复制并粘贴到下一步。"
    ].join("\n");
  }

  const permissions =
    input.autoCreatePullRequest
      ? ["- Issues: Read and write", "- Pull requests: Read and write", "- Contents: Read and write"]
      : ["- Issues: Read and write", "- Pull requests: Read and write", "- Contents: not needed for the default apply-1 flow; branch push uses your local git remote credentials"];
  return [
    "Where to create the GitHub token:",
    `- Direct token page: ${OFFICIAL_SETUP_LINKS.githubTokenPage}`,
    `- Official guide: ${OFFICIAL_SETUP_LINKS.githubTokenDocs}`,
    "",
    "Create a fine-grained personal access token and limit it to this repository. Required permissions:",
    ...permissions,
    "",
    "GitHub only shows the token once. Copy it immediately, then paste it into the next prompt."
  ].join("\n");
}

export function formatGitLabTokenHelp(language: CliLanguage, input: { baseUrl: string }): string {
  const tokenPage =
    input.baseUrl === "https://gitlab.com"
      ? OFFICIAL_SETUP_LINKS.gitlabTokenPage
      : `${input.baseUrl.replace(/\/$/, "")}/-/user_settings/personal_access_tokens`;
  if (language === "zh-CN") {
    return [
      "GitLab token 在哪里创建:",
      `- 直接打开: ${tokenPage}`,
      `- 官方教程: ${OFFICIAL_SETUP_LINKS.gitlabTokenDocs}`,
      "",
      "推荐创建 personal access token 或 project access token，只授权当前项目。需要权限:",
      "- api: 用于通过 Notes API 回写 issue / merge request 评论，并在 apply 后通过 Merge Requests API 创建 MR",
      "",
      "Webhook 设置里需要启用 Note events，并填写 OpenTag 生成的 secret token。"
    ].join("\n");
  }

  return [
    "Where to create the GitLab token:",
    `- Token page: ${tokenPage}`,
    `- Official guide: ${OFFICIAL_SETUP_LINKS.gitlabTokenDocs}`,
    "",
    "Create a personal access token or project access token scoped to this project. Required scope:",
    "- api: lets OpenTag post issue / merge request replies through the Notes API and create MRs through the Merge Requests API after apply",
    "",
    "In the project webhook, enable Note events and paste the secret token generated by OpenTag."
  ].join("\n");
}

export function formatTelegramCredentialHelp(language: CliLanguage): string {
  if (language === "zh-CN") {
    return [
      "Telegram 凭据在哪里拿:",
      `- BotFather: ${OFFICIAL_SETUP_LINKS.telegramBotFather}`,
      "- 发送 /newbot 或打开已有 bot，复制 bot token。",
      "- bot token 前缀中的数字就是 bot id，OpenTag 会自动推导。",
      `- getUpdates / setWebhook 官方文档: ${OFFICIAL_SETUP_LINKS.telegramBotApiDocs}`,
      "",
      "默认 polling 模式不需要公网 tunnel；只有 --telegram-mode webhook 才需要公网 HTTPS URL。"
    ].join("\n");
  }

  return [
    "Where to find Telegram credentials:",
    `- BotFather: ${OFFICIAL_SETUP_LINKS.telegramBotFather}`,
    "- Use /newbot or open an existing bot, then copy the bot token.",
    "- The numeric token prefix is the bot id; OpenTag derives it automatically.",
    `- getUpdates / setWebhook docs: ${OFFICIAL_SETUP_LINKS.telegramBotApiDocs}`,
    "",
    "Default polling mode does not need a public tunnel; only --telegram-mode webhook needs a public HTTPS URL."
  ].join("\n");
}

export function formatDiscordCredentialHelp(language: CliLanguage): string {
  if (language === "zh-CN") {
    return [
      "Discord 凭据在哪里拿:",
      `- Developer Portal: ${OFFICIAL_SETUP_LINKS.discordApplications}`,
      "- Bot Token: 打开 Bot 页面并复制 token，用于 Gateway 连接和向频道发送/编辑消息。",
      "- Public Key: 只有 --discord-mode webhook 需要，位于 General Information 页面。",
      "- Interactions Endpoint URL: 只有 webhook 模式需要公网 HTTPS URL。",
      `- Gateway 官方文档: ${OFFICIAL_SETUP_LINKS.discordGatewayEventsDocs}`,
      `- Interactions 官方文档: ${OFFICIAL_SETUP_LINKS.discordInteractionsOverview}`,
      `- Slash command 官方文档: ${OFFICIAL_SETUP_LINKS.discordApplicationCommands}`
    ].join("\n");
  }

  return [
    "Where to find Discord credentials:",
    `- Developer Portal: ${OFFICIAL_SETUP_LINKS.discordApplications}`,
    "- Bot Token: open the Bot page and copy the token used for Gateway connection and channel messages.",
    "- Public Key: only needed for --discord-mode webhook, on the application's General Information page.",
    "- Interactions Endpoint URL: only webhook mode needs a public HTTPS URL.",
    `- Gateway docs: ${OFFICIAL_SETUP_LINKS.discordGatewayEventsDocs}`,
    `- Interactions docs: ${OFFICIAL_SETUP_LINKS.discordInteractionsOverview}`,
    `- Slash command docs: ${OFFICIAL_SETUP_LINKS.discordApplicationCommands}`
  ].join("\n");
}
