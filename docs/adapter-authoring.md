# Adapter Authoring

## Status

Current supported adapter boundary, 2026-09-04.

OpenTag keeps Slack provider behavior behind a narrow adapter boundary. GitHub
is a Project Target and publication/readback provider, not a second Source App.

```text
Slack event -> OpenTagEvent -> Control Plane -> Run/Attempt -> Runner
                                                   |
                                  GitHub publication/readback when governed
```

## Adapter types

| Adapter type | Purpose | Current example |
| --- | --- | --- |
| Ingress normalizer | Converts a signed Slack event into `OpenTagEvent` | `@opentag/slack` |
| Ingress app | Receives signed Slack events and calls the Control Plane | `apps/control-plane` |
| Target adapter | Resolves GitHub target and readback evidence | `@opentag/github` |
| Delivery adapter | Prepares one governed provider request | Slack delivery side-effect kernel |

Adapters translate provider shape into OpenTag contracts. They do not own Run,
Attempt, lease, approval, retry, cancellation, receipt, or completion state.

## Boundary rules

- Verify Slack signatures before parsing or admitting source events.
- Preserve stable provider event IDs, message IDs, thread keys, and target
  references.
- Normalize provider data into typed, bounded OpenTag fields.
- Keep provider credentials outside source events, prompts, logs, and durable
  presentation payloads.
- Do not choose a local checkout or Runner directly; bindings and routing own
  those decisions.
- Do not execute Agent code in an adapter; the paired Runner owns execution.
- Do not turn provider API success into completion without a provider
  observation or material-action receipt.
- Treat an ambiguous provider result as `outcome_unknown`; never blind-retry a
  material action.

## Slack ingress

Slack is the supported Source App. The ingress adapter should:

1. verify the raw request signature;
2. reject stale, malformed, or duplicate events according to the source
   delivery contract;
3. preserve channel, thread, message, actor, and application identity;
4. map the event to the bounded OpenTag context packet;
5. submit it to the Control Plane;
6. render only the semantic status or action receipt returned by OpenTag.

The adapter must not create a second task queue or decide which Runner owns a
Run. It may apply source-thread presentation policy such as concise status
updates and attention-required routing.

## GitHub target and readback

GitHub is the supported Project Target. Target adapters may:

- resolve `github:owner/repo` identity;
- identify issues, pull requests, branches, and required checks;
- prepare or publish an explicitly approved artifact;
- read back provider state and return evidence with its observed revision.

Publication is a material action. It requires current Run/Attempt fencing,
policy and approval checks, a stable idempotency key, and a receipt. Readback
is evidence and must retain its assurance level; reported state is not the same
as provider-verified state.

## ACP execution boundary

Adapters do not launch ACP processes. The paired Runner creates the Attempt,
sets the approved workspace and context, applies grants, starts the configured
ACP executor, and reports lifecycle/evidence. See [ACP agent integration](./acp-agent-integration.md).

The Agent must not receive Slack application credentials or post directly to
the Slack source thread. Any external write goes through the material-action
boundary.

## Presentation

Adapters receive semantic presentations and may render Slack Block Kit,
GitHub Markdown, or bounded plain text as appropriate. They must preserve:

- action state (`ready_to_apply`, `needs_approval`, `needs_setup`, or
  `unsupported`);
- target and impact;
- approval requirement;
- safe next action;
- receipt, evidence, or reconciliation status.

They must not expose raw ACP frames, unbounded tool traces, credentials,
internal secrets, or unsupported provider claims.

## Testing checklist

An adapter change should cover:

- signature verification before parsing and side effects;
- duplicate and stale event handling;
- stable source/thread/target identity;
- bounded malformed input and output;
- credential redaction;
- unsupported capability behavior;
- action idempotency and stale-fence rejection;
- provider timeout and `outcome_unknown` handling;
- semantic Slack/GitHub rendering without a second lifecycle authority.

## Related documents

- [Slack platform guide](./platforms/slack.en.md)
- [GitHub platform guide](./platforms/github.en.md)
- [Control Plane runtime architecture](./control-plane-runtime-architecture.md)
- [Source-thread action receipts](./source-thread-action-receipts.md)
- [Integration taxonomy](./integration-taxonomy.md)
