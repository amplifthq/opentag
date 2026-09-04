# @opentag/client

Strict HTTP client for the OpenTag Control V1 protocol.

This package connects a trusted local Runner to a self-hosted Control Plane.
Its surface is limited to paired Control V1 authority and receipt flows;
provider writes remain behind their governed runtime boundaries.

## Install

```bash
pnpm add @opentag/client
```

## Authority model

Every authenticated request uses an explicit Control V1 credential:

- `bootstrap_pairing` registers a new Runner.
- `recovery_pairing` re-provisions a Runner whose runtime credential is no
  longer recoverable.
- `runtime` reads Runner Control Context and performs fenced Runner work.

Do not place credentials in URLs, command arguments, logs, or persisted
protocol payloads. The bootstrap and recovery authorities must never become
runtime credentials.

## Runner example

```ts
import { createOpenTagClient } from "@opentag/client";

const client = createOpenTagClient({
  controlPlaneUrl: "https://control.example.com",
  controlCredential: {
    kind: "runtime",
    token: process.env.OPENTAG_RUNNER_TOKEN!
  }
});

const context = await client.getRunnerControlContextV1({
  runnerId: "runner_local"
});

const claim = await client.claimHostedRunControlV1({
  runnerId: context.runnerId,
  request: hostedClaimRequest
});
```

`controlPlaneUrl` is the only endpoint option. The former `dispatcherUrl`
option is not accepted or migrated.

The caller must construct requests with the canonical schemas and digest
helpers from `@opentag/control-protocol`.

## Supported surface

Pairing and onboarding:

- `getRelayCapabilitiesControlV1`
- `registerRunnerControlV1`
- `reprovisionRunnerControlV1`
- `getRunnerControlContextV1`
- `upsertRunnerProjectTargetControlV1`

Runner execution:

- hosted claim and source-content redemption
- fenced heartbeat, running, progress, completion, and reject-start lifecycle
  operations
- readiness, permission, material-action, and proposal-settlement operations

GitHub publication:

- claim-next, begin, receipt, reconciliation, completion, and branch ownership
  operations

## Result boundary

A successful client call proves only that the strict response passed Control V1
status, origin, identity, generation, and digest validation. It does not by
itself prove Slack delivery, GitHub publication, or accepted completion.

Ambiguous provider effects remain `outcome_unknown`. Reconcile the original
operation; do not create a replacement operation merely because the transport
result was uncertain.

## Errors

- `OpenTagControlV1HttpError` exposes sanitized Control V1 status, error code,
  request ID, and retry metadata.
- `OpenTagClientHttpError` exposes a safe client-side validation or transport
  reason.

Remote response bodies and credentials are not surfaced as diagnostic text.
