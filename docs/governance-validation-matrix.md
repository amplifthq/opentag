# Governance Validation Matrix

Use this matrix when you need to prove OpenTag's governed source-thread loop is
not only a happy-path demo. It groups repeatable tests around failure
boundaries, source-thread controls, recovery behavior, artifact quality, replay
parity, and privacy redaction.

Run every local matrix case:

```bash
corepack pnpm smoke:governance -- --all --report .omx/governance-matrix/all.json
```

List available cases:

```bash
corepack pnpm smoke:governance -- --list
```

## Cases

| Case | What It Proves |
| --- | --- |
| `permission-boundaries` | Token and permission failures remain explicit; public repos are denied by default without write access; `allowedActors` can allow or deny; bot permission failures are surfaced; daemon Project Target allowlists block unsafe runs. |
| `source-thread-controls` | GitHub, GitLab, Slack, and Lark action replies reach `submitThreadAction`; `apply 1`, `reject 1`, `continue 1`, and `stop` have durable effects; duplicate and concurrent action replies are idempotent. |
| `recovery-idempotency` | Runner leases, duplicate source deliveries, lifecycle idempotency keys, callback dedupe/retry/suppression, heartbeats, timeout cancellation, and status evidence survive failure or retry paths. |
| `artifact-ledger-quality` | `opentag status --run <run_id>` remains useful after live-shaped runs: artifacts, Agent Work Ledger, callback delivery, liveness, and apply outcome metrics are visible while source-thread receipts stay concise. |
| `apply-failure-ux` | PR/MR apply cleanup and failure paths are explicit: missing branches disable apply before writes, create failures fall back to child runs, repeated replies do not duplicate external writes, and provider tokens/headers stay out of callbacks. |
| `replay-parity` | GitHub, Slack, GitLab, and Lark live-shaped fixtures replay in memory with the same receipt, artifact, ledger, callback, and executor-capability strategy. |
| `privacy-redaction` | Replay fixtures plus existing `.omx/live-e2e` and `.omx/governance-matrix` reports are scanned for token-like values, private keys, webhook secrets, Slack bot tokens, GitHub/GitLab tokens, full Lark message IDs, and local absolute paths. |

Run the privacy scan directly when reviewing live artifacts:

```bash
corepack pnpm smoke:privacy -- \
  --allow-missing \
  --path packages/dispatcher/test/fixtures/replay \
  --path .omx/live-e2e \
  --path .omx/governance-matrix
```

The scan never reads secret files such as local token files. It only scans
visible callback/report/status/artifact evidence and redacts matched excerpts in
its own output.

## Live-Derived Replay Fixtures

`replay-parity` includes sanitized GitHub, Slack, GitLab, and Lark fixtures.
These fixtures should preserve the live run shape, not the raw provider payload:

- replace real repositories, user IDs, chat IDs, message IDs, and project IDs
  with reviewable placeholders;
- keep action receipts, artifact types, ledger categories, and callback
  expectations realistic;
- never copy provider tokens, webhook secrets, private keys, raw API response
  bodies, local checkout paths, or full Lark/Slack message identifiers into the
  fixture.

## Boundary

This harness is intentionally local and repeatable. It does not hit live
GitHub, Slack, Lark, or GitLab APIs. Use `smoke:live` plus the provider-specific
live scripts when you need fresh external-provider evidence.

The matrix is still valuable before a live pass because it exercises the exact
dispatcher, adapter, store, and daemon contracts that live provider callbacks
enter after ingestion. After a live pass, rerun `privacy-redaction` and promote
only sanitized evidence into replay fixtures.
