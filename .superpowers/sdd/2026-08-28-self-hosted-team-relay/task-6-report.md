# Task 6 Report — Delivery Runtime and PostgreSQL Relay Repository

## Outcome

- Extracted the provider-neutral producer, side-effect kernel, composite-registry facade, and Awaitable repository port into the public `@opentag/delivery-runtime` package.
- Replaced the three dispatcher implementation paths with compatibility re-exports. The Slack lifecycle compatibility seam now awaits the repository's sync-or-async lookup contract.
- Added migration-owned PostgreSQL relay delivery custody with immutable intent/digest/idempotency identity, exclusive lease/fence claims, begin markers, terminal observations, deadline abandonment, supersession, and accepted external-resource lookup.
- Wired the PostgreSQL repository into the Control Plane runtime. The provider-delivery worker performs one kernel iteration and does not implement a retry loop.
- Added the public package to the complete release inventory.

## TDD Evidence

- Baseline before extraction: unchanged SQLite journal and dispatcher delivery tests: 4 files / 66 tests passed.
- RED: new runtime and PostgreSQL tests failed because the new package/module did not exist.
- GREEN: delivery contract/runtime/SQLite/dispatcher/release targeted gate: 14 files / 109 tests passed.
- Real PostgreSQL migration/schema/repository/crash gate: 4 files / 9 tests passed against PostgreSQL 16.

The PostgreSQL tests cover immutable duplicate/conflict behavior, claim exclusivity, lease expiry and stale-fence rejection, migration-only table creation, begin-before-side-effect restart, terminal replay after a late response, and received/running coalescing to a single terminal presentation.

## Build and Static Verification

- `corepack pnpm typecheck`: passed.
- `corepack pnpm lint`: passed for all 29 non-root workspace projects.
- `@opentag/delivery-runtime`, `@opentag/dispatcher`, and full `@opentag/control-plane` builds: passed.
- Runtime dependency scan: no store, dispatcher, provider, SQLite, PostgreSQL, Hono, or Drizzle imports in `packages/delivery-runtime`.
- `git diff --check`: passed.

## Full-suite Note

Serialized real-PostgreSQL full suite: 224 files / 2,918 tests passed; one unrelated existing material-action ordering assertion failed because this disposable database collates `git.push` before `github.pull_request.create`. Task 6's complete targeted corpus and schema parity remained green. No unrelated material-action change was made.

## Safety Review

- Ambiguous provider effects remain terminal `outcome_unknown`; no blind provider retry path was introduced.
- `markBegin` is durable before provider I/O, and restart finalization records `delivery_restart_after_begin`.
- External-resource identity is provider-neutral in the kernel; native Slack identity validation remains in the Slack adapter boundary.
- Delivery expiry/supersession changes delivery rows only and never mutates canonical Run state.
- PostgreSQL is the sole relay repository; no broker, Redis, object store, provider call, push, deploy, or publish was added or performed.
