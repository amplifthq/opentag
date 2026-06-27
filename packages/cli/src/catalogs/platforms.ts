export type PlatformId = "lark" | "slack" | "github" | "telegram";

export type PlatformStatus = "setup_ready" | "setup_pending" | "experimental_setup_pending";

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
    id: "telegram",
    label: "Telegram",
    status: "experimental_setup_pending",
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
