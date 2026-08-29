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

## Fix Round 1/5 — Critical and Important Review Findings

Base: `80207419 feat: admit finite work while the Runner is offline`.

### Fixed findings

1. **Executor completion mapping**
   - Added explicit six-way mapping:
     `success -> succeeded`, `failure -> failed`, `cancelled -> cancelled`,
     `interrupted -> interrupted`, `timed_out -> timed_out`, and
     `needs_human -> needs_approval`.
   - `needs_human` is nonterminal and projects only
     `waiting_for_approval`; proposal/review readiness is emitted only for
     terminal `succeeded` Runs.
   - Extended Attempt state constraints for `needs_approval`, `interrupted`,
     and `timed_out` and tested every conclusion.

2. **Material-action negative truth**
   - Absence of a material receipt now fails closed as
     `started_or_ambiguous`, with a stable reconciliation identity and
     `outcome_unknown`.
   - Added `cp_material_action_non_start_proof` and an authenticated
     Attempt/fence-bound Control V1 proof endpoint.
   - Replacement is possible only when that durable negative-start proof
     exists and the original deadline remains open. A start/crash before any
     receipt now interrupts and blocks replacement.

3. **Permission ceiling and Publication mode**
   - Request and `allow_once` resolution both recheck the current Run/Attempt
     under lock against Admission-frozen `permissionCeiling.allowedActions`,
     policy snapshot identity, and `publication_mode`.
   - `proposal_only` rejects pull-request/publication permissions even if a
     human attempts to approve them.
   - Added request-time rejection and approval-time tampering/stale-policy
     regressions.

4. **Reconciliation lock order**
   - Replaced the Attempt-first bulk update with a bounded batch of at most
     100 Runs locked deterministically by organization/Run, followed by each
     exact current Attempt lock.
   - The two-client RED reproduced PostgreSQL `40P01 deadlock detected`; the
     same barrier is GREEN with Run-to-Attempt ordering.

5. **Atomic invalidation transaction**
   - Added the transaction-aware invalidation authority method and passed the
     custody transaction client into the coordinator.
   - Withdrawal, Run/Attempt fencing, grant revocation, immutable authority
     receipt, crypto-shredding, and tombstone persistence now commit or roll
     back through one PostgreSQL transaction. Content custody still does not
     import or write hosted Run state.
   - A `poolMax=1` regression with eight concurrent same-command withdrawals
     proves no nested-transaction pool starvation and exact receipt replay.

6. **Mandatory exact grant authority**
   - Every source-backed claim now requires one Attempt/fence/content/purpose/
     expiry-bound grant; custody or content unavailability rolls back the
     Attempt, grant, claim journal, and assignment.
   - Claim responses include the exact grant descriptor and token. Stored
     claim/grant rows contain only the token hash and key version, never the
     plaintext token.
   - Tokens are deterministically derived using a purpose-separated HKDF
     subkey and HMAC bound to KEK key version plus the complete authority
     tuple. Replay reconstructs the same token after verifying the stored hash.
   - Added zero/one/rollback/replay, key-version separation, one-time read, and
     retained Control V1 consumer coverage.

7. **Real runtime restart proof**
   - Replaced direct fake `SourceResolutionPort` calls with a real Source App
     installation/binding, encrypted reservation, durable job, runtime worker
     processing, runtime recreation, and post-restart empty poll.
   - Added durable two-phase reservation-idempotency admission state. A crash
     before Admission or after Admission but before decision persistence can
     resume safely; a changed physical request cannot create a second Run.
   - The test proves one hosted Run, one Source resolution, one durable
     idempotency record, and a succeeded Source job after restart.

### Fix-round TDD evidence

- Completion/material RED: `8 failed | 13 passed`; failures showed every
  non-success conclusion incorrectly becoming `succeeded` and absence of a
  receipt incorrectly proving no start.
- Permission RED: proposal-only pull-request permission returned `waiting`
  instead of `conflict`.
- Lock-order RED: the two-client barrier produced PostgreSQL error `40P01`
  with the old Attempt-first reconciliation update.
- Focused final GREEN: `19 test files / 258 tests passed` against real
  PostgreSQL, covering hosted/races/control-v1/grants/permissions/runtime/
  source deletion/material/migration/schema plus retained consumers.
- Fresh serialized full suite: `216 test files / 2864 tests passed` in
  `104.55s` with one worker and PostgreSQL required.
- `corepack pnpm typecheck`: passed.
- Workspace lint across 28 projects: passed.
- `@opentag/control-protocol`, `@opentag/client`, and
  `@opentag/control-plane` builds: passed.
- `git diff --check`: clean.

## Fix Round 2/5 — State, Proof, Taxonomy, and Legacy Replay

Base: `83108c5f fix: harden offline hosted authority boundaries`.

### Fixed findings

1. **Completion/approval state-machine bypass**
   - Executor conclusions now use unambiguous Attempt states:
     `succeeded`, `failed`, `cancelled`, `interrupted`, `timed_out`, and
     `needs_approval`. `rejected` is reserved exclusively for `reject-start`.
   - Under the existing Run→Attempt locks, a `needs_approval` Attempt accepts
     heartbeat/cancellation only. Direct Runner `running` or successful
     completion is rejected as `invalid_transition`.
   - Exact current Attempt/fence and immutable policy-bound `allow_once`
     evidence atomically moves both Run and Attempt back to `running`.
     An exact denial atomically settles Attempt/Run as `failed` with the
     permission-resolution receipt and `permission_denied` reason.
   - Regressions cover all six conclusions, bypass attempts, tampered/wrong
     approval, exact resume then success, exact denial, and reject-start-only
     `rejected` state.

2. **Negative-proof replacement bypass**
   - Added `material_start_state` to the exact Attempt:
     `open | proven_not_started | started_or_ambiguous`.
   - Recording a negative-start proof locks the current Run/Attempt, requires
     the exact current fence while authority is still `open`, persists the
     proof, and atomically closes start authority as `proven_not_started`.
   - Recording the first material receipt atomically closes authority as
     `started_or_ambiguous`; proof-then-start is rejected, while an append-only
     reconciliation receipt chain remains allowed after start.
   - Expired-Attempt claim SQL now requires the exact current Attempt number,
     ID, fence digest, `proven_not_started` state, and matching durable proof.
     Absence/unknown can no longer claim directly before reconciliation.
   - Regressions cover direct claim before reconciliation, start/crash without
     receipt, proof-then-start, stale proof, concurrent proof/claim, and safe
     replacement only after proof plus lease expiry.

3. **Closed publication capability taxonomy**
   - Added a shared closed `HostedActionCapabilityV1` taxonomy used by both
     Admission permission ceilings and Runner permission requests/receipts.
   - Non-publication capabilities are explicit (`workspace.read`,
     `workspace.write`, `command.execute`, `git.read`). Publication-capable
     entries explicitly cover git push/force-push/target write, GitHub pull
     request create/update/merge, release creation, and branch deletion.
   - `proposal_only` checks the typed capability set at both request and
     `allow_once`; no regex or action-family naming heuristic remains.
     Unknown/future capability values fail schema validation closed.
   - The local Control V1 adapter performs an exact closed mapping from known
     operations and throws `permission_action_capability_unknown` otherwise.
   - Regressions cover merge, push, force-push, target write, PR create/update,
     release, branch deletion, unknown future actions, and a valid
     non-publication workspace action.

4. **Legacy persisted claim replay**
   - Added explicit `claim_version` migration/schema support. Pre-0007 claims
     backfill as version 1; every new claim is persisted as version 2.
   - Version-1 replay never parses the current strict claim schema, fabricates
     a grant/token, or attempts replacement. Under Run→Attempt locks it fences
     the legacy Attempt, revokes future grants, and settles the Run as
     controlled `interrupted + outcome_unknown` with a stable reconciliation
     identity and `legacy_claim_authority_unrecoverable` reason.
   - The coordinator/application return typed `legacy_interrupted` state on
     exact replay. Current version-2 replay continues to reconstruct and
     verify the exact deterministic grant token.
   - Migration coverage inserts a pre-fix claim before 0007 and proves it is
     version 1; coordinator coverage replays that row without a Zod exception.

### Round-2 TDD and verification evidence

- Initial real-PostgreSQL RED: `6 failed | 23 passed` across the amended
  hosted/race/permission tests. Failures showed direct approval bypass,
  no-proof replacement, missing `claim_version`, unrecognized typed
  capability, and ambiguous `completed/rejected` Attempt states.
- Serial amended focused suite: `17 test files / 249 tests passed`; the final
  reject-start-exclusive focused file passed `22/22`.
- Fresh serialized full suite: `216 test files / 2869 tests passed` in
  `103.32s` with one worker and PostgreSQL required.
- `corepack pnpm typecheck`: passed.
- Workspace lint across 28 projects: passed.
- `@opentag/control-protocol`, `@opentag/client`, and
  `@opentag/control-plane` builds: passed.
- `git diff --check`: clean.

## Fix Round 3/5 — Exact Approval, Begin CAS, Canonical Descriptor, and Global Containment

Base: `fff0e4a1 fix: close hosted approval and replay bypasses`.

### Fixed findings

1. **Exact `needs_approval` linkage and bounded expiry**
   - A `needs_human` executor result is no longer self-authorizing. The request
     must identify exactly one current `waiting` permission request for the
     same Run, Attempt number/ID, fencing-token digest, canonical action
     descriptor digest, and immutable policy snapshot digest.
   - The coordinator persists `blocked_permission_request_id`,
     `blocked_action_descriptor_digest`, and
     `blocked_policy_snapshot_digest` on the exact Attempt. Database checks
     require all three fields only while the Attempt is `needs_approval`.
   - Resume or denial requires the matching durable permission-resolution
     evidence under the same Run→Attempt locks. Unrelated, stale, wrong-action,
     wrong-policy, or wrong-fence decisions cannot resume the blocked Attempt.
   - Approval-pending Attempts participate in reconciliation. Lease expiry
     clears blocked linkage, revokes the pending permission, interrupts with
     `outcome_unknown`, and cannot be replaced without an exact negative-start
     proof. A proof winner instead revokes the permission and safely moves the
     Run into replacement eligibility.

2. **Server-authoritative material begin/proof CAS**
   - Added `cp_material_action_begin_intent` and an authenticated Control V1
     begin endpoint/client operation. The begin tuple binds organization, Run,
     Attempt ID/number, fence digest, canonical action descriptor/digest, and
     idempotency key.
   - Before provider execution, the trusted local Control V1 adapter now calls
     begin after exact permission authorization. Begin atomically CASes
     `material_start_state: open -> started_or_ambiguous`.
   - Negative proof is guarded by a PostgreSQL trigger. Under the exact Attempt
     lock it can win only when state is `open` and no begin intent or material
     receipt exists. Its single transaction changes state to
     `proven_not_started`, expires/fences the old Attempt, clears approval
     linkage, revokes its content grant and waiting permissions, and moves the
     Run to safe replacement eligibility.
   - Every lifecycle, permission, begin, receipt, and claim gate observes the
     same material-start state. Proof-vs-begin has one database winner;
     proof-then-lifecycle/permission/begin is stale.
   - Evidence arriving after proof is never discarded. It is appended to the
     evidence tables and atomically changes the Run to controlled
     `interrupted + outcome_unknown` with a reconciliation identity and
     `late_material_evidence_after_non_start_proof` reason.

3. **One canonical action descriptor**
   - Removed independently self-labelled `actionFamily`, permission scope, and
     capability fields from permission authority. Permission requests and
     receipts now carry one closed `PermissionActionDescriptor` plus its
     canonical digest.
   - Admission freezes an exact sorted descriptor allow-list and a digest of
     that list. The coordinator verifies the ceiling digest during Admission.
   - The descriptor enum inseparably defines operation and publication
     semantics for workspace read/write, command execution, git read/push/
     force-push/target-write, GitHub pull-request create/update/merge, release
     creation, and branch deletion.
   - Request and `allow_once` validate the same descriptor/digest against the
     Admission ceiling. `proposal_only` rejects every publication descriptor.
     Legacy field combinations, mismatched descriptors/digests, and unknown
     future values fail strict schema or coordinator validation.
   - The trusted local adapter uses an exact closed operation-to-descriptor
     mapping; there is no regex classification or permissive fallback.

4. **Global version-1 claim containment**
   - Migration 0007 now contains every persisted `claim_version = 1` Run,
     fences the exact referenced Attempt when present, revokes future grant
     authority, and stores controlled `interrupted + outcome_unknown`
     reconciliation state.
   - Every hosted claim poll performs global tenant/Runner containment before
     operation replay or candidate selection. Candidate SQL independently
     excludes any Run referenced by a version-1 claim, so a different
     operation ID cannot bypass containment.
   - Missing legacy Attempts still contain the Run. Exact legacy replay returns
     typed controlled state without parsing the modern claim schema or
     fabricating a grant/token. A stale legacy replay whose Run already has a
     later Attempt fences only the exact old Attempt and does not modify the
     later Attempt or current Run.
   - Current version-2 replay remains unchanged and verifies/reconstructs the
     exact deterministic grant.

5. **Material-truth migration dominance and database invariant**
   - Migration backfill computes `material_start_state` with strict priority:
     receipt or begin evidence -> `started_or_ambiguous`; exact matching proof
     and no evidence -> `proven_not_started`; neither -> `open`.
   - The migration corpus includes receipt-only, proof-only, both, and missing
     cases; receipt evidence dominates proof.
   - The proof trigger prevents proof from overriding committed begin/receipt
     evidence even under concurrent clients. Exact replay repairs an `open`
     state only when no evidence exists; otherwise it fails closed.

### Round-3 TDD and verification evidence

- Initial amended RED covered missing waiting-request linkage, proof/begin
  authority gaps, legacy descriptor combinations, global v1 bypass, and
  incomplete migration truth.
- Real-PostgreSQL proof/begin and approval races were exercised with separate
  clients, including proof-vs-begin, proof-vs-claim, proof-then-lifecycle,
  proof-then-begin, late evidence, approval proof/replacement, and
  approval-pending expiry without proof.
- Final serial focused matrix: `18 test files / 266 tests passed`.
- Fresh serialized full suite: `216 test files / 2874 tests passed` in
  `107.52s` with one worker and PostgreSQL required.
- `corepack pnpm typecheck`: passed.
- Workspace lint across 28 projects: passed.
- `@opentag/control-protocol`, `@opentag/client`, and
  `@opentag/control-plane` builds: passed.
- `git diff --check`: clean.
