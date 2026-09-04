# Configuration

## Current boundary

OpenTag has one supported configuration path: a Slack-persistent, self-hosted
Control Plane paired with one local Runner and one GitHub Project Target.

Configuration is split by authority:

| Concern | Authority | What it contains |
| --- | --- | --- |
| Control Plane bootstrap | [`deploy/compose/.env.example`](../deploy/compose/.env.example) | PostgreSQL/bootstrap settings, non-secret Slack installation IDs, and file-backed secret paths |
| Local Runner setup | `opentag setup` | trusted Control Plane origin, Runner registration, local GitHub repository mapping, ACP executor settings, and optional GitHub token |
| Redacted inspection | `opentag config show` | the same local Runner configuration with secret values replaced by references or redaction markers |
| Operational verification | `opentag doctor`, `opentag status`, `opentag service status` | local configuration, pairing, Runner, Control Plane reachability, and bounded readiness observations |

Do not combine these authorities. The Control Plane bootstrap file configures
the service. The CLI setup command configures the paired Runner. A local config
file is not a copy of the Control Plane database or Slack installation record.

## Control Plane bootstrap

Start from the checked-in [Compose environment example](../deploy/compose/.env.example).
It is the authority for the self-hosted Control Plane bootstrap contract.

The file covers:

- PostgreSQL connection and pool settings;
- initial organization and administrator bootstrap;
- pairing, recovery, fencing, login-throttle, and release identity settings;
- bind address, public origin, and environment name;
- file-backed paths for the Slack signing secret and Slack bot token;
- non-secret Slack installation, binding, route, team, app, channel, bot, and
  role IDs;
- the initial Slack publication mode and GitHub Project Target identifier;
- durable job lease, polling, and retry limits.

Secret values should live in protected files referenced by the `*_SOURCE_FILE`
variables. Keep those files outside the environment file, under a protected
parent directory, with permissions that allow only the intended Control Plane
process/container to read them. The environment example contains placeholders;
replace them before starting a non-local deployment.

The Slack IDs and role lists are identifiers, not credentials. They still form
an authorization boundary and must identify the intended Slack installation and
operators. The Control Plane validates the signing secret, route, binding, and
credential generation before accepting a source event or interactive action.

See the [Slack Source App guide](./platforms/slack.en.md) for the provider-side
Events API and Interactivity setup, and the [Control Plane deployment guide](./control-plane-deployment.md)
for service deployment and database operations.

## Pair the local Runner

The supported CLI path creates a local Runner configuration and pairs it with a
trusted Control Plane origin:

```bash
opentag setup \
  --relay https://control.example.com \
  --project /absolute/path/to/repository \
  --executor codex \
  --github-repository acme/demo \
  --project-target-id target_team
```

Replace `target_team` with the Project Target ID configured on the active Slack
binding in Control Plane Compose; it is a normal CLI value, not a Runner secret
or a second required environment variable.

This reset also starts a fresh local durability contract. If an earlier OpenTag
database exists, select new empty `OPENTAG_CONFIG_HOME` and
`OPENTAG_STATE_DIR` directories. The Runner rejects an unmarked SQLite schema
without modifying it; migration of earlier local state is intentionally not a
supported startup path.

Use the actual command options exposed by the installed CLI; run `opentag
setup --help` when a release adds or changes an option. The setup flow records:

- one trusted Control Plane origin in `daemon.relayUrl`;
- the local Runner identity and registration material;
- the exact local GitHub repository mapping, including owner/repository,
  Project Target ID, checkout path, base branch, and remote;
- the selected ACP executor and its local launch configuration;
- optional local GitHub credential references needed for governed publication
  or readback.

Pairing does not copy Slack credentials into the Runner config. Slack transport
and installation credentials remain owned by the Control Plane. The Runner
receives only the scoped runtime material needed for an authorized operation.
Before pairing becomes final, the CLI registers every configured target through
the active Slack binding and verifies the exact Runner Control Context readback.

One paired Runner is the supported execution capacity. Do not add a second
Runner entry as an implicit fallback or capacity pool; claim, lease, and
terminal ownership must remain unambiguous.

## What the local configuration contains

The local Runner config is limited to:

- one `daemon.relayUrl` and its explicit trusted-origin authorization;
- Runner registration and current credential-generation metadata;
- local GitHub repository bindings and workspace paths;
- ACP executor selection, arguments, profiles, and bounded runtime settings;
- local scratch/workspace policy;
- optional GitHub token or SecretRef required for an explicitly governed
  publication/readback operation;
- local service and polling settings needed by the Runner.

The config must not contain:

- Slack signing secrets, bot tokens, or Slack transport configuration;
- a second platform block or provider-specific source configuration;
- an alternate local-only execution mode;
- legacy application names or local listener settings;
- Control Plane database rows, raw source messages, or complete ACP
  transcripts;
- a presence table or a boolean that claims the Runner is always available.

The local checkout path is an execution input, not a publication authority.
GitHub publication still requires the current Run/Attempt fence, exact target,
policy, approval, idempotency key, and material-action receipt.

## Trusted origin and pairing state

The relay origin is an explicit trust decision. It must identify the intended
self-hosted Control Plane and must not silently change when a Runner starts.
The CLI should reject malformed or loopback-as-remote origins for the paired
profile and report the repair action.

Runner registration is generation-bound. A replaced, revoked, or stale
credential cannot claim work or write lifecycle state. Pairing success means
registration was accepted; it does not prove that Slack is receiving events,
that ACP is ready, or that GitHub publication is authorized.

## Inspect and verify safely

Use the CLI surfaces instead of reading raw config files into logs or chat:

```bash
opentag config show
opentag doctor
opentag status
opentag service status
```

`opentag config show` must redact secret values and show only a safe SecretRef,
presence marker, or bounded status. `doctor` reports configuration and
dependency checks. `status` reports current Run, Runner, Control Plane, and
target read models. `service status` reports the local service supervisor and
its latest bounded runtime observations.

These commands are evidence at different boundaries. A local config parse or a
healthy process is not proof of a deployed Control Plane. A reachable Control
Plane is not proof of a Slack delivery. A Runner heartbeat is not proof of an
ACP completion or a GitHub side effect.

## Outcome and evidence boundary

The canonical execution sequence is:

```text
Slack source event
  -> admission
  -> Run
  -> Attempt
  -> lease/fencing
  -> ACP execution
  -> material-action receipt and provider observation
  -> terminal outcome
```

Configuration selects and authorizes boundaries; it does not create completion
evidence. In particular:

- a queued request is not an accepted external action;
- an accepted Run is not an executing Attempt;
- a process exit is not provider confirmation;
- a GitHub URL is not exact-head readback;
- an unverified check report is not provider-verified evidence;
- an ambiguous provider response is `outcome_unknown`, not success and not a
  reason to replay blindly.

Status and source-thread presentation must preserve these distinctions. The
Control Plane remains authoritative for durable Run/Attempt lifecycle, leases,
action identity, receipts, evidence, and terminal state; the Runner is the
local execution worker.

## Configuration changes

Change bootstrap values in the deployment environment, and change Runner values
through the CLI setup/configuration flow. After a change:

1. inspect the redacted configuration;
2. run `opentag doctor`;
3. run `opentag status` and `opentag service status`;
4. verify the current pairing generation and GitHub target identity;
5. treat live Slack delivery, GitHub publication, and completion evidence as
   separate provider checks.

Do not hand-edit generated credential material or copy secret values between
the Control Plane environment and the Runner config. If a credential operation
may already have reached a provider but its outcome is unclear, stop and
reconcile it before changing configuration or retrying.

## Related guides

- [Compose environment authority](../deploy/compose/.env.example)
- [Slack Source App](./platforms/slack.en.md)
- [GitHub Project Target](./platforms/github.en.md)
- [ACP agent integration](./acp-agent-integration.md)
- [Control Plane runtime architecture](./control-plane-runtime-architecture.md)
- [Relay security hardening](./relay-security-hardening.md)
