# @opentag/cli

The OpenTag CLI sets up and operates a persistent Slack coding-agent presence backed by a user-controlled Runner.

## Install

```bash
npm install -g @opentag/cli@latest
opentag setup --relay https://relay.example.com --project-target-id target_team
opentag doctor
opentag service install
opentag service start
```

The setup flow has one product path:

1. deploy the Control Plane and bootstrap its Slack installation and binding;
2. provide the trusted relay URL and the Control Plane bootstrap pairing token through the local password prompt;
3. choose the local GitHub Project Target mapping, checkout, and ACP executor;
4. register that exact Project Target through its active Slack binding and verify Control Plane readback;
5. verify both sides and start the Runner before the first Slack mention.

Interactive setup prompts for the Project Target ID. `setup --yes` requires
`--project-target-id`; use the value configured on the active Slack binding in
Control Plane Compose. No duplicate Runner environment variable is required.

For non-interactive setup or pairing, provide the bootstrap authority in the
process environment as `OPENTAG_BOOTSTRAP_PAIRING_TOKEN`. OpenTag uses it only
for that pairing attempt and never writes it to the Runner config. A replayed
registration enters `recovery_required`; recover the same Runner explicitly
with `opentag pair --recover <recoveryCredentialId>` rather than starting it.

Repository contents, coding-agent credentials, worktrees, and execution remain
on the Runner. The optional GitHub credential is collected through the
interactive secret prompt and is used only for configured provider readback and
explicitly approved publication.

## Core commands

```bash
opentag setup --relay https://relay.example.com --project-target-id target_team
opentag start
opentag doctor
opentag status
opentag service install
opentag service start
opentag service status
opentag service logs
opentag executors
opentag config show
```

`opentag pair --relay https://relay.example.com --trust-relay-origin
https://relay.example.com` is the pairing entry point for an existing unpaired
config. It reads the bootstrap authority from the local password prompt or the
environment variable above; there is no secret-bearing CLI option. For an
already paired Runner, the command only reconciles its declared targets and
verifies the authoritative Control Plane readback.

Run detail and attention live in the originating Slack thread and the
self-hosted Control Plane console. The Runner CLI reports its local pairing,
relay reachability, executor, secret-reference, and Project Target readiness.

Slack is the supported Source App and its credentials remain in the Control
Plane. The Runner config contains no Slack transport credentials. GitHub is the
Project Target and publication/evidence provider, not a Source ingress.

## Local config

The default configuration path is:

```text
~/.config/opentag/config.json
```

The CLI writes configuration with private file permissions and redacts secret values from `opentag config show`, status, doctor, and logs.

The Runner has one relay endpoint: `daemon.relayUrl`. Its paired execution mode
is implicit; there is no top-level `runtime` block, duplicate relay URL,
or provider classification to keep synchronized.

## Guides

- Slack setup: `docs/platforms/slack.en.md`
- GitHub Project Target and publication: `docs/platforms/github.en.md`
- Self-hosted paired relay: `docs/architecture/team-relay.md`
- ACP executors: `docs/acp-agent-integration.md`

## Verification boundary

Local tests and `opentag doctor` prove only local configuration and software behavior. They do not prove a live Slack delivery, a GitHub publication, a deployed relay, or an externally accepted completion.

## Local development

```bash
corepack pnpm opentag-dev
opentag-dev setup --relay https://relay.example.com
opentag-dev doctor
```
