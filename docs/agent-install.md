# Agent-Readable OpenTag Install Guide

Use this guide to install the supported persistent-teammate profile:

```text
Slack Source App
  -> self-hosted Docker Compose Control Plane
  -> paired local Runner and ACP Agent
  -> GitHub Project Target/publication
  -> truthful Slack thread projection
```

Slack is the source surface. GitHub is the Project Target and
publication/readback provider. The ACP Agent is confined to the selected local
checkout; Slack delivery and GitHub provider access remain OpenTag-owned.

## 1. Bootstrap the Control Plane and Slack

From a reviewed OpenTag checkout, copy `deploy/compose/.env.example` to
`deploy/compose/.env` and replace every placeholder. Follow
`deploy/compose/README.md` for the complete deployment contract.

Put the Slack signing secret and bot token in separate protected host files.
The Compose `.env` contains only:

```text
OPENTAG_SLACK_SIGNING_SECRET_SOURCE_FILE=...
OPENTAG_SLACK_BOT_TOKEN_SOURCE_FILE=...
```

Fill the non-secret Slack IDs, route identity, member roles, publication mode,
and `OPENTAG_SLACK_PROJECT_TARGET_ID`. Configure the Slack app with:

```text
https://control.example.com/v1/providers/slack/events/<route-identity>
https://control.example.com/v1/providers/slack/interactivity/<route-identity>
```

Then start and inspect Compose:

```bash
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml config
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml up --build -d
docker compose --env-file deploy/compose/.env -f deploy/compose/compose.yaml ps
curl --fail https://control.example.com/readyz
```

Completion: migrations and bootstraps succeed, the Control Plane and jobs are
healthy behind TLS, and no Slack credential value appears in `.env`, rendered
Compose config, or logs.

## 2. Install the local CLI

OpenTag requires Node.js 22.14 or newer. Install and verify the reviewed CLI:

```bash
node --version
npm install -g @opentag/cli@0.11.0
opentag --version
```

Completion: `opentag --version` reports `0.11.0` on the Runner host.

## 3. Configure and pair the Runner

Confirm the intended checkout and preserve unrelated changes:

```bash
git -C /absolute/path/to/checkout status --short
git -C /absolute/path/to/checkout remote get-url origin
```

Run setup without secret command-line flags. Enter the GitHub credential and
pairing authority only through local secret input:

```bash
opentag setup \
  --relay https://control.example.com \
  --project /absolute/path/to/checkout \
  --executor codex \
  --github-repository owner/repo \
  --project-target-id target_team
```

Replace `target_team` with the Project Target ID configured on the active Slack
binding in Control Plane Compose. The CLI does not require a duplicate Runner
environment variable for this value.

Setup performs initial pairing. If a separately prepared existing config is
still unpaired, complete it against the same trusted origin:

```bash
opentag pair \
  --relay https://control.example.com \
  --trust-relay-origin https://control.example.com
```

Pairing registers the target only when its ID is already referenced by the
active Slack installation and binding. It computes the binding digest and
verifies repository, branch, executor, credential generations, and Runner from
the returned Control Context before marking the local state paired.

Completion: redacted config shows one `daemon.relayUrl`, a paired runner-scoped
credential, the exact trusted origin and GitHub target, and no retained
bootstrap token; Control Plane target readback has already succeeded.

## 4. Start and verify the Runner

Start the paired Runner:

```bash
opentag start
```

Keep that terminal open, or use the globally installed background service:

```bash
opentag service install
opentag service start
opentag service status
```

Then verify the complete local declaration:

```bash
opentag doctor
opentag status
opentag config show
```

Completion: the service reports running and ready, the selected ACP executor
is ready, the checkout maps to the Control Plane target, and all displayed credentials
are redacted.

## 5. Verify the persistent teammate

Invite the OpenTag app to the bootstrapped Slack channel and send one bounded
mention using its actual display name.

Completion: one signed Slack event creates one WorkThread and Run, the paired
Runner claims one fenced Attempt in the intended checkout, and the originating
Slack thread receives a concise result or explicit actionable failure.

Do not infer provider success from Run completion, approval, a queued delivery,
or a generated URL. GitHub publication and Slack delivery require their durable
receipts; an ambiguous begun operation remains `outcome_unknown` until
reconciled.
