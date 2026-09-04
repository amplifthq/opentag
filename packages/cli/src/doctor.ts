import { createDoctorSummaryPresentation, renderOpenTagPresentationPlainText } from "@opentag/core";
import { doctorHasFailures, executorsFromConfig, runDoctor, type DoctorCheck } from "@opentag/local-runtime";
import { formatConfiguredCapabilities } from "./catalogs/capabilities.js";
import { defaultConfigPath, readCliConfig, readRedactedCliConfig, redactedCliConfig } from "./config.js";
import { relaySecurityChecksFromConfig } from "./relay-security.js";
import { formatSecretReadiness } from "./secret-readiness.js";

export type DoctorCommandOptions = {
  config?: string;
};

function credentialSourcesCheck(secretConfig: unknown): DoctorCheck {
  return {
    status: "ok",
    name: "credential sources",
    message: formatSecretReadiness(secretConfig).slice(1).join("; ")
  };
}

function operationalDeclarationChecks(config: ReturnType<typeof readCliConfig>): DoctorCheck[] {
  const control = config.daemon.controlRegistration;
  const registration = control && "registration" in control ? control.registration : undefined;
  const executors = [...new Set(config.daemon.repositories.map((repository) => repository.defaultExecutor))].sort();
  return [
    {
      status: registration ? "ok" : "warn",
      name: "relay deployment identity",
      message: registration
        ? `organization=${registration.organizationId}; registrationGeneration=${registration.registrationGeneration}`
        : "unknown; configuration does not prove a relay deployment identity"
    },
    {
      status: config.daemon.repositories.length ? "ok" : "fail",
      name: "Project Target mapping",
      message: config.daemon.repositories.length
        ? `${config.daemon.repositories.length} local GitHub target mapping(s) configured`
        : "no GitHub Project Target is configured"
    },
    {
      status: config.daemon.runnerToken ? "ok" : "warn",
      name: "Runner credential and generation",
      message: `credential=${config.daemon.runnerToken ? "runner_scoped_configured" : "missing"}; generation=${registration?.credentialGeneration ?? "unknown"}; readiness=unverified`
    },
    {
      status: executors.length ? "warn" : "fail",
      name: "ACP executor and harness",
      message: executors.length ? `declared=${executors.join(",")}; harness=unverified` : "unsupported; no executor is declared"
    },
    {
      status: "warn",
      name: "queue deadline policy",
      message: config.daemon.runTimeoutMs ? `hard timeout after ${config.daemon.runTimeoutMs}ms; runtime verification=unavailable` : "disabled; runtime verification=unavailable"
    },
    {
      status: "warn",
      name: "execution isolation",
      message: "declared by executor configuration only; runtime verification=unavailable"
    },
    {
      status: "warn",
      name: "delivery health",
      message: "unknown; no provider delivery receipt was inspected"
    },
    {
      status: "warn",
      name: "installation certification",
      message: "unverified; configuration and reachability are not installation certification"
    }
  ];
}

export function appendCliDoctorChecks(config: ReturnType<typeof readCliConfig>, checks: DoctorCheck[], secretConfig: unknown = redactedCliConfig(config)): DoctorCheck[] {
  const capabilityLines = formatConfiguredCapabilities({
    executors: config.daemon.repositories.map((repository) => repository.defaultExecutor)
  }).slice(1);
  return [
    ...checks,
    ...operationalDeclarationChecks(config),
    credentialSourcesCheck(secretConfig),
    {
      status: "ok",
      name: "capability catalog",
      message: capabilityLines.join("; ")
    },
    ...relaySecurityChecksFromConfig(config).map((check) => ({
      status: check.status,
      name: check.name,
      message: check.message
    }))
  ];
}

export function formatCliDoctorChecks(checks: DoctorCheck[]): string {
  return renderOpenTagPresentationPlainText(
    createDoctorSummaryPresentation({
      title: "OpenTag doctor",
      checks
    })
  );
}

export async function runDoctorCommand(options: DoctorCommandOptions): Promise<void> {
  const configPath = options.config ?? defaultConfigPath();
  let config: ReturnType<typeof readCliConfig>;
  let secretConfig: unknown;
  try {
    secretConfig = readRedactedCliConfig(configPath);
    config = readCliConfig(configPath);
  } catch (error) {
    const checks: DoctorCheck[] = [
      {
        status: "fail",
        name: "credential resolution",
        message: error instanceof Error ? error.message : String(error)
      }
    ];
    if (secretConfig !== undefined) {
      checks.unshift(credentialSourcesCheck(secretConfig));
    }
    console.log(formatCliDoctorChecks(checks));
    process.exitCode = 1;
    return;
  }
  const checks = appendCliDoctorChecks(
    config,
    await runDoctor({
      config: config.daemon,
      executors: executorsFromConfig(config.daemon)
    }),
    secretConfig
  );
  console.log(formatCliDoctorChecks(checks));
  if (doctorHasFailures(checks)) {
    process.exitCode = 1;
  }
}
