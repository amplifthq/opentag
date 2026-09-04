#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const openclawCommand = process.env.OPENTAG_OPENCLAW_COMMAND || "openclaw";
const hermesCommand = process.env.OPENTAG_HERMES_COMMAND || "hermes";
const builtInAcpAgents = process.env.OPENTAG_BUILTIN_ACP_AGENTS?.split(",").map((value) => value.trim())
  ?? ["codex", "claude-code", "cursor", "opencode", "hermes", "openclaw"];

function requiredCommandsForBuiltInAcpAgent(agent) {
  if (["codex", "claude-code", "opencode"].includes(agent)) return ["npx"];
  if (agent === "cursor") return ["cursor-agent"];
  if (agent === "hermes") return [hermesCommand];
  if (agent === "openclaw") return [openclawCommand];
  return [];
}

const cases = [
  {
    id: "paired-relay",
    label: "Self-hosted Control Plane and paired Runner contract",
    live: false,
    command: "corepack pnpm test:team-relay",
    requiredCommands: ["corepack"],
    requiredEnv: ["OPENTAG_TEST_DATABASE_URL"],
    notes: [
      "Runs the deterministic Slack Source App, Control Plane, paired Runner, GitHub publication-control, and recovery contract against PostgreSQL.",
      "No provider credentials are read and no real Slack or GitHub API is contacted."
    ]
  },
  {
    id: "builtin-acp",
    label: "Live built-in coding-agent ACP conformance",
    live: true,
    command: "corepack pnpm smoke:acp-conformance",
    requiredCommands: [
      "corepack",
      "git",
      ...new Set(builtInAcpAgents.flatMap(requiredCommandsForBuiltInAcpAgent))
    ],
    notes: [
      "Runs real readiness, scratch cwd, isolated worktree, and declared process-tree cancellation cases.",
      "Set OPENTAG_BUILTIN_ACP_AGENTS to a comma-separated subset of codex,claude-code,cursor,opencode,hermes,openclaw.",
      "OpenClaw declares best-effort cancellation, so its process-tree case is not applicable; use openclaw-acp for the strict upstream probe.",
      "Codex and Claude require working local authentication; Hermes requires a usable OPENTAG_HERMES_PROFILE provider."
    ]
  },
  {
    id: "openclaw-acp",
    label: "Live OpenClaw Gateway ACP conformance",
    live: true,
    command: "corepack pnpm smoke:openclaw-acp-conformance",
    requiredCommands: ["corepack", "git", openclawCommand],
    notes: [
      "Requires OpenClaw 2026.7.1 and a running Gateway for OPENTAG_OPENCLAW_PROFILE (default: opentag-conformance).",
      "Uses real model and file tools in temporary worktree and scratch fixtures, then exercises live cancellation.",
      "Stock 2026.7.1 currently fails the strict hard-cancellation probe because its cancelled shell can still reach the completion marker; built-in support remains available with cancel=no.",
      "The profile owns Gateway authentication; never put its token in the integration manifest."
    ]
  }
];

function usage() {
  return [
    "Usage: node scripts/test/live-e2e-smoke.mjs [options]",
    "",
    "Options:",
    "  --case <id>         Select a case. Repeat or pass comma-separated ids.",
    "  --all               Select every case.",
    "  --dry-run           Print plan and preflight without executing commands.",
    "  --allow-missing     Skip selected cases with missing commands/env instead of failing.",
    "  --report <path>     Write a JSON report.",
    "  --json              Print JSON instead of text.",
    "  --list              List cases and exit.",
    "  --help              Show this help.",
    "",
    "Cases:",
    ...cases.map((testCase) => `  ${testCase.id}${testCase.live ? " (live)" : " (local)"} - ${testCase.label}`)
  ].join("\n");
}

function parseArgs(argv) {
  const selected = new Set();
  const options = {
    all: false,
    allowMissing: false,
    dryRun: false,
    json: false,
    list: false,
    reportPath: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--allow-missing") {
      options.allowMissing = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--case") {
      const value = argv[index + 1];
      if (!value) throw new Error("--case requires a value.");
      for (const id of value.split(",")) selected.add(id.trim());
      index += 1;
      continue;
    }
    if (arg === "--report") {
      const value = argv[index + 1];
      if (!value) throw new Error("--report requires a value.");
      options.reportPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { ...options, selected };
}

function commandExists(command) {
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => resolve(directory, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function envPresent(name) {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
}

function envRequirementMet(requirement) {
  const [name, expected] = requirement.split("=");
  if (!name) return false;
  if (expected === undefined) return envPresent(name);
  return process.env[name]?.trim().toLowerCase() === expected.toLowerCase();
}

function preflight(testCase) {
  const missing = [];
  const warnings = [];

  for (const command of testCase.requiredCommands ?? []) {
    if (!commandExists(command)) missing.push(`command:${command}`);
  }
  for (const envName of testCase.requiredEnv ?? []) {
    if (!envPresent(envName)) missing.push(`env:${envName}`);
  }
  for (const alternatives of testCase.requiredOneOfEnv ?? []) {
    if (!alternatives.some(envRequirementMet)) missing.push(`env:${alternatives.join("|")}`);
  }
  for (const command of testCase.optionalCommands ?? []) {
    if (!commandExists(command)) warnings.push(`optional command missing: ${command}`);
  }

  return { missing, warnings };
}

function selectedCases(options) {
  if (options.list) return [];
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  if (options.all) return cases;
  if (options.selected.size === 0) return [];
  const output = [];
  for (const id of options.selected) {
    const testCase = byId.get(id);
    if (!testCase) {
      throw new Error(`Unknown case: ${id}. Run with --list to see available cases.`);
    }
    output.push(testCase);
  }
  return output;
}

async function runCommand(command) {
  const startedAt = Date.now();
  const child = spawn(command, {
    cwd: rootDir,
    env: process.env,
    shell: true,
    stdio: "inherit"
  });
  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  return {
    exitCode,
    durationMs: Date.now() - startedAt
  };
}

function renderText(report) {
  const lines = [
    `Live E2E smoke harness: ${report.selectedCases.length} selected case(s)`,
    `Started: ${report.startedAt}`,
    ""
  ];
  if (report.selectedCases.length === 0) {
    lines.push("No cases selected. Use --case <id>, --all, or --list.");
    return lines.join("\n");
  }

  for (const result of report.results) {
    lines.push(`${result.status.toUpperCase()} ${result.id}: ${result.label}`);
    lines.push(`  command: ${result.command}`);
    if (result.missing.length > 0) lines.push(`  missing: ${result.missing.join(", ")}`);
    if (result.warnings.length > 0) lines.push(`  warnings: ${result.warnings.join(", ")}`);
    if (result.notes.length > 0) lines.push(...result.notes.map((note) => `  note: ${note}`));
    if (typeof result.durationMs === "number") lines.push(`  durationMs: ${result.durationMs}`);
    if (typeof result.exitCode === "number") lines.push(`  exitCode: ${result.exitCode}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function writeReport(path, report) {
  const absolute = resolve(rootDir, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    console.log(usage());
    return;
  }

  const selected = selectedCases(options);
  const report = {
    ok: true,
    dryRun: options.dryRun,
    startedAt: new Date().toISOString(),
    selectedCases: selected.map((testCase) => testCase.id),
    results: []
  };

  for (const testCase of selected) {
    const { missing, warnings } = preflight(testCase);
    const result = {
      id: testCase.id,
      label: testCase.label,
      live: testCase.live,
      command: testCase.command,
      status: "planned",
      missing,
      warnings,
      notes: testCase.notes ?? []
    };

    if (missing.length > 0) {
      if (options.allowMissing) {
        result.status = "skipped";
        report.results.push(result);
        continue;
      }
      result.status = "failed";
      report.ok = false;
      report.results.push(result);
      continue;
    }

    if (options.dryRun) {
      result.status = "planned";
      report.results.push(result);
      continue;
    }

    const execution = await runCommand(testCase.command);
    result.exitCode = execution.exitCode;
    result.durationMs = execution.durationMs;
    result.status = execution.exitCode === 0 ? "passed" : "failed";
    if (execution.exitCode !== 0) report.ok = false;
    report.results.push(result);
  }

  report.finishedAt = new Date().toISOString();

  if (options.reportPath) {
    writeReport(options.reportPath, report);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
    if (options.reportPath) console.log(`Report: ${resolve(rootDir, options.reportPath)}`);
  }

  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
