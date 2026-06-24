# @opentag/client

HTTP client SDK for talking to an OpenTag dispatcher.

Use this package from ingress apps, admin setup scripts, local daemons, hosted runners, or tests that need to create, claim, update, or inspect OpenTag runs over the dispatcher API.

## Install

```bash
pnpm add @opentag/client
```

## Exports

- `createOpenTagClient`: full dispatcher client for run creation, claiming, progress, completion, and binding management.
- `createDispatcherClient`: runner-focused compatibility wrapper used by `opentagd`.
- `createDispatcherAdminClient`: admin-focused compatibility wrapper for runner registration and bindings.
- `OpenTagClient`, `ClaimedOpenTagRun`, `RepoBindingInput`, `RunProgressInput`: public TypeScript contracts.

## Example

```ts
import { createOpenTagClient } from "@opentag/client";

const client = createOpenTagClient({
  dispatcherUrl: "https://opentag.example.com",
  pairingToken: process.env.OPENTAG_DISPATCHER_TOKEN
});

await client.createRun({
  runId: `run_${Date.now()}`,
  event
});

const claimed = await client.claim({ runnerId: "runner_local" });
if (claimed) {
  await client.markRunning({ runId: claimed.run.id, executor: "custom" });
  await client.progress({
    runId: claimed.run.id,
    type: "executor.progress",
    message: "Working on the request",
    at: new Date().toISOString()
  });
  await client.complete({
    runId: claimed.run.id,
    result: { conclusion: "success", summary: "Done" }
  });
}
```

## Error Handling

Non-2xx dispatcher responses throw `Error` values that include the HTTP status and response body excerpt. Treat these messages as diagnostic text, not a stable machine-readable API.

## Stability

The method names and input object shapes are public API. New fields should be optional by default. Breaking changes follow the repository versioning policy.
