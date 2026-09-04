# Live E2E Smoke Harness

The smoke harness groups the current Slack Source App, paired Runner, and ACP
runtime checks. It does not turn local or executor evidence into a claim about
a real Slack or GitHub provider outcome.

## Cases

| Case | Live | Scope |
| --- | --- | --- |
| `slack-protocol` | No | Slack mention normalization, Run lifecycle, quiet progress, and final presentation enqueue through the delivery producer |
| `paired-relay` | No | Self-hosted Control Plane, Slack ingress, paired Runner recovery, and GitHub publication-control contracts against PostgreSQL |
| `builtin-acp` | Yes | Real built-in coding-agent readiness, isolated worktree, and declared cancellation behavior |
| `openclaw-acp` | Yes | Real OpenClaw Gateway ACP conformance |

List the case definitions directly from the harness:

```bash
corepack pnpm smoke:live -- --list
```

Preflight without executing a case:

```bash
corepack pnpm smoke:live -- --case slack-protocol --dry-run
corepack pnpm smoke:live -- --case paired-relay,builtin-acp,openclaw-acp --dry-run --allow-missing
```

## Local protocol and paired-relay checks

Run the credential-free Slack protocol case:

```bash
corepack pnpm smoke:live -- --case slack-protocol
```

The paired-relay case requires an isolated PostgreSQL test database but clears
Slack and GitHub provider credentials before running:

```bash
test -n "${OPENTAG_TEST_DATABASE_URL:-}"
corepack pnpm smoke:live -- --case paired-relay
```

Run the Control Plane composition checks separately when validating the
self-hosted distribution:

```bash
corepack pnpm smoke:control-plane-compose:typecheck
corepack pnpm e2e:control-plane
```

The browser E2E requires its documented Docker and Playwright environment. A
passing local composition proves the packaged services cooperate; it does not
prove that Slack accepted a reply or GitHub accepted a publication.

## ACP checks

Select only the installed, authenticated agents you intend to verify:

```bash
OPENTAG_BUILTIN_ACP_AGENTS=codex corepack pnpm smoke:live -- --case builtin-acp
corepack pnpm smoke:live -- --case openclaw-acp
```

These cases execute real local agent runtimes. They prove executor readiness,
workspace isolation, and the declared cancellation contract, not provider
delivery.

## Evidence boundary

`slack-protocol` and `paired-relay` may prove that a canonical delivery intent
was durably queued. Only the delivery journal can establish whether provider I/O
began and whether the terminal outcome was `accepted`, `rejected`,
`outcome_unknown`, or `attention`. A real provider acceptance additionally
requires provider-visible or provider-reconciled evidence.

Never infer delivery from Run completion, an external-looking URI, or
`delivery.intent.queued`. Never replay an ambiguous provider operation merely
because the local process restarted.

## Reports

Use `--report` to retain a mode-0600 JSON result:

```bash
corepack pnpm smoke:live -- \
  --case slack-protocol \
  --report .omx/live-e2e/slack-protocol.json
```

The report records the selected command, preflight state, exit status, and
elapsed time. Keep release identity, local contract evidence, provider journal
truth, and provider-visible proof as separate receipts.
