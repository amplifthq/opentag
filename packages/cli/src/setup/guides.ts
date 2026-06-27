import type { CliLanguage } from "../catalogs/languages.js";
import { platformById, platformSetupGuideUrl, type PlatformId } from "../catalogs/platforms.js";

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

export function formatPlatformSetupGuide(platform: PlatformId, language: CliLanguage): string | undefined {
  const url = platformSetupGuideUrl(platform, language);
  if (!url) return undefined;

  const descriptor = platformById(platform);
  const needs = setupNeeds(platform, language);
  if (language === "zh-CN") {
    return [
      `${descriptor.label} 配置教程:`,
      url,
      "",
      "继续填写前，先打开教程确认这些值在哪里拿：",
      ...needs.map((item) => `- ${item}`)
    ].join("\n");
  }

  return [
    `${descriptor.label} setup guide:`,
    url,
    "",
    "Open the guide before filling in these values:",
    ...needs.map((item) => `- ${item}`)
  ].join("\n");
}
