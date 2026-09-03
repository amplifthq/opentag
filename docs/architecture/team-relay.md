# Self-hosted team relay architecture

## Scope

The `paired_relay` profile turns a Slack engineering thread into governed local
agent work. An operator runs the relay on infrastructure they choose and pairs
one user-controlled local Runner. This is an architecture and local-contract
description, not evidence that an installation is certified, live, highly
available, or managed by OpenTag.

`local_direct` remains the trial and single-machine mode. It is
`offlineSafe=false`: its source listener, dispatcher, and Runner share one
machine and disappear together. `paired_relay` separates the relay from the
Runner fault domain, but the reference single-node profile is always
`Relay-not-HA`. It may claim `Runner-offline-safe` only after the documented
deterministic and installation certification gates pass.

## Boundaries

```text
Slack Source App
  signed Events API + interactivity requests
             |
             v
Self-hosted Control Plane
  admission, canonical lifecycle, approvals, audit, delivery intents
             |
             v
Paired local Runner
  checkout, ACP executor, local credentials, fenced Attempt execution
             |
             v
Delivery providers
  Slack presentation; optional exact-approved GitHub draft PR/check observation
```

| Boundary | Owns | Does not own |
| --- | --- | --- |
| Source App | Signature verification, provider identity/thread mapping, bounded context, presentation, provider I/O | Run/Attempt lifecycle, approval authority, execution, retry authority, or terminal settlement |
| Control Plane | Admission, one canonical Run/Attempt lineage, runner affinity, claims/leases/fences, approval records, durable audit and delivery intent state | Local checkout, coding-agent credentials, worktree, or executor process |
| Runner | Registered Project Target, local checkout/worktree, ACP executor and fenced attempt evidence | Source ingress, global lifecycle truth, provider approval, or delivery retry policy |
| Delivery provider | Provider-observed response and receipt | Run success, Attempt success, approval, or completion authority |

## Canonical lifecycle and evidence

A source request creates one canonical **Run**. Each execution episode is a
fenced **Attempt** under that Run. The Control Plane—not a Source App, Runner,
or delivery adapter—owns lifecycle transitions and terminal settlement.

Provider delivery is deliberately independent. A Slack message being accepted,
a GitHub API request returning, or a reconciliation observation occurring is
provider evidence only. It has its own delivery-intent and observation lineage;
it cannot synthesize a provider result, mutate a Run terminal state, or silently
turn `outcome_unknown` into success.

`outcome_unknown` is a truthful terminal observation when the provider outcome
cannot be established. It is not an instruction to retry. Retry exists only
where a bounded, idempotent retry authority can safely reconcile the same fact.
If cancellation wins after a material-action begin marker, the Run records the
cancellation while preserving `outcome_unknown` and its reconciliation identity.
An exact late receipt may resolve that material observation without reviving the
cancelled Run or authorizing another provider call.

## Approval and publication

The default is proposal-only. A draft pull request or other material action is
possible only when the Project Target and provider binding allow it, the
canonical proposed payload and exact target are recorded, the configured policy
authorizes it, a person gives an exact current approval through the authorized
source-thread control, and the provider result is recorded or remains explicitly
`outcome_unknown`.

An agent response, a stale approval, Slack delivery acceptance, or a guessed
provider response is never publication authority. This profile does not
auto-merge, force-push, or use blind retry to recover unknown provider outcomes.

## Operating profiles

| Profile | Source ingress | Execution | Product truth |
| --- | --- | --- | --- |
| `local_direct` | Local listener, including optional Socket Mode | Local Runner | Trial/single-machine; `offlineSafe=false` |
| `paired_relay` | Self-hosted Slack Events API + interactivity HTTPS endpoint | One paired outbound local Runner and configured ACP executor | Exact certification is separate; reference single-node relay is `Relay-not-HA` |

Slack is the supported Source App in this profile. GitHub is a Project Target
and optional publication provider, not a second source ingress. Socket Mode is
not a certified paired-relay transport. Managed service availability,
multi-Runner fallback, high availability, ambient memory, scheduled work, and
automatic merge are outside this profile.

## Recovery and visibility

The relay retains coordination and audit metadata needed to explain admission,
claims, approvals, evidence, and delivery observations. The paired Runner keeps
the local repository, worktree, coding-agent credentials, and actual execution.
Every user-visible status is a projection of durable truth; it is not a second
lifecycle owner.

Before calling an installation `Runner-offline-safe`, run the exact deterministic
and installation gates in [the deployment runbook](../control-plane-deployment.md).
A real end-to-end provider canary is separate work and must use
[the canary runbook](../testing/team-relay-canary.md) with explicit authorization.
