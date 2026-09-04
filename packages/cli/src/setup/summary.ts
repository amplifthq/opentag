import { formatConfiguredCapabilities } from "../catalogs/capabilities.js";
import type { OpenTagCliConfig } from "../config.js";
import { formatConfiguredProjectTargetSummary } from "../project-target-summary.js";
import type { OpenTagSetupInput } from "./types.js";

export function formatSetupReview(
  input: OpenTagSetupInput,
  configPath: string
): string {
  const lines = [
    input.language === "zh-CN" ? "请确认 OpenTag 设置：" : "Review OpenTag setup:",
    "- Relay: " + input.relayUrl,
    "- " + (input.language === "zh-CN" ? "本地项目" : "Local project") + ": " + input.projectPath,
    "- " + (input.language === "zh-CN" ? "ACP executor" : "ACP executor") + ": " + input.executor,
    "- " + (input.language === "zh-CN" ? "配置文件" : "Config") + ": " + configPath,
    "- Control Plane bootstrap authority: provided for this pairing only; not persisted"
  ];
  lines.push("- GitHub Project Target: " + input.github.projectTargetId
    + " -> github:" + input.github.owner + "/" + input.github.repo);
  return lines.join("\n");
}

export function formatSetupComplete(
  config: OpenTagCliConfig,
  configPath: string
): string {
  const language = config.preferences?.language ?? "en";
  const repositories = config.daemon.repositories;
  return [
    language === "zh-CN" ? "OpenTag 已配置。" : "OpenTag is configured.",
    (language === "zh-CN" ? "配置文件: " : "Config: ") + configPath,
    ...repositories.map((repository) =>
      (language === "zh-CN" ? "Project Target: " : "Project Target: ") + formatConfiguredProjectTargetSummary(repository)
    ),
    ...formatConfiguredCapabilities({
      executors: repositories.map((repository) => repository.defaultExecutor)
    }),
    language === "zh-CN"
      ? "Control Plane：Project Target 已通过 active Slack binding 注册并完成精确 readback。"
      : "Control Plane: the Project Target was registered through its active Slack binding and verified by exact readback.",
    language === "zh-CN"
      ? "Runner 下一步：运行 opentag doctor，然后用 opentag start 启动，或依次运行 opentag service install 和 opentag service start；两边都 ready 后再 @ teammate。"
      : "Runner next step: run opentag doctor, then use opentag start, or run opentag service install followed by opentag service start; mention the teammate only after both sides are ready."
  ].join("\n");
}
