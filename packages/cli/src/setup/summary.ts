import { executorLabel } from "../catalogs/executors.js";
import { formatConfiguredCapabilities } from "../catalogs/capabilities.js";
import { platformById } from "../catalogs/platforms.js";
import type { CliLanguage } from "../catalogs/languages.js";
import type { OpenTagCliConfig } from "../config.js";
import { githubLocalWebhookUrl, githubPublicWebhookUrlPlaceholder, githubWebhooksSettingsUrl } from "../platforms/github/display.js";
import { formatLarkPersonalAgentSummary } from "../platforms/lark/display.js";
import { DEFAULT_GITHUB_WEBHOOK_PORT, DEFAULT_SLACK_EVENTS_PORT } from "../platforms/ports.js";
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
  const slack = config.platforms.slack;
  const githubPort = github?.port ?? DEFAULT_GITHUB_WEBHOOK_PORT;
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
      github ? `Payload URL: ${githubPublicWebhookUrlPlaceholder(github.webhookPath ?? "/github/webhooks")}` : undefined,
      github ? `Secret: ${github.webhookSecret}` : undefined,
      github ? "Content type: application/json" : undefined,
      github ? "Events: Issue comments, Pull request review comments" : undefined,
      github ? `本地监听: ${githubLocalWebhookUrl({ port: github.port, webhookPath: github.webhookPath })}` : undefined,
      github ? `公网 URL 需要由 tunnel 指向本地监听地址，例如 ngrok http ${githubPort}。` : undefined,
      github ? "当 OpenTag 给出 create_pull_request 建议动作后，在 thread 里回复 apply 1 创建 PR。" : undefined
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
    github ? `Payload URL: ${githubPublicWebhookUrlPlaceholder(github.webhookPath ?? "/github/webhooks")}` : undefined,
    github ? `Secret: ${github.webhookSecret}` : undefined,
    github ? "Content type: application/json" : undefined,
    github ? "Events: Issue comments, Pull request review comments" : undefined,
    github ? `Local listener: ${githubLocalWebhookUrl({ port: github.port, webhookPath: github.webhookPath })}` : undefined,
    github ? `Point a public tunnel at the local listener, for example: ngrok http ${githubPort}.` : undefined,
    github ? "When OpenTag shows a create_pull_request action, reply `apply 1` in the thread to create the PR." : undefined
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
