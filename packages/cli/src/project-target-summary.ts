import { formatProjectTargetRef } from "@opentag/core";
import type { OpenTagCliConfig } from "./config.js";

type ConfiguredRepository = OpenTagCliConfig["daemon"]["repositories"][number];

export function formatConfiguredProjectTargetSummary(repository: ConfiguredRepository): string {
  const target = formatProjectTargetRef({
    provider: repository.provider,
    owner: repository.owner,
    repo: repository.repo
  });
  return `${target} (hasWorkspacePath=${repository.checkoutPath ? "yes" : "no"})`;
}
