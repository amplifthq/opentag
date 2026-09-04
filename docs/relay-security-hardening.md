# Self-Hosted Relay Security

## Status

Current security boundary for the Slack paired-relay profile, 2026-09-04.

The Control Plane is always-on self-hosted infrastructure. Treat it as trusted
operator infrastructure: it can see bounded source/run metadata and controls
which authorized work the one paired Runner may claim. It must not receive
raw repository contents or provider credentials outside an authorized grant.

## Slack signature and route verification

Slack is the only Source App. The Control Plane must:

1. verify the raw Slack request signature before parsing or side effects;
2. reject stale timestamps and malformed signatures;
3. resolve the configured workspace/application/channel route;
4. verify the current binding generation and event identity;
5. deduplicate the source event before creating a Run;
6. return bounded errors without exposing secrets or raw request bodies.

Interactivity requests use the same signed Control Plane boundary and must carry
enough route and action identity to bind the decision to the current source
thread. A stale, duplicated, or mismatched action is rejected or replayed
idempotently; it never invokes a provider directly.

The Slack signing secret is Control Plane configuration. Protect it at rest,
redact it from logs/status/traces, and never place it in an ACP prompt or source
event payload.

## Binding and credential custody

Bindings identify the Slack source route, the GitHub Project Target, and the one
paired Runner. A binding must not silently change its application, workspace,
target, or credential generation while a Run is active.

Credential rules:

- Slack signing and app credentials remain in the Control Plane credential
  boundary.
- GitHub credentials required for publication/readback remain in the paired
  Runner's protected credential store.
- ACP Agents receive only scoped, operation-specific grants.
- Tokens, authorization headers, refresh material, and raw credential errors
  never enter Run records, prompts, presentations, or public logs.
- A credential rotation changes the binding generation and invalidates stale
  grants and actions.

## Runner identity and fencing

Only one paired Runner is supported for execution. The Control Plane verifies:

- Runner identity and pairing generation;
- current credential generation;
- lease ownership and expiry;
- Attempt identity and fencing token;
- target and workspace binding;
- cancellation and terminal-write authority.

The Runner must fail closed when any generation, lease, or fence is stale. A
heartbeat is an observation, not permission to claim work or write terminal
state. Presence/readiness is a derived status projection and is not a durable
security or execution authority.

## GitHub publication intent and readback

GitHub is the only Project Target. Every publication requires:

1. an explicit target and exact current head/branch intent;
2. a current Run and Attempt fence;
3. policy and approval for the exact proposal;
4. a stable idempotency key;
5. a material-action receipt;
6. exact-head readback and provider observation.

Readback must record the repository, resource identity, expected head, observed
head, check conclusions, observation time, and assurance level. A changed head
invalidates the prior intent. A provider response that may have succeeded but
cannot be verified is `outcome_unknown`; never blind-retry it.

## Data minimization

The Control Plane stores only the bounded metadata and evidence required by the
Run contract. Do not persist:

- raw Slack signing material or tokens;
- GitHub credential values;
- full ACP transcripts or terminal streams;
- complete repository checkouts;
- unbounded provider request/response bodies.

Logs should contain stable IDs, reason codes, redacted target references, and
bounded recovery guidance. They must not contain secrets, cookies, authorization
headers, or raw provider credential material.

## Failure posture

Security failures are explicit and fail closed:

- invalid Slack signature: do not parse or admit;
- unknown or stale route/binding: do not create or mutate a Run;
- stale Runner credential or fence: reject the operation;
- expired lease: stop the Attempt and require reconciliation;
- target/proposal mismatch: reject before provider I/O;
- ambiguous GitHub result: retain `outcome_unknown` and require readback;
- unavailable Control Plane: do not infer presence or completion locally.

## Required verification

The self-hosted profile is security-ready only when tests cover signature
verification, route/binding fencing, credential redaction, duplicate
interactivity, stale Runner credentials, lease expiry, exact-head target
validation, publication idempotency, readback assurance, and
`outcome_unknown` preservation.

## Related documents

- [Slack Source App](./platforms/slack.en.md)
- [GitHub Project Target](./platforms/github.en.md)
- [Control Plane runtime architecture](./control-plane-runtime-architecture.md)
- [ADR 0004: Slack Persistent Presence](./adr/0004-always-on-channel-ingress-local-execution.md)
