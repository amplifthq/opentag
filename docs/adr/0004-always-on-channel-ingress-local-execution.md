# ADR 0004: Slack Persistent Presence with Self-Hosted Local Execution

- Status: Accepted
- Date: 2026-09-04
- Decision owners: OpenTag maintainers

## Decision

OpenTag provides a persistent Slack presence backed by a self-hosted,
always-on Control Plane. Slack Events API and interactivity are the supported
source ingress. The Control Plane accepts and durably records source events,
routes admitted work, and exposes status and approval projections.

Execution remains on exactly one paired local Runner. The Runner is the only
component that starts the configured ACP executor, owns the local workspace or
scratch area, and reports execution evidence to the Control Plane. A deployment
may place the Control Plane on operator infrastructure and the Runner on a
separate machine, but this decision does not authorize multiple active Runners,
automatic Runner fallback, or a hosted OpenTag service.

GitHub is the only Project Target and publication/readback provider in this
profile. GitHub data may identify the target, receive an explicitly governed
publication, and supply readback evidence. Slack is the Source App; it is not a
Project Target. No other Source App, Project Target, or provider-specific
workflow is part of this decision.

## Authority model

The canonical execution model is:

```text
Slack source event
  -> admission and context snapshot
  -> Run
  -> Attempt
  -> lease and fencing
  -> executor work
  -> material-action receipt / provider observation
  -> terminal completion or outcome_unknown
```

The Control Plane is authoritative for the durable Run and its Attempt lineage,
lease/fencing state, action identity, receipts, provider observations, and
terminal outcome. The Runner is an execution worker, not a second task or
completion authority. Slack messages, Web status, and GitHub readback are
projections or evidence for that canonical lifecycle.

Every material external action has a stable action identity and idempotency
boundary. A provider timeout or ambiguous response is recorded as
`outcome_unknown`; it is never silently converted into success and never
replayed solely because the caller did not receive a response.

### Presence is derived

“Online”, “ready”, and “present” are derived observations, not a durable
presence table and not an execution authority. Presence may combine current
Slack ingress health, Control Plane health, Runner heartbeat, pairing/fencing
state, executor capability, and recent evidence. A stale or missing observation
must not mutate a Run, grant a lease, claim work, or imply provider completion.

The system must not create a second truth named `AgentPresence`, `RunnerStatus`,
or equivalent solely to support a UI badge. Persisted records belong to the
Run/Attempt/lease/receipt lifecycle or to an explicitly owned configuration
object. Presence responses are time-bounded read models.

## Deployment shape

The supported deployment is a self-hosted always-on Control Plane with one
paired Runner:

```text
Slack Events API / interactivity
              |
              v
   self-hosted Control Plane ---- PostgreSQL
              |
       paired Runner over Control V1
              |
          ACP executor
              |
       local workspace/scratch
```

The Control Plane must verify Slack request signatures before accepting source
events. Pairing, runner identity, credential generations, leases, and fencing
must be checked before a Runner can claim or mutate a Run. The Control Plane
may be restarted without creating a second Run or allowing a stale Runner to
write terminal state.

The reference deployment is single-node for the Control Plane and single-runner
for execution. High availability, horizontal owner routing, and cross-runner
work stealing require a separate architecture decision.

## Local execution boundary

The Runner keeps repository contents, ACP conversation state, executor
credentials, and local workspaces in its own execution boundary. The Control
Plane receives only the protocol fields and evidence required by the Run
contract. It must not claim to see local files or provider effects that the
Runner has not reported.

There is no separate `local_direct` product mode. Development may co-locate the
Control Plane and Runner, but it still uses the same PostgreSQL, Slack ingress,
pairing, and Control V1 path. Co-location does not provide persistent Slack
presence when that machine is unavailable and must not introduce an embedded
dispatcher or a second lifecycle implementation.

## Source and target contract

Slack ingress owns:

- signed event and interactivity verification;
- source-thread identity and deduplication;
- concise status, approval, and terminal projections;
- the human-facing route into the canonical Run.

GitHub target/publication/readback owns:

- target identity and repository metadata;
- explicitly authorized publication actions;
- required-check, pull-request, and other readback evidence;
- provider observations used by completion gates.

Neither adapter owns Run creation, Attempt claims, leases, retries,
cancellation, terminal writes, or completion assessment. Those remain under the
canonical Control Plane and Runner protocol.

## Non-goals

This decision does not include:

- a hosted or vendor-operated OpenTag service;
- a local-direct compatibility runtime or second availability contract;
- multiple active Runners, automatic fallback, or scheduler-level work
  stealing;
- a general-purpose multi-provider chat gateway;
- retired platform adapters and provider-specific integration tables;
- a general multi-item orchestration layer;
- a durable presence table or presence-based execution authority;
- automatic merge, deployment, or unreviewed GitHub mutation;
- copying raw repository contents, full tool traces, or provider credentials
  into the Control Plane;
- treating a Slack message, Runner heartbeat, HTTP 202, process exit, or
  provider API response by itself as completion evidence.

## Rationale and deletion boundary

The decision narrows the product to one durable user-facing presence and one
unambiguous execution path. Legacy platform tables, OAuth state, adapters,
ports, and presentation branches were removed because they described providers
that are not part of the supported Slack/GitHub profile. The former broad
orchestration documents were removed because they introduced a second product
scope and authority model without a current supported execution path.

Removing those surfaces is intentional. New providers, additional Runners,
hosted availability or broader orchestration require a new decision that names
their authority, evidence, migration, and failure semantics before code or
documentation is added.

## Consequences

Positive consequences:

- Slack presence has one supported ingress and one clear operator deployment.
- Run/Attempt/lease/receipt ownership remains easy to audit.
- GitHub publication and readback stay explicit and bounded.
- Provider and platform breadth cannot silently create parallel state machines.
- Availability language is separated from local process reachability.

Costs:

- A single paired Runner limits capacity and fault tolerance.
- The Control Plane must remain available even when no Run is executing.
- Additional platforms or execution workers need a fresh authority decision.
- Some previously documented experimental APIs disappear without compatibility
  shims, as explicitly authorized for this reset.

## Verification expectation

Implementations claiming conformance to this ADR must demonstrate, at minimum:

1. Slack signature verification and source-event deduplication.
2. One paired Runner identity with stale-generation rejection.
3. Durable Run and Attempt transitions with lease/fencing checks.
4. Material-action receipts and provider observations that preserve
   `outcome_unknown`.
5. Slack status as a projection of canonical lifecycle state.
6. GitHub publication/readback constrained to the explicit target contract.
7. No presence table and no readiness-to-completion shortcut.
