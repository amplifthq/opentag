# @opentag/runner

Executor contracts and the generic ACP host for OpenTag.

Use this package when building a local daemon, hosted runner, or custom executor that consumes OpenTag runs.

## Install

```bash
pnpm add @opentag/runner
```

## Exports

- `ExecutorAdapter`: interface every executor implements.
- `createEchoExecutor`: smoke-test executor that echoes the normalized command.
- `createAcpAgentExecutor`: generic stdio ACP host for an ACP launch definition.
- `parseAcpRegistry` and `resolveAcpRegistryAgent`: provider-neutral ACP Registry parsing and launch-candidate resolution.
- `createBuiltInAcpExecutors`: compatibility aliases for Registry-backed Codex and Claude plus the local Hermes ACP command.
- `builtInAcpAgentDefinitions`: the data-only compatibility definitions and Registry provenance.
- `createAcpExecutor`: lower-level generic stdio ACP host for an internal integration manifest.
- Git helpers such as `createRunBranch`, `changedFiles`, and `branchNameForRun`.
- Command helpers such as `nodeCommandRunner` and `assertCommandSucceeded`.
- Built-in and generic ACP executors expose an optional `capability` contract so setup, doctor, status, and service surfaces can report profile, cancellation, hook-completion, progress-event, approval-boundary, prompt/context trust gates, workspace isolation, ACP session-cwd conformance, secret, and completion-signal support honestly.

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

Codex, Claude Code, and Hermes run through the same generic ACP host. Codex and
Claude use exact package versions from the ACP Registry through `npx`; Hermes
uses its configured local command and profile. The generic ACP host
passes the attempt workspace as the ACP session `cwd`, scrubs the child
environment, and terminates the adapter process group when a run is cancelled.

## Stability

`ExecutorAdapter` is public API. Add optional fields rather than changing required method signatures.
