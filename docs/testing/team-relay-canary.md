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
