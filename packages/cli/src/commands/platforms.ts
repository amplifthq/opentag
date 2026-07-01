import { formatPlatformCapability } from "../catalogs/capabilities.js";
import { formatPlatforms, PLATFORM_CATALOG } from "../catalogs/platforms.js";

export type PlatformsCommandOptions = {
  logger?: Pick<typeof console, "log">;
};

export function formatPlatformCapabilityCatalog(): string {
  return ["Platform capabilities:", ...PLATFORM_CATALOG.map((platform) => `  ${formatPlatformCapability(platform.id)}`)].join("\n");
}

export function formatPlatformsCommandOutput(): string {
  return [formatPlatforms(), formatPlatformCapabilityCatalog()].join("\n\n");
}

export function runPlatformsCommand(options: PlatformsCommandOptions = {}): void {
  const logger = options.logger ?? console;
  logger.log(formatPlatformsCommandOutput());
}
