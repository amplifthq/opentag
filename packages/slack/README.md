# @opentag/slack

Slack adapter helpers for OpenTag.

Use this package to normalize Slack `app_mention` events into `OpenTagEvent` objects and to encode or parse Slack callback thread keys.

## Install

```bash
pnpm add @opentag/slack
```

## Exports

- `normalizeSlackAppMention`: converts a Slack app mention into an `OpenTagEvent`.
- `slackThreadKey`: encodes team, channel, and thread timestamp for callback routing.
- `parseSlackThreadKey`: decodes a Slack thread key for `chat.postMessage`.
- `SlackChannelBinding`: channel-to-repository binding contract.

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
    owner: "acme",
    repo: "demo"
  }
});

if (event) {
  // Send event to @opentag/client or your own OpenTag-compatible control plane.
}
```

## Stability

Thread key format is public because callback sinks depend on it. Change it only with a migration path.
