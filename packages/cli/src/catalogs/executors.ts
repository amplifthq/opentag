import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

export type ExecutorId = "echo" | "codex" | "claude-code" | "hermes";

export type ExecutorDescriptor = {
  id: ExecutorId;
  label: string;
  command?: string;
  commandEnv?: string;
  alwaysAvailable?: boolean;
  devOnly?: boolean;
};

export type ExecutorDetection = {
  id: ExecutorId;
  available: boolean;
  reason: string;
};

export const EXECUTOR_CATALOG: ExecutorDescriptor[] = [
  {
    id: "codex",
    label: "Codex",
    command: "codex"
  },
  {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    commandEnv: "OPENTAG_CLAUDE_COMMAND"
  },
  {
    id: "hermes",
    label: "Hermes",
    command: "hermes",
    commandEnv: "OPENTAG_HERMES_COMMAND"
  },
  {
    id: "echo",
    label: "Echo",
    alwaysAvailable: true,
    devOnly: true
  }
];

function pathExistsOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const paths = env.PATH?.split(delimiter).filter(Boolean) ?? [];
  const candidates =
    process.platform === "win32" && !extname(command)
      ? [command, ...(env.PATHEXT?.split(delimiter).filter(Boolean) ?? [".COM", ".EXE", ".BAT", ".CMD"]).map((extension) => `${command}${extension.toLowerCase()}`)]
      : [command];
  return paths.some((directory) => candidates.some((candidate) => existsSync(join(directory, candidate))));
}

function executorCommand(executor: ExecutorDescriptor, env: NodeJS.ProcessEnv): string | undefined {
  return executor.commandEnv ? env[executor.commandEnv] || executor.command : executor.command;
}

export function isExecutorId(value: string): value is ExecutorId {
  return value === "echo" || value === "codex" || value === "claude-code" || value === "hermes";
}

export function detectExecutors(env: NodeJS.ProcessEnv = process.env): ExecutorDetection[] {
  return EXECUTOR_CATALOG.map((executor) => {
    if (executor.alwaysAvailable) {
      return {
        id: executor.id,
        available: true,
        reason: executor.devOnly ? "Dev/test only; does not run a real coding agent" : "Built in"
      };
    }
    const command = executorCommand(executor, env);
    const available = command ? pathExistsOnPath(command, env) : false;
    return {
      id: executor.id,
      available,
      reason: available ? `Found ${command} on PATH` : `Could not find ${command} on PATH`
    };
  });
}

export function defaultExecutorId(input: {
  previous?: ExecutorId;
  detections?: ExecutorDetection[];
} = {}): ExecutorId {
  if (input.previous) {
    return input.previous;
  }
  const detections = input.detections ?? detectExecutors();
  if (detections.find((executor) => executor.id === "codex")?.available) {
    return "codex";
  }
  if (detections.find((executor) => executor.id === "claude-code")?.available) {
    return "claude-code";
  }
  if (detections.find((executor) => executor.id === "hermes")?.available) {
    return "hermes";
  }
  return "echo";
}

export function executorLabel(id: string): string {
  return EXECUTOR_CATALOG.find((executor) => executor.id === id)?.label ?? id;
}

function formatExecutorStatus(executor: ExecutorDescriptor, available: boolean): string {
  if (executor.devOnly) {
    return "dev/test only";
  }
  return available ? "available" : "not found";
}

export function formatExecutors(env: NodeJS.ProcessEnv = process.env): string {
  const detections = detectExecutors(env);
  return [
    "Coding agents:",
    ...EXECUTOR_CATALOG.map((executor) => {
      const detection = detections.find((entry) => entry.id === executor.id);
      const status = formatExecutorStatus(executor, detection?.available ?? false);
      return `  ${executor.label}: ${status}${detection ? ` (${detection.reason})` : ""}`;
    })
  ].join("\n");
}
