import { executorLabel } from "../catalogs/executors.js";
import { formatConfiguredCapabilities } from "../catalogs/capabilities.js";
import { platformById } from "../catalogs/platforms.js";
import type { CliLanguage } from "../catalogs/languages.js";
import type { OpenTagCliConfig } from "../config.js";
import { discordLocalInteractionsUrl, discordPublicInteractionsUrlPlaceholder } from "../platforms/discord/display.js";
import { githubLocalWebhookUrl, githubPublicWebhookUrlPlaceholder, githubWebhooksSettingsUrl } from "../platforms/github/display.js";
import { gitlabLocalWebhookUrl, gitlabProjectWebhooksSettingsUrl, gitlabPublicWebhookUrlPlaceholder } from "../platforms/gitlab/display.js";
import { formatLarkPersonalAgentSummary } from "../platforms/lark/display.js";
import { linearApiSettingsUrl, linearLocalWebhookUrl, linearPublicWebhookUrlPlaceholder, linearWebhookSettingsUrl } from "../platforms/linear/display.js";
import { telegramLocalWebhookUrl, telegramPublicWebhookUrlPlaceholder } from "../platforms/telegram/display.js";
import { DEFAULT_GITHUB_WEBHOOK_PORT, DEFAULT_GITLAB_WEBHOOK_PORT, DEFAULT_LINEAR_WEBHOOK_PORT, DEFAULT_SLACK_EVENTS_PORT } from "../platforms/ports.js";
import type { LarkSetupMethod, OpenTagSetupInput } from "./types.js";

function yesNo(value: boolean, language: CliLanguage): string {
  return language === "zh-CN" ? (value ? "是" : "否") : value ? "yes" : "no";
}

function larkSetupDescription(method: LarkSetupMethod, language: CliLanguage): string {
  if (language === "zh-CN") {
    if (method === "saved") return "使用已保存的个人代理应用";
    return method === "scan" ? "创建新的个人代理应用" : "手动填写";
  }
  if (method === "saved") return "Saved Personal Agent";
  return method === "scan" ? "Create new Personal Agent" : "Manual credentials";
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function relayWebhookUrl(relayUrl: string, webhookPath: string): string {
  return `${stripTrailingSlash(relayUrl)}${webhookPath}`;
}

export function formatSetupReview(input: OpenTagSetupInput, configPath: string): string {
  const platform = platformById(input.platform);
  const commonLines =
    input.language === "zh-CN"
      ? [
          "请确认 OpenTag 配置：",
          `配置文件: ${configPath}`,
          `平台: ${platform.label}`,
          `编码代理: ${executorLabel(input.executor)}`,
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
  const capabilityLines = formatConfiguredCapabilities({
    platforms: [input.platform],
    executors: [input.executor]
  });
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
            `个人代理应用: ${larkPersonalAgent}`,
            `Lark/飞书租户: ${input.lark.domain}`,
            `默认绑定当前项目: ${yesNo(input.lark.bindingMethod === "default_project", input.language)}`
          ]
        : [
            `Lark setup: ${larkSetupDescription(input.lark.setupMethod, input.language)}`,
            `Personal Agent: ${larkPersonalAgent}`,
            `Lark / Feishu tenant: ${input.lark.domain}`,
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
          ? ["Slack 连接方式: 公网 Events API", `Slack Events URL: http://localhost:${input.slack.port ?? DEFAULT_SLACK_EVENTS_PORT}/slack/events`]
          : ["Slack connection: Public Events API", `Slack Events URL: http://localhost:${input.slack.port ?? DEFAULT_SLACK_EVENTS_PORT}/slack/events`];
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
    const webhookPath = input.github.webhookPath;
    platformLines.push(
      ...(input.language === "zh-CN"
        ? [
            `GitHub 仓库: ${input.github.owner}/${input.github.repo}`,
            `GitHub 本地 webhook: ${githubLocalWebhookUrl({ port: input.github.port, webhookPath })}`,
            `GitHub Payload URL: ${githubPublicWebhookUrlPlaceholder(webhookPath)}`,
            "Webhook secret: OpenTag 会自动生成",
            "默认 PR 流程: 回复 apply 1 后创建",
            `run 后立刻自动创建 PR: ${yesNo(input.github.autoCreatePullRequest, input.language)}`
          ]
        : [
            `GitHub repository: ${input.github.owner}/${input.github.repo}`,
            `GitHub local webhook: ${githubLocalWebhookUrl({ port: input.github.port, webhookPath })}`,
            `GitHub Payload URL: ${githubPublicWebhookUrlPlaceholder(webhookPath)}`,
            "Webhook secret: generated by OpenTag",
            "Default PR flow: create after replying `apply 1`",
            `Immediate PR after run: ${yesNo(input.github.autoCreatePullRequest, input.language)}`
          ])
    );
  }
  if (input.gitlab) {
    const webhookPath = input.gitlab.webhookPath;
    platformLines.push(
      ...(input.language === "zh-CN"
        ? [
            `GitLab 项目: ${input.gitlab.projectPathWithNamespace}`,
            `GitLab base URL: ${input.gitlab.baseUrl}`,
            `GitLab 本地 webhook: ${gitlabLocalWebhookUrl({ port: input.gitlab.port, webhookPath })}`,
            `GitLab Payload URL: ${gitlabPublicWebhookUrlPlaceholder(webhookPath)}`,
            "Webhook secret: OpenTag 会自动生成",
            "Webhook events: Note events"
          ]
        : [
            `GitLab project: ${input.gitlab.projectPathWithNamespace}`,
            `GitLab base URL: ${input.gitlab.baseUrl}`,
            `GitLab local webhook: ${gitlabLocalWebhookUrl({ port: input.gitlab.port, webhookPath })}`,
            `GitLab Payload URL: ${gitlabPublicWebhookUrlPlaceholder(webhookPath)}`,
            "Webhook secret: generated by OpenTag",
            "Webhook events: Note events"
          ])
    );
  }
  if (input.linear) {
    const webhookPath = input.linear.webhookPath;
    const hostedOAuth = input.linear.auth?.method === "hosted_oauth_app";
    const localOAuthApp = input.linear.auth?.method === "oauth_app";
    platformLines.push(
      ...(input.language === "zh-CN"
        ? [
            input.linear.teamKey ? `Linear team key: ${input.linear.teamKey}` : undefined,
            input.linear.teamId ? `Linear team id: ${input.linear.teamId}` : undefined,
            hostedOAuth ? "Linear OAuth App: 由 trusted relay 发起 hosted install" : undefined,
            hostedOAuth ? undefined : `Linear 本地 webhook: ${linearLocalWebhookUrl({ port: input.linear.port, webhookPath })}`,
            `Linear webhook URL: ${linearPublicWebhookUrlPlaceholder(webhookPath)}`,
            localOAuthApp ? "Webhook 配置位置: Linear OAuth app 设置（启用 Webhooks 并指向上面的 URL）" : undefined,
            hostedOAuth
              ? "Webhook signing secret: 已在 trusted relay 上配置 OAuth App secret"
              : localOAuthApp
                ? "Webhook signing secret: 从 Linear OAuth app 的 Webhooks 设置复制（--linear-webhook-secret）"
                : "Webhook signing secret: OpenTag 会自动生成；如 Linear 不允许自定义，请把 Linear 生成的 secret 写回 config",
            hostedOAuth || localOAuthApp ? "Webhook events: Comment 和 Agent Session events" : "Webhook events: Comment events"
          ]
        : [
            input.linear.teamKey ? `Linear team key: ${input.linear.teamKey}` : undefined,
            input.linear.teamId ? `Linear team id: ${input.linear.teamId}` : undefined,
            hostedOAuth ? "Linear OAuth App: hosted install will be started by the trusted relay" : undefined,
            hostedOAuth ? undefined : `Linear local webhook: ${linearLocalWebhookUrl({ port: input.linear.port, webhookPath })}`,
            `Linear webhook URL: ${linearPublicWebhookUrlPlaceholder(webhookPath)}`,
            localOAuthApp ? "Webhook location: the Linear OAuth app settings (enable Webhooks and point them at the URL above)" : undefined,
            hostedOAuth
              ? "Webhook signing secret: configured on the trusted relay for the OAuth App"
              : localOAuthApp
                ? "Webhook signing secret: copy it from the Linear OAuth app's Webhooks settings (--linear-webhook-secret)"
                : "Webhook signing secret: generated by OpenTag; if Linear does not accept a custom secret, copy the one Linear generates back into the config",
            hostedOAuth || localOAuthApp ? "Webhook events: Comment and Agent Session events" : "Webhook events: Comment events"
          ]).filter((line): line is string => Boolean(line))
    );
  }
  if (input.telegram) {
    const telegramMode = input.telegram.mode;
    platformLines.push(
      ...(input.language === "zh-CN"
        ? [
            `Telegram 连接方式: ${telegramMode === "webhook" ? "Webhook（需要公网 HTTPS endpoint）" : "Polling（默认，无需公网 tunnel）"}`,
            `Telegram bot id: ${input.telegram.botId}`,
            input.telegram.botUsername ? `Telegram bot username: @${input.telegram.botUsername.replace(/^@/, "")}` : undefined,
            telegramMode === "webhook" ? `Telegram 本地 webhook: ${telegramLocalWebhookUrl({ botId: input.telegram.botId })}` : undefined,
            telegramMode === "webhook" ? `Telegram webhook URL: ${telegramPublicWebhookUrlPlaceholder({ botId: input.telegram.botId })}` : undefined,
            telegramMode === "webhook" ? "Webhook secret token: OpenTag 会自动生成" : "OpenTag 会用 getUpdates 长轮询接收消息",
            "群聊绑定: 私聊可直接 /bind；群聊 /bind 需要配置 binding admin user ids"
          ]
        : [
            `Telegram connection: ${telegramMode === "webhook" ? "Webhook (public HTTPS endpoint required)" : "Polling (default; no public tunnel required)"}`,
            `Telegram bot id: ${input.telegram.botId}`,
            input.telegram.botUsername ? `Telegram bot username: @${input.telegram.botUsername.replace(/^@/, "")}` : undefined,
            telegramMode === "webhook" ? `Telegram local webhook: ${telegramLocalWebhookUrl({ botId: input.telegram.botId })}` : undefined,
            telegramMode === "webhook" ? `Telegram webhook URL: ${telegramPublicWebhookUrlPlaceholder({ botId: input.telegram.botId })}` : undefined,
            telegramMode === "webhook" ? "Webhook secret token: generated by OpenTag" : "OpenTag receives messages with getUpdates long polling",
            "Chat binding: private chats can /bind directly; group /bind requires binding admin user ids"
          ]).filter((line): line is string => Boolean(line))
    );
  }
  if (input.discord) {
    const discordMode = input.discord.mode;
    platformLines.push(
      ...(input.language === "zh-CN"
        ? [
            `Discord 连接方式: ${discordMode === "webhook" ? "Interactions Endpoint（需要公网 HTTPS endpoint）" : "Gateway（默认，无需公网 tunnel）"}`,
            discordMode === "webhook" ? `Discord 本地 interactions endpoint: ${discordLocalInteractionsUrl({ webhookPath: input.discord.webhookPath })}` : undefined,
            discordMode === "webhook" && input.discord.webhookPath
              ? `Discord Interactions Endpoint URL: ${discordPublicInteractionsUrlPlaceholder(input.discord.webhookPath)}`
              : undefined,
            "Slash command: 注册 /opentag，并把应用安装到目标 server"
        ]
        : [
            `Discord connection: ${discordMode === "webhook" ? "Interactions Endpoint (public HTTPS endpoint required)" : "Gateway (default; no public tunnel required)"}`,
            discordMode === "webhook" ? `Discord local interactions endpoint: ${discordLocalInteractionsUrl({ webhookPath: input.discord.webhookPath })}` : undefined,
            discordMode === "webhook" && input.discord.webhookPath
              ? `Discord Interactions Endpoint URL: ${discordPublicInteractionsUrlPlaceholder(input.discord.webhookPath)}`
              : undefined,
            "Slash command: register /opentag and install the app into the target server"
          ]
      ).filter((line): line is string => Boolean(line))
    );
  }
  const sessionProfileLines =
    input.agentSessionProfile && (input.agentSessionProfile.profile || input.agentSessionProfile.profileTemplate)
      ? input.language === "zh-CN"
        ? [
            input.agentSessionProfile.profile ? `Agent 会话 profile: ${input.agentSessionProfile.profile}` : undefined,
            input.agentSessionProfile.profileTemplate ? `Agent 会话 profile 模板: ${input.agentSessionProfile.profileTemplate}` : undefined
          ]
        : [
            input.agentSessionProfile.profile ? `Agent session profile: ${input.agentSessionProfile.profile}` : undefined,
            input.agentSessionProfile.profileTemplate ? `Agent session profile template: ${input.agentSessionProfile.profileTemplate}` : undefined
          ]
      : [];
  const lines = [...commonLines, ...capabilityLines, ...platformLines, ...sessionProfileLines.filter((line): line is string => Boolean(line))];
  return lines.join("\n");
}

export function formatSetupComplete(config: OpenTagCliConfig, configPath: string): string {
  const repository = config.daemon.repositories[0];
  const language = config.preferences?.language ?? "en";
  const github = config.platforms.github;
  const gitlab = config.platforms.gitlab;
  const linear = config.platforms.linear;
  const slack = config.platforms.slack;
  const telegram = config.platforms.telegram;
  const discord = config.platforms.discord;
  const githubPort = github?.port ?? DEFAULT_GITHUB_WEBHOOK_PORT;
  const gitlabPort = gitlab?.port ?? DEFAULT_GITLAB_WEBHOOK_PORT;
  const linearPort = linear?.port ?? DEFAULT_LINEAR_WEBHOOK_PORT;
  const relayUrl = config.runtime?.mode === "relay" ? config.runtime.relayUrl : undefined;
  const githubWebhookPath = github?.webhookPath ?? "/github/webhooks";
  const gitlabWebhookPath = gitlab?.webhookPath ?? "/gitlab/webhooks";
  const linearWebhookPath = linear?.webhookPath ?? "/linear/webhooks";
  const linearHostedOAuth = linear?.auth?.method === "hosted_oauth_app" ? linear.auth : undefined;
  const linearLocalOAuthApp = linear?.auth?.method === "oauth_app";
  const linearEventLine =
    linearHostedOAuth || linearLocalOAuthApp
      ? language === "zh-CN"
        ? "Events: Comment 和 Agent Session events"
        : "Events: Comment and Agent Session events"
      : "Events: Comment events";
  const linearSecretLine = linearHostedOAuth
    ? undefined
    : linearLocalOAuthApp
      ? language === "zh-CN"
        ? "Signing secret: 在 Linear OAuth app 的 Webhooks 设置里启用 Webhooks，把它生成的 signing secret 写回 platforms.linear.webhookSecret"
        : "Signing secret: enable Webhooks on the Linear OAuth app and copy its signing secret into platforms.linear.webhookSecret"
      : `Signing secret: ${linear?.webhookSecret}`;
  if (language === "zh-CN") {
    return [
      "OpenTag 配置已保存。",
      `配置文件: ${configPath}`,
      repository ? `项目路径: ${repository.checkoutPath}` : undefined,
      slack ? "" : undefined,
      slack ? "Slack 下一步：" : undefined,
      slack ? `绑定 channel: ${slack.teamId}/${slack.channelId}` : undefined,
      slack ? "测试前先在 Slack channel 里运行 /invite @你的 App 名称。" : undefined,
      slack?.mode === "socket_mode" ? "Socket Mode 不需要公网 URL；直接保持 opentag start 运行即可。" : undefined,
      slack?.mode !== "socket_mode" && slack ? `Events API 本地监听: http://localhost:${slack.port ?? DEFAULT_SLACK_EVENTS_PORT}/slack/events` : undefined,
      github ? "" : undefined,
      github ? "GitHub webhook 下一步：" : undefined,
      github ? `GitHub 设置页: ${githubWebhooksSettingsUrl(github)}` : undefined,
      github ? `Payload URL: ${relayUrl ? relayWebhookUrl(relayUrl, githubWebhookPath) : githubPublicWebhookUrlPlaceholder(githubWebhookPath)}` : undefined,
      github ? `Secret: ${github.webhookSecret}` : undefined,
      github ? "Content type: application/json" : undefined,
      github ? "Events: Issue comments, Pull request review comments" : undefined,
      github && !relayUrl ? `本地监听: ${githubLocalWebhookUrl({ port: github.port, webhookPath: github.webhookPath })}` : undefined,
      github && !relayUrl ? `公网 URL 需要由 tunnel 指向本地监听地址，例如 ngrok http ${githubPort}。` : undefined,
      github && relayUrl ? "Relay 模式：GitHub 直接调用上面的 relay URL，不需要 ngrok/cloudflared。" : undefined,
      github ? "当 OpenTag 给出 create_pull_request 建议动作后，在 thread 里回复 apply 1 创建 PR。" : undefined,
      gitlab ? "" : undefined,
      gitlab ? "GitLab webhook 下一步：" : undefined,
      gitlab ? `GitLab 设置页: ${gitlabProjectWebhooksSettingsUrl(gitlab)}` : undefined,
      gitlab ? `Payload URL: ${relayUrl ? relayWebhookUrl(relayUrl, gitlabWebhookPath) : gitlabPublicWebhookUrlPlaceholder(gitlabWebhookPath)}` : undefined,
      gitlab ? `Secret token: ${gitlab.webhookSecret}` : undefined,
      gitlab ? "Content type: application/json" : undefined,
      gitlab ? "Events: Note events" : undefined,
      gitlab && !relayUrl ? `本地监听: ${gitlabLocalWebhookUrl({ port: gitlab.port, webhookPath: gitlab.webhookPath })}` : undefined,
      gitlab && !relayUrl ? `公网 URL 需要由 tunnel 指向本地监听地址，例如 ngrok http ${gitlabPort}。` : undefined,
      gitlab && relayUrl ? "Relay 模式：GitLab 直接调用上面的 relay URL，不需要 ngrok/cloudflared。" : undefined,
      linear ? "" : undefined,
      linear ? "Linear webhook 下一步：" : undefined,
      linear ? `Linear API/Webhooks 设置页: ${linearWebhookSettingsUrl()}` : undefined,
      linear && !linearHostedOAuth ? `API key 设置页: ${linearApiSettingsUrl()}` : undefined,
      linearHostedOAuth?.authorizationUrl ? `Linear OAuth install URL: ${linearHostedOAuth.authorizationUrl}` : undefined,
      linearHostedOAuth?.stateExpiresAt ? `Linear OAuth install 需在 ${linearHostedOAuth.stateExpiresAt} 前完成。` : undefined,
      linear ? `Webhook URL: ${relayUrl ? relayWebhookUrl(relayUrl, linearWebhookPath) : linearPublicWebhookUrlPlaceholder(linearWebhookPath)}` : undefined,
      linear && !linearHostedOAuth ? linearSecretLine : undefined,
      linear ? linearEventLine : undefined,
      linear && !relayUrl ? `本地监听: ${linearLocalWebhookUrl({ port: linear.port, webhookPath: linear.webhookPath })}` : undefined,
      linear && !relayUrl ? `公网 URL 需要由 tunnel 指向本地监听地址，例如 ngrok http ${linearPort}。` : undefined,
      linear && relayUrl ? "Relay 模式：Linear 直接调用上面的 relay URL，不需要 ngrok/cloudflared。" : undefined,
      telegram ? "" : undefined,
      telegram ? "Telegram 下一步：" : undefined,
      telegram?.mode === "webhook" ? `Webhook URL: ${telegramPublicWebhookUrlPlaceholder({ botId: telegram.botId })}` : undefined,
      telegram?.mode === "webhook" ? `Secret token: ${telegram.secretToken}` : undefined,
      telegram?.mode === "webhook" ? `本地监听: ${telegramLocalWebhookUrl({ botId: telegram.botId })}` : undefined,
      telegram?.mode === "webhook"
        ? "用 BotFather 设置 bot commands，至少包含 /opentag；然后用 setWebhook 指向公网 HTTPS tunnel。"
        : undefined,
      telegram?.mode !== "webhook" && telegram
        ? "默认 polling 模式不需要公网 tunnel；启动 opentag start 后直接在 Telegram 给 bot 发消息。"
        : undefined,
      telegram ? "私聊可直接发送 /bind <owner>/<repo>；群聊绑定需要配置 binding admin user ids。" : undefined,
      discord ? "" : undefined,
      discord ? "Discord 下一步：" : undefined,
      discord?.mode === "webhook" ? `Interactions Endpoint URL: ${discordPublicInteractionsUrlPlaceholder(discord.webhookPath ?? "/discord/interactions")}` : undefined,
      discord?.mode === "webhook" ? `本地 endpoint: ${discordLocalInteractionsUrl({ webhookPath: discord.webhookPath })}` : undefined,
      discord?.mode === "webhook"
        ? "在 Developer Portal 的 General Information 页面填写 Interactions Endpoint URL，并注册 /opentag slash command。"
        : undefined,
      discord?.mode !== "webhook" && discord
        ? "默认 Gateway 模式不需要公网 tunnel；注册 /opentag slash command 并安装 app 到目标 server。"
        : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }
  return [
    "OpenTag config saved.",
    `Config: ${configPath}`,
    repository ? `Project path: ${repository.checkoutPath}` : undefined,
    slack ? "" : undefined,
    slack ? "Slack next steps:" : undefined,
    slack ? `Bound channel: ${slack.teamId}/${slack.channelId}` : undefined,
    slack ? "Before testing, run /invite @your app name in that Slack channel." : undefined,
    slack?.mode === "socket_mode" ? "Socket Mode does not need a public URL; keep opentag start running." : undefined,
    slack?.mode !== "socket_mode" && slack ? `Events API local listener: http://localhost:${slack.port ?? DEFAULT_SLACK_EVENTS_PORT}/slack/events` : undefined,
    github ? "" : undefined,
    github ? "GitHub webhook next steps:" : undefined,
    github ? `GitHub settings: ${githubWebhooksSettingsUrl(github)}` : undefined,
    github ? `Payload URL: ${relayUrl ? relayWebhookUrl(relayUrl, githubWebhookPath) : githubPublicWebhookUrlPlaceholder(githubWebhookPath)}` : undefined,
    github ? `Secret: ${github.webhookSecret}` : undefined,
    github ? "Content type: application/json" : undefined,
    github ? "Events: Issue comments, Pull request review comments" : undefined,
    github && !relayUrl ? `Local listener: ${githubLocalWebhookUrl({ port: github.port, webhookPath: github.webhookPath })}` : undefined,
    github && !relayUrl ? `Point a public tunnel at the local listener, for example: ngrok http ${githubPort}.` : undefined,
    github && relayUrl ? "Relay mode: GitHub should call the relay URL above; no ngrok/cloudflared tunnel is needed." : undefined,
    github ? "When OpenTag shows a create_pull_request action, reply `apply 1` in the thread to create the PR." : undefined,
    gitlab ? "" : undefined,
    gitlab ? "GitLab webhook next steps:" : undefined,
    gitlab ? `GitLab settings: ${gitlabProjectWebhooksSettingsUrl(gitlab)}` : undefined,
    gitlab ? `Payload URL: ${relayUrl ? relayWebhookUrl(relayUrl, gitlabWebhookPath) : gitlabPublicWebhookUrlPlaceholder(gitlabWebhookPath)}` : undefined,
    gitlab ? `Secret token: ${gitlab.webhookSecret}` : undefined,
    gitlab ? "Content type: application/json" : undefined,
    gitlab ? "Events: Note events" : undefined,
    gitlab && !relayUrl ? `Local listener: ${gitlabLocalWebhookUrl({ port: gitlab.port, webhookPath: gitlab.webhookPath })}` : undefined,
    gitlab && !relayUrl ? `Point a public tunnel at the local listener, for example: ngrok http ${gitlabPort}.` : undefined,
    gitlab && relayUrl ? "Relay mode: GitLab should call the relay URL above; no ngrok/cloudflared tunnel is needed." : undefined,
      linear ? "" : undefined,
      linear ? "Linear webhook next steps:" : undefined,
      linear ? `Linear API/Webhooks settings: ${linearWebhookSettingsUrl()}` : undefined,
    linear && !linearHostedOAuth ? `API key settings: ${linearApiSettingsUrl()}` : undefined,
    linearHostedOAuth?.authorizationUrl ? `Linear OAuth install URL: ${linearHostedOAuth.authorizationUrl}` : undefined,
    linearHostedOAuth?.stateExpiresAt ? `Complete the Linear OAuth install before ${linearHostedOAuth.stateExpiresAt}.` : undefined,
    linear ? `Webhook URL: ${relayUrl ? relayWebhookUrl(relayUrl, linearWebhookPath) : linearPublicWebhookUrlPlaceholder(linearWebhookPath)}` : undefined,
    linear && !linearHostedOAuth ? linearSecretLine : undefined,
    linear ? linearEventLine : undefined,
    linear && !relayUrl ? `Local listener: ${linearLocalWebhookUrl({ port: linear.port, webhookPath: linear.webhookPath })}` : undefined,
    linear && !relayUrl ? `Point a public tunnel at the local listener, for example: ngrok http ${linearPort}.` : undefined,
    linear && relayUrl ? "Relay mode: Linear should call the relay URL above; no ngrok/cloudflared tunnel is needed." : undefined,
    telegram ? "" : undefined,
    telegram ? "Telegram next steps:" : undefined,
    telegram?.mode === "webhook" ? `Webhook URL: ${telegramPublicWebhookUrlPlaceholder({ botId: telegram.botId })}` : undefined,
    telegram?.mode === "webhook" ? `Secret token: ${telegram.secretToken}` : undefined,
    telegram?.mode === "webhook" ? `Local listener: ${telegramLocalWebhookUrl({ botId: telegram.botId })}` : undefined,
    telegram?.mode === "webhook"
      ? "Use BotFather to set bot commands, including /opentag; then call setWebhook with the public HTTPS tunnel URL."
      : undefined,
    telegram?.mode !== "webhook" && telegram
      ? "Default polling mode does not need a public tunnel; start opentag start, then message the bot in Telegram."
      : undefined,
    telegram ? "Private chats can send /bind <owner>/<repo> directly; group binding requires configured binding admin user ids." : undefined,
    discord ? "" : undefined,
    discord ? "Discord next steps:" : undefined,
    discord?.mode === "webhook" ? `Interactions Endpoint URL: ${discordPublicInteractionsUrlPlaceholder(discord.webhookPath ?? "/discord/interactions")}` : undefined,
    discord?.mode === "webhook" ? `Local endpoint: ${discordLocalInteractionsUrl({ webhookPath: discord.webhookPath })}` : undefined,
    discord?.mode === "webhook"
      ? "Paste the Interactions Endpoint URL on the Developer Portal General Information page, then register the /opentag slash command."
      : undefined,
    discord?.mode !== "webhook" && discord
      ? "Default Gateway mode does not need a public tunnel; register /opentag and install the app into the target server."
      : undefined
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
