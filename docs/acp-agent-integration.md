# Integrating an ACP Agent with OpenTag

## Status

Current ACP v1 integration guide for the supported Slack/GitHub profile,
2026-09-04.

OpenTag is the ACP client. The configured Agent process is the ACP server for
one disposable Attempt. The Control Plane owns the durable Run and execution
governance; the Agent supplies reasoning and work inside the Attempt envelope.

For the wire contract, see [Executor Protocol](./executor-protocol.md).

## Ownership

OpenTag owns:

- Run creation, durable lifecycle, and Attempt lineage;
- lease ownership, fencing, cancellation, retry, and recovery;
- workspace/scratch isolation and the absolute ACP `cwd`;
- input, context, policy, grant, and approval snapshots;
- material-action identity, idempotency, receipts, and reconciliation;
- provider observations, completion evidence, and source-thread presentation.

The ACP Agent owns:

- reasoning and task execution inside the supplied Attempt envelope;
- ACP capability negotiation and session updates;
- requesting permission for an ungranted tool action;
- returning useful output and verification through ACP.

An Agent must not post directly to the Slack source thread. It must not receive
Slack application credentials, Control Plane fencing credentials, or raw
connector secrets. External publication goes through the governed action path.

## Launch definition

An executor configuration declares the Agent process and its safe capability
profile. A minimal conceptual configuration is:

```json
{
  "id": "codex",
  "kind": "stdio",
  "command": "codex",
  "args": ["app-server"],
  "protocol": "acp",
  "protocolVersion": 1
}
```

The actual command, arguments, environment, and capability declaration are
owned by the Runner configuration. The Control Plane does not infer an Agent's
capabilities from its display name or executable path.

## Attempt envelope

For every Attempt, the Runner supplies:

- the approved ACP `cwd`;
- the workspace or scratch path;
- the immutable context packet and relevant source-thread references;
- the effective policy and permission grants;
- the Run, Attempt, lease, and fencing identities required for reports;
- only the environment variables explicitly permitted by the grant.

The Runner must reject a stale Attempt or expired lease before starting work.
An Agent process cannot extend its own lease or select a different Run target.

## Permission and material actions

ACP tool requests are evaluated against the current Run/Attempt grants. A
request that would mutate an external system requires the material-action
boundary, including:

1. a stable action identity and idempotency key;
2. the current Attempt fence;
3. the exact policy and approval decision;
4. a provider-specific execution adapter;
5. a receipt or an explicit failure/unknown outcome.

The Agent may propose an action, but a proposal is not an execution. A local
process exit is not evidence that an external provider accepted the action.

## Reporting

The Runner reports normalized lifecycle information to the Control Plane:

- Attempt started, heartbeat, and terminal state;
- bounded progress and diagnostics;
- tool/action requests and decisions where policy requires them;
- material-action receipts;
- provider observations and readback evidence;
- final text, verification summary, usage, and result hash.

If provider I/O may have occurred but its result is unavailable, report
`outcome_unknown`. Never retry an ambiguous material action merely because the
ACP process or HTTP request did not return a final response.

## Slack integration boundary

Slack is the Source App. Its adapter normalizes signed events and renders
semantic status, approval, and receipt presentations. The ACP Agent receives a
bounded context packet, not the Slack bot token or a direct channel API.

The source thread may show:

- accepted/running/attention-required/terminal projections;
- proposed actions and approval controls;
- provider-verified evidence;
- recovery instructions and Run links.

It must not show raw ACP frames, credentials, unbounded tool traces, or a
provider success claim unsupported by a receipt.

## GitHub target boundary

GitHub is the Project Target and publication/readback provider. The Agent may
prepare a patch, branch, or pull-request proposal within its workspace. A
GitHub publication is a separately governed material action. Required checks,
pull-request state, and other readback are evidence for completion gates, not
implicit approval.

## Failure and recovery

The Runner should classify failures at the boundary where they occur:

- invalid or stale lease/fence: reject before Agent startup;
- workspace failure: no valid Attempt envelope;
- ACP protocol failure: Agent interaction could not be trusted;
- provider failure: external adapter returned a terminal error;
- ambiguous provider result: `outcome_unknown`;
- cancellation: terminal cancellation semantics, not success.

After a process crash or lost connection, the Runner reconciles the current
Run/Attempt before resuming or reporting. It must not create a replacement
Attempt without the Control Plane's next lease/attempt decision.

## Minimal verification

An ACP adapter is ready for the supported profile when tests demonstrate:

- protocol and capability negotiation;
- absolute `cwd` and workspace isolation;
- stale lease and fencing rejection;
- bounded context and output handling;
- permission denial before ungranted mutation;
- material-action receipt persistence;
- cancellation and crash reconciliation;
- `outcome_unknown` preservation;
- Slack source-thread projection and GitHub readback separation.
