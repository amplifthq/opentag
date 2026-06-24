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

OpenTag applies a lightweight runner security gate before local agent execution. This is a v1 guardrail, not a full sandbox.

By default, the gate:

- refuses write-capable Codex runs unless the run includes `repo:write`.
- blocks obvious prompt-injection and secret-exfiltration requests such as "ignore previous instructions" or "dump tokens".
- rejects `file` context pointers outside the mapped workspace.
- starts Codex with a scrubbed environment that keeps common runtime variables and drops token, secret, password, API key, cloud credential, GitHub, Slack, OpenAI, Anthropic, and SSH-related variables.

`createCodexExecutor` also refuses to run when the target checkout has uncommitted changes. It creates an isolated `opentag/<runId>` branch before running Codex.

Local daemon deployments can set:

- `OPENTAG_SECURITY_MODE=enforce|audit|off` (`enforce` is the default).
- `OPENTAG_ALLOWED_WORKSPACE_ROOT=/path/to/repos` to restrict mapped checkouts to one local root.
- `OPENTAG_ALLOW_UNSAFE_PROMPTS=true` to disable prompt-pattern blocking while keeping other checks.

Use `audit` when onboarding a real team: findings are reported as progress events, but the run continues.

## Stability

`ExecutorAdapter` is public API. Add optional fields rather than changing required method signatures.
