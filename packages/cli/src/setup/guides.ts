import type { CliLanguage } from "../catalogs/languages.js";

export const OFFICIAL_SETUP_LINKS = {
  githubTokenPage: "https://github.com/settings/personal-access-tokens/new",
  githubTokenDocs:
    "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
} as const;

export function formatRunnerSetupGuide(language: CliLanguage): string {
  return language === "zh-CN"
    ? [
        "配对 Runner 设置",
        "- 已部署且受信任的 OpenTag Control Plane relay",
        "- 一个本地 Git checkout 与 ACP executor",
        "- GitHub Project Target；发布/readback token 可选",
        "- Slack installation、binding 与凭证由 Control Plane 管理，不写入 Runner 配置",
      ].join("\n")
    : [
        "Paired Runner setup",
        "- A deployed and trusted OpenTag Control Plane relay",
        "- A local Git checkout and ACP executor",
        "- A GitHub Project Target; the approved publication/readback token is optional",
        "- Slack installation, binding, and credentials stay in the Control Plane, not Runner config",
      ].join("\n");
}

export function formatGitHubTokenHelp(language: CliLanguage): string {
  return [
    language === "zh-CN"
      ? "GitHub 是 Project Target 与已批准发布/证据读取 provider，不是 Source ingress。"
      : "GitHub is the Project Target and approved publication/evidence provider, not Source ingress.",
    language === "zh-CN"
      ? `Token 创建页: ${OFFICIAL_SETUP_LINKS.githubTokenPage}`
      : `Token page: ${OFFICIAL_SETUP_LINKS.githubTokenPage}`,
    language === "zh-CN"
      ? `官方文档: ${OFFICIAL_SETUP_LINKS.githubTokenDocs}`
      : `Official docs: ${OFFICIAL_SETUP_LINKS.githubTokenDocs}`,
  ].join("\n");
}
