<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/readme-logo-light.png">
    <img src="./assets/readme-logo-light.png" alt="OpenTag logo" width="112" />
  </picture>
</p>

<p align="center"><b>English</b> · <a href="./README.zh-CN.md">简体中文</a></p>

# OpenTag

**Mention any coding agent. Get proof, not promises.**

Run OpenTag's relay on infrastructure you choose, pair one local Runner, and
turn a Slack engineering thread into governed local agent work with verifiable
results. Your repository, coding-agent credentials, worktree, and execution
stay with the Runner you control.

OpenTag is a self-hosted coordination boundary, not a managed coding service.
It receives a thread request, records governed Run and Attempt state, pairs a
specific Runner, and projects verified status back to the source thread.
Provider delivery is independent evidence; it cannot replace canonical Run or
Attempt truth.

## The journey

1. A person mentions the configured OpenTag Slack app in an engineering thread.
2. The self-hosted Control Plane admits one canonical **Run** and records its
   source-thread, Project Target, authority, and evidence lineage.
3. The paired local Runner claims a fenced **Attempt** and starts its configured
   ACP executor against the local checkout.
4. The Runner reports bounded evidence. OpenTag presents status, attention, or
   an approval request in the original Slack thread.
5. A material provider action, such as a draft pull request, needs the exact
   configured policy and separate explicit approval. An agent report alone
   never performs a real provider action.

## Honest operating modes

| Mode | Intended use | Availability statement |
| --- | --- | --- |
| `local_direct` | Trial and single-machine use | `offlineSafe=false`. It works only while that machine and local OpenTag process are online. |
| `paired_relay` | Self-hosted team profile | A separately operated relay accepts Slack ingress and one outbound local Runner executes approved work. Exact installation certification is separate. |

The reference single-node Compose profile may display `Runner-offline-safe`
only after its deterministic and installation certification gates pass. It is
always `Relay-not-HA`; this repository does not claim high availability.

## Quick start: self-hosted paired relay

The team profile uses Slack Events API and Slack interactivity over a public
HTTPS origin, a GitHub Project Target, one paired local Runner, and an ACP
executor. Socket Mode remains a `local_direct` development option; it is **not**
certified for the paired relay profile.

### 1. Start the relay you operate

Requirements: Docker Compose, a public HTTPS origin for Slack, and a relay host
that is distinct from the paired Runner machine.

```bash
cd deploy/compose
cp .env.example .env
```

Replace every `.env` placeholder. Create a separate mode-`0600` relay-content
KEK host file containing exactly 32 raw bytes, 64 hexadecimal characters, or
base64 decoding to 32 bytes. Set `OPENTAG_RELAY_CONTENT_KEK_SOURCE_FILE` to its
host path. Never place the KEK in `.env`: Compose mounts it at
`/run/secrets/opentag_relay_content_kek` with immutable key version `v1`.

Render the configuration before starting it:

```bash
docker compose --env-file .env config
docker compose --env-file .env up --build
```

Wait for `control-plane` to become healthy, then use `OPENTAG_PUBLIC_URL`. The
[Compose guide](deploy/compose/README.md) and [deployment runbook](docs/control-plane-deployment.md)
cover recovery, readiness, and the installation-certification boundary.

### 2. Configure Slack as the Source App

Create one Slack app for the workspace and private engineering channel. Point
both **Event Subscriptions** and **Interactivity & Shortcuts** at the relay's
public HTTPS Slack endpoint. Configure its signing secret and bot token in the
self-hosted installation, subscribe to the documented app-mention and
private-channel events, then invite the app into the channel.

Follow [the Slack guide](docs/platforms/slack.en.md) for the exact events,
permissions, URL, and verification procedure. Do not configure Socket Mode as
the certified paired-relay ingress.

### 3. Pair one local Runner and its Project Target

On the machine holding the checkout and executor:

```bash
npm install -g @opentag/cli@0.11.0
opentag setup --relay https://relay.example.com
opentag pair --relay https://relay.example.com \
  --trust-relay-origin https://relay.example.com
opentag start
```

`paired_relay` rejects loopback and same-process relay URLs. During setup,
register the local GitHub Project Target and choose an ACP executor available
on that machine (for example, Codex or Claude Code). The paired Runner retains
the checkout, coding-agent credentials, and worktree.

```bash
opentag doctor
opentag status
```

### 4. Start with a governed Slack request

```text
@OpenTag investigate the failing check and propose a fix
```

An acknowledgement proves ingress recorded the request—not that a Runner is
online or that work completed. Read the Slack projection or run
`opentag status --run <run_id>` for local audit detail. Approve only the exact
material action presented by policy. OpenTag does not auto-merge, blindly retry
an `outcome_unknown` provider outcome, or turn completion evidence into a
provider action.

## Current supported profile

- Slack is the Source App for thread ingress, status, and approval presentation.
- GitHub is the Project Target and optional publication provider, not a second
  source ingress for this profile.
- One paired, user-controlled Runner uses one configured ACP executor.
- The relay owns durable coordination and audit metadata; provider delivery is
  independent from Run/Attempt lifecycle state.

Managed hosting, high availability, ambient memory, scheduled work,
multi-Runner fallback, automatic merge, and unsupported Source Apps are not
asserted by this profile. See [the team-relay architecture](docs/architecture/team-relay.md)
and the separately authorized [real-canary runbook](docs/testing/team-relay-canary.md).

## Verify the local implementation

These commands validate checked-in local software only. They do not deploy a
relay, contact Slack or GitHub, or establish installation certification.

```bash
corepack pnpm smoke:control-plane-compose:typecheck
corepack pnpm test
```

For a disposable browser/Compose exercise, see [the Control Plane README](apps/control-plane/README.md).
A real Slack or GitHub canary requires separate explicit authorization.

## Documentation

- [Team relay architecture](docs/architecture/team-relay.md)
- [Self-hosted Compose guide](deploy/compose/README.md)
- [Control Plane deployment runbook](docs/control-plane-deployment.md)
- [Slack Source App guide](docs/platforms/slack.en.md)
- [Team-relay canary runbook](docs/testing/team-relay-canary.md)
- [Configuration reference](docs/configuration.md)
- [Agent-readable install guide](docs/agent-install.md)
- [npm prerelease candidate guide](docs/npm-prerelease.md)

## License

[MIT](./LICENSE)
