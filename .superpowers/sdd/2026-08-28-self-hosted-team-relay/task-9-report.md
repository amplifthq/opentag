# Task 9 — exact-approved draft PR publication

## Scope and base

- Worktree: `/Users/mingyoo/repos/opentag/.worktrees/self-hosted-team-relay`
- Base: `3fb75edfd7469ef1b5c7d4c834788ac0e1c8697f`
- No remote GitHub, provider, push, or deployment action was performed.

## Implemented evidence

- Ordinary local execution cannot push or create a PR: `maybeCreatePullRequest` is now a no-op, including when legacy `allowAutoCreatePullRequest` and a local token are supplied.
- GitHub's ordinary mutation compiler rejects `create_pull_request`; the only exported PR writer requires `draft: true`.
- The protocol carries only exact publication authority, never Git/GitHub credentials: organization/run/Attempt/fence, Candidate digest, approved identity, repository/remote/base, branch/head, step, operation key, Runner generation, and expiry.
- Publication is split into `push_owned_branch` then `create_draft_pull_request`; local execution begins before provider work and records a receipt afterwards. An ambiguous provider result is recorded as `outcome_unknown`, without an in-process blind retry.
- `0014_publication_operations.sql` is a publication-specific durable authority/receipt migration, with immutable intent, branch ownership, capability, begin, and receipt rows.
- Application/runtime/client wiring exposes authenticated claim, begin, and receipt Control V1 routes. Route/body identity must match the authenticated Runner and exact Run.
- `publisher.begin` now joins the durable capability to its intent, current Run, Attempt, and Runner before recording `started`; cancellation/terminal state, changed Attempt, expired lease, or changed Runner credential generation reject an unstarted capability.
- The hosted local-runtime sidecar polls the coordinator-owned publication queue on every fresh Control V1 iteration. A `201` capability is executed only after the exact succeeded imported Attempt/fence is recovered from the local Store; missing/stale Store authority, repository binding mismatch, or missing PR credential fails closed before `begin` or any provider call.
- Local push and draft-PR effects use exact repository/remote/base/branch/head bindings. The GitHub token remains only in local callback closures and is never placed in a Control V1 request, receipt, Store row, completion observation, or reportable source payload.
- A `200` completion dispatch now contains only the exact capability plus its immutable succeeded draft-PR receipt. The Runner performs credentialed reads of the exact PR, head, base, draft state, and current check/status rollup, then submits a credential-free completion observation. Neither push nor PR creation is replayed.
- `outcome_unknown` is immediately followed by one exact local observation and a typed reconciliation submission. The side effect is called once; unresolved ambiguity remains coordinator-blocked, exact presence settles, and exact absence alone authorizes the coordinator to issue the next capability.
- Restart recovery is stateless on the Runner side: every poll derives the next step from PostgreSQL `0014` state, while the raw fence is recovered only from the immutable local hosted run/Attempt import chain. Terminal completion clearing live assignment pointers does not erase publication authority.

## Strict TDD record

| Change | RED evidence | GREEN evidence |
| --- | --- | --- |
| Receipt digest input schema | `corepack pnpm vitest run packages/control-protocol/test/canonical-values.test.ts` failed during import with `Error: .omit() cannot be used on object schemas containing refinements`, at `packages/control-protocol/src/index.ts:467` | Added schema-load regression test; derived digest input from an unrefined base object and then applied `superRefine`. Same test: 16/16 pass; protocol build passes. |
| Local proposal-only no publication | Existing focused tests exercised legacy auto-PR options without provider calls | `packages/local-runtime/test/pr.test.ts` is green inside the focused suite. |
| Draft-only GitHub PR writer | Existing tests reject non-draft writer input | `packages/github/test/pull-request.test.ts` is green inside the focused suite. |
| Migration corpus | Added checked-in `0014` presence/immutability assertion | `apps/control-plane/test/migrations.test.ts` is green inside the focused suite. |
| Sidecar null/stale fence | New sidecar test failed because `runPublicationControlV1Iteration` did not exist | Added the public one-iteration publication dispatcher; absent exact Store authority returns `false` with zero begin/receipt/provider calls. |
| Completion-needed dispatch | New test received `false` for a `200` completion response | Added the minimal `{ capability, completionReceipt }` response and exact PR/check observation; push and PR callbacks remain uncalled. |
| Ambiguity reconciliation | New test observed zero reconciliation calls after an ambiguous push | Added one exact observation plus typed reconcile after the durable `outcome_unknown` receipt; provider call count remains one. |
| Store restart recovery | New SQLite restart test returned `null` after hosted success | Removed dependence on terminal-cleared live assignment pointers; exact authority now derives from succeeded run/Attempt plus immutable hosted imports and linked active claim. |
| Legacy automatic PR expectations | Full workspace suite reported 15 stale tests that still expected ordinary daemon/apply PR writes | Updated legacy regression contracts to proposal-only/coordinator-approved behavior; the final full workspace suite is green. |

## Crash/recovery matrix

| Boundary | Durable state / outcome |
| --- | --- |
| capability issued before local call | capability is immutable and one-use; `begin` has not occurred, so no provider call is authorized |
| begin committed before provider call | `cp_publication_begin` records `started`; later claim is fenced as reconciliation-required rather than blindly reissued |
| provider completed before response | local layer maps uncertainty to `outcome_unknown` and records it, not a success/failure assertion |
| receipt accepted before caller response | `cp_publication_receipt` has unique capability identity and returns replay only for the same receipt digest |
| stale/duplicate receipt | stored capability identity, receipt digest, and primary/unique keys reject a conflicting replay |
| Attempt expiry/cancellation/Runner generation change before begin | `publisher.begin` rechecks current Attempt/lease/terminal and Runner generation in its insert-select; it returns `stale_fence` without `started` |
| reconnect/restart after ambiguous provider outcome | typed exact presence/absence/ambiguity is persisted in `cp_publication_reconciliation`; only authoritative absence permits the coordinator to issue the next capability |
| restart after push receipt | next `claim-next` derives `create_draft_pull_request` from durable `0014` state; push is not replayed |
| restart after PR receipt | `200` returns the immutable prior PR receipt for read-only completion observation; neither effect is replayed |
| restart before terminal completion | exact local raw fence is recovered from succeeded hosted import evidence even though live assignment pointers were cleared at executor completion |

## Fresh verification

- `corepack pnpm test` (outside restricted sandbox because ingress binds loopback): **233 files; 206 passed, 27 skipped; 3,134 tests; 2,886 passed, 248 skipped**.
- Focused publication/control/GitHub/Store/migration suite: **13 files passed, 4 PostgreSQL-gated files skipped; 200 tests passed, 9 skipped**.
- `OPENTAG_TEST_DATABASE_URL=postgresql://mingyoo@127.0.0.1:55432/postgres corepack pnpm vitest run ...publication... ...material-actions... ...migrations.postgres...`: **5 files, 89 tests passed** against the disposable local PostgreSQL 14 cluster.
- `packages/store/test/hosted-import.test.ts` plus `packages/local-runtime/test/publication-control-v1.test.ts`: **2 files, 51 tests passed**, including restart, stale digest/claim, null-fence, push→PR→completion, ambiguity, and no-replay cases.
- `corepack pnpm typecheck`: passed.
- `corepack pnpm lint`: passed across 29 workspace projects.
- `corepack pnpm --filter @opentag/control-protocol build`: passed.
- `corepack pnpm --filter @opentag/client build`: passed.
- `corepack pnpm --filter @opentag/github build`: passed.
- `corepack pnpm --filter @opentag/store build`: passed.
- `corepack pnpm --filter @opentag/local-runtime build`: passed.
- `corepack pnpm --filter @opentag/control-plane build`: passed.
- `git diff --check`: passed.
- The first real migration run was RED (60 failures) because historical tests used `slice(0, -1)` as an implicit alias for “through 0012”. With `0014`, that also applied `0013`, so historical fixtures attempted to recreate `cp_publication_candidate`. The tests now select the true 0012 base (`slice(0, -2)`), assert the 0014 ordered migration/table contract, and the migration corpus is GREEN: **80/80**.

## Remaining gaps

- No Task 9 implementation gap remains. No real GitHub provider call, branch push, deployment, or production mutation was performed during verification.
- The local test PostgreSQL cluster and loopback webhook servers were test fixtures only; they are not deployment evidence.

## Stop condition

Task 9 is complete when the exact-approved publication patch, this report, and the regression updates are committed together after the full source/test/build gates above pass. That stop condition has been reached.

## Fix Round 4 correction — settlement authority and 0014 readiness

The earlier Round 3 claim that contradictory reconciliation and complete 0014
readiness were closed was incorrect. `reconcile()` previously inserted an
`absent` observation after an authoritative succeeded receipt, and startup
readiness accepted a nullable 0014 receipt column. Those failures were
reproduced on an isolated local PostgreSQL 14 cluster before this correction.

- `publisher.ts` now has one transaction-aware operation-state reducer over
  immutable capability, begin, receipt, and reconciliation facts. A succeeded
  receipt or exact `present` reconciliation is settled forever; an exact
  `absent` observation is retryable only before any settlement; begun/unknown
  operations are reconciliation-only; and untouched operations remain subject
  to the normal issuance gate. Explicit claim, runner recovery/claim-next,
  push prerequisite, completion, and reconciliation all use that reducer.
- Reconciliation locks the capability and all associated immutable fact rows
  before reducing state. A later absent/ambiguous fact cannot be inserted after
  settlement; exact reconciliation replays, while a different observation or
  reconciliation identity conflicts. Exact presence produces the canonical
  succeeded representation from the provider-observed facts without mutating
  an earlier unknown receipt.
- Local GitHub PR reconciliation now requires the owned head branch and head
  repository in addition to SHA, target/base repository, draft/open state, and
  URL. The durable observation schema retains `headBranch` and
  `headRepository` when the provider supplies them; no credential enters that
  data.
- Readiness now checks every 0014 authority family for table presence, ordered
  family cardinality, all-NOT-NULL/no-default authority columns, capability
  retry uniqueness, receipt/reconciliation/completion uniqueness, the
  ownership expression index, and each enabled unconditional zero-argument
  immutable trigger. The PostgreSQL tamper cases cover receipt nullability,
  capability-attempt uniqueness, and disabled immutable triggers.

Fresh local verification (no provider, push, deployment, or production action):

```text
OPENTAG_TEST_DATABASE_URL=postgresql://mingyoo@127.0.0.1:55433/opentag_task9_fix4 \
  corepack pnpm vitest run packages/control-protocol/test packages/github/test \
  packages/local-runtime/test/publication-control-v1.test.ts \
  apps/control-plane/test/publication.postgres.test.ts \
  apps/control-plane/test/publication-transport.postgres.test.ts \
  apps/control-plane/test/migrations.postgres.test.ts
14 files passed; 215 tests passed.
```

`corepack pnpm --filter @opentag/control-protocol build`,
`corepack pnpm --filter @opentag/control-plane build`, affected package lint,
and `git diff --check` also pass.

The full requested descriptor-level 0014 catalog and the exhaustive
per-family tamper matrix are **not** yet proven by this Round 4 patch; this
correction intentionally does not claim that broader readiness work complete.

## Fix Round 1 — Slice A

### Authority repair

- Branch ownership is now a Runner-authenticated attestation that must exist before human approval. It binds the current succeeded Attempt/fence, Runner credential generation, exact Candidate digest, frozen Project Target/binding, workspace base/tree/current revision, deterministic `opentag/<runId>` branch, local remote alias, and expected head.
- The relay derives canonical `github` provider/owner/repo identity from the frozen Project Target and validates it against the Admission-frozen repository and binding. Runner input cannot select provider/owner/repo.
- `cp_publication_branch_ownership` stores normalized provider/owner/repo columns plus the exact branch, remote/base/head, Candidate/Attempt/fence/generation, frozen workspace evidence, and immutable attestation digest. Its actual-repository-plus-case-folded-branch unique index rejects casing, remote, and base variants of a taken branch.
- Human publication approval now carries only ownership ID/digest, Candidate ID/digest, approval ID/timestamps, and route identity. Repository, branch, head, Attempt, fence, and Runner generation are not accepted from the human payload; the authenticated route injects the approver actor.
- Intent creation locks and exact-matches the Run, current succeeded Attempt, Candidate, frozen Project Target, Branch Ownership, Runner generation, and canonical repository identity. Self-approval remains denied.
- Exact approval replay is represented by a canonical approval digest over every immutable approval and inherited ownership authority field. Changed approver, approval, ownership, Candidate, fence, generation, or expiry conflicts instead of replaying.
- `cp_publication_capability.attempt_number` is PostgreSQL-assigned monotonically per Organization/Intent/step under the locked intent, unique and immutable. Issuance, retry gating, completion, and latest-operation selection order by this number, not timestamp or random capability ID.
- Drizzle declarations, `0014_publication_operations.sql`, and migration readiness checks now require the normalized ownership columns, monotonic capability column, and canonical uniqueness index.

### Strict TDD evidence

- RED: `packages/control-protocol/test/canonical-values.test.ts` failed 2 tests because Runner ownership attestation did not exist and the old approval schema required human-supplied repository/branch/head/Attempt/fence/generation.
- GREEN: the same protocol test is 19/19 passed; strict schemas reject non-deterministic/target branches and malicious approval authority fields.
- Real PostgreSQL GREEN: publication ownership/approval/capability tests are 5/5 passed, including concurrent exact ownership and approval replay, concurrent capability issuance, monotonic per-step attempts, exact replay conflicts, normalized identity, and casing/remote/base takeover denial.
- Real PostgreSQL focused GREEN: publication, publication transport, material actions, material-action transport, and migrations are 5 files / 90 tests passed. The transport test rejects malicious approval repository/branch/head fields before the publisher and proves ownership/approval payloads remain provider-credential-free.
- Non-PostgreSQL focused GREEN: protocol, client, local publication runtime, and migration suites are 11 passed / 3 PostgreSQL-gated files skipped, 207 passed / 86 skipped tests.
- `corepack pnpm typecheck`, `git diff --check`, and builds for `@opentag/control-protocol`, `@opentag/client`, `@opentag/github`, `@opentag/local-runtime`, and `@opentag/control-plane` passed.

### Boundary

- No remote provider, GitHub write, push, deployment, or production mutation was performed. PostgreSQL verification used only the existing disposable local test cluster.

## Fix Round 1 — Slice B

### Recovery and receipt settlement

- A durably begun operation with no terminal receipt, an `outcome_unknown` receipt, or an ambiguous reconciliation is now returned by `claimNextForRunner` as credential-free `reconciliation_pending` work containing the exact original capability and operation identity. The HTTP/client/local-sidecar path preserves that identity and performs only a credentialed observation; it never calls push or PR creation while recovering.
- The coordinator treats an authoritative exact `present` observation as settlement of the original capability. It derives a canonical reconciled receipt for completion projection while retaining the original unknown receipt as immutable history. Exact absence remains the only retry gate; ambiguity remains `outcome_unknown`.
- Publication begin records PostgreSQL `CURRENT_TIMESTAMP` and evaluates capability expiry plus Attempt lease in the same DB statement. The Runner-supplied `begunAt` is no longer an authorization time source.
- Push success accepts only the capability's exact expected head. Draft-PR presence/receipt requires `github`, exact owner/repo/base, `open`, `draft: true`, exact head, `github_pr_<positive-number>`, and the canonical `https://github.com/<owner>/<repo>/pull/<number>` URL. Completion uses exact PR id equality rather than numeric suffix matching.

### Strict TDD and verification

- RED: against real PostgreSQL, an expired Attempt lease plus a backdated caller `begunAt` returned `{ kind: "begun" }`; the new assertion required `stale_fence`.
- GREEN: the same test now passes with the DB clock gate; it also proves begun/unknown recovery returns the original operation and exact `present` reconciliation reaches completion without an effect retry.
- Real PostgreSQL: `publication.postgres`, `publication-transport.postgres`, and `migrations.postgres` are **86/86 passed**.
- Local runtime/protocol: publication control, PR, and canonical protocol suites are **32/32 passed**.
- A restart-specific Control V1 regression proves `reconciliation_pending` invokes exactly one observe/reconcile call for the original capability and invokes neither publication effect.
- Direct persistence regressions prove a forged push head and forged PR id/URL/provider/repository/base/head/draft payload are rejected before a `cp_publication_receipt` row exists.
- The 0014 PostgreSQL readiness matrix covers all seven publication-authority table families for organization non-nullability, primary-key presence, immutable-trigger presence, and the capability attempt/digest/body fields; the existing corpus additionally exercises migration idempotency and publication trigger mutation rejection.
- Broad final verification found and repaired a Drizzle/0014 semantic-parity drift: the declarative schema now includes the migration's expression uniqueness index, publication checks, attempt FK, receipt uniqueness, and completion digest check. `schema-parity.postgres` is green.
- Complete Control Plane isolated-PostgreSQL suite: **38 files / 312 tests passed**. Complete Store/local-runtime/Runner suite: **36 files / 617 tests passed**. Affected control-protocol, client, github, store, local-runtime, runner, and control-plane builds passed; cached and working-tree diff checks passed.
- `corepack pnpm typecheck`, `corepack pnpm lint`, relevant package builds, and `git diff --check` passed.

### Boundaries

- No provider call, GitHub write, branch push, deployment, or production mutation was performed.
- The test matrix covers representative fail-closed classes per authority table family; no provider or production-state verification is implied.

## Fix Round 2

### Recovery, settlement, and observation authority

- `claimNextForRunner` now selects a persisted begun/unsettled capability before normal issuance selection. This branch is strictly observation-only and therefore survives expired intent/Attempt lease, cancelled or terminal Run state, and a rotated credential generation for the same paired Runner identity. It does not permit a new effect; only later authoritative `absent` returns to normal issuance gates.
- Explicit `claim` now recognizes a prior exact-present reconciliation of the owned branch as settled, matching the queue path rather than requiring a push receipt alone. Exact present blocks reissue; absent is the only retry state.
- Duplicate reconciliation unique conflicts now read the persisted reconciliation and replay only if reconciliation id, operation id, canonical observation, and observation timestamp all match; a changed duplicate returns `conflict` and cannot manufacture a response from caller input.
- Local GitHub draft-PR observation requires provider-returned `open`, `draft`, exact target repository, base, head, and canonical PR URL before it returns `present`. These observed facts are preserved into reconciliation rather than synthesized from desired capability values.
- Runtime readiness now also verifies the ordered column contracts for intent, begin, receipt, reconciliation, and completion tables and enabled immutable triggers for every 0014 authority table family.

### Fresh verification

- Real PostgreSQL publication/migration focused tests: **86 passed**.
- Complete isolated-PostgreSQL Control Plane suite: **38 files / 312 tests passed**.
- Complete Store/local-runtime/Runner suite: **36 files / 617 tests passed**; the first sandbox attempt was blocked by loopback `EPERM`, and the permitted local rerun passed.
- Workspace typecheck and lint passed. Builds passed for control-protocol, client, github, store, local-runtime, runner, and control-plane. `git diff --check` passed.

## Fix Round 3

- Begun unknown recovery is now selected before normal issuance gates. A real PostgreSQL RED that produced `empty` after intent expiry, terminal cancellation, lease expiry, and same-runner generation rotation is GREEN: it returns the immutable original reconciliation capability and does not authorize a write.
- Explicit claim and queued claim both recognize a successful receipt or exact present reconciliation as settled. Explicit draft-PR prerequisite no longer diverges by considering only push receipts.
- A reconciliation submitted after an authoritative successful receipt/present settlement is rejected as a conflict when it contradicts persisted observation identity; duplicate reconciliation replay reads persisted values only.
- GitHub local PR observation now carries provider-observed head branch and head repository identity, requires exact branch/repository, and returns ambiguous rather than absent when matching-SHA candidates exist but none exactly identify the owned PR.
- Runtime migration readiness now validates ordered 0014 columns for all authority families and the exact enabled immutable trigger/function relationship for every authority table. The earlier duplicate-reconciliation Minor is resolved by persisted-value replay checking.
- Focused GitHub/local test suite: **8 files / 95 tests passed** in the permitted local environment; unprivileged loopback `EPERM` was sandbox-only.
