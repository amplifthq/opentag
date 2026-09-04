import type { CliLanguage } from "../catalogs/languages.js";

const messages = {
  en: {
    intro: "Set up your OpenTag paired Runner",
    language: "Setup language",
    executor: "Coding agent",
    executorCustomHint: "Previously configured custom ACP executor",
    projectPath: "Local project checkout",
    githubRepository: "GitHub Project Target (owner/repo)",
    projectTargetId: "Project Target ID (use the Control Plane Compose OPENTAG_SLACK_PROJECT_TARGET_ID value)",
    githubToken: "GitHub token for approved publication and provider readback",
    confirmSetup: "Pair this Runner and write the OpenTag configuration?",
    cancelled: "OpenTag setup cancelled.",
  },
  "zh-CN": {
    intro: "设置你的 OpenTag 配对 Runner",
    language: "设置语言",
    executor: "编程 Agent",
    executorCustomHint: "上次配置的自定义 ACP executor",
    projectPath: "本地项目 checkout",
    githubRepository: "GitHub Project Target（owner/repo）",
    projectTargetId: "Project Target ID（使用 Control Plane Compose 的 OPENTAG_SLACK_PROJECT_TARGET_ID 值）",
    githubToken: "用于已批准发布和 provider readback 的 GitHub token",
    confirmSetup: "配对此 Runner 并写入 OpenTag 配置？",
    cancelled: "已取消 OpenTag 设置。",
  },
} as const;

export type MessageKey = keyof typeof messages.en;

export function t(language: CliLanguage, key: MessageKey): string {
  return messages[language][key];
}
