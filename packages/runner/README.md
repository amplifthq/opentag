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
- `createCodexExecutor`: executor that runs `codex exec` in a mapped local checkout.
- Git helpers such as `createRunBranch`, `changedFiles`, and `branchNameForRun`.
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

`createCodexExecutor` refuses to run when the target checkout has uncommitted changes. It creates an isolated `opentag/<runId>` branch before running Codex.

## Stability

`ExecutorAdapter` is public API. Add optional fields rather than changing required method signatures.
