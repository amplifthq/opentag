# Task 4 Report: Hosted Admission Runner-Offline-Safe and Deadline-Bounded

## Outcome

Implemented the Task 4 hosted lifecycle on top of the existing
`HostedRunCoordinator`; no second Run/Attempt lifecycle or second work-loop
owner was introduced.

The coordinator now:

- admits a Run while its affined Runner is offline and projects canonical
  `queued` as `waiting_for_runner`;
- freezes source-content identity, queue deadline, permission ceiling,
  Publication Policy, Completion Contract, binding, Runner, and executor data;
- enforces the canonical Run status set only:
  `queued | assigned | running | needs_approval | succeeded | failed |
  cancelled | interrupted | timed_out`;
- enforces one immutable, finite, non-renewable `queueClaimDeadline` in schema,
  migration, claim selection, expiry reconciliation, and a database immutability
  trigger;
- atomically creates an Attempt/fence and exactly one Attempt-bound source read
  grant on a successful source-backed claim; a failed claim rolls back both;
- serializes claim/expiry, claim/deletion, cancel/claim, duplicate Admission,
  and invalidation replay through PostgreSQL row/advisory locks;
- rejects stale Attempt lifecycle/evidence authority and never revives a
  terminal or deadline-expired Run;
- allows automatic replacement only before the original deadline when durable
  material-action evidence proves no material action was recorded;
- converts started or ambiguous external effects to `outcome_unknown`, stores a
  reconciliation identity, interrupts the Run, and blocks replacement;
- serves as the sole `SourceContentInvalidationAuthority`, returning the exact
  strict immutable receipt keyed by `commandId` and replaying it exactly;
- cancels queued source-deleted Runs, interrupts live Attempts, revokes future
  read authority, and leaves terminal Runs unchanged;
- wires the generic Source ingress worker to a concrete coordinator-backed
  `SourceResolutionPort` through the existing local jobs loop. Repeated
  reservation resolution reuses one durable hosted Run; no Slack-specific
  behavior was added.

## TDD Evidence

RED was captured before production changes with real PostgreSQL:

```text
Test Files  2 failed (2)
Tests       15 failed | 2 passed (17)
```

The expected failure was strict protocol rejection of the five new immutable
Admission fields (`sourceContextEnvelope`, `queueClaimDeadline`,
`permissionCeiling`, `publicationPolicy`, `completionContract`), plus the
missing waiting projection.

GREEN focused matrix:

```text
Test Files  16 passed (16)
Tests       256 passed (256)
```

This matrix covered hosted coordinator and transport, two-client races,
source-content grants/deletion, material-action retry truth, permissions,
Source ingress, runtime composition/restart replay, migration compatibility,
schema parity, and all retained protocol/client/store/local-runtime consumers.

Final fresh serialized full suite:

```text
Test Files  216 passed (216)
Tests       2853 passed (2853)
Duration    110.92s
```

## Build and Static Verification

- `corepack pnpm typecheck` — exit 0.
- `corepack pnpm lint` — all 28 workspace projects passed.
- `corepack pnpm --filter @opentag/control-protocol build` — exit 0.
- `corepack pnpm --filter @opentag/client build` — exit 0.
- `corepack pnpm --filter @opentag/control-plane build` — server declarations
  and console Vite build passed.
- `git diff --check` — clean.

## Migration and Compatibility

Added `0007_hosted_run_offline_safe.sql`. It:

- migrates legacy `pending/claimed/completed/rejected` rows to canonical states;
- backfills every newly required immutable field for existing hosted rows;
- makes the frozen fields non-null and applies finite deadline and
  publication/completion matching constraints;
- adds queue/source indexes, Attempt grant uniqueness, and durable coordinator
  invalidation receipts;
- prevents mutation of Admission-frozen identity/deadline/policy fields with a
  PostgreSQL trigger.

The migration corpus test applies 0000–0006, inserts a legacy hosted row,
applies 0007, verifies the canonical projection/backfill, and verifies a
deadline mutation is rejected.

## Race and Lock-Order Review

- Claim and queue expiry compare one immutable deadline and have one database
  winner; `queue_claim_deadline > now` and expiry `<= now` are complementary.
- Duplicate claim operations retain the existing operation advisory lock.
- Invalidation commands now have their own tenant/command advisory lock so
  concurrent replays return one receipt rather than racing the receipt insert.
- Source withdrawal obtains its source-version advisory lock, verifies content
  without holding content row locks, invokes coordinator invalidation, then
  locks and crypto-shreds content. This preserves the coordinator Run-before-
  grant authority order and avoids the prior content-lock/Run-lock inversion
  against claim grant issuance.
- Claim creates Attempt, source grant, claim journal, Run assignment, and audit
  in one transaction. Any content/grant/audit failure rolls the whole claim
  back.
- Cancellation and deletion revoke unconsumed grants in the same coordinator
  transaction that fences/settles the Run.
- Material-action classification is centralized in the material-action module
  as `proven_not_started | started_or_ambiguous`; only the first class can be
  replaced before the original deadline.

## Scope Boundaries Preserved

- PostgreSQL remains the sole team authority.
- No provider call, publication side effect, Redis/broker/S3/new database,
  managed relay, multiple-Runner fallback, deployment, push, or UI work was
  performed.
- GitHub changes are compatibility-only for the expanded frozen Admission
  envelope; they do not certify a new GitHub source path.
- Generic Source processing remains Source-App-neutral and preserves Task 3's
  reservation idempotency and exact job lease/fence identity.
