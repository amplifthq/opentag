# @opentag/runner

Executor contracts and built-in runner adapters for OpenTag.

Use this package when building a local daemon, hosted runner, or custom executor that consumes OpenTag runs.

## Install

```bash
pnpm add @opentag/runner
```

## Exports

- `ExecutorAdapter`: interface every executor implements.
- `createEchoExecutor`: smoke-test executor that echoes the normalized command.
- `createCodexExecutor`: executor that runs `codex exec` in an isolated per-run worktree.
- Git helpers such as `createRunWorktree`, `changedFiles`, `commitRunChanges`, `worktreePathForRun`, and `branchNameForRun`.
- Command helpers such as `nodeCommandRunner` and `assertCommandSucceeded`.

## Example

```ts
import type { ExecutorAdapter } from "@opentag/runner";

export const executor: ExecutorAdapter = {
  id: "my-agent",
  displayName: "My Agent",
  async canRun() {
    return { ready: true };
  },
  async run(input, sink) {
    await sink.emit({
      type: "executor.started",
      message: `Running ${input.command.rawText}`,
      at: new Date().toISOString()
    });

    return {
      conclusion: "success",
      summary: "Handled by my-agent"
    };
  },
  async cancel() {
    return;
  }
};
```

## Safety Notes

`createCodexExecutor` does not switch the user's current checkout. It creates a per-run worktree, checks out an `opentag/<runId>` branch, runs Codex there, cleans internal agent artifacts, commits changed files, and then removes or keeps the worktree according to `keepWorktree`.

## Stability

`ExecutorAdapter` is public API. Add optional fields rather than changing required method signatures.
