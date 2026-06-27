import { existsSync } from "node:fs";
import { defaultConfigPath, readCliConfig, type OpenTagCliConfig } from "../config.js";
import type { SetupDefaults } from "./types.js";

export function setupDefaultsFromConfig(config: OpenTagCliConfig): SetupDefaults {
  const repository = config.daemon.repositories[0];
  const lark = config.platforms.lark;
  const lastSetup = config.preferences?.lastSetup;

  return {
    ...(config.preferences?.language ? { language: config.preferences.language } : {}),
    ...(lastSetup?.platforms?.[0] ? { platform: lastSetup.platforms[0] } : lark ? { platform: "lark" } : {}),
    ...(repository?.checkoutPath ? { projectPath: repository.checkoutPath } : {}),
    ...(repository?.defaultExecutor ? { executor: repository.defaultExecutor } : {}),
    ...(lastSetup?.larkSetupMethod ? { larkSetupMethod: lastSetup.larkSetupMethod } : {}),
    ...(lastSetup?.larkDomain ? { larkDomain: lastSetup.larkDomain } : lark?.domain ? { larkDomain: lark.domain } : {}),
    ...(lastSetup?.bindingMethod
      ? { bindingMethod: lastSetup.bindingMethod }
      : lark?.defaultProjectBinding === false
        ? { bindingMethod: "bind_later" }
        : lark
          ? { bindingMethod: "default_project" }
          : {})
  };
}

export function loadSetupDefaults(path = defaultConfigPath()): SetupDefaults {
  if (!existsSync(path)) {
    return {};
  }
  return setupDefaultsFromConfig(readCliConfig(path));
}
