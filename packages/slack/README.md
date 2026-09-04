# @opentag/slack

Slack Source App helpers for the OpenTag Control Plane.

Use this package to verify signed Slack requests, normalize `app_mention` and
authenticated deletion events, read bounded thread context, render governed
presentations, and deliver through the active Control Plane installation.

This package does not start an HTTP listener, open Socket Mode, or own a local
transport. Transport ownership belongs to the Control Plane.

## Install

```bash
pnpm add @opentag/slack
```

## Exports

- `normalizeSlackAppMention`: converts a Slack app mention into an `OpenTagEvent`.
- `createSlackSourceApp`: creates the registry-backed ingress, context,
  presentation, and delivery definition used by the Control Plane.
- `computeSlackSignature`, `verifySlackSignature`, and `verifySlackTimestamp`:
  verify the raw Slack request before parsing it.
- `slackThreadKey`: encodes team, channel, and thread timestamp for source-thread delivery.
- `parseSlackThreadKey`: decodes a Slack thread key for `chat.postMessage`.

## Example

```ts
import { normalizeSlackAppMention } from "@opentag/slack";

const event = normalizeSlackAppMention({
  teamId: "T123",
  channelId: "C123",
  userId: "U456",
  text: "<@U_APP> investigate this deploy failure",
  ts: "1710000000.000100",
  eventId: "Ev123",
  eventTime: 1710000000,
  botUserId: "U_APP",
  binding: {
    teamId: "T123",
    channelId: "C123",
    repoProvider: "github",
    owner: "acme",
    repo: "demo"
  }
});

if (event) {
  // Admit it through the Control Plane's active Slack installation and binding.
}
```

## Stability

Thread key and signature behavior are part of the Control Plane Source App
boundary. A breaking change must update the Control Plane and this package
atomically.
