import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeCliConfigAtomic, type OpenTagCliConfig } from "../src/config.js";
import {
  buildLaunchAgentPlist,
  buildSystemdUserService,
  formatServiceLogs,
  formatServiceStatus,
  getServiceStatus,
  getServiceStatusWithRuntimeReadiness,
  installAndStartService,
  installService,
  runServiceRestartCommand,
  runServiceStatusCommand,
  serviceControllerForPlatform,
  servicePaths,
  startService,
  type CommandResult
} from "../src/service.js";
import { createSetupConfig } from "../src/setup.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "opentag-cli-test-"));
}

function configPathIn(home: string): string {
  return join(home, ".config", "opentag", "config.json");
}

function writeConfig(path: string, mutate?: (config: OpenTagCliConfig) => void): void {
  const projectPath = tempDir();
  const config = createSetupConfig({
    language: "en",
    relayUrl: "https://relay.example",
    projectPath,
    executor: "echo",
    stateDirectory: join(tempDir(), "state"),
    github: {
      projectTargetId: "target_1",
      token: "ghp_token",
      owner: "acme",
      repo: "demo"
    }
  });
  config.daemon.runnerToken = "runner_runtime_token";
  config.daemon.trustedRelay = {
    schemaVersion: 1,
    origin: "https://relay.example",
    authorizedAt: "2026-08-08T00:00:00.000Z",
    authorizationMethod: "explicit_cli"
  };
  config.daemon.controlRegistration = {
    kind: "hosted_control_v1",
    state: "paired",
    operationId: "operation-service",
    registration: {
      schemaVersion: 1,
      protocolVersion: "1.0",
      organizationId: "org_1",
      runnerId: config.daemon.runnerId,
      registrationGeneration: 1,
      credentialGeneration: 1,
      credentialId: "credential-service",
      credentialPurpose: "runtime",
      createdAt: "2026-08-08T00:00:00.000Z"
    }
  };
  mutate?.(config);
  writeCliConfigAtomic(path, config);
}

function writeRelayConfig(path: string): void {
  writeConfig(path);
}

function launchctl(status: number): (args: string[]) => CommandResult {
  return () => ({
    status,
    stdout: "",
    stderr: status === 0 ? "" : "service is not loaded"
  });
}

const doctorCommandRunner = {
  async run(command: string, args: string[]) {
    if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
  }
};

function responseAt(url: string, response: Response): Response {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function runtimeFetch(input: { runnerMissing?: boolean } = {}): {
  fetchImpl: typeof fetch;
  requests: Array<{ url: string; authorization: string | null }>;
} {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    requests.push({ url: href, authorization: new Headers(init?.headers).get("authorization") });
    if (href.endsWith("/healthz")) {
      return Response.json({ ok: true });
    }
    if (href.endsWith("/v1/runners/runner_local/control-context")) {
      return input.runnerMissing
        ? responseAt(href, Response.json({ error: "runner_not_found" }, { status: 404 }))
        : responseAt(href, Response.json({
            schemaVersion: 1,
            protocolVersion: "1.0",
            contextKind: "runner_control",
            organizationId: "org_1",
            runnerId: "runner_local",
            credentialId: "credential-service",
            registrationGeneration: 1,
            credentialGeneration: 1,
            capabilities: [],
            targets: [{
              projectTargetId: "target_1",
              bindingDigest: `sha256:${"a".repeat(64)}`,
              provider: "github",
              owner: "acme",
              repo: "demo",
              defaultExecutor: "echo",
              defaultBranch: "main"
            }],
            observedAt: "2026-08-08T00:00:00.000Z"
          }));
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe("OpenTag CLI service", () => {
  it("generates a LaunchAgent plist with service run arguments and log paths", () => {
    const plist = buildLaunchAgentPlist({
      label: "im.opentag.agent",
      programArguments: ["/usr/local/bin/node", "/opt/opentag/dist/index.js", "service", "run", "--mode", "background"],
      runAtLoad: true,
      keepAlive: true,
      stdoutPath: "/tmp/opentag.log",
      stderrPath: "/tmp/opentag.err.log",
      workingDirectory: "/Users/mingyoo/repos/opentag",
      environment: {
        OPENTAG_CONFIG_PATH: "/tmp/config.json"
      }
    });

    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>im.opentag.agent</string>");
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("<string>service</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("/tmp/opentag.log");
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain("/tmp/opentag.err.log");
    expect(plist).toContain("<key>WorkingDirectory</key>");
  });

  it("generates a systemd user service unit with service run arguments and log paths", () => {
    const unit = buildSystemdUserService({
      environment: {
        OPENTAG_CONFIG_PATH: "/tmp/config.json",
        OPENTAG_MAX_REQUEST_BODY_BYTES: "4096",
        PATH: "/usr/local/bin:/usr/bin:/bin"
      },
      execStart: ["/usr/local/bin/node", "/opt/opentag/dist/index.js", "service", "run", "--mode", "background"],
      label: "im.opentag.agent",
      stderrPath: "/tmp/opentag.err.log",
      stdoutPath: "/tmp/opentag.log",
      workingDirectory: "/home/mingyoo/opentag"
    });

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=OpenTag local agent");
    expect(unit).toContain("[Service]");
    expect(unit).toContain('WorkingDirectory="/home/mingyoo/opentag"');
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/opentag/dist/index.js" "service" "run" "--mode" "background"');
    expect(unit).toContain('Environment="OPENTAG_CONFIG_PATH=/tmp/config.json"');
    expect(unit).toContain('Environment="OPENTAG_MAX_REQUEST_BODY_BYTES=4096"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("StandardOutput=append:/tmp/opentag.log");
    expect(unit).toContain("StandardError=append:/tmp/opentag.err.log");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("installs the macOS LaunchAgent plist without starting launchctl", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    const paths = installService(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        nodePath: "/usr/local/bin/node",
        cliEntry: "/opt/opentag/dist/index.js",
        uid: 501,
        launchctl: () => {
          throw new Error("install should not call launchctl");
        }
      }
    );

    const plist = readFileSync(paths.plistPath, "utf8");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/opentag/dist/index.js</string>");
    expect(plist).toContain(`<string>${configPath}</string>`);
    expect(plist).toContain(`<string>${paths.stdoutPath}</string>`);
    expect(plist).toContain(`<string>${paths.stderrPath}</string>`);
  });

  it("refuses to start a service while Runner credential recovery is required", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath, (config) => {
      delete config.daemon.runnerToken;
      config.daemon.controlRegistration = {
        kind: "hosted_control_v1",
        state: "unpaired",
        reason: "recovery_required",
        registration: {
          ...config.daemon.controlRegistration!.registration
        }
      };
    });
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const startCall = vi.fn(launchctl(0));

    expect(() => startService(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: startCall }
    )).toThrow("credential recovery is required");
    expect(startCall).not.toHaveBeenCalled();
  });

  it("installs and starts the LaunchAgent for setup service mode", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    const calls: string[] = [];

    const paths = await installAndStartService(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        nodePath: "/usr/local/bin/node",
        cliEntry: "/opt/opentag/dist/index.js",
        uid: 501,
        launchctl(args) {
          calls.push(args.join(" "));
          return { status: 0, stdout: "service = im.opentag.agent", stderr: "" };
        },
        sleep: async () => undefined
      }
    );

    const plist = readFileSync(paths.plistPath, "utf8");
    expect(plist).toContain("<string>/opt/opentag/dist/index.js</string>");
    expect(calls).toContain(`bootstrap gui/501 ${paths.plistPath}`);
    expect(calls).toContain("kickstart -k gui/501/im.opentag.agent");
    expect(calls).toContain("print gui/501/im.opentag.agent");
  });

  it("installs and starts the Linux systemd user service for setup service mode", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    const calls: string[] = [];

    const paths = await installAndStartService(
      { config: configPath },
      {
        platform: "linux",
        homeDir: home,
        nodePath: "/usr/local/bin/node",
        cliEntry: "/opt/opentag/dist/index.js",
        systemctl(args) {
          calls.push(args.join(" "));
          if (args[0] === "is-active") return { status: 0, stdout: "active\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
        sleep: async () => undefined
      }
    );

    const unit = readFileSync(paths.unitPath, "utf8");
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/opentag/dist/index.js" "service" "run" "--mode" "background" "--config"');
    expect(unit).toContain(`"${configPath}"`);
    expect(calls).toEqual([
      "daemon-reload",
      "enable im.opentag.agent.service",
      "daemon-reload",
      "start im.opentag.agent.service",
      "is-active im.opentag.agent.service"
    ]);
  });

  it("installs the LaunchAgent with a conservative CLI PATH for executor binaries", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    const paths = installService(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        nodePath: "/usr/local/bin/node",
        cliEntry: "/opt/opentag/dist/index.js",
        uid: 501,
        launchctl: () => {
          throw new Error("install should not call launchctl");
        }
      }
    );

    const plist = readFileSync(paths.plistPath, "utf8");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>");
    expect(plist).not.toContain(".codex/tmp");
  });

  it("restarts cleanly when service-target bootout and kickstart report stale launchd state", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });

    const calls: string[] = [];
    const logs: string[] = [];
    let loaded = true;
    await runServiceRestartCommand(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        uid: 501,
        launchctl(args) {
          calls.push(args.join(" "));
          if (args[0] === "bootout" && args.length === 2) {
            return { status: 1, stdout: "", stderr: "No such process" };
          }
          if (args[0] === "bootout" && args.length === 3) {
            loaded = false;
            return { status: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "bootstrap") {
            loaded = true;
            return { status: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "kickstart") {
            return { status: 1, stdout: "", stderr: "service is not loaded" };
          }
          if (args[0] === "print") {
            return loaded
              ? { status: 0, stdout: "service = im.opentag.agent", stderr: "" }
              : { status: 1, stdout: "", stderr: "service is not loaded" };
          }
          return { status: 1, stdout: "", stderr: `unexpected launchctl ${args.join(" ")}` };
        },
        logger: { log: (message) => logs.push(message) }
      }
    );

    expect(calls).toEqual([
      "bootout gui/501/im.opentag.agent",
      `bootout gui/501 ${servicePaths({ config: configPath }, { homeDir: home }).plistPath}`,
      "print gui/501/im.opentag.agent",
      `bootstrap gui/501 ${servicePaths({ config: configPath }, { homeDir: home }).plistPath}`,
      "kickstart -k gui/501/im.opentag.agent",
      "print gui/501/im.opentag.agent",
      "print gui/501/im.opentag.agent"
    ]);
    expect(logs).toEqual(["OpenTag service restarted: im.opentag.agent"]);
  });

  it("formats service status for installed and not installed launchd services", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);

    const missing = getServiceStatus({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(1) });
    expect(missing.installed).toBe(false);
    expect(formatServiceStatus(missing)).toContain("Installed: no");

    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const running = getServiceStatus({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    expect(running.installed).toBe(true);
    expect(running.running).toBe("running");
    expect(formatServiceStatus(running)).toContain("Controller: launchd");
    expect(formatServiceStatus(running)).not.toContain("Runtime: paired_relay");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: unverified");
    expect(formatServiceStatus(running)).toContain("Project Targets:");
    expect(formatServiceStatus(running)).toContain(
      "github:acme/demo, publication=ready"
    );
    expect(formatServiceStatus(running)).toContain("Secrets:");
    expect(formatServiceStatus(running)).toContain("daemon.runnerToken: inline (redacted)");
    expect(formatServiceStatus(running)).toContain("daemon.githubToken: inline (redacted)");
    expect(formatServiceStatus(running)).toContain("Capabilities:");
    expect(formatServiceStatus(running)).toContain("executor Echo:");
    expect(formatServiceStatus(running)).toContain("isolation=none");
    expect(formatServiceStatus(running)).toContain("completion=process_exit");
  });

  it("summarizes GitHub publication readiness without local ingress state", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath, (config) => {
      delete config.daemon.githubToken;
    });
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });

    const formatted = formatServiceStatus(
      getServiceStatus({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) })
    );

    expect(formatted).toContain("Project Targets:");
    expect(formatted).toContain("github:acme/demo, publication=unavailable");
    expect(formatted).not.toContain("ingress=");
  });

  it("marks a running service ready only after relay health succeeds", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const { fetchImpl, requests } = runtimeFetch();

    const running = await getServiceStatusWithRuntimeReadiness(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: launchctl(0), fetchImpl, commandRunner: doctorCommandRunner }
    );

    expect(requests).toEqual([
      { url: "https://relay.example/healthz", authorization: null },
      { url: "https://relay.example/healthz", authorization: null },
      {
        url: "https://relay.example/v1/runners/runner_local/control-context",
        authorization: "Bearer runner_runtime_token"
      }
    ]);
    expect(running.running).toBe("running");
    expect(running.runtimeReadiness).toBe("ready");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: ready (relay healthz ok; doctor checks ok");
  });

  it("reports disabled launchd autostart separately from installation", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });

    const summary = getServiceStatus(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        launchctl(args) {
          if (args[0] === "print-disabled") {
            return {
              status: 0,
              stdout: 'disabled services = {\n  "im.opentag.agent" => true\n}\n',
              stderr: ""
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
      }
    );

    expect(summary.installed).toBe(true);
    expect(summary.autostart).toBe("disabled");
    expect(formatServiceStatus(summary)).toContain("Autostart: disabled");
  });

  it("marks a launchd-running service degraded when doctor checks fail", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const { fetchImpl } = runtimeFetch({ runnerMissing: true });

    const running = await getServiceStatusWithRuntimeReadiness(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: launchctl(0), fetchImpl, commandRunner: doctorCommandRunner }
    );

    expect(running.running).toBe("running");
    expect(running.runtimeReadiness).toBe("degraded");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: degraded (doctor checks degraded (2 fail, 0 warn))");
    expect(formatServiceStatus(running)).toContain("Runtime Checks:");
    expect(formatServiceStatus(running)).toContain("FAIL runner registration:");
  });

  it("keeps the paired service ready when the optional GitHub publication credential is absent", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath, (config) => {
      delete config.daemon.githubToken;
    });
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const { fetchImpl } = runtimeFetch();

    const running = await getServiceStatusWithRuntimeReadiness(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: launchctl(0), fetchImpl, commandRunner: doctorCommandRunner }
    );

    expect(running.running).toBe("running");
    expect(running.runtimeReadiness).toBe("ready");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: ready");
  });

  it("marks a launchd-running service unreachable when relay health fails", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const running = await getServiceStatusWithRuntimeReadiness(
      { config: configPath },
      { platform: "darwin", homeDir: home, launchctl: launchctl(0), fetchImpl, healthTimeoutMs: 5 }
    );

    expect(running.running).toBe("running");
    expect(running.runtimeReadiness).toBe("unreachable");
    expect(formatServiceStatus(running)).toContain("OpenTag runtime: unreachable (relay healthz failed (https://relay.example))");
  });

  it("uses runtime readiness probing in the service status command", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });
    const lines: string[] = [];

    await runServiceStatusCommand(
      { config: configPath },
      {
        platform: "darwin",
        homeDir: home,
        launchctl: launchctl(0),
        fetchImpl: runtimeFetch().fetchImpl,
        commandRunner: doctorCommandRunner,
        logger: { log: (message) => lines.push(message) }
      }
    );

    expect(lines.join("\n")).toContain("Running: running");
    expect(lines.join("\n")).toContain("OpenTag runtime: ready");
  });

  it("reports Linux systemd user service status", async () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeConfig(configPath);
    await installAndStartService(
      { config: configPath },
      {
        platform: "linux",
        homeDir: home,
        systemctl(args) {
          if (args[0] === "is-active") return { status: 0, stdout: "active\n", stderr: "" };
          if (args[0] === "is-enabled") return { status: 0, stdout: "enabled\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
        sleep: async () => undefined
      }
    );

    const summary = getServiceStatus(
      { config: configPath },
      {
        platform: "linux",
        homeDir: home,
        systemctl(args) {
          if (args[0] === "is-active") return { status: 0, stdout: "active\n", stderr: "" };
          if (args[0] === "is-enabled") return { status: 0, stdout: "enabled\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        }
      }
    );

    expect(summary.controller).toBe("systemd");
    expect(summary.installed).toBe(true);
    expect(summary.running).toBe("running");
    expect(summary.autostart).toBe("enabled");
    expect(formatServiceStatus(summary)).toContain("Controller: systemd");
    expect(formatServiceStatus(summary)).toContain("Systemd unit:");
  });

  it("reports unsupported service management without crashing on unsupported platforms", () => {
    const home = tempDir();
    const summary = getServiceStatus({}, { platform: "win32", homeDir: home });

    expect(summary.controller).toBe("unsupported");
    expect(formatServiceStatus(summary)).toContain("service management is supported on macOS and Linux only");
  });

  it("maps service controllers by platform", () => {
    expect(serviceControllerForPlatform("darwin")).toBe("launchd");
    expect(serviceControllerForPlatform("linux")).toBe("systemd");
    expect(serviceControllerForPlatform("win32")).toBe("unsupported");
  });

  it("includes relay security checks in service status", () => {
    const home = tempDir();
    const configPath = configPathIn(home);
    writeRelayConfig(configPath);
    installService({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) });

    const formatted = formatServiceStatus(
      getServiceStatus({ config: configPath }, { platform: "darwin", homeDir: home, launchctl: launchctl(0) })
    );

    expect(formatted).not.toContain("Runtime: paired_relay");
    expect(formatted).toContain("Relay Security:");
    expect(formatted).toContain("OK relay transport: HTTPS is enabled.");
    expect(formatted).toContain("WARN relay trust: Use only a relay you operate or trust");
    expect(formatted).toContain("OK relay token scope: Runner calls use the scoped daemon.runnerToken");
  });

  it("prints recent stdout and stderr logs", () => {
    const home = tempDir();
    const paths = servicePaths({}, { homeDir: home });
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(paths.stdoutPath, "one\ntwo\nthree\n");
    writeFileSync(paths.stderrPath, "err-one\nerr-two\n");

    const logs = formatServiceLogs({ lines: 2 }, { homeDir: home });

    expect(logs).toContain("two\nthree");
    expect(logs).not.toContain("one\ntwo\nthree");
    expect(logs).toContain("err-one\nerr-two");
  });

  it("does not load the beginning of oversized service logs", () => {
    const home = tempDir();
    const paths = servicePaths({}, { homeDir: home });
    mkdirSync(paths.logsDir, { recursive: true });
    writeFileSync(paths.stdoutPath, `old-start-marker\n${"x".repeat(1024 * 1024 + 32)}\nnear-end\nlast\n`);

    const logs = formatServiceLogs({ lines: 10 }, { homeDir: home });

    expect(logs).toContain("near-end\nlast");
    expect(logs).not.toContain("old-start-marker");
  });
});
