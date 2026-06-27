import { spawn } from "node:child_process";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandEnvironment = Record<string, string | undefined>;

export type CommandRunner = {
  run(command: string, args: string[], options?: { cwd?: string; input?: string; env?: CommandEnvironment }): Promise<CommandResult>;
};

export const nodeCommandRunner: CommandRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      });

      // A large prompt (larger than the OS pipe buffer, ~64KB) written to a
      // child that exits or closes its stdin before the full write drains emits
      // an EPIPE on the stdin stream. Without a listener that error is uncaught
      // and crashes the long-lived local-runtime polling daemon. Swallow it: the
      // child's exit/close is already handled above and is the authoritative
      // signal here.
      child.stdin.on("error", () => {});

      if (options.input) {
        child.stdin.write(options.input);
      }
      child.stdin.end();
    });
  }
};

export async function assertCommandSucceeded(result: CommandResult, label: string): Promise<void> {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
}
