import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultConfigPath,
  defaultStateDirectory,
  ensurePrivateDirectory,
  readCliConfig,
  readRedactedCliConfig,
  relayUrlFromConfig,
  runtimeModeFromConfig,
  type OpenTagCliConfig,
  type PathEnvironment
} from "./config.js";
import {
  dispatcherRuntimeHardeningInputFromEnv,
  doctorHasFailures,
  executorsFromConfig,
  runDoctor,
  type DoctorCheck
} from "@opentag/local-runtime";
import type { CommandRunner } from "@opentag/runner";
import { formatConfiguredCapabilities } from "./catalogs/capabilities.js";
import type { PlatformId } from "./catalogs/platforms.js";
import { formatRelaySecurityChecks, relaySecurityChecksFromConfig } from "./relay-security.js";
import { formatSecretReadiness } from "./secret-readiness.js";
import { probeDispatcherHealth } from "./health.js";
import { runStartCommand } from "./start.js";

export const SERVICE_LABEL = "im.opentag.agent";

export type ServiceCommandOptions = {
  config?: string;
  lines?: string | number;
  maxRequestBodyBytes?: string | number;
  mode?: string;
  rateLimitDisabled?: boolean;
  rateLimitMaxRequests?: string | number;
  rateLimitWindowMs?: string | number;
};

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type ServiceDependencies = {
  cliEntry?: string;
  codexConfigPath?: string;
  commandRunner?: CommandRunner;
  env?: PathEnvironment;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
  homeDir?: string;
  launchctl?: (args: string[]) => CommandResult;
  logger?: Pick<Console, "log">;
  nodePath?: string;
  platform?: NodeJS.Platform;
  uid?: number;
};

export type ServicePaths = {
  configPath: string;
  label: string;
  logsDir: string;
  plistPath: string;
  stderrPath: string;
  stdoutPath: string;
};

export type ServiceStatusSummary = ServicePaths & {
  autostart: "enabled" | "disabled" | "unknown";
  controller: "launchd" | "unsupported";
  installed: boolean;
  relayUrl?: string;
  relaySecurity: string[];
  running: "running" | "stopped" | "unknown";
  runtimeMode: "local" | "relay" | "unknown";
  runtimeReadiness: "ready" | "starting" | "degraded" | "stale_heartbeat" | "unreachable" | "unverified" | "stopped" | "unknown";
  runtimeReadinessDetail?: string;
  runtimeDiagnostics?: string[];
  connectors: string[];
  secrets: string[];
  capabilities: string[];
  serviceHardening: string[];
};

const serviceHardeningEnvKeys = [
  "OPENTAG_MAX_REQUEST_BODY_BYTES",
  "OPENTAG_RATE_LIMIT_WINDOW_MS",
  "OPENTAG_RATE_LIMIT_MAX_REQUESTS",
  "OPENTAG_RATE_LIMIT_DISABLED"
] as const;

function loggerFrom(dependencies: ServiceDependencies): Pick<Console, "log"> {
  return dependencies.logger ?? console;
}

function platformFrom(dependencies: ServiceDependencies): NodeJS.Platform {
  return dependencies.platform ?? process.platform;
}

function homeFrom(dependencies: ServiceDependencies): string {
  return dependencies.homeDir ?? homedir();
}

function uidFrom(dependencies: ServiceDependencies): number {
  return dependencies.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
}

export function servicePaths(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  const home = homeFrom(dependencies);
  const env = dependencies.env ?? process.env;
  const configPath = options.config ?? defaultConfigPath(env, home);
  const stateDirectory = defaultStateDirectory(env, home);
  const logsDir = join(stateDirectory, "logs");
  return {
    configPath,
    label: SERVICE_LABEL,
    logsDir,
    plistPath: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    stdoutPath: join(logsDir, "opentag.log"),
    stderrPath: join(logsDir, "opentag.err.log")
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function plistStringArray(values: string[]): string {
  return values.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
}

export function buildLaunchAgentPlist(input: {
  environment?: Record<string, string>;
  keepAlive: boolean;
  label: string;
  programArguments: string[];
  runAtLoad: boolean;
  stderrPath: string;
  stdoutPath: string;
  workingDirectory: string;
}): string {
  const environmentEntries = Object.entries(input.environment ?? {});
  const environment =
    environmentEntries.length > 0
      ? [
          "  <key>EnvironmentVariables</key>",
          "  <dict>",
          ...environmentEntries.flatMap(([key, value]) => [
            `    <key>${escapeXml(key)}</key>`,
            `    <string>${escapeXml(value)}</string>`
          ]),
          "  </dict>"
        ]
      : [];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(input.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    plistStringArray(input.programArguments),
    "  </array>",
    "  <key>RunAtLoad</key>",
    `  <${input.runAtLoad ? "true" : "false"}/>`,
    "  <key>KeepAlive</key>",
    `  <${input.keepAlive ? "true" : "false"}/>`,
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(input.stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(input.stderrPath)}</string>`,
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(input.workingDirectory)}</string>`,
    ...environment,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function launchctlRunner(dependencies: ServiceDependencies): (args: string[]) => CommandResult {
  if (dependencies.launchctl) return dependencies.launchctl;
  return (args: string[]) => {
    const result = spawnSync("launchctl", args, { encoding: "utf8" });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  };
}

function launchdDomain(dependencies: ServiceDependencies): string {
  return `gui/${uidFrom(dependencies)}`;
}

function launchdServiceTarget(dependencies: ServiceDependencies): string {
  return `${launchdDomain(dependencies)}/${SERVICE_LABEL}`;
}

function unsupportedMessage(): string {
  return "OpenTag service management is not supported yet on this platform. Use `opentag start` in the foreground for now.";
}

function assertMacOS(dependencies: ServiceDependencies): void {
  if (platformFrom(dependencies) !== "darwin") {
    throw new Error(unsupportedMessage());
  }
}

function runLaunchctlOrThrow(dependencies: ServiceDependencies, args: string[], action: string): CommandResult {
  const result = launchctlRunner(dependencies)(args);
  if (result.status !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`${action} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

function serviceWorkingDirectory(configPath: string): string {
  const config = readCliConfig(configPath);
  return config.daemon.repositories[0]?.checkoutPath ?? dirname(configPath);
}

function serviceProgramArguments(options: ServiceCommandOptions, dependencies: ServiceDependencies): string[] {
  const paths = servicePaths(options, dependencies);
  return [
    dependencies.nodePath ?? process.execPath,
    dependencies.cliEntry ?? process.argv[1] ?? "opentag",
    "service",
    "run",
    "--mode",
    "background",
    "--config",
    paths.configPath
  ];
}

function positiveIntegerOption(flag: string, value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, received ${value}`);
  }
  return String(parsed);
}

function serviceHardeningEnvironment(options: ServiceCommandOptions): Record<string, string> {
  const maxRequestBodyBytes = positiveIntegerOption("--max-request-body-bytes", options.maxRequestBodyBytes);
  const rateLimitWindowMs = positiveIntegerOption("--rate-limit-window-ms", options.rateLimitWindowMs);
  const rateLimitMaxRequests = positiveIntegerOption("--rate-limit-max-requests", options.rateLimitMaxRequests);
  const environment: Record<string, string> = {
    ...(maxRequestBodyBytes ? { OPENTAG_MAX_REQUEST_BODY_BYTES: maxRequestBodyBytes } : {}),
    ...(rateLimitWindowMs ? { OPENTAG_RATE_LIMIT_WINDOW_MS: rateLimitWindowMs } : {}),
    ...(rateLimitMaxRequests ? { OPENTAG_RATE_LIMIT_MAX_REQUESTS: rateLimitMaxRequests } : {}),
    ...(options.rateLimitDisabled ? { OPENTAG_RATE_LIMIT_DISABLED: "true" } : {})
  };
  dispatcherRuntimeHardeningInputFromEnv(environment);
  return environment;
}

function configured(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function connectorStatus(ready: boolean, detail: string): string {
  return ready ? `ready (${detail})` : `missing (${detail})`;
}

function formatConnectorReadiness(config: OpenTagCliConfig): string[] {
  const lines = ["Connectors:"];
  const github = config.platforms.github;
  if (github) {
    const callbackReady = configured(config.daemon.githubToken);
    const applyReady = config.daemon.githubApplyToken === null ? "disabled" : configured(config.daemon.githubApplyToken ?? config.daemon.githubToken) ? "ready" : "missing";
    lines.push(
      `  github: ingress=repository_webhook path=${github.webhookPath ?? "/github/webhooks"} port=${github.port ?? "default"}, callback=${connectorStatus(callbackReady, "daemon.githubToken")}, apply=${applyReady}, target=github:${github.owner}/${github.repo}`
    );
  }

  const slack = config.platforms.slack;
  if (slack) {
    const mode = slack.mode ?? "events_api";
    const ingressReady = mode === "socket_mode" ? configured(slack.appToken) : configured(slack.signingSecret);
    const ingressDetail = mode === "socket_mode" ? "appToken" : `signingSecret port=${slack.port ?? "default"}`;
    lines.push(
      `  slack: ingress=${mode} ${connectorStatus(ingressReady, ingressDetail)}, callback=${connectorStatus(configured(slack.botToken), "botToken")}, source=${slack.teamId}/${slack.channelId}`
    );
  }

  const lark = config.platforms.lark;
  if (lark) {
    const credentialsReady = configured(lark.appId) && configured(lark.appSecret);
    const addressing = lark.botOpenId ? "bot_open_id configured" : "bot identity may need discovery";
    lines.push(
      `  lark: ingress=long_connection domain=${lark.domain} ${connectorStatus(credentialsReady, "appId/appSecret")}, callback=${connectorStatus(credentialsReady, "appId/appSecret")}, addressing=${addressing}`
    );
  }

  return lines.length > 1 ? lines : [...lines, "  none configured"];
}

function launchAgentEnvironment(options: ServiceCommandOptions, paths: ServicePaths): Record<string, string> {
  return {
    OPENTAG_CONFIG_PATH: paths.configPath,
    ...serviceHardeningEnvironment(options)
  };
}

export function installService(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  assertMacOS(dependencies);
  const paths = servicePaths(options, dependencies);
  const workingDirectory = serviceWorkingDirectory(paths.configPath);
  mkdirSync(dirname(paths.plistPath), { recursive: true });
  ensurePrivateDirectory(paths.logsDir);
  const plist = buildLaunchAgentPlist({
    label: paths.label,
    programArguments: serviceProgramArguments(options, dependencies),
    runAtLoad: true,
    keepAlive: true,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    workingDirectory,
    environment: launchAgentEnvironment(options, paths)
  });
  writeFileSync(paths.plistPath, plist, { mode: 0o644 });
  return paths;
}

function installed(paths: ServicePaths): boolean {
  return existsSync(paths.plistPath);
}

function isNotLoaded(result: CommandResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return text.includes("no such process") || text.includes("could not find service") || text.includes("service is not loaded");
}

export function startService(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  assertMacOS(dependencies);
  const paths = servicePaths(options, dependencies);
  if (!installed(paths)) {
    throw new Error(`OpenTag service is not installed. Run \`opentag service install --config ${paths.configPath}\` first.`);
  }
  const launchctl = launchctlRunner(dependencies);
  const bootstrap = launchctl(["bootstrap", launchdDomain(dependencies), paths.plistPath]);
  if (bootstrap.status !== 0) {
    const print = launchctl(["print", launchdServiceTarget(dependencies)]);
    if (print.status !== 0) {
      const detail = [bootstrap.stderr.trim(), bootstrap.stdout.trim()].filter(Boolean).join("\n");
      throw new Error(`launchctl bootstrap failed${detail ? `: ${detail}` : "."}`);
    }
  }
  runLaunchctlOrThrow(dependencies, ["kickstart", "-k", launchdServiceTarget(dependencies)], "launchctl kickstart");
  return paths;
}

export function stopService(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  assertMacOS(dependencies);
  const paths = servicePaths(options, dependencies);
  if (!installed(paths)) return paths;
  const launchctl = launchctlRunner(dependencies);
  const first = launchctl(["bootout", launchdServiceTarget(dependencies)]);
  if (first.status !== 0 && !isNotLoaded(first)) {
    const second = launchctl(["bootout", launchdDomain(dependencies), paths.plistPath]);
    if (second.status !== 0 && !isNotLoaded(second)) {
      const detail = [second.stderr.trim(), first.stderr.trim(), second.stdout.trim(), first.stdout.trim()].filter(Boolean).join("\n");
      throw new Error(`launchctl bootout failed${detail ? `: ${detail}` : "."}`);
    }
  }
  return paths;
}

export function uninstallService(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  assertMacOS(dependencies);
  const paths = stopService(options, dependencies);
  rmSync(paths.plistPath, { force: true });
  return paths;
}

export function enableServiceAutostart(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  assertMacOS(dependencies);
  const paths = installed(servicePaths(options, dependencies)) ? servicePaths(options, dependencies) : installService(options, dependencies);
  runLaunchctlOrThrow(dependencies, ["enable", launchdServiceTarget(dependencies)], "launchctl enable");
  return paths;
}

export function disableServiceAutostart(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServicePaths {
  assertMacOS(dependencies);
  const paths = servicePaths(options, dependencies);
  if (installed(paths)) {
    runLaunchctlOrThrow(dependencies, ["disable", launchdServiceTarget(dependencies)], "launchctl disable");
  }
  return paths;
}

export function getServiceStatus(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): ServiceStatusSummary {
  const paths = servicePaths(options, dependencies);
  const controller = platformFrom(dependencies) === "darwin" ? "launchd" : "unsupported";
  const isInstalled = installed(paths);
  let running: ServiceStatusSummary["running"] = isInstalled ? "stopped" : "unknown";
  if (controller === "launchd" && isInstalled) {
    const result = launchctlRunner(dependencies)(["print", launchdServiceTarget(dependencies)]);
    running = result.status === 0 ? "running" : "stopped";
  }

  let runtimeMode: ServiceStatusSummary["runtimeMode"] = "unknown";
  let relayUrl: string | undefined;
  let relaySecurity: string[] = [];
  let connectors: string[] = ["Connectors:", "  unavailable (config missing)"];
  let secrets: string[] = ["Secrets:", "  unavailable (config missing)"];
  let capabilities: string[] = ["Capabilities:", "  platform unknown", "  executor unknown"];
  if (existsSync(paths.configPath)) {
    const config = readCliConfig(paths.configPath);
    runtimeMode = runtimeModeFromConfig(config);
    relayUrl = relayUrlFromConfig(config);
    relaySecurity = formatRelaySecurityChecks(relaySecurityChecksFromConfig(config));
    connectors = formatConnectorReadiness(config);
    secrets = formatSecretReadiness(readRedactedCliConfig(paths.configPath));
    const platforms = Object.entries(config.platforms)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key as PlatformId);
    capabilities = formatConfiguredCapabilities({
      platforms,
      executors: config.daemon.repositories.map((repository) => repository.defaultExecutor)
    });
  }

  return {
    ...paths,
    controller,
    installed: isInstalled,
    running,
    runtimeMode,
    runtimeReadiness: running === "running" ? "unverified" : running === "stopped" ? "stopped" : "unknown",
    ...(relayUrl ? { relayUrl } : {}),
    relaySecurity,
    connectors,
    secrets,
    capabilities,
    serviceHardening: formatServiceHardening(paths),
    autostart: isInstalled ? "enabled" : "disabled"
  };
}

function readLaunchAgentEnvironment(paths: ServicePaths): Record<string, string> {
  if (!existsSync(paths.plistPath)) return {};
  const plist = readFileSync(paths.plistPath, "utf8");
  const environmentBlock = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  const body = environmentBlock?.[1];
  if (!body) return {};
  return Object.fromEntries(
    Array.from(body.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)).flatMap((match) => {
      const key = match[1];
      const value = match[2];
      return key !== undefined && value !== undefined ? [[unescapeXml(key), unescapeXml(value)]] : [];
    })
  );
}

function formatServiceHardening(paths: ServicePaths): string[] {
  const environment = readLaunchAgentEnvironment(paths);
  const configured = serviceHardeningEnvKeys
    .filter((key) => environment[key])
    .map((key) => `  ${key}=${environment[key]}`);
  return ["Service Hardening:", ...(configured.length ? configured : ["  dispatcher hardening env not configured in LaunchAgent"])];
}

function doctorCounts(checks: DoctorCheck[]): { fail: number; warn: number } {
  return {
    fail: checks.filter((check) => check.status === "fail").length,
    warn: checks.filter((check) => check.status === "warn").length
  };
}

function formatRuntimeDiagnostic(check: DoctorCheck): string {
  return `${check.status.toUpperCase()} ${check.name}: ${check.message}`;
}

function runtimeReadinessFromHeartbeatChecks(checks: DoctorCheck[]): Pick<ServiceStatusSummary, "runtimeReadiness" | "runtimeReadinessDetail"> | null {
  if (checks.some((check) => check.status === "fail")) return null;
  const heartbeat = checks.find((check) => check.name === "runner heartbeat" && check.status === "warn");
  if (!heartbeat) return null;
  if (heartbeat.message.startsWith("stale;")) {
    return {
      runtimeReadiness: "stale_heartbeat",
      runtimeReadinessDetail: heartbeat.message
    };
  }
  if (heartbeat.message.startsWith("no heartbeat observed")) {
    return {
      runtimeReadiness: "starting",
      runtimeReadinessDetail: heartbeat.message
    };
  }
  return null;
}

export async function getServiceStatusWithRuntimeReadiness(
  options: ServiceCommandOptions = {},
  dependencies: ServiceDependencies = {}
): Promise<ServiceStatusSummary> {
  const summary = getServiceStatus(options, dependencies);
  if (summary.running !== "running" || !existsSync(summary.configPath) || summary.controller === "unsupported") {
    return summary;
  }

  const config = readCliConfig(summary.configPath);
  const dispatcherUrl = config.daemon.dispatcherUrl;
  const ready = await probeDispatcherHealth({
    dispatcherUrl,
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    timeoutMs: dependencies.healthTimeoutMs ?? 1_000
  });
  if (!ready) {
    return {
      ...summary,
      runtimeReadiness: "unreachable",
      runtimeReadinessDetail: `dispatcher healthz failed (${dispatcherUrl})`
    };
  }

  try {
    const checks = await runDoctor({
      config: config.daemon,
      executors: executorsFromConfig(config.daemon),
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      ...(dependencies.commandRunner ? { commandRunner: dependencies.commandRunner } : {}),
      ...(dependencies.codexConfigPath ? { codexConfigPath: dependencies.codexConfigPath } : {})
    });
    const counts = doctorCounts(checks);
    const diagnostics = checks.filter((check) => check.status !== "ok").map(formatRuntimeDiagnostic);
    const heartbeatReadiness = runtimeReadinessFromHeartbeatChecks(checks);
    if (heartbeatReadiness) {
      return {
        ...summary,
        ...heartbeatReadiness,
        ...(diagnostics.length ? { runtimeDiagnostics: diagnostics } : {})
      };
    }
    if (doctorHasFailures(checks) || counts.warn > 0) {
      return {
        ...summary,
        runtimeReadiness: "degraded",
        runtimeReadinessDetail: `doctor checks degraded (${counts.fail} fail, ${counts.warn} warn)`,
        runtimeDiagnostics: diagnostics
      };
    }
    return {
      ...summary,
      runtimeReadiness: "ready",
      runtimeReadinessDetail: `dispatcher healthz ok; doctor checks ok (${checks.length} checks)`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...summary,
      runtimeReadiness: "degraded",
      runtimeReadinessDetail: `doctor checks failed: ${message}`,
      runtimeDiagnostics: [`FAIL doctor checks: ${message}`]
    };
  }
}

export function formatServiceStatus(summary: ServiceStatusSummary): string {
  return [
    `Controller: ${summary.controller}`,
    `Installed: ${summary.installed ? "yes" : "no"}`,
    `Running: ${summary.running}`,
    `Autostart: ${summary.autostart}`,
    `Config: ${summary.configPath}`,
    `Runtime: ${summary.runtimeMode}`,
    `OpenTag runtime: ${summary.runtimeReadiness}${summary.runtimeReadinessDetail ? ` (${summary.runtimeReadinessDetail})` : ""}`,
    ...(summary.runtimeDiagnostics?.length ? ["Runtime Checks:", ...summary.runtimeDiagnostics.map((diagnostic) => `  ${diagnostic}`)] : []),
    ...(summary.relayUrl ? [`Relay: ${summary.relayUrl}`] : []),
    ...summary.relaySecurity,
    ...summary.connectors,
    ...summary.secrets,
    ...summary.capabilities,
    ...summary.serviceHardening,
    `LaunchAgent: ${summary.plistPath}`,
    `Stdout log: ${summary.stdoutPath}`,
    `Stderr log: ${summary.stderrPath}`,
    ...(summary.controller === "unsupported" ? [unsupportedMessage()] : [])
  ].join("\n");
}

function parseLines(value: string | number | undefined): number {
  if (value === undefined) return 80;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--lines must be a positive integer, received ${value}`);
  }
  return parsed;
}

function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) {
    return "(log file does not exist yet)";
  }
  const content = readFileSync(path, "utf8");
  const entries = content.split(/\r?\n/);
  if (entries.at(-1) === "") entries.pop();
  return entries.slice(-lines).join("\n") || "(log file is empty)";
}

export function formatServiceLogs(options: ServiceCommandOptions = {}, dependencies: ServiceDependencies = {}): string {
  const paths = servicePaths(options, dependencies);
  const lines = parseLines(options.lines);
  return [
    `== ${paths.stdoutPath} ==`,
    tailFile(paths.stdoutPath, lines),
    `== ${paths.stderrPath} ==`,
    tailFile(paths.stderrPath, lines)
  ].join("\n");
}

export async function runServiceInstallCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = installService(options, dependencies);
  loggerFrom(dependencies).log(`OpenTag service installed: ${paths.plistPath}`);
  loggerFrom(dependencies).log("It will start at login. Run `opentag service start` to start it now.");
}

export async function runServiceStartCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = startService(options, dependencies);
  loggerFrom(dependencies).log(`OpenTag service started: ${paths.label}`);
}

export async function runServiceStopCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = stopService(options, dependencies);
  loggerFrom(dependencies).log(`OpenTag service stopped: ${paths.label}`);
}

export async function runServiceRestartCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  stopService(options, dependencies);
  const paths = startService(options, dependencies);
  loggerFrom(dependencies).log(`OpenTag service restarted: ${paths.label}`);
}

export async function runServiceUninstallCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = uninstallService(options, dependencies);
  loggerFrom(dependencies).log(`OpenTag service uninstalled: ${paths.plistPath}`);
}

export async function runServiceStatusCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const summary = await getServiceStatusWithRuntimeReadiness(options, dependencies);
  loggerFrom(dependencies).log(formatServiceStatus(summary));
  if (summary.controller === "unsupported") {
    process.exitCode = 1;
  }
}

export async function runServiceLogsCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  loggerFrom(dependencies).log(formatServiceLogs(options, dependencies));
}

export async function runServiceAutostartEnableCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = enableServiceAutostart(options, dependencies);
  loggerFrom(dependencies).log(`OpenTag service autostart enabled: ${paths.label}`);
}

export async function runServiceAutostartDisableCommand(options: ServiceCommandOptions, dependencies: ServiceDependencies = {}): Promise<void> {
  const paths = disableServiceAutostart(options, dependencies);
  loggerFrom(dependencies).log(`OpenTag service autostart disabled: ${paths.label}`);
}

export async function runServiceRunCommand(options: ServiceCommandOptions): Promise<void> {
  if (options.mode && options.mode !== "background") {
    throw new Error(`Unsupported service run mode: ${options.mode}`);
  }
  await runStartCommand({ ...(options.config ? { config: options.config } : {}), background: true });
}
