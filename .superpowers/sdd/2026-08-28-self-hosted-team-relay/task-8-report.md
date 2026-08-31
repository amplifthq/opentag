# Task 8 Report — Proposal-Ready Default Completion Contract

## Status

Implemented and verified. Executor success is now an intermediate Attempt fact, not Run completion. A proposal-only Run reaches terminal `succeeded/proposal_ready` only after Governance accepts a complete immutable PublicationCandidate with verification and no unresolved material outcome. A pull-request Run with the same Candidate remains canonical `running` with `publication_pending` projection.

## Implementation

- Added strict `PublicationCandidate` and proposal-readiness assessment schemas, including canonical sorted/unique identity arrays.
- Added Governance evaluation for executor success, candidate presence, verification presence, Admission-frozen policy/contract identity, and unresolved material outcomes.
- Added truthful source-thread proposal presentation with Candidate identity, changed files, verification, limitations, exact next action, and explicit absence of branch/PR/check/review/merge/deployment claims.
- Added the dispatcher-to-Governance assessment seam; the dispatcher does not invent readiness.
- Added immutable, content-free PostgreSQL PublicationCandidate storage with exact replay/conflict handling, uniqueness by Run/Attempt, content checks, and an UPDATE/DELETE rejection trigger.
- Added schema bootstrap/readiness and Drizzle semantic parity for `cp_publication_candidate`.
- Changed hosted executor `success` handling so the Attempt becomes `succeeded` while the Run stays `running`.
- Added coordinator-owned `settleProposalCandidate`, which consumes validated Task 7 evidence identities, verifies Run/Attempt/fence/workspace/base/tree/target/policy bindings, derives the Candidate inside the locked PostgreSQL transaction, persists it, and writes the only allowed Run terminal transition.
- Proposal-only accepted assessment atomically stores Candidate and terminal settlement. Pull-request assessment stores Candidate and leaves the Run nonterminal `running/publication_pending`.
- Material/external unknown remains a Governance blocker; no delivery or provider state is inferred.

## Strict TDD Evidence

### RED

Command:

```text
corepack pnpm vitest run packages/governance/test/evaluate.test.ts apps/control-plane/test/publication-candidates.postgres.test.ts apps/control-plane/test/hosted-coordinator.postgres.test.ts
```

Observed expected RED:

```text
Test Files 2 failed | 1 skipped (3)
Tests 3 failed | 14 passed | 26 skipped (43)
Governance failures: evaluateProposalReadiness is not a function
PostgreSQL suite failure: publication-candidates module does not exist
```

The failures were caused by the absent Task 8 governance and persistence seams, not test syntax or fixture errors.

### GREEN

Focused Governance:

```text
corepack pnpm vitest run packages/governance/test/evaluate.test.ts
Test Files 1 passed (1)
Tests 18 passed (18)
```

Full relevant Governance/PostgreSQL verification:

```text
OPENTAG_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/opentag_control_plane_test \
  corepack pnpm vitest run packages/governance/test \
  apps/control-plane/test/publication-candidates.postgres.test.ts \
  apps/control-plane/test/hosted-coordinator.postgres.test.ts \
  apps/control-plane/test/material-actions.postgres.test.ts \
  apps/control-plane/test/schema-parity.postgres.test.ts \
  apps/control-plane/test/migrations.postgres.test.ts
Test Files 10 passed (10)
Tests 81 passed (81)
```

Final hosted replay/presentation regression:

```text
OPENTAG_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/opentag_control_plane_test \
  corepack pnpm vitest run apps/control-plane/test/hosted-coordinator.postgres.test.ts \
  packages/governance/test/evaluate.test.ts
Test Files 2 passed (2)
Tests 46 passed (46)
```

The PostgreSQL fixture created isolated disposable schemas and closed/dropped them after each suite. The already-running local PostgreSQL service was not started or mutated outside those schemas.

## Build, Typecheck, and Lint

```text
corepack pnpm typecheck
exit 0

corepack pnpm lint
29 workspace projects linted; exit 0

corepack pnpm --filter @opentag/control-protocol build
exit 0
corepack pnpm --filter @opentag/core build
exit 0
corepack pnpm --filter @opentag/governance build
exit 0
corepack pnpm --filter @opentag/dispatcher build
exit 0
corepack pnpm --filter @opentag/control-plane build
server and console builds exit 0

git diff --check
exit 0
```

## Files

- `packages/core/src/schema.ts` — PublicationCandidate and proposal-readiness schemas/types.
- `packages/core/src/presentation.ts` — truthful proposal-ready presentation and rendering.
- `packages/control-protocol/src/completion.ts` — proposal-readiness state/reason/assessment contract.
- `packages/governance/src/evaluate.ts` — sole proposal-readiness evaluator.
- `packages/governance/test/evaluate.test.ts` — executor-only, verification, unknown outcome, policy/contract, pull-request, malformed identity, and presentation tests.
- `packages/dispatcher/src/completion-governance.ts` — dispatcher delegation to Governance.
- `apps/control-plane/src/modules/publication-candidates/schema.ts` — Drizzle schema.
- `apps/control-plane/src/modules/publication-candidates/index.ts` — immutable PostgreSQL repository and replay/conflict behavior.
- `apps/control-plane/src/database/schema.ts` — schema export.
- `apps/control-plane/src/database/migrations.ts` — candidate table/trigger bootstrap and readiness.
- `apps/control-plane/src/modules/hosted-runs/index.ts` — nonterminal executor success plus coordinator-owned atomic Candidate settlement.
- `apps/control-plane/test/publication-candidates.postgres.test.ts` — real PostgreSQL immutability/content/replay/conflict tests.
- `apps/control-plane/test/hosted-coordinator.postgres.test.ts` — atomic settlement, exact replay, fence/identity, and truthful projection tests.

## Self-Review

- Candidate persistence contains identities only; it excludes the binary diff, logs, output, paths, limitations, and secrets.
- Candidate arrays are canonical and immutable; direct database mutation/deletion is rejected.
- The coordinator derives Candidate fields from validated evidence and locked Admission/Attempt state rather than accepting a Runner-authored readiness claim.
- Executor success, proposal readiness, publication readiness, and provider delivery remain separate facts.
- `proposal_only` cannot be upgraded to `pull_request`; stored Admission policy and completion mode are checked.
- No code claims branch/PR/check/review/merge/deployment facts without evidence.
- No push, publish, deploy, provider, or delivery call was made.
- Diff whitespace and credential-pattern scans were clean.

## Concerns / Follow-Up Boundary

- Task 9 remains responsible for Publication Intent/Receipt and exact provider evidence. Task 8 deliberately leaves `pull_request` Runs at `running/publication_pending`.
- The candidate schema bootstrap is implemented in the declared `database/migrations.ts` surface so the Task 8 exact staging list remains intact; readiness now explicitly fails if the candidate table is absent.

## Fix Round 1

### Review Findings Closed

1. **Coordinator authority** — `settleProposalCandidate` no longer accepts or trusts a caller assessment or separate identity fields. It validates the complete Task 7 artifact and canonical artifact/evidence/diff/changed-files digests, binds the artifact digest to the stored successful executor lifecycle receipt, derives the Candidate under locked Run/Attempt/fence state, checks frozen Admission mode/contract/policy, classifies current material-action truth, includes durable Run `outcome_unknown`, invokes the shared Governance reducer, and persists only that returned assessment. Candidate `createdAt` and assessment `assessedAt` come from the coordinator clock.
2. **Transaction and replay authority** — the public Pool-backed Candidate `put` surface was removed. Mutation is available only to a real coordinator transaction. The table now binds `(organization_id, run_id, attempt_number)` to the exact hosted Attempt. Concurrent identical settlement deterministically yields one `created` and one `replayed`; conflicting evidence/assessment fails closed. Exact replay returns the durable Candidate/projection without rewriting Run receipt or `updated_at`.
3. **Versioned schema/readiness** — removed unversioned post-migration DDL. Added checked-in `0013_publication_candidates.sql`, including upgrade handling, exact Attempt FK, checks/index, assessment persistence, and immutable UPDATE/DELETE trigger. Readiness now verifies migration checksum plus indispensable columns, named constraints, index, schema-local function body, and enabled trigger. Fresh, 0012→0013 upgrade, checksum, partial-trigger, and schema-parity tests pass.
4. **Nonterminal presentation** — unified Candidate presentation now has exact `publication_candidate` kind with `proposal_ready | publication_pending` state. `proposal_ready` remains terminal; `publication_pending` is attention-required/nonterminal and explicitly says exact approval/publication evidence remains required while claiming no branch/PR/check/review/merge/deployment fact.

### RED Evidence

Initial focused command:

```text
corepack pnpm vitest run apps/control-plane/test/migrations.test.ts \
  packages/governance/test/evaluate.test.ts \
  apps/control-plane/test/publication-candidates.postgres.test.ts \
  apps/control-plane/test/hosted-coordinator.postgres.test.ts \
  apps/control-plane/test/migrations.postgres.test.ts
```

Observed defects:

```text
Unit: 4 failed — missing 0013, unversioned bootstrap extra query,
partial readiness false-positive, missing publication-candidate presentation.
PostgreSQL: 5 failed — public put/orphan path, missing 0013,
dropped trigger reported ready, coordinator crashed on authoritative artifact input.
```

The subsequent complete Control Plane run exposed one directly affected stale assertion in `permissions.postgres.test.ts`: it expected bare executor success to terminally succeed. The authorized one-line expectation now proves the Run remains `running` until Candidate Governance.

### GREEN Evidence

```text
Focused migration/Governance presentation: 2 files, 25/25 tests passed.
Focused PostgreSQL authority/migration/material/schema: 5 files, 39/39 tests passed.
Complete Control Plane: 36 files, 228/228 tests passed.
Core presentation/channel + Governance + migration unit: 8 files, 74/74 tests passed.
Root typecheck: exit 0.
Root lint: 29 workspace projects, exit 0.
Control-protocol, Core, Governance, Dispatcher, Control Plane builds: exit 0.
```

All PostgreSQL suites used isolated temporary schemas that were closed and dropped by the fixture. No PostgreSQL server was started by this task, so no task-owned server process remained to stop.

### Fix-Round Scope Expansion

- Added the explicitly authorized checked-in migration `apps/control-plane/migrations/0013_publication_candidates.sql`.
- Updated `apps/control-plane/test/permissions.postgres.test.ts` only at the stale bare-success assertion, with parent authorization, to preserve the Task 8 nonterminal executor-success contract.
- Updated `apps/control-plane/src/modules/hosted-runs/material-actions.ts` only to classify a succeeded, locked Attempt with no begin Intent or receipt as proven not started; running/open attempts remain ambiguous.
- With parent authorization, added the minimal literal `@opentag/governance` Control Plane workspace dependency/reference in `apps/control-plane/package.json`, `apps/control-plane/tsconfig.json`, and `pnpm-lock.yaml`. Core retains vocabulary/schema and complete Task 7 artifact validation; `packages/governance` remains the sole pure proposal-readiness evaluator invoked by both Dispatcher and HostedRunCoordinator.

### Remaining Boundary

- The earlier concern about unversioned schema bootstrap is resolved by checked-in migration 0013 and exact readiness validation.
- Task 9 remains the sole owner of remote publication intents/receipts and provider evidence. No push, publish, deploy, delivery, or provider operation occurred in this fix round.

## Fix Round 2

### Findings Closed

1. **Exact Attempt binding and coordinator-only mutation**
   - Added `cp_hosted_attempt_exact_identity_key` over `(organization_id, run_id, attempt_number, attempt_id)` and changed `cp_publication_candidate_attempt_fk` to reference all four columns.
   - Removed the exported generic Candidate mutation and transaction-lock read helpers from the publication-candidates module. Its normal public surface is read-only.
   - Moved Candidate mutation into private HostedRunCoordinator functions. The write is an `INSERT ... SELECT` from the already locked current Run/Attempt and requires exact current Attempt number/id, `succeeded` Attempt state, and matching Candidate/assessment JSON identities inside the SQL statement.
   - Exact concurrent settlement continues to yield one `created` and one `replayed`; conflicts remain fail-closed; exact replay returns before Run/receipt/assessment mutation.

2. **Actual unversioned 0013 upgrade and definition-level readiness**
   - The migration now drops the b1f954dd immutable trigger before ALTER/backfill.
   - It backfills `attempt_number` only through an exact Organization/Run/Attempt-id join.
   - It reconciles `completion_assessment` only from an already durable matching proposal-only terminal receipt whose policy, Candidate id, state, acceptance, and reason are exact. No remote or new acceptance fact is invented.
   - Any unsupported/orphan/ambiguous existing row aborts with stable `publication_candidate_upgrade_reconciliation_required` for operator reconciliation.
   - The migration normalizes the legacy auto-named unique constraint, creates the exact hosted Attempt unique key and four-column Candidate FK, and recreates the immutable function/trigger after reconciliation.
   - Readiness now checks exact column count, types, NOT NULL state, absence of defaults, primary/unique/FK source and target column arrays, hosted Attempt exact key, every indispensable check expression, nonunique unpredicated index columns, schema-local function language/return/security/volatility/body, and enabled row-level BEFORE UPDATE/DELETE trigger bound to that function.

### RED Evidence

Command:

```text
OPENTAG_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/opentag_control_plane_test \
  corepack pnpm vitest run \
  apps/control-plane/test/publication-candidates.postgres.test.ts \
  apps/control-plane/test/hosted-coordinator.postgres.test.ts \
  apps/control-plane/test/migrations.postgres.test.ts
```

Observed RED:

```text
Test Files 3 failed (3)
Tests 9 failed | 35 passed (44)
- wrong attempt id / valid number and valid id / wrong number both fulfilled
- generic persistPublicationCandidateInTransaction remained exported
- actual b1f954dd row upgrade failed with publication_candidate_immutable
- altered FK, check body, nullability, column type, index columns, and trigger event all reported ready
```

The first faithful upgrade run initially exposed a fixture-only parameterized multi-statement limitation. After splitting the two setup updates, the required production RED was observed exactly as `publication_candidate_immutable` before migration changes.

### GREEN Evidence

```text
Focused Candidate/coordinator/migration/schema suite: 4 files, 46/46 tests passed,
including unsupported unversioned reconciliation with the stable reason.
Complete Control Plane: 36 files, 238/238 tests passed.
Root typecheck: exit 0.
Root lint: 29 workspace projects, exit 0.
Control-protocol, Core, Governance, Dispatcher, Control Plane builds: exit 0.
git diff --check: exit 0.
```

All PostgreSQL tests used isolated temporary schemas and dropped them during fixture cleanup. The task did not start a PostgreSQL server, so no task-owned database process remained to stop.

### Remaining Boundary

- No migration reconciliation ambiguity remains for durably accepted b1f954dd proposal-only rows; the exact fixture is preserved and becomes ready.
- Unsupported historical row/state combinations intentionally require operator reconciliation and are never silently accepted or deleted.
- Task 9 remains the only owner of remote publication facts. No provider, delivery, push, publish, or deploy operation was performed.

## Fix Round 3

### Finding Closed

1. **Exact definition-level catalog readiness**
   - Every indispensable Candidate CHECK is compared against its complete whitespace-normalized `pg_get_constraintdef`, not token presence. Readiness also requires `convalidated = true` and `connoinherit = false`.
   - Both Candidate FKs require the exact relation and ordered source/target column arrays, `MATCH SIMPLE`, `NO ACTION` on update/delete, validated state, and nondeferrable/immediate state.
   - The immutable trigger now requires the exact enabled row-level BEFORE DELETE OR UPDATE event mask, `tgqual IS NULL`, zero arguments, the schema-local intended function, and canonical normalized `pg_get_triggerdef` semantics. Function language, trigger return type, argument count, security-definer/leakproof/volatility flags, and exact normalized body remain checked.
   - Token-preserving `OR true`, NOT VALID FK/CHECK, cascading/deferred/MATCH FULL FK, NO INHERIT CHECK, conditional trigger, and argumented trigger all fail readiness.

2. **Strict historical assessment reconciliation**
   - 0013 now reconciles only an exact five-key assessment object: `state`, boolean `accepted`, `candidateId`, singleton ordered `reasonCodes`, and `assessedAt`.
   - `state = proposal_ready`, boolean `accepted = true`, exact Candidate id, and exactly `["proposal_ready"]` are required.
   - A migration-local immutable strict timestamp validator enforces real canonical UTC millisecond timestamps with an exception-safe round trip; it is dropped after reconciliation and does not become runtime schema.
   - The historical Candidate JSON must be an exact eleven-key object and every identity/digest/array/timestamp must equal the durable Candidate columns.
   - Missing or invalid `assessedAt`, an extra key, wrong acceptance type, duplicate/noncanonical reasons, and Candidate mismatch remain unreconciled and trigger stable `publication_candidate_upgrade_reconciliation_required` without accepting or deleting the row.

### RED Evidence

Command:

```text
OPENTAG_TEST_DATABASE_URL=postgresql://127.0.0.1:5432/opentag_control_plane_test \
  corepack pnpm vitest run apps/control-plane/test/migrations.postgres.test.ts
```

Observed RED:

```text
Test Files 1 failed (1)
Tests 11 failed | 17 passed (28)
- missing assessedAt, invalid timestamp, extra key, and accepted-as-string migrated
- token-preserving OR true CHECK, NOT VALID FK/CHECK, altered FK actions/match/
  deferrability, NO INHERIT CHECK, WHEN(false), and trigger args reported ready
```

Duplicate/noncanonical reason arrays and Candidate mismatch already failed closed before production edits and remained regression coverage.

### GREEN Evidence

```text
Focused migration PG + schema parity + Candidate reads: 3 files, 31/31 tests passed.
Two tests that timed out only under full parallel PG contention passed isolated:
  2 files, 32/32 tests.
Complete Control Plane with --maxWorkers=1: 36 files, 252/252 tests passed.
Root typecheck: exit 0.
Root lint: 29 workspace projects, exit 0.
Control-protocol, Core, Governance, Dispatcher, Control Plane builds: exit 0.
git diff --check: exit 0.
```

The default fully parallel Control Plane run passed 250/252 assertions and hit only two five-second migration/readiness timeouts under concurrent PostgreSQL schema load. The exact timed-out tests passed isolated, and the complete one-worker run passed all 252 tests.

### Migration Assumption

- Migration 0013 is edited in place because no interim Task 8 commit was deployed or applied outside isolated disposable test schemas. An external database that somehow applied a different 0013 checksum continues to fail with the existing `migration_checksum_mismatch`; this behavior was not weakened. No second migration was added for an undeployed intermediate state.

### Remaining Boundary

- All PostgreSQL runs used isolated schemas dropped by test cleanup. The task did not start a PostgreSQL server, so no task-owned process remained to stop.
- No provider, delivery, push, publish, or deploy operation was performed.

## Fix Round 4

### Findings Closed

1. **Organization FK readiness verifies both sides.** The Candidate organization FK check now resolves and requires both ordered catalog arrays: source `ARRAY['organization_id']` and referenced `ARRAY['organization_id']` on `cp_organization`, while retaining validation, action, match, and deferrability checks. A real schema tamper adds a distinct eligible unique organization key, retargets the named Candidate FK to it, and readiness fails closed.
2. **Historical Candidate reconciliation now validates the whole strict shape.** Migration-local exception-safe predicates require an exact eleven-key JSON object, JSON-string scalar identities, nonempty identifier fields, revision/digest/timestamp constraints, canonical nonempty sorted/unique changed-file and verification-evidence arrays, and exact equality to all durable Candidate columns. Numeric/boolean scalar coercions, empty changed-file strings, invalid evidence digests, unsorted/duplicate arrays, and extra/missing/wrong-typed values remain unreconciled.
3. **Assessment reconciliation is exception-safe for every JSON form.** An exact five-key proposal assessment predicate validates object-only operations after a type guard and catches parsing errors. Scalar, array, JSON-null, and wrong-key historical assessments now all leave the row unreconciled and produce only `publication_candidate_upgrade_reconciliation_required`.

### Strict TDD Evidence

The new database-backed RED corpus was added before migration/readiness production changes. Against the prior 0013/readiness implementation it observed nine failures: readiness incorrectly returned `{ ready: true }` after the FK was retargeted to an alternate eligible organization key, and migration silently reconciled numeric/boolean scalar identities, empty strings, invalid evidence digests, and unsorted/duplicate Candidate arrays. The non-object assessment fixtures already failed with the stable reconciliation reason in this PostgreSQL execution; the production predicate makes that exception-safety explicit rather than depending on SQL predicate evaluation order.

### GREEN Evidence

```text
Focused migration + Candidate + schema parity: 4 files, 54/54 tests passed.
Complete Control Plane with --maxWorkers=1: 36 files, 268/268 tests passed.
Root typecheck: exit 0.
Root lint: 29 workspace projects linted; exit 0.
Control-protocol, Core, Governance, Dispatcher, and Control Plane builds: exit 0.
```

All PostgreSQL tests used random isolated schemas and dropped them during cleanup. The migration remains edited in place under the existing undeployed-0013 checksum assumption; no additional migration was added. No provider, delivery, push, publish, or deploy operation occurred.
