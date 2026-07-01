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
- Built-in executors expose an optional `capability` contract so setup, doctor, status, and service surfaces can report profile, cancellation, hook-completion, progress-event, approval-boundary, prompt/context trust gates, workspace-isolation, secret, and completion-signal support honestly.

## Example

```ts
import type { ExecutorAdapter } from "@opentag/runner";

export const executor: ExecutorAdapter = {
  id: "my-agent",
  displayName: "My Agent",
  capability: {
    id: "my-agent",
    invocation: "spawn",
    supportsProfile: false,
    supportsStreaming: false,
    supportsCancel: false,
    supportsHookCompletion: false,
    progressEvents: "audit",
    approvalMode: "opentag_policy",
    contextAccess: ["context_packet", "context_pointers", "workspace"],
    promptAssembly: "executor_adapter",
    writeAccess: "workspace",
    conversationAccess: "request",
    promptMutation: "none",
    rawContextAccess: false,
    writeActionAccess: "none",
    workspaceIsolation: "branch",
    requiredSecrets: [],
    completionSignals: [
      {
        type: "process_exit",
        required: true,
        description: "The process exits after producing the final result."
      }
    ]
  },
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
