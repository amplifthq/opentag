# OpenTag Integration Taxonomy

## Status

Current integration boundary for the Slack/GitHub/ACP profile, 2026-09-04.

An integration is classified by the role it plays. Roles have independent
bindings, credentials, process ownership, and lifecycle. No integration role
may create a second Run, Attempt, lease, receipt, or terminal authority.

## Current roles

| Role | Current implementation | Owns |
| --- | --- | --- |
| Source App | Slack | signed ingress, source event identity, thread keys, semantic presentation |
| Project Target | GitHub | repository identity, explicit publication, readback evidence |
| Agent Runtime | configured ACP executor | reasoning and work inside one Runner-owned Attempt |
| Control Plane | self-hosted Node/PostgreSQL service | durable Run governance and protocol authority |
| Execution Worker | one paired local Runner | claim, isolated Attempt execution, reports, and local workspace |

## Discovery envelope

An integration declaration identifies a role and its process binding. It may
declare command, args, ACP protocol version, and capability metadata, but it
must not contain credentials or raw provider state.

```json
{
  "protocol": "opentag.integration.v1",
  "id": "codex",
  "label": "ACP executor",
  "roles": {
    "agent": {
      "protocol": "acp",
      "protocolVersion": 1,
      "binding": "agent"
    }
  },
  "bindings": {
    "agent": {
      "kind": "stdio",
      "command": "codex",
      "args": ["app-server"]
    }
  }
}
```

The discovery envelope is configuration metadata. It is not an event stream,
credential store, Run status, or proof that the process is available.

## Role boundaries

### Slack Source App

Slack ingress verifies signed requests before parsing and normalizes them into
OpenTag source events. It may render status, approval, action receipt, and
terminal projections. It must not claim Run completion from a sent message or
own execution leases.

### GitHub Project Target

GitHub identifies the repository and source work item, receives explicitly
authorized publication actions, and supplies readback evidence such as pull
request and required-check observations. Readback is evidence for a completion
gate, not an approval decision.

### ACP Agent Runtime

The ACP executor runs inside one Runner-owned Attempt. It receives the approved
workspace, context, policy, and grants. It does not receive source app
credentials and does not post directly to Slack.

### Control Plane and Runner

The Control Plane is authoritative for durable Run/Attempt lifecycle,
lease/fencing, action identity, approval, receipts, provider observations, and
terminal state. The one paired Runner is the only execution worker. Presence
and readiness are derived observations and are not integration roles or durable
authority.

## Credential boundary

Credentials are owned by the integration that requires them and projected only
inside an authorized operation. Do not put tokens, secrets, authorization
headers, or refresh material in discovery metadata, source events, ACP prompts,
Run records, or presentations.

An ACP Agent must not receive Slack bot credentials. A GitHub publication must
use the governed provider adapter and material-action receipt path rather than
an arbitrary credential copied into the prompt.

## Lifecycle and evidence

Every role reports only facts it can establish:

- Slack reports signed ingress and source delivery facts.
- GitHub reports publication/readback facts and provider observations.
- ACP reports execution and verification facts from the Attempt.
- Runner reports lease-bound lifecycle facts.
- Control Plane records the canonical Run state and reconciles conflicts.

`accepted`, `running`, and `process_exit` are not equivalent to external
provider completion. If a provider action may have occurred but cannot be
verified, the canonical result is `outcome_unknown`.

## Adding a role

Before adding an integration, document:

1. the role and canonical owner;
2. stable event, target, and action identities;
3. credential acquisition and projection boundary;
4. supported capabilities and explicit unsupported cases;
5. idempotency and provider-observation behavior;
6. lease, cancellation, retry, and `outcome_unknown` semantics;
7. the Slack or operator-facing presentation projection;
8. tests that prove the role cannot create a second execution authority.

An adapter translates provider shape into OpenTag contracts. It does not add a
provider-specific task model to Core and does not choose a local checkout or
executor behind the Control Plane's back.

## Related documents

- [Control Plane runtime architecture](./control-plane-runtime-architecture.md)
- [ACP agent integration](./acp-agent-integration.md)
- [Adapter authoring](./adapter-authoring.md)
- [Slack platform guide](./platforms/slack.en.md)
- [GitHub platform guide](./platforms/github.en.md)
