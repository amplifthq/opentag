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
  feishuWebSocketDocs: "https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/use-websocket?lang=zh-CN"
} as const;

function setupNeeds(platform: PlatformId, language: CliLanguage): string[] {
  if (language === "zh-CN") {
    switch (platform) {
      case "lark":
        return ["推荐直接扫码创建 Personal Agent", "手动配置时需要 Lark App ID 和 App Secret"];
      case "slack":
        return ["推荐本地使用 Socket Mode", "Socket Mode 需要 Slack App-Level Token 和 Bot User OAuth Token", "Events API 需要 Slack Signing Secret 和公网 Request URL", "Slack Team ID", "Slack Channel ID"];
      case "github":
        return ["GitHub 仓库 owner/repo", "GitHub token（用于回写评论；允许时也用于创建 PR）", "OpenTag 会自动生成 webhook secret", "需要一个公网 tunnel 转发 GitHub webhook"];
      case "telegram":
        return [];
    }
  }

  switch (platform) {
    case "lark":
      return ["QR scan is the recommended path", "manual setup needs a Lark App ID and App Secret"];
    case "slack":
      return ["Socket Mode is recommended for local OpenTag", "Socket Mode needs a Slack App-Level Token and Bot User OAuth Token", "Events API needs a Slack Signing Secret and public Request URL", "Slack Team ID", "Slack Channel ID"];
    case "github":
      return ["GitHub repository owner/repo", "GitHub token for comments and optional pull requests", "OpenTag generates the webhook secret", "A public tunnel is required for GitHub webhook delivery"];
    case "telegram":
      return [];
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
      case "telegram":
        return [];
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
    case "telegram":
      return [];
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
      "手动 Lark / 飞书凭据在哪里拿:",
      `- 开发者后台: ${consoleUrl}`,
      "- App ID / App Secret: 打开你的应用，进入 Credentials & Basic Info / 凭证与基础信息",
      "- 事件接收方式: 使用长连接 / WebSocket",
      `- 长连接官方文档: ${websocketDocs}`,
      "",
      "如果你没有自建应用，建议返回选择扫码创建 Personal Agent。"
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
            "- Socket Mode 不需要 Request URL"
          ]
        : [
            `- Signing Secret 官方文档: ${OFFICIAL_SETUP_LINKS.slackSigningSecretDocs}`,
            "- Slack Signing Secret: Basic Information -> App Credentials",
            "- Request URL: 填你的公网 tunnel，例如 https://<your-tunnel>/slack/events"
          ];
    return [
      "Slack 这些值在哪里拿:",
      `- Slack App 管理页: ${OFFICIAL_SETUP_LINKS.slackApps}`,
      ...modeSpecific,
      "- Slack Bot User OAuth Token: OAuth & Permissions -> Bot User OAuth Token",
      "- Bot Token Scopes: app_mentions:read, chat:write",
      "- Team ID / Channel ID: 用浏览器打开 Slack channel，从地址里复制 T... 和 C..."
    ].join("\n");
  }

  const modeSpecific =
    mode === "socket_mode"
      ? [
          `- Socket Mode docs: ${OFFICIAL_SETUP_LINKS.slackSocketModeDocs}`,
          "- Slack App-Level Token: Basic Information -> App-Level Tokens -> Generate Token and Scopes, then add connections:write",
          "- Socket Mode does not need a Request URL"
        ]
      : [
          `- Signing Secret docs: ${OFFICIAL_SETUP_LINKS.slackSigningSecretDocs}`,
          "- Slack Signing Secret: Basic Information -> App Credentials",
          "- Request URL: use your public tunnel, for example https://<your-tunnel>/slack/events"
        ];
  return [
    "Where to find these Slack values:",
    `- Slack app settings: ${OFFICIAL_SETUP_LINKS.slackApps}`,
    ...modeSpecific,
    "- Slack Bot User OAuth Token: OAuth & Permissions -> Bot User OAuth Token",
    "- Bot Token Scopes: app_mentions:read, chat:write",
    "- Team ID / Channel ID: open the Slack channel in a browser and copy the T... and C... values from the URL"
  ].join("\n");
}

export function formatGitHubTokenHelp(language: CliLanguage, input: { autoCreatePullRequest: boolean }): string {
  const permissions =
    input.autoCreatePullRequest
      ? ["- Issues: Read and write", "- Pull requests: Read and write", "- Contents: Read and write"]
      : ["- Issues: Read and write", "- Pull requests: Read and write", "- Contents: not needed unless you allow OpenTag to create pull requests"];
  if (language === "zh-CN") {
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
