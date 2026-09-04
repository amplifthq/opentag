# ADR 0006: Presence-first coordination with narrow effect authority

- Status: Accepted
- Date: 2026-09-05
- Decision owners: OpenTag maintainers
- Partially supersedes: ADR 0004 and ADR 0005 as described below

Implementation status: target architecture accepted; the existing
publication, material-action, and provider-delivery interfaces remain current
until their vertical replacements satisfy this ADR's acceptance gates.

## Context

OpenTag is a persistent AI teammate in Slack whose coding agent runs on one
paired, user-controlled computer. The always-on Control Plane accepts signed
Slack ingress, keeps work durably queued while the Runner is offline, and
projects truthful status back into the source thread. The Runner owns the local
checkout, worktree, ACP executor, coding-agent session, and GitHub credential.

The first Control Plane implementation preserved important failure semantics,
including idempotent admission, one canonical Run and Attempt lineage, leases,
fencing, write-before-effect, immutable receipts, late evidence, and
`outcome_unknown`. It implemented those guarantees independently for material
actions, publication, and provider delivery. The resulting interfaces expose
internal stages such as ownership, capability, claim, begin, receipt,
reconciliation, and completion to callers. The PostgreSQL schema similarly
materializes current state, operation records, begin markers, receipts,
reconciliation, projections, cursors, locks, and migration markers as separate
tables.

That shape is too broad for the supported Slack/GitHub, single-Runner profile.
It makes the Control Plane resemble a provider-specific workflow engine and
causes each new proof obligation to add another public operation and durable
entity. The Agent Presence reset also establishes a fresh-database-only
contract, so compatibility with the pre-reset schema is not a requirement.

The design must preserve the valuable guarantees without preserving the
current table-per-proof and route-per-stage implementation.

## Decision

OpenTag will use one presence-first architecture. It will not introduce
separate simple and governed modes.

The Control Plane is the canonical **Work Authority**, **Effect Policy
Authority**, and **Effect Evidence Projection Authority**. It decides whether
work or a material effect may proceed, which accepted evidence belongs to that
effect, whether a successor mutation is permitted, and what current Work and
Effect views OpenTag exposes. It does not own the transaction journal or
provider-specific execution algorithm for Runner-owned effects. The execution
side decides how to perform an authorized operation. The external provider is
the source of scoped observations about what may actually exist; a provider
response is evidence, not automatically canonical truth.

The ownership rule is:

```text
Control Plane decides may.
Executor decides how and when to perform an authorized operation.
Provider supplies scoped observations of what externally exists.
```

Scheduling an authorized operation is not authority to broaden it. In
particular, the executor cannot decide that an ambiguous mutation may be
repeated. A new mutating attempt requires current Control Plane authority.

These are three distinct authorities:

1. Policy authority decides whether an operation is permitted.
2. Transaction authority owns write-before-effect, provider I/O, and local
   recovery for that operation.
3. Evidence projection authority admits observations and derives OpenTag's
   current view.

For GitHub publication and local material effects, the paired Runner is the
transaction authority. For Slack channel projection, `ChannelProjection` in
the Control Plane is the transaction authority. The Control Plane remains the
policy and evidence projection authority for both classes.

### Three deep Modules

The supported product is expressed through three Modules with small external
interfaces.

#### WorkAuthority

`WorkAuthority` owns source admission, the durable queue, Run and Attempt
lineage, assignment, lease, fence, cancellation, approval state, and terminal
Work projection.

Its Runner-facing interface is conceptually:

```ts
interface WorkAuthority {
  claim(runner: RunnerIdentity): Promise<WorkLease | null>;
  renew(lease: WorkLease): Promise<LeaseRenewal>;
  report(evidence: WorkEvidence): Promise<WorkView>;
}
```

The interface does not expose database operations, individual lifecycle
tables, or provider delivery stages. One Work has exactly one claim owner,
Attempt-retry authority, cancellation authority, and terminal writer.
`WorkAuthority` decides whether a new Run Attempt may exist;
`EffectAuthority` separately decides whether the same logical effect may have
a successor effect attempt. A new Run Attempt cannot bypass an unresolved
material effect.

`report` accepts execution lifecycle evidence such as claimed, running,
heartbeat, proposal-produced, and executor-terminal facts. Raw material or
provider evidence enters only through `EffectAuthority.record`. After reducing
that evidence, `EffectAuthority` supplies a stable `EffectView` reference to
`WorkAuthority` through an internal seam.

#### EffectAuthority

`EffectAuthority` owns authorization and accepted-evidence projection for
material, policy-gated, non-repeatable effects and effects that may influence
Work terminal truth. Reads, reasoning, ordinary reversible local edits, and
channel rendering of an already canonical view do not enter this protocol.
Classification is determined by a closed `EffectKind` plus Control Plane
policy; the Runner cannot relabel a material action as a local edit or channel
projection.

Its external interface has three operations:

```ts
interface EffectAuthority {
  request(request: EffectRequest): Promise<EffectView>;
  acquire(executor: EffectExecutorIdentity): Promise<
    | { kind: "execute"; permit: EffectPermit }
    | { kind: "reconcile"; permit: ReconciliationPermit }
    | { kind: "none" }
  >;
  record(evidence: EffectEvidence): Promise<EffectView>;
}
```

`request` describes one desired logical effect, not its provider-specific
steps. An `EffectRequest` binds the Organization, Work, Attempt, Runner,
fencing digest, exact target, policy and approval evidence, idempotency
identity, and expiry.

`acquire` atomically revalidates current authority and records that an effect
attempt and its permit were issued before returning the execute permit. Permit
issuance means provider I/O may become possible; it does not claim that the
executor actually started that I/O. The executor separately records the actual
provider-I/O begin in its own transaction-owner journal immediately before the
call. If permit issuance committed but its response may not have reached the
executor, the next acquisition returns a reconciliation permit instead of
another mutation permit unless the original executor supplies admissible
not-started evidence.

`record` accepts evidence, not caller-selected lifecycle transitions. Evidence
is a small, closed, versioned union:

```ts
type EffectEvidence =
  | EffectNotStartedEvidence
  | EffectPresentEvidence
  | EffectAbsentEvidence
  | EffectFailedEvidence
  | EffectAmbiguousEvidence
  | OperatorAttentionAnnotation;
```

The Module validates the permit, identity, fence, target, predecessor, and
evidence digest, appends accepted evidence, and derives the current Effect
view. Callers cannot request `succeeded`, authorize a retry, or overwrite an
earlier observation directly.

`EffectNotStartedEvidence`, `EffectAbsentEvidence`, and
`EffectFailedEvidence` are not interchangeable:

- not-started evidence must come from the original transaction owner's intact
  journal and prove provider I/O never crossed its begin marker;
- absence evidence must bind provider, effect, target, operation identity,
  binding generation, observation scope, and time, and must satisfy the
  Adapter-specific evidence policy;
- failure supports a successor only when the provider conclusively proves the
  intended effect did not occur;
- an operator annotation explains attention but does not prove success,
  absence, or authorize an automatic successor. Any future break-glass release
  requires a separate accepted decision and audit contract.

The original `outcome_unknown` evidence remains immutable when a later
observation changes the derived current view.

#### ChannelProjection

`ChannelProjection` projects current Work and Presence views to Slack. It owns
one bounded, coalescing outbox and the Slack delivery Adapter. It does not own
Run state, Effect state, approval, retry authority for material effects, or
terminal completion.

Its internal interface is conceptually:

```ts
interface ChannelProjection {
  project(view: TeammateThreadView): Promise<ProjectionResult>;
}
```

A newer revision for the same Slack thread and projection key may supersede an
older revision only while that older revision is proven not to have begun.
The implementation retains unresolved ambiguous delivery and a bounded
evidence window; it does not preserve every transient presence or progress
rendering forever. Channel projection is excluded from `EffectAuthority`
because it only renders existing truth and cannot influence Work or material
Effect terminal truth.

### Execution follows credential and data custody

GitHub publication and local material actions execute on the paired Runner.
The GitHub token, checkout, Git operations, provider request construction,
readback implementation, and local crash-recovery journal remain there.

Slack source verification and channel projection execute on the Control Plane.
Slack must remain available to acknowledge durable custody and show queued,
offline, and attention states while the Runner is unavailable. Slack delivery
is a projection of canonical Work truth, not evidence that the Work succeeded.

Provider Adapters translate an `EffectPermit` or projection into external I/O
and translate provider responses/readback into evidence. They do not own Run
creation, approval, mutation retry authority, or terminal state.

### Authority matrix

| Fact or action | Authority or journal owner | Executor or evidence producer |
| --- | --- | --- |
| Slack source acceptance and deduplication | Control Plane | Slack ingress Adapter |
| Teammate identity, binding, and current Presence view | Control Plane | Derived from configuration and bounded observations |
| Work, Run, Attempt, lease, fence, cancellation, terminal state | `WorkAuthority` | Paired Runner reports lifecycle evidence |
| Exact human approval and policy decision | Control Plane | Human and policy inputs |
| Effect scope, target, idempotency identity, expiry | `EffectAuthority` | Control Plane |
| Permit issuance and permission to attempt mutation | `EffectAuthority` | Control Plane |
| GitHub or local provider-I/O begin | Runner local effect journal | Paired Runner Adapter |
| GitHub and local material mutation | Runner transaction authority | Paired Runner Adapter |
| Slack provider-I/O begin | `ChannelProjection` journal | Control Plane Slack Adapter |
| Slack channel mutation | `ChannelProjection` transaction authority | Control Plane Slack Adapter |
| External resource state | External provider or local target | Credential-holding Adapter produces a scoped observation |
| Accepted Effect evidence and current Effect view | `EffectAuthority` | Deterministic reducer |
| Permission to issue a successor mutation | `EffectAuthority` | Based on current evidence and policy |
| Timing, backoff, and read-only observation | Executing runtime | Runner or Control Plane worker |

There is no fact for which the Control Plane and Runner are both canonical
owners.

## Effect guarantees

The Control Plane Effect view is:

```text
requested
  -> authorized
  -> permit_issued
  -> succeeded | failed | outcome_unknown | attention

outcome_unknown
  -> read-only observation
  -> succeeded | retry_eligible | still_unknown
```

The Runner transaction journal for a local material or publication effect is:

```text
permit_accepted
  -> provider_io_begun
  -> succeeded | failed | outcome_unknown
```

`permit_issued` means execution became possible and therefore prevents silent
reassignment. It is not a claim that provider I/O actually began. For Slack,
the `ChannelProjection` journal records its own `provider_io_begun` before the
Slack Adapter call.

The following guarantees are mandatory:

1. A stale Attempt, fence, Runner generation, approval, target binding, or
   expired permit cannot begin a new provider mutation.
2. Control Plane permit issuance and the executor's local provider-I/O begin
   are both durably recorded before provider I/O starts. Neither record alone
   permits an ambiguous operation to be repeated.
3. Replaying the same request and semantic payload returns the same result;
   reusing an identity with a different payload fails closed.
4. Provider timeout or transport ambiguity records `outcome_unknown` and does
   not authorize automatic mutation retry.
5. A read-only observation may make a successor attempt eligible only when the
   `EffectKind` has a tested absence-evidence policy and the observation proves
   exact absence under that policy. Only `EffectAuthority` can issue the
   successor permit. Effects without such a policy remain attention or
   `outcome_unknown` and are never automatically repeated.
6. Matching evidence for an already issued permit and transaction-owner begin
   may arrive after lease expiry or Work cancellation. It updates Effect
   evidence without reviving a cancelled Work or authorizing new mutation.
7. Losing the Runner's local journal fails closed. Neither a previous permit
   nor a missing local receipt is permission to repeat provider I/O.
8. Channel projection failure or ambiguity never changes canonical Work or
   Effect truth.

## Persistence shape

The target PostgreSQL model distinguishes current authority, effect attempts,
immutable evidence, and rebuildable presentation:

```text
cp_effect
cp_effect_attempt
cp_effect_evidence
cp_publication_candidate
cp_channel_outbox
```

`cp_effect` stores one logical effect, its closed `effect_kind`, exact authority
and target digests, current derived state, and the current evidence reference.

`cp_effect_attempt` stores each authorized executor attempt, permit digest,
Runner/fence and binding generations, `permit_issued_at`, permit expiry,
execution owner, execution-owner generation, and optionally a reported begin
observation. It does not claim to be the Runner's actual provider-I/O begin
journal.

`cp_effect_evidence` stores append-only not-started, provider outcome,
reconciliation, and operator-attention evidence with predecessor and payload
digests.

`cp_publication_candidate` remains separate because a reviewable proposed
artifact has an independent product lifecycle before any external mutation.

`cp_channel_outbox` is bounded and coalescing. It is a delivery mechanism and
read model, not an immutable history of every presentation revision.

Common authority and lookup fields are explicit columns. Kind-specific
payloads may use JSONB only when they are validated by a closed, versioned
schema. The design does not permit arbitrary EAV records, unversioned provider
payloads, or speculative provider fields.

The target replaces the separate material-action, publication-operation, and
provider-delivery/projection ledgers. It must not be added beside them as a
fourth ledger.

### Runner persistence

The Runner keeps one bounded local effect journal for permits, actual
provider-I/O begin, outcome evidence awaiting acknowledgement,
not-started proof, and reconciliation-required operations. Superseded
readiness, empty polling, and acknowledged heartbeat or progress records have
explicit retention bounds. The journal owns execution recovery but does not
create a second Work or Effect authority.

## Teammate model

`Teammate` is the product identity presented in Slack. In the first supported
profile it is a projection over one active Slack binding, one registered
Runner, one Project Target, configured executor capability, and recent bounded
readiness. It is not initially a new authority aggregate or table.

Display name, avatar, and role are optional profile metadata. They do not
receive separate tables or independent lifecycle until a concrete product
behavior requires independently mutable identity, permissions, or history.

Presence remains a time-bounded read model with these user-facing states:

```text
available | queued | working | needs_attention | offline | setup_required
```

No Presence state can claim work, grant an Effect permit, cancel an Attempt,
or assert provider completion.

## Relationship to prior ADRs

This ADR preserves ADR 0004's always-on Slack ingress, one paired local Runner,
single Work owner, local repository and credential custody, derived Presence,
fencing, truthful `outcome_unknown`, projection isolation, and fresh-state
reset. It supersedes only an interpretation that provider-specific publication
claim, begin, receipt, reconciliation, and completion stages must remain
separate long-term Control Plane interfaces or tables.

This ADR preserves ADR 0005's typed Slack Adapter responsibilities and the rule
that an Adapter cannot own Run, approval, mutation-retry, or terminal
authority. It supersedes any requirement to retain a generic Source App
registry, public five-port package surface, or generic installation schema for
hypothetical future Source Apps. Slack is the only current Source App; another
Source App must first justify a real seam through a separate decision.

Provider-specific workflow stays behind the credential-holding
`LocalEffectExecutor` or `ChannelProjection` Adapter. Only a logical Effect,
permit, scoped evidence, and derived view cross the `EffectAuthority` seam.

## Alternatives considered

### Control Plane owns complete provider-specific transaction workflows

Rejected as the default. It centralizes governance but makes the Control Plane
an availability dependency for every external detail, leaks provider workflow
stages across the Runner seam, and recreates table-per-proof growth. Provider
I/O may still execute where credentials live, but provider-specific workflow
must stay behind the credential-holding `LocalEffectExecutor` or
`ChannelProjection` Adapter rather than become the public interface.

### Control Plane owns Presence only; Runner owns effects and retry

Rejected. It weakens the persistent teammate promise when the Runner is
offline, splits approval and mutation authority, and makes global terminal
truth depend on a second local owner. The Runner may schedule an authorized
operation, but it cannot decide that an ambiguous mutation may be repeated.

### Separate simple and governed modes

Rejected. Two modes would create two authority models, recovery contracts,
test matrices, and documentation paths. The single supported path keeps
ordinary work light by invoking `EffectAuthority` only for material effects.

### Preserve the current interfaces and only merge tables

Rejected. The public stages would continue to force internal persistence and
ordering details onto callers, so database complexity would quickly return.

## Migration and deletion policy

This is a compulsory replacement inside the fresh-database Agent Presence
reset. There is no compatibility adapter, dual-write period, shadow ledger, or
in-place migration from the previous schema.

Implementation proceeds in vertical replacements:

1. Implement one exact-approved GitHub draft-PR path through
   `EffectAuthority.request/acquire/record`.
2. Switch the Runner and Control Plane callers and tests to that interface.
3. Delete the old publication claim/begin/receipt/reconcile/complete interface,
   implementation, tables, and tests in the same replacement.
4. Move material-action guarantees behind the same Effect Module, then delete
   the old material ledger.
5. Replace general provider-delivery projection machinery with the bounded
   `ChannelProjection` outbox for the supported Slack Adapter.
6. Remove dead generic Source App implementations, registries, installation
   layers, SQLite delivery, migration-upgrade, schema, test, and documentation
   surfaces as their replacements become authoritative. Retain only the typed
   Slack Adapter responsibilities preserved above.
7. After the target schema stabilizes, replace the historical migration corpus
   with one reviewed fresh baseline and retain only the checksum ledger needed
   for future forward migrations.

Each replacement follows replace-not-layer discipline. Once all active
consumers cross the new interface and its acceptance tests pass, the old code
is deleted rather than deprecated.

Existing databases remain immutable recovery artifacts. The new release starts
with a separate empty PostgreSQL database and separate empty Runner state, as
required by the Agent Presence reset.

## Consequences

Positive consequences:

- The always-on Slack experience remains available when the Runner is offline.
- Checkout, Agent, and GitHub credential custody remain local.
- Work, approval, effect permission, accepted evidence, and terminal state keep
  one canonical owner.
- Publication, material actions, and provider delivery share one small
  authority interface instead of three public state machines.
- Provider-specific failure handling stays near the credential-holding Adapter.
- Rebuildable channel presentation no longer receives the same persistence
  weight as material external effects.
- Database tables and tests follow product aggregates rather than protocol
  stages.

Costs and constraints:

- A reachable Control Plane remains required before any new governed mutation
  can begin.
- The Runner needs a small local effect journal and fail-closed recovery.
- The Effect Module must resist becoming an arbitrary provider workflow engine.
- Provider observations are eventually delivered evidence, not distributed
  ACID transactions.
- Removing the existing ledgers requires replacement-level PostgreSQL,
  transport, crash-window, and provider-Adapter tests.

## Acceptance gates

The replacement is acceptable only when tests demonstrate:

1. stale fence, Runner generation, target binding, approval, and expired permit
   rejection;
2. durable permit issuance plus local provider-I/O begin before the first
   provider mutation;
3. idempotent replay and conflicting-payload rejection;
4. permit-response loss producing reconciliation or admissible not-started
   handling rather than duplicate I/O;
5. GitHub and Slack conformance fixtures recovering provider success with
   receipt-upload loss through the same operation identity and readback,
   without another mutation;
6. timeout preserving `outcome_unknown` and blocking automatic retry;
7. every `EffectKind` that permits an automatic successor defining and testing
   an Adapter-specific exact-absence policy; kinds without one never receive
   an automatic successor permit;
8. late evidence after cancellation being recorded without reviving Work;
9. Runner restart recovering the local effect journal;
10. Runner journal loss failing closed;
11. Runner-offline Slack projection of queued, offline, and attention states;
12. Slack delivery failure not changing Work truth;
13. explicit TTL or maximum-history constants for idle polling, readiness,
    heartbeat, lifecycle, completed jobs, and channel projection, with
    fake-clock tests proving row counts do not grow linearly over simulated
    days; pending, `outcome_unknown`, attention, and sole anti-replay evidence
    are excluded from ordinary garbage collection;
14. fresh PostgreSQL and SQLite schema creation from reviewed baselines;
15. zero production references to removed interfaces, tables, migrations, and
    package exports.
