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

## Security Policy V1

Repository bindings can include an optional `securityPolicy` with read/write actor allowlists, blocked actors, allowed runner IDs, and permission scopes that should create a `needs_approval` run instead of immediately dispatching. This is a lightweight v0 policy layer, not a replacement for organization SSO, OIDC, tenant isolation, or a full approval workflow.

## Stability

The Hono app factory and callback sink interfaces are public API. Individual HTTP endpoint semantics should remain backward compatible within a major version.
