# Source-Thread Action Receipts

## Status

Current interaction contract for Slack and GitHub, 2026-09-04.

OpenTag presents proposed material actions in the source thread as semantic
receipts. The receipt makes the intended target, impact, capability state,
approval requirement, and safe next action visible without exposing raw
executor output or internal protocol noise.

## Authority

The source thread is a presentation surface, not the action authority. The
canonical lifecycle remains:

```text
source event -> Run -> Attempt -> action identity -> approval/grant
             -> provider call -> receipt/observation -> terminal outcome
```

The Control Plane owns action identity, idempotency, approval decisions, and
receipt persistence. The Runner performs the authorized operation. Slack and
GitHub render projections of that state. A message button, comment, process
exit, or provider response does not bypass the Control Plane lifecycle.

## Receipt shape

Every proposed action should expose:

1. A stable display index for the current source-thread presentation.
2. A semantic title describing the proposed action.
3. The target and intended scope.
4. A concise impact statement.
5. Capability/preflight state.
6. Required human decision, if any.
7. A safe next action.
8. Relevant preconditions and verification summary.
9. A link to the Run or audit record when one is available.

Internal proposal and intent identifiers may remain in the audit record, but
should not dominate the human-facing receipt.

## Action states

The presentation distinguishes these states:

| State | Meaning | Primary user action |
| --- | --- | --- |
| `ready_to_apply` | Capability and preflight permit the direct action | Review, then apply or reject |
| `needs_approval` | The action is prepared but requires a human approval record | Approve or reject |
| `needs_setup` | Setup, credentials, or preflight are incomplete | Repair setup or continue without the action |
| `unsupported` | No safe direct action path exists | Continue or reject; never imply apply |

Approval is not execution. A recorded approval authorizes the exact current
proposal and preconditions; it does not authorize a changed target, changed
branch, changed Run, or stale Attempt.

## Slack rendering

Slack should optimize for scanning and low thread noise:

- use a compact Block Kit presentation when the channel supports it;
- show one clear action per row or a small bounded action group;
- label destructive or externally visible actions explicitly;
- keep provider and target names visible;
- include a concise next step and a Run/audit link;
- do not paste full context packets, ACP frames, terminal streams, or raw
  credentials into the thread;
- send routine progress through the source-thread status policy rather than
  repeatedly posting noisy updates.

The Slack adapter renders the semantic receipt and does not decide whether the
action is authorized. It must preserve the receipt state and must not turn a
missing or ambiguous provider result into a success message.

## GitHub rendering

GitHub is the Project Target and publication/readback provider. GitHub comments
should optimize for durable review context:

- identify the repository and target artifact clearly;
- summarize the proposed publication or change;
- show required checks and their assurance level;
- distinguish reported evidence from provider-verified evidence;
- link to the Run and relevant artifacts;
- keep apply/approve/reject semantics explicit;
- avoid presenting a comment as proof that a later provider mutation happened.

GitHub readback can supply evidence to a completion gate. It does not itself
create an approval decision and does not silently retry a publication whose
provider outcome is uncertain.

## Material action and delivery boundary

Material actions require a stable idempotency key, current Run/Attempt fencing,
the exact approval or grant required by policy, and a recorded receipt. The
receipt should capture the provider-facing target, action family, result
classification, and provider observation when available.

If provider I/O was not attempted, the receipt says so. If it may have happened
but cannot be verified, the canonical state is `outcome_unknown`. The source
thread must not say “delivered”, “applied”, or “completed” merely because an
intent was queued or a local process exited successfully.

## Examples

### GitHub pull-request publication

```text
Action: Publish pull request
Target: github:acme/demo
Impact: Creates a pull request from `opentag/run-1` into `main`.
Capability: External write is withheld until approval.
Approval: Review the exact target and changed files, then approve or reject.
Next: approve 1
```

### Action blocked before provider I/O

```text
Action: Publish pull request
Status: activation blocked
Provider I/O: not attempted
Next: repair the blocking precondition; do not replay blindly.
```

### Ambiguous provider outcome

```text
Action: Publish pull request
Status: outcome_unknown
Provider observation: unavailable after request boundary
Next: inspect the provider and reconcile before retrying.
```

## Implementation rules

- Presentations consume semantic OpenTag schemas.
- Adapters do not own Run, Attempt, lease, retry, cancellation, or terminal
  state.
- A renderer must not invent provider success or hide a blocking state.
- A projection may be retried, but a material provider action must use its
  own idempotency and reconciliation contract.
- Human-facing copy should use product-native OpenTag terms and avoid raw
  provider protocol details unless needed for recovery.

## Related current documents

- [ADR 0004: Slack Persistent Presence](./adr/0004-always-on-channel-ingress-local-execution.md)
- [Control Plane runtime architecture](./control-plane-runtime-architecture.md)
- [ACP agent integration](./acp-agent-integration.md)
- [Slack platform guide](./platforms/slack.en.md)
- [GitHub platform guide](./platforms/github.en.md)
