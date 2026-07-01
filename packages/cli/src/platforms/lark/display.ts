import type { LarkDomain } from "@opentag/lark";
import type { CliLanguage } from "../../catalogs/languages.js";
import type { SavedLarkCredentials } from "./saved-config.js";

type LarkPersonalAgentSummaryInput = {
  appId: string;
  domain: LarkDomain;
  botOpenId?: string;
  source?: SavedLarkCredentials["source"];
};

function shortId(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function domainLabel(domain: LarkDomain): string {
  return domain === "feishu" ? "Feishu" : "Lark";
}

function sourceLabel(source: SavedLarkCredentials["source"], language: CliLanguage): string {
  if (language === "zh-CN") {
    return source === "opentag_config" ? "OpenTag 配置" : "旧 start-lark 配置";
  }
  return source === "opentag_config" ? "OpenTag config" : "legacy start-lark config";
}

export function formatLarkPersonalAgentSummary(input: LarkPersonalAgentSummaryInput, language: CliLanguage): string {
  const parts = [
    domainLabel(input.domain),
    `${language === "zh-CN" ? "应用 ID" : "App ID"} ${shortId(input.appId)}`,
    input.botOpenId ? `${language === "zh-CN" ? "机器人 Open ID" : "Bot Open ID"} ${shortId(input.botOpenId)}` : undefined,
    input.source
      ? language === "zh-CN"
        ? `来源: ${sourceLabel(input.source, language)}`
        : `from ${sourceLabel(input.source, language)}`
      : undefined
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" | ");
}

export function formatSavedLarkCredentialsHint(credentials: SavedLarkCredentials, language: CliLanguage): string {
  return formatLarkPersonalAgentSummary(credentials, language);
}
