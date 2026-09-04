# Slack-to-GitHub Integration Verification

The supported integration path is:

```text
Slack Source App
  -> self-hosted Control Plane
  -> paired local Runner
  -> GitHub Project Target and publication
  -> truthful result projected to the originating Slack thread
```

Each boundary has a different evidence authority. Keep those authorities
separate when deciding whether a release or deployment is ready.

## Local contract gate

Run the credential-free checks from the repository root:

```bash
corepack pnpm smoke:control-plane-compose:typecheck
corepack pnpm verify:delivery-fixtures
```

With an isolated PostgreSQL test database configured, run the paired-relay
certification:

```bash
test -n "${OPENTAG_TEST_DATABASE_URL:-}"
corepack pnpm test:team-relay
```

This suite exercises Slack ingress, Control Plane custody, Run claiming,
paired-Runner recovery, GitHub publication control, delivery crash boundaries,
and projection outbox behavior. It clears provider credentials and performs no
real Slack or GitHub API call.

Run the packaged Control Plane browser path when its Docker and Playwright
prerequisites are available:

```bash
corepack pnpm e2e:control-plane
```

These checks prove source, test, and local-runtime behavior only. They are not
provider-live proof.

## Agent runtime gate

Verify only the local ACP integrations intended for the release:

```bash
OPENTAG_BUILTIN_ACP_AGENTS=codex corepack pnpm smoke:acp-conformance
corepack pnpm smoke:openclaw-acp-conformance
```

Record the exact agent command and version. A readiness or execution pass says
nothing about Slack or GitHub delivery.

## Delivery truth

Use the delivery journal as the authority for outbound effects:

| Evidence | Supported statement |
| --- | --- |
| `delivery.intent.queued` | The canonical intent was durably accepted for delivery |
| `pending` or `leased` | A local delivery attempt exists or is claimed |
| `provider_io_begun` | The fenced provider operation began; its outcome may still be unknown |
| `accepted` | The adapter recorded provider acceptance |
| `rejected` | The provider rejected the operation |
| `outcome_unknown` | Provider I/O began but the terminal result cannot be proved |
| `attention` | An operator decision or reconciliation is required |

Run completion, executor success, and an external-looking URL are not delivery
receipts. Never automatically retry `outcome_unknown`; reconcile the original
operation first.

## Provider-live acceptance

A provider-live claim requires an explicitly authorized run with test-owned
Slack and GitHub resources. Retain sanitized evidence for all of the following:

1. the exact release or image identity under test;
2. a Slack event accepted by the configured Source App and bound channel;
3. the canonical WorkThread, Run, Attempt, and fencing lineage;
4. the paired Runner that claimed and completed the attempt;
5. the GitHub Project Target and immutable publication operation identity;
6. delivery-journal begin and terminal records for GitHub and Slack effects;
7. provider-visible or provider-reconciled GitHub publication evidence;
8. the final Slack thread projection, without internal logs or secrets; and
9. restart reconciliation proving that an ambiguous begun operation is not
   sent twice.

If any required provider evidence is unavailable, report that boundary as
unverified or `outcome_unknown`. A passing local gate must remain separately
labelled as local evidence.
