import type { CliLanguage } from "../catalogs/languages.js";
import type { BindingMethod, LarkSetupMethod } from "../setup/types.js";

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

export function bindingMethodLabel(language: CliLanguage, method: BindingMethod): string {
  if (language === "zh-CN") {
    return method === "default_project" ? "默认使用这个项目" : "稍后在 Lark 里用 /bind 绑定";
  }
  return method === "default_project" ? "Use this project by default" : "Bind later from Lark with /bind";
}

export function bindingMethodHint(language: CliLanguage, method: BindingMethod): string {
  if (language === "zh-CN") {
    return method === "default_project" ? "推荐，最快跑通" : "适合多个项目";
  }
  return method === "default_project" ? "Recommended" : "Best for multiple projects";
}
