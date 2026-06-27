import { existsSync } from "node:fs";
import { join } from "node:path";

export type ExecutorId = "echo" | "codex" | "claude-code";

export type ExecutorDescriptor = {
  id: ExecutorId;
  label: string;
  command?: string;
  alwaysAvailable?: boolean;
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
    command: "claude"
  },
  {
    id: "echo",
    label: "Echo",
    alwaysAvailable: true
  }
];

function pathExistsOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const paths = env.PATH?.split(":") ?? [];
  return paths.some((directory) => existsSync(join(directory, command)));
}

export function parseExecutorId(value: string): ExecutorId {
  if (value === "echo" || value === "codex" || value === "claude-code") {
    return value;
  }
  throw new Error("Executor must be echo, codex, or claude-code.");
}

export function detectExecutors(env: NodeJS.ProcessEnv = process.env): ExecutorDetection[] {
  return EXECUTOR_CATALOG.map((executor) => {
    if (executor.alwaysAvailable) {
      return {
        id: executor.id,
        available: true,
        reason: "Built in test mode"
      };
    }
    const available = executor.command ? pathExistsOnPath(executor.command, env) : false;
    return {
      id: executor.id,
      available,
      reason: available ? `Found ${executor.command} on PATH` : `Could not find ${executor.command} on PATH`
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
  return "echo";
}

export function executorLabel(id: ExecutorId): string {
  return EXECUTOR_CATALOG.find((executor) => executor.id === id)?.label ?? id;
}

export function formatExecutors(env: NodeJS.ProcessEnv = process.env): string {
  const detections = detectExecutors(env);
  return [
    "Coding agents:",
    ...EXECUTOR_CATALOG.map((executor) => {
      const detection = detections.find((entry) => entry.id === executor.id);
      const status = detection?.available ? "available" : "not found";
      return `  ${executor.label}: ${status}${detection ? ` (${detection.reason})` : ""}`;
    })
  ].join("\n");
}
