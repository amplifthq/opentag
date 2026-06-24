# @opentag/dispatcher

Embeddable dispatcher service for OpenTag.

Use this package when you want to host the OpenTag dispatcher inside another Node or Hono-compatible service instead of running `@opentag/dispatcher-app`.

## Install

```bash
pnpm add @opentag/dispatcher
```

## Exports

- `createDispatcherApp`: creates the Hono app that exposes the OpenTag dispatcher API.
- `createGitHubCallbackSink`: posts callback messages to GitHub issue or PR comments.
- `createSlackCallbackSink`: posts callback messages to Slack threads through `chat.postMessage`.
- `createCompositeCallbackSink`: fans callback delivery out to multiple sinks.
- `CallbackMessage`, `CallbackSink`: callback delivery contracts.

## Example

```ts
import {
  createCompositeCallbackSink,
  createDispatcherApp,
  createGitHubCallbackSink,
  createSlackCallbackSink
} from "@opentag/dispatcher";

export const dispatcher = createDispatcherApp({
  databasePath: "opentag.db",
  pairingToken: process.env.OPENTAG_PAIRING_TOKEN,
  callbackSink: createCompositeCallbackSink([
    createGitHubCallbackSink({ token: process.env.OPENTAG_GITHUB_TOKEN }),
    createSlackCallbackSink({ botToken: process.env.OPENTAG_SLACK_BOT_TOKEN })
  ])
});
```

## API Shape

The app exposes `/healthz` and `/v1/*` dispatcher endpoints for runners, repository bindings, Slack channel bindings, runs, progress, heartbeats, completion, and audit event lookup.

When `pairingToken` is set, every `/v1/*` endpoint requires:

```text
Authorization: Bearer <pairingToken>
```

## Reliability Notes

The v0 dispatcher includes lightweight reliability guardrails without adding a queue service:

- `POST /v1/runs` is idempotent per normalized source event ID. Replayed GitHub or Slack events return the existing run with `idempotentReplay: true`.
- runner claim uses a conditional SQLite update so a queued run can only move to `assigned` once.
- callback delivery is retried before being written as `callback.<kind>.dead_lettered` in the run audit log.
- `GET /v1/runs/:runId/callback-dead-letters` returns exhausted callback delivery failures for operator follow-up.

This is intentionally still a SQLite-first v0 control plane. Multi-instance deployments should continue toward stronger database transactions, callback workers, metrics, and external dead-letter handling.

## Stability

The Hono app factory and callback sink interfaces are public API. Individual HTTP endpoint semantics should remain backward compatible within a major version.
