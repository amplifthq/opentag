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
  lineConsole: "https://developers.line.biz/console/",
  lineWebhookDocs: "https://developers.line.biz/en/docs/messaging-api/receiving-messages/",
  lineSignatureDocs: "https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/",
  larkConsole: "https://open.larksuite.com/app",
  feishuConsole: "https://open.feishu.cn/app",
  larkAppIdDocs: "https://open.larksuite.com/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-app-id",
  larkWebSocketDocs: "https://open.larksuite.com/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/use-websocket",
  feishuWebSocketDocs: "https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/use-websocket?lang=zh-CN",
  gitlabTokenPage: "https://gitlab.com/-/user_settings/personal_access_tokens",
  gitlabTokenDocs: "https://docs.gitlab.com/user/profile/personal_access_tokens/",
  gitlabWebhookEventsDocs: "https://docs.gitlab.com/user/project/integrations/webhook_events/",
  gitlabNotesApiDocs: "https://docs.gitlab.com/api/notes/",
  gitlabMergeRequestsApiDocs: "https://docs.gitlab.com/api/merge_requests/"
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
      case "discord":
        return [];
      case "line":
        return ["LINE Official Account channel secret", "LINE channel access token", "Conversation ID or auto", "本地 webhook 端口，默认 3070", "需要一个公网 tunnel 转发 LINE webhook"];
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
    case "discord":
      return [];
    case "line":
      return ["LINE Official Account channel secret", "LINE channel access token", "Conversation ID or auto", "Local webhook port, default 3070", "A public tunnel is required for LINE webhook delivery"];
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
      case "discord":
        return [];
      case "line":
        return [
          `LINE Developers Console: ${OFFICIAL_SETUP_LINKS.lineConsole}`,
          `LINE webhook 官方文档: ${OFFICIAL_SETUP_LINKS.lineWebhookDocs}`
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
    case "discord":
      return [];
    case "line":
      return [
        `LINE Developers Console: ${OFFICIAL_SETUP_LINKS.lineConsole}`,
        `LINE webhook docs: ${OFFICIAL_SETUP_LINKS.lineWebhookDocs}`
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

export function formatLineCredentialHelp(language: CliLanguage): string {
  if (language === "zh-CN") {
    return [
      "LINE 这些值在哪里拿:",
      `- LINE Developers Console: ${OFFICIAL_SETUP_LINKS.lineConsole}`,
      "- Channel secret: Messaging API channel -> Basic settings",
      "- Channel access token: Messaging API channel -> Messaging API -> Channel access token",
      "- Webhook URL: 使用公网 tunnel，例如 https://<your-tunnel>/line/events/<accountId>",
      `- 签名校验官方文档: ${OFFICIAL_SETUP_LINKS.lineSignatureDocs}`,
      "- 会话 ID: 使用 auto 自动绑定到达 webhook 且签名有效的 LINE 用户、群组或 room，也可以从 LINE webhook 事件里的 source.userId / groupId / roomId 复制"
    ].join("\n");
  }

  return [
    "Where to find LINE values:",
    `- LINE Developers Console: ${OFFICIAL_SETUP_LINKS.lineConsole}`,
    "- Channel secret: Messaging API channel -> Basic settings",
    "- Channel access token: Messaging API channel -> Messaging API -> Channel access token",
    "- Webhook URL: use your public tunnel, for example https://<your-tunnel>/line/events/<accountId>",
    `- Signature verification docs: ${OFFICIAL_SETUP_LINKS.lineSignatureDocs}`,
    "- Conversation ID: use auto to bind signed LINE users, groups, or rooms that reach this webhook, or copy source.userId, source.groupId, or source.roomId from a LINE webhook event"
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
