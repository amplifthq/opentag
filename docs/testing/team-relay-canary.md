# Team-relay real canary runbook

## Authorization boundary

This runbook is for a separately authorized real canary. It does not authorize
Slack, GitHub, or provider mutation by itself. Do not run a real provider action
without a separate, explicit authorization that names the exact action and target.

Use a disposable or designated test environment only:

- one real Slack App and one private Slack test channel;
- one GitHub test repository configured as the Project Target;
- one self-hosted relay on an operator-controlled public HTTPS origin;
- one paired local Runner on a distinct machine with the checkout; and
- one configured ACP harness/executor on that Runner.

The profile remains `Relay-not-HA`. Do not represent a completed canary as
managed-service availability or production activation.

## Preconditions

1. Select one immutable relay source revision and record `git rev-parse HEAD`.
2. Complete Compose configuration, including a backed-up KEK source file and
   key version `v1`; run `docker compose --env-file .env config` and record its
   redacted configuration receipt.
3. Run deterministic and installation gates. Only those gates can support the
   installation's `Runner-offline-safe` declaration.
4. Configure Slack Events API and Interactivity & Shortcuts with the exact
   public HTTPS endpoint. Verify signing and private-channel events. Socket
   Mode is not a paired-relay canary transport.
5. Pair exactly one local Runner with the exact trusted relay origin. Register
   its GitHub Project Target and selected ACP executor/harness. Record the
   Runner generation, binding identity, and redacted readiness result.
6. Agree whether the canary stops at proposal evidence or includes an exact
   approved draft PR. The latter requires an additional authorization.

## Evidence record

Record identifiers and digests, never secrets or source plaintext outside its
authorized custody boundary.

| Record | Required evidence |
| --- | --- |
| Relay | Exact git head, image digest if used, redacted Compose/config receipt, public origin |
| Binding | Organization/binding ID, Slack app/channel identity, GitHub Project Target, policy version |
| Runner | Runner ID, credential generation, local Project Target, ACP executor/harness version and readiness |
| Source request | Slack channel/thread timestamp, actor identity, ingress receipt, canonical Run ID |
| Execution | Attempt ID, current fence/claim generation, bounded evidence and terminal/attention state |
| Candidate | Candidate/proposal ID, canonical payload digest, exact provider target and approval state |
| Provider, if authorized | Exact approval ID, draft PR URL/number, exact head SHA, required-check receipts, delivery/reconciliation observation |

An absent provider receipt stays absent or `outcome_unknown`; never infer it
from a Slack projection or process log.

## Procedure

### Read-only recovery of an uncertain Slack projection

Apply `0001_slack_delivery_observation.sql` after the current fresh baseline.
It adds one nullable `reconciliation_receipt` field, no tables, and a narrowly
guarded unknown-to-accepted transition. The retired pre-reset migration history
still has no upgrade path. Take the usual database backup before migration.

New versioned Slack messages carry `opentag_projection_v1` metadata with an
opaque digest binding the frozen intent, revision/event sequence, target,
provider binding and rendered request. The metadata contains no command text or
raw credentials. Recovery requires Slack to return it via `include_all_metadata`;
missing metadata, missing read permission or unsupported readback remains unknown.

The minute-window observation job schedules durable per-intent jobs and runs at
most one observation each minute across the installation. It uses only GET:
`auth.test`, then the specific thread/message. Update lookups use exact timestamp
bounds; creation lookups require a complete, unique bounded thread observation.
The adapter verifies the workspace, bot and app, thread/message target, marker,
text and blocks. Only Slack-added block IDs and default text flags are ignored.
Extra attachments, altered controls, another version, absent/deleted messages,
incomplete pagination, malformed or oversized responses never imply success or
permission to resend. Reads time out after 10 seconds and are bounded to 2 MB.

On an exact observation, the worker rechecks its job lease and the current source
binding, locks the delivery truth key, and atomically records the observation,
marks the delivery accepted, and settles the observation job. The immutable
receipt retains the original unknown evidence, error and timestamp. A stale
worker, disabled/rotated binding or changed payload cannot settle. Database
triggers require the active observation lease and forbid receipt rewrites.
Existing projection dispatch then resumes; an observed anchor also wakes its
deferred projection. Neither observation nor recovery calls a Slack write API.

Unconfirmed reads retain unknown and retry with bounded backoff (one minute to
15 minutes, respecting a longer valid `Retry-After`). After 100 attempts the job
fails visibly and requires operator review; it never clears or retries the
uncertain delivery. Prior messages without the marker cannot be retroactively
certified from matching text alone. This path does not recover reactions or
unthreaded creates, does not revive a Run/Attempt, and does not grant approval.

For acceptance, simulate a provider-accepted write whose response is lost, then
verify: exactly one write, a matching read observation and immutable receipt,
and only then a claimable newer projection. Repeat with wrong version/content,
binding rotation, expired lease, restart, and a settlement rollback. Keep real
provider canary evidence separate from these deterministic tests.

### A0. Prove durable waiting before admission

1. Establish real readiness, stop the Runner, and let the receipt expire (or be
   pruned). Do not use a still-fresh receipt to claim offline recovery coverage.
2. Post one bounded request. Its ingress reservation must remain `pending` with
   no terminal resolution; its `source_ingress.process` job must remain pending
   between checks, with `runner_not_ready` as its wait reason. At this point the
   request is in custody, not an admitted Run or a promise of execution.
3. Observe more readiness checks than the job's failure-attempt limit. Expected
   dependency waits must not consume that budget or extend the original eight-hour
   deadline. Actual processing failures still consume the budget.
4. Restart the relay while the Runner remains offline. Confirm the same
   reservation and job survive; do not resend or manually reset the source event.
5. Start the Runner. Fresh current-generation readiness, the exact target binding
   generation, and current source authorization must be checked before admission.
   Confirm one Run is admitted from the original request, then continue with A.

Expired waits close without execution. Deleted source content must not be
redeemed after recovery. A previously terminally resolved request is not reopened
by this fix: retain the failed canary record and use a new explicitly requested
test message. This change adds no tables and requires no schema migration.

### A. Prove signed ingress and local execution

1. Post a bounded engineering request in the private Slack test channel and
   mention the configured App.
2. Record the source-thread identity and admitted Run ID. Confirm the visible
   acknowledgement says only what durable state proves.
3. Observe the paired Runner claim one Attempt. Record the Runner generation
   and fencing-token digest/identifier, not the live secret.
4. Have the ACP harness produce bounded proposal or verification evidence.
5. Confirm the source-thread projection, Control Plane Run view, and durable
   Run/Attempt state agree. If they do not, stop and retain the
   discrepancy as the canary outcome.

### B. Stop at proposal unless a provider action is explicitly authorized

The preceding steps prove signed ingress, canonical lifecycle, pairing, and
local ACP execution without creating a provider-side change. A proposal is not
a draft pull request and does not imply publication.

If, and only if, an additional authorization names the GitHub test repository,
exact candidate, and draft-PR action:

1. Verify candidate digest and exact target still match the approval.
2. Execute only the approved action.
3. Reconcile the provider response to the exact draft PR URL, number, and head SHA.
4. If checks are included, record exact names and provider receipts. Do not
   call a check green from an agent report.
5. Stop after the named action. Never merge, force-push, or broaden the target.

## Stop conditions

Stop immediately and retain evidence if Slack signature, source-thread, binding,
or actor evidence differs; if Runner generation, Project Target, ACP executor,
claim, or fence is stale; if delivery is ambiguous or `outcome_unknown`; if an
approval is absent, stale, mismatched, or out of scope; if a provider returns a
different repository, branch, pull request, head, or check result; or if an
installation gate is missing or failing.

The canary outcome must distinguish local test success, relay installation
evidence, provider observation, and production outcome. A real canary does not
authorize deployment, managed hosting, high availability, future scheduled work,
or any later provider action.
