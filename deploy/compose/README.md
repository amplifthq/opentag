# OpenTag Control Plane with Docker Compose

This is the reference single-host installation. It runs PostgreSQL and five
roles from one `opentag-control-plane:local` image: migrations, administrator
bootstrap, one-shot Slack installation bootstrap, the HTTP application/static
console, and durable jobs.

The declared profile envelope is `Runner-offline-safe`; an exact installation
may display that state only after completing the required certification checks
in the deployment runbook. Its availability declaration is always
`Relay-not-HA`.

1. Copy `.env.example` to `.env` and replace every placeholder secret. Use an
   independently generated fencing-token and login-throttle secrets rather
   than reusing the pairing, recovery, administrator, or database secret. Keep
   the file out of version control.
2. Create a separately backed-up relay-content KEK file and set
   `OPENTAG_RELAY_CONTENT_KEK_SOURCE_FILE` to its host-side path. On native
   Linux, put it in a mode-`0700` directory and make the file mode `0444`, or
   otherwise make it readable by container UID/GID `10001` without exposing
   the parent directory. Compose file-backed secrets are bind mounts, so a
   mode-`0600` file owned by another host user is not readable by the non-root
   container. The file must contain exactly 32 raw bytes, 64 hexadecimal
   characters, or base64 that decodes to 32 bytes. Do not put the KEK itself in
   `.env`. Missing files make Compose refuse the deployment;
   malformed or placeholder content makes relay
   readiness fail closed. The container receives only the mounted file path
   `/run/secrets/opentag_relay_content_kek` and immutable version `v1`.
3. Create separate Slack signing-secret and bot-token files under the same
   protected-file rules, then set `OPENTAG_SLACK_SIGNING_SECRET_SOURCE_FILE`
   and `OPENTAG_SLACK_BOT_TOKEN_SOURCE_FILE`. Put only Slack IDs, role lists,
   the route identity, and those host-side paths in `.env`; never put the
   credential values there. `bootstrap-slack` verifies both mounted files and
   stores only their fixed `file:/run/secrets/...` references.
4. Replace every `OPENTAG_SLACK_*` identifier. Member/operator/admin values are
   comma-separated Slack user IDs without spaces or duplicates. Operators,
   admins, and the optional approver must be members. `pull_request` mode
   requires an approver; start with `proposal_only` otherwise. Set
   `OPENTAG_SLACK_PROJECT_TARGET_ID` to the Project Target ID the paired Runner
   will register.
5. Run `docker compose --env-file .env config` and inspect the rendered secret
   mounts. For an upgrade, stop the old `control-plane` and `jobs` services,
   run the one-shot `migrate` service, then start the reviewed image. Do not
   migrate while an old jobs worker still owns a live projection lease. For a
   new installation, run `docker compose --env-file .env up --build`.
6. `bootstrap-slack` creates the generic installation, binding, and Slack
   projection in one transaction. Re-running the exact configuration is a
   recorded replay. Partial pre-existing state or any changed identity, role,
   target, mode, or Secret Reference stops startup with a conflict; this v1
   bootstrap does not rotate or repair an installation.
7. Wait for `control-plane` to become healthy, then open the configured
   `OPENTAG_PUBLIC_URL`.
8. Sign in with the bootstrapped owner and pair a local OpenTag runner with
   `OPENTAG_BOOTSTRAP_PAIRING_TOKEN`. Register the Project Target using the
   exact ID from `OPENTAG_SLACK_PROJECT_TARGET_ID`; mentions received before
   that target and Runner readiness exist settle as setup-required or
   temporarily unavailable rather than becoming executable work.

Useful checks:

```bash
docker compose --env-file .env ps
curl --fail "${OPENTAG_PUBLIC_URL:-http://127.0.0.1:3000}/healthz"
curl --fail "${OPENTAG_PUBLIC_URL:-http://127.0.0.1:3000}/readyz"
docker compose --env-file .env logs --no-log-prefix migrate bootstrap-admin bootstrap-slack
```

From the repository root, the bounded end-to-end smoke validates the public
Control V1 client, signed GitHub ingress, permission and material receipts,
canonical cancellation, credential reprovisioning, and console projections
against the running Compose stack:

```bash
corepack pnpm smoke:control-plane-compose:typecheck
corepack pnpm --filter @opentag/cli exec tsx \
  --env-file="$PWD/deploy/compose/.env" \
  ../../scripts/test/control-plane-compose-smoke.ts
```

The smoke creates uniquely named test records in the configured database. It
prints only identifiers and bounded outcomes, never the issued credentials or
webhook secret.

For the real browser journey, install Chromium once and run the isolated E2E
from the repository root:

```bash
corepack pnpm --dir apps/control-plane e2e:install
corepack pnpm e2e:control-plane
```

Unlike the protocol smoke above, this command owns a new disposable Compose
project. It builds the production image, applies migrations, bootstraps the
owner, drives Chromium through the public console, verifies the exact durable
records with `psql`, and always removes the test volume and generated secret
file. See the checked-in journey catalog at
`apps/control-plane/e2e/TEST-CATALOG.md`.

The default profile is intentionally PostgreSQL-only. It does not require
Cloudflare, Redis, object storage, a broker, or a platform scheduler. Put a TLS
reverse proxy in front before exposing the service or GitHub webhook publicly.

Treat the PostgreSQL backup, the exact KEK file, and key version `v1` as one
recovery set. Losing PostgreSQL loses the authority and ciphertext records;
losing the KEK makes every retained relay-content ciphertext unrecoverable.
Restoring mismatched members is not a valid recovery. Back up the database with
normal PostgreSQL tooling rather than copying a live volume, protect the KEK
backup separately, and rehearse restoring both together. Do not rotate or
replace this profile's KEK or change `v1` without an explicit ciphertext/key
migration. Compose is a single-host availability profile; it is not a
multi-node PostgreSQL or container-orchestrator HA design.

The application uses the same checked-in migrations and image commands in
self-hosted and future managed installations. This profile does not claim a
managed environment exists. See the full
[deployment runbook](../../docs/control-plane-deployment.md) for TLS, image
pinning, pool sizing, upgrade, backup/restore, graceful shutdown, and recovery.

The default `OPENTAG_LOGIN_NETWORK_THROTTLE_MODE=direct-peer` is appropriate
when the Node service observes distinct client peers. If a reverse proxy makes
all requests share one socket peer, configure `trusted-edge` and enforce a
verified client-aware login limit at that edge. The application deliberately
ignores forwarded address headers; its normalized-email bucket remains active.
