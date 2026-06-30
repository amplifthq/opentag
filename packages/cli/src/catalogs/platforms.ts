import type { CliLanguage } from "./languages.js";

export type PlatformId = "lark" | "slack" | "github" | "gitlab" | "telegram";

export type PlatformStatus = "setup_ready" | "setup_pending" | "experimental_setup_pending";

export type PlatformDescriptor = {
  id: PlatformId;
  label: string;
  status: PlatformStatus;
  startable: boolean;
};

const SETUP_GUIDE_BASE_URL = "https://github.com/amplifthq/opentag/blob/main/docs/platforms";

const PLATFORM_SETUP_GUIDE_FILES: Partial<Record<PlatformId, Record<CliLanguage, string>>> = {
  lark: {
    en: "lark.en.md",
    "zh-CN": "lark.zh-CN.md"
  },
  slack: {
    en: "slack.en.md",
    "zh-CN": "slack.zh-CN.md"
  },
  github: {
    en: "github.en.md",
    "zh-CN": "github.zh-CN.md"
  }
  // gitlab deliberately has no setup guide entry until CLI setup wiring lands;
  // the MVP only exposes gitlab through the adapter package, not via `opentag setup`.
};

export const PLATFORM_CATALOG: PlatformDescriptor[] = [
  {
    id: "lark",
    label: "Lark / Feishu",
    status: "setup_ready",
    startable: true
  },
  {
    id: "slack",
    label: "Slack",
    status: "setup_ready",
    startable: true
  },
  {
    id: "github",
    label: "GitHub",
    status: "setup_ready",
    startable: true
  },
  {
    id: "gitlab",
    label: "GitLab",
    status: "experimental_setup_pending",
    startable: false
  },
  {
    id: "telegram",
    label: "Telegram",
    status: "experimental_setup_pending",
    startable: false
  }
];

export function parsePlatformId(value: string): PlatformId {
  if (value === "lark" || value === "slack" || value === "github" || value === "gitlab" || value === "telegram") {
    return value;
  }
  throw new Error("Platform must be lark, slack, github, gitlab, or telegram.");
}

export function platformById(id: PlatformId): PlatformDescriptor {
  const descriptor = PLATFORM_CATALOG.find((platform) => platform.id === id);
  if (!descriptor) {
    throw new Error(`Unknown platform: ${id}`);
  }
  return descriptor;
}

export function platformSetupGuideUrl(id: PlatformId, language: CliLanguage): string | undefined {
  const file = PLATFORM_SETUP_GUIDE_FILES[id]?.[language];
  return file ? `${SETUP_GUIDE_BASE_URL}/${file}` : undefined;
}

export function formatPlatformStatus(status: PlatformStatus): string {
  switch (status) {
    case "setup_ready":
      return "Setup wizard ready";
    case "setup_pending":
      return "Adapter exists; CLI setup pending";
    case "experimental_setup_pending":
      return "Experimental adapter; CLI setup pending";
  }
}

export function formatPlatforms(): string {
  return [
    "CLI setup support:",
    ...PLATFORM_CATALOG.map((platform) => {
      return `  ${platform.label}: ${formatPlatformStatus(platform.status)}`;
    })
  ].join("\n");
}
