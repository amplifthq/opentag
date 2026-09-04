# Slack Source App

## Supported profile

Slack is OpenTag's sole Source App. The supported deployment is a self-hosted
`paired_relay` profile:

```text
Slack Events API + Interactivity
              |
              v
     self-hosted Control Plane
              |
       one paired Runner
              |
          ACP executor
```

The Control Plane receives signed Slack events, resolves the source channel and
thread, admits work, and renders status or action receipts. The paired Runner
executes the canonical Run locally. Slack conversation state is a projection of
Run/Attempt facts; it is not an execution queue or completion authority.

GitHub is the only Project Target. A Slack request may identify a GitHub target
and may display a governed publication proposal, but Slack acknowledgement or
Agent output never performs an external write by itself.

## Slack app requirements

Configure a Slack app with:

- Events API enabled;
- an HTTPS Request URL on the self-hosted Control Plane;
- Interactivity & Shortcuts enabled, using the same Control Plane origin;
- the signing secret stored by the Control Plane, never in source messages;
- the minimum bot scopes required by the deployed Slack adapter.

The Control Plane verifies the raw Slack signature before parsing the request.
It then checks the configured route, workspace/application identity, event
deduplication key, and current binding generation before admitting a source
event. Invalid or stale events fail closed without creating a Run.

## User flow

1. Deploy the self-hosted Control Plane and its PostgreSQL database.
2. Pair exactly one Runner with the Control Plane.
3. Configure the Slack app's Events API Request URL and Interactivity URL.
4. Bind the Slack workspace/channel to the intended GitHub Project Target.
5. Invite the Slack app to the channel.
6. Mention OpenTag in a thread.
7. Review the returned status, action receipt, or attention request.
8. Approve an exact governed action only when its target and preconditions are
   correct.

Routine progress remains bounded and concise. Detailed execution evidence is
available through the Run/audit projection rather than being pasted into the
Slack thread.

## Thread and attention semantics

The adapter preserves Slack channel, message, and thread identity. Each source
event is associated with one canonical Run or with an explicit control action.
The Control Plane may project:

- accepted or running state;
- a completion or provider-evidence summary;
- an action receipt requiring approval;
- an attention-required state with a safe next action;
- cancellation, failure, or `outcome_unknown`.

A source-thread message is never proof that a provider-side effect succeeded.
When provider I/O may have happened but cannot be verified, the Run retains
`outcome_unknown` and the thread instructs the operator to reconcile before
retrying.

## Interactivity

Block Kit buttons such as **Apply**, **Approve**, **Continue**, and **Reject**
submit the same semantic action as a typed source-thread command. The
Control Plane validates the current Run, Attempt fence, proposal hash,
preconditions, and authority before applying the decision.

Duplicate clicks, stale messages, changed targets, and expired decisions must
be rejected or replayed idempotently. A button handler must not call a provider
directly or bypass the action receipt ledger.

## Credential custody

The Slack signing secret and any Slack app credentials are Control Plane
configuration. They are encrypted or protected at rest, redacted from status
and logs, and never placed in an ACP prompt. The ACP Agent must not post to
Slack directly. Source-thread delivery is performed by the governed Slack
delivery boundary using the current route and Run authority.

## Official links

- [Slack API apps](https://api.slack.com/apps)
- [Events API](https://api.slack.com/apis/events-api)
- [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack interactivity](https://api.slack.com/interactivity)
- [Slack app scopes](https://api.slack.com/scopes)

## Operational boundary

Slack configuration proves only that the Source App route is configured. It
does not prove Runner availability, ACP readiness, GitHub publication authority,
or completion evidence. Those facts come from their respective current
protocol records and provider observations.
