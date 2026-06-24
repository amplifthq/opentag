# Custom Runner Example

This example shows how to build a third-party runner with `@opentag/client` and `@opentag/runner`.

The runner claims one pending run from a dispatcher, emits progress, executes a tiny custom executor, and completes the run.

## Prerequisites

Start a dispatcher and create a run first. You can use:

- `examples/github-to-echo` for the full manual loop.
- `examples/embedded-dispatcher` if you want an embedded dispatcher host.

Register and bind the runner:

```bash
curl -X POST http://localhost:3030/v1/runners \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev_pairing_token' \
  -d '{"runnerId":"runner_custom","name":"Custom Runner"}'

curl -X POST http://localhost:3030/v1/repo-bindings \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev_pairing_token' \
  -d '{"provider":"github","owner":"acme","repo":"demo","runnerId":"runner_custom","workspacePath":"/tmp/demo","defaultExecutor":"custom"}'
```

## Run Once

```bash
OPENTAG_DISPATCHER_URL=http://localhost:3030 \
OPENTAG_PAIRING_TOKEN=dev_pairing_token \
OPENTAG_RUNNER_ID=runner_custom \
pnpm --filter @opentag/example-custom-runner dev
```

## What It Demonstrates

- Defining an `ExecutorAdapter`.
- Claiming a run with `createOpenTagClient`.
- Marking a run as running.
- Emitting progress events.
- Completing the run with an `OpenTagRunResult`.

This is intentionally small. Production runners should add cancellation, retries, local workspace resolution, and executor-specific readiness checks.
