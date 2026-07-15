import type { AcpAgentCandidate } from "./acp-agent.js";

export type AcpRegistryPackageDistribution = {
  package: string;
  args: string[];
  env?: Record<string, string>;
};

export type AcpRegistryBinaryTarget = {
  archive: string;
  sha256?: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
};

export type AcpRegistryAgent = {
  id: string;
  name: string;
  version: string;
  description: string;
  distribution: {
    npx?: AcpRegistryPackageDistribution;
    uvx?: AcpRegistryPackageDistribution;
    binary?: Record<string, AcpRegistryBinaryTarget>;
  };
};

export type AcpRegistry = {
  version: string;
  agents: AcpRegistryAgent[];
};

export type AcpRegistryResolution =
  | {
      status: "launchable";
      registryId: string;
      label: string;
      version: string;
      distribution: "npx" | "uvx";
      agent: AcpAgentCandidate;
    }
  | {
      status: "needs_setup";
      registryId: string;
      label: string;
      version: string;
      distribution: "npx" | "uvx" | "binary";
      reason: string;
      binary?: AcpRegistryBinaryTarget & { platform: string };
    };

type RegistryRecord = Record<string, unknown>;

function record(value: unknown, label: string): RegistryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as RegistryRecord;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return [...value] as string[];
}

function environment(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, label);
  for (const [name, entry] of Object.entries(input)) {
    if (!name || typeof entry !== "string") throw new Error(`${label} must contain only string values.`);
  }
  return input as Record<string, string>;
}

function packageDistribution(value: unknown, label: string): AcpRegistryPackageDistribution | undefined {
  if (value === undefined) return undefined;
  const input = record(value, label);
  const env = environment(input.env, `${label}.env`);
  return {
    package: nonEmptyString(input.package, `${label}.package`),
    args: stringArray(input.args, `${label}.args`),
    ...(env ? { env } : {})
  };
}

function binaryDistributions(value: unknown, label: string): Record<string, AcpRegistryBinaryTarget> | undefined {
  if (value === undefined) return undefined;
  const input = record(value, label);
  const targets: Record<string, AcpRegistryBinaryTarget> = {};
  for (const [platform, rawTarget] of Object.entries(input)) {
    const target = record(rawTarget, `${label}.${platform}`);
    const sha256 = target.sha256 === undefined ? undefined : nonEmptyString(target.sha256, `${label}.${platform}.sha256`);
    if (sha256 && !/^[a-f0-9]{64}$/iu.test(sha256)) {
      throw new Error(`${label}.${platform}.sha256 must be a 64-character hexadecimal digest.`);
    }
    const env = environment(target.env, `${label}.${platform}.env`);
    targets[platform] = {
      archive: nonEmptyString(target.archive, `${label}.${platform}.archive`),
      ...(sha256 ? { sha256: sha256.toLowerCase() } : {}),
      cmd: nonEmptyString(target.cmd, `${label}.${platform}.cmd`),
      args: stringArray(target.args, `${label}.${platform}.args`),
      ...(env ? { env } : {})
    };
  }
  if (Object.keys(targets).length === 0) throw new Error(`${label} must declare at least one platform target.`);
  return targets;
}

function registryAgent(value: unknown, index: number): AcpRegistryAgent {
  const input = record(value, `agents[${index}]`);
  const distributionInput = record(input.distribution, `agents[${index}].distribution`);
  const npx = packageDistribution(distributionInput.npx, `agents[${index}].distribution.npx`);
  const uvx = packageDistribution(distributionInput.uvx, `agents[${index}].distribution.uvx`);
  const binary = binaryDistributions(distributionInput.binary, `agents[${index}].distribution.binary`);
  if (!npx && !uvx && !binary) throw new Error(`agents[${index}].distribution must not be empty.`);
  return {
    id: nonEmptyString(input.id, `agents[${index}].id`),
    name: nonEmptyString(input.name, `agents[${index}].name`),
    version: nonEmptyString(input.version, `agents[${index}].version`),
    description: nonEmptyString(input.description, `agents[${index}].description`),
    distribution: {
      ...(npx ? { npx } : {}),
      ...(uvx ? { uvx } : {}),
      ...(binary ? { binary } : {})
    }
  };
}

export function parseAcpRegistry(value: unknown): AcpRegistry {
  const input = record(value, "ACP Registry");
  const version = nonEmptyString(input.version, "ACP Registry version");
  if (version.split(".")[0] !== "1") {
    throw new Error(`Unsupported ACP Registry major version '${version}'.`);
  }
  if (!Array.isArray(input.agents)) throw new Error("ACP Registry agents must be an array.");
  const agents = input.agents.map(registryAgent);
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) throw new Error(`ACP Registry contains duplicate agent id '${agent.id}'.`);
    ids.add(agent.id);
  }
  return { version, agents };
}

function platformId(platform: NodeJS.Platform, arch: string): string | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : undefined;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  return os && cpu ? `${os}-${cpu}` : undefined;
}

function hasEnvironment(distribution: { env?: Record<string, string> }): boolean {
  return Object.keys(distribution.env ?? {}).length > 0;
}

function packageIsPinned(distribution: "npx" | "uvx", packageSpec: string): boolean {
  const delimiter = distribution === "uvx" && packageSpec.includes("==") ? "==" : "@";
  const delimiterIndex = packageSpec.lastIndexOf(delimiter);
  if (delimiterIndex <= 0) return false;
  const version = packageSpec.slice(delimiterIndex + delimiter.length);
  return /^[0-9]+(?:\.[0-9]+)+(?:[A-Za-z0-9._+-]*)$/u.test(version);
}

export function resolveAcpRegistryAgent(
  registry: AcpRegistry,
  registryId: string,
  options: {
    executorId?: string;
    platform?: NodeJS.Platform;
    arch?: string;
    npxCommand?: string;
    uvxCommand?: string;
  } = {}
): AcpRegistryResolution {
  const entry = registry.agents.find((agent) => agent.id === registryId);
  if (!entry) throw new Error(`ACP Registry agent '${registryId}' was not found.`);
  const executorId = options.executorId ?? entry.id;
  const packageCandidates = [
    ["npx", entry.distribution.npx, options.npxCommand ?? "npx"],
    ["uvx", entry.distribution.uvx, options.uvxCommand ?? "uvx"]
  ] as const;
  let needsSetup: Extract<AcpRegistryResolution, { status: "needs_setup" }> | undefined;

  for (const [kind, distribution, command] of packageCandidates) {
    if (!distribution) continue;
    if (hasEnvironment(distribution)) {
      needsSetup ??= {
        status: "needs_setup",
        registryId: entry.id,
        label: entry.name,
        version: entry.version,
        distribution: kind,
        reason: "Registry environment overlays require an explicit OpenTag security policy before launch."
      };
      continue;
    }
    if (!packageIsPinned(kind, distribution.package)) {
      needsSetup ??= {
        status: "needs_setup",
        registryId: entry.id,
        label: entry.name,
        version: entry.version,
        distribution: kind,
        reason: `Registry ${kind} package '${distribution.package}' is not pinned to an exact version.`
      };
      continue;
    }
    return {
      status: "launchable",
      registryId: entry.id,
      label: entry.name,
      version: entry.version,
      distribution: kind,
      agent: {
        id: executorId,
        label: entry.name,
        registry: { id: entry.id, version: entry.version },
        launch: {
          command,
          args: [...(kind === "npx" ? ["--yes"] : []), distribution.package, ...distribution.args]
        }
      }
    };
  }
  if (needsSetup) return needsSetup;

  const selectedPlatform = platformId(options.platform ?? process.platform, options.arch ?? process.arch);
  const target = selectedPlatform ? entry.distribution.binary?.[selectedPlatform] : undefined;
  return {
    status: "needs_setup",
    registryId: entry.id,
    label: entry.name,
    version: entry.version,
    distribution: "binary",
    reason: target
      ? "Binary ACP distributions must be materialized and checksum-verified before launch."
      : `No launchable ACP distribution is available for ${selectedPlatform ?? `${options.platform ?? process.platform}-${options.arch ?? process.arch}`}.`,
    ...(target ? { binary: { platform: selectedPlatform!, ...target } } : {})
  };
}
