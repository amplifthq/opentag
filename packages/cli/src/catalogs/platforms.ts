export type PlatformId = "lark" | "slack" | "github" | "telegram";

export type PlatformStatus = "ready" | "coming_soon" | "experimental";

export type PlatformDescriptor = {
  id: PlatformId;
  label: string;
  status: PlatformStatus;
  startable: boolean;
};

export const PLATFORM_CATALOG: PlatformDescriptor[] = [
  {
    id: "lark",
    label: "Lark / Feishu",
    status: "ready",
    startable: true
  },
  {
    id: "slack",
    label: "Slack",
    status: "coming_soon",
    startable: false
  },
  {
    id: "github",
    label: "GitHub",
    status: "coming_soon",
    startable: false
  },
  {
    id: "telegram",
    label: "Telegram",
    status: "experimental",
    startable: false
  }
];

export function parsePlatformId(value: string): PlatformId {
  if (value === "lark" || value === "slack" || value === "github" || value === "telegram") {
    return value;
  }
  throw new Error("Platform must be lark, slack, github, or telegram.");
}

export function platformById(id: PlatformId): PlatformDescriptor {
  const descriptor = PLATFORM_CATALOG.find((platform) => platform.id === id);
  if (!descriptor) {
    throw new Error(`Unknown platform: ${id}`);
  }
  return descriptor;
}

export function formatPlatformStatus(status: PlatformStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "coming_soon":
      return "Coming soon";
    case "experimental":
      return "Experimental";
  }
}

export function formatPlatforms(): string {
  return [
    "Platforms:",
    ...PLATFORM_CATALOG.map((platform) => {
      return `  ${platform.label}: ${formatPlatformStatus(platform.status)}`;
    })
  ].join("\n");
}
