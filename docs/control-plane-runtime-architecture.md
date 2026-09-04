# OpenTag Control Plane Runtime Architecture

## Status

Current self-hosted architecture for the supported Slack/GitHub profile,
2026-09-04. This document describes the implementation boundary and its
authority model; it does not describe a hosted OpenTag service or a future
multi-runner platform.

## Purpose

The Control Plane provides an always-on, self-hosted coordination point for
Slack source ingress and one paired local Runner. It accepts signed Slack
events, records durable lifecycle state, admits work, exposes status and
approval projections, and accepts evidence from the Runner. The Runner starts
the configured ACP executor against a local workspace or scratch area.

```text
Slack Events API / interactivity
              |
              v
      Control Plane (Hono) ---- PostgreSQL
              |
       Control V1 over HTTPS/WS
              |
          one paired Runner
              |
          ACP executor
              |
       workspace or scratch area
```

The reference deployment is a single Control Plane instance and one active
paired Runner. The Control Plane may run on operator infrastructure while the
Runner runs on a separate operator-controlled machine.

## Components

### Control Plane

The Control Plane is the durable authority for:

- authenticated Slack ingress and source-event deduplication;
- Runner registration, pairing, credential generations, and fencing;
- Run and Attempt lifecycle state;
- lease ownership, cancellation, retry decisions, and terminal writes;
- capability and permission records;
- material-action identity, idempotency, and receipts;
- provider observations and completion evidence;
- status and approval projections returned to Slack or an operator console.

The implementation uses a Node HTTP application, PostgreSQL, versioned Control
V1 contracts, and a same-origin console where configured. The Control Plane
does not receive a local repository checkout or raw executor credentials merely
because a Runner is paired.

### Runner

The paired Runner is an execution worker. It:

- authenticates to the Control Plane with its current pairing/runner
  credential;
- advertises the configured executor capability;
- claims only an admitted Run for the current lease and fencing generation;
- creates an isolated Attempt envelope;
- starts the ACP agent process with the approved context and grants;
- reports progress, material-action receipts, provider observations, and the
  final Attempt result;
- stops or recovers work according to the Control V1 lifecycle.

The Runner does not create an independent task queue or decide that a provider
side effect completed without evidence. A stale Runner or lease cannot write a
new terminal state.

### Slack Source App

Slack is the supported Source App. The adapter verifies the raw request
signature before parsing and normalizes events into OpenTag source events. It
owns provider-specific event shape, source message identity, thread keys, and
the rendering of semantic OpenTag presentations. It does not own Run,
Attempt, lease, retry, cancellation, or completion state.

### GitHub Project Target

GitHub is the supported Project Target and publication/readback provider. The
GitHub boundary may:

- identify the target repository and source work item;
- publish an explicitly authorized artifact or change;
- read back pull-request, required-check, or related evidence;
- provide provider observations used by completion gates.

GitHub is not a second Source App in this profile. Publication is an explicit
material action with a receipt and an idempotency boundary. Readback is
evidence, not an implicit approval or completion signal.

## Canonical lifecycle

```text
source event
  -> admission decision and context snapshot
  -> Run
  -> Attempt
  -> lease and fencing
  -> ACP execution
  -> action receipt / provider observation
  -> terminal completion or outcome_unknown
```

One Run owns its Attempt lineage. Exactly one authority owns claim, retry,
cancellation, and terminal writing for that Run. A process exit, HTTP success,
Slack message, GitHub readback, or Runner heartbeat is not sufficient by itself
to establish completion.

If a material provider operation may have occurred but its result cannot be
verified, the Control Plane records `outcome_unknown`. It must not silently
convert the state into success or replay the action solely because a response
was lost.

## Presence and availability

Presence is a derived read model. It may combine recent Slack ingress health,
Control Plane reachability, Runner heartbeat, pairing generation, executor
readiness, capacity, and recent lifecycle evidence. It is never a durable
`presence` table and never an authority for Run admission, lease ownership, or
provider completion.

Development may co-locate the Control Plane and Runner on one machine, but it
still uses the canonical PostgreSQL, Slack ingress, pairing, and Control V1
path. There is no embedded-dispatcher or `local_direct` compatibility runtime,
and co-location must not be described as persistent Slack availability.

## Security boundaries

- Slack signatures are verified before source-event processing.
- Runner credentials are scoped to the paired Runner and its current
  generation.
- Lease and fencing checks run before claim, heartbeat, action receipt, and
  terminal mutation.
- Provider credentials are granted only within the authorized execution
  boundary and are not copied into Run data or prompts.
- Slack and GitHub adapters receive semantic contracts rather than raw ACP
  frames or arbitrary executor state.
- Logs and status output must redact tokens, secrets, authorization headers,
  and raw provider credential material.

## Persistence

PostgreSQL is the durable store for the self-hosted Control Plane. Persisted
records describe source events, Runs, Attempts, leases, grants, actions,
receipts, evidence, and audit events. The store is not a generic presence
registry and is not a second execution queue.

The Control Plane may restart and recover its durable lifecycle. The Runner
must reconcile its current connection, lease, and Attempt state before it can
resume work. Reconciliation preserves idempotency and rejects stale placement
or fencing generations.

## Explicit non-goals

- hosted OpenTag availability or vendor-operated infrastructure;
- multiple active Runners, automatic Runner fallback, or work stealing;
- horizontal Control Plane owner routing;
- a local-direct compatibility runtime or independent availability contract;
- additional Source Apps or Project Targets;
- automatic merge, deployment, or unreviewed GitHub mutation;
- a durable presence table;
- using presence/readiness as a completion shortcut;
- storing raw repository contents, complete executor transcripts, or provider
  secrets in the Control Plane.

## Related current documents

- [ADR 0003: Node/PostgreSQL Control Plane](./adr/0003-node-postgresql-control-plane.md)
- [ADR 0004: Slack Persistent Presence](./adr/0004-always-on-channel-ingress-local-execution.md)
- [Relay security hardening](./relay-security-hardening.md)
- [Control Plane deployment](./control-plane-deployment.md)
- [ACP agent integration](./acp-agent-integration.md)
- [Source-thread action receipts](./source-thread-action-receipts.md)
