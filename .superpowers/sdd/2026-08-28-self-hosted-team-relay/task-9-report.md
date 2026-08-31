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
