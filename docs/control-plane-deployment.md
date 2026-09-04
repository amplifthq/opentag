# OpenTag Control Plane deployment runbook

This runbook covers the open-source, single-host Docker Compose profile. It is
also the operational baseline for any managed deployment: the managed service
must run the same OCI image, PostgreSQL schema, migration corpus, and process
commands. This document does not claim that a managed environment is deployed.

## Minimum topology

The reference profile has four application roles and one durable dependency:

| Service | Authority |
| --- | --- |
| `postgres` | All durable Control Plane, identity, audit, and job state |
| `migrate` | One-shot checked-in SQL migration runner |
| `bootstrap-admin` | Idempotent initial owner provisioning |
| `bootstrap-slack` | Idempotent initial Slack installation and binding provisioning |
| `control-plane` | Hono API, operational endpoints, and static console |
| `jobs` | PostgreSQL-leased reconciliation and retention work |

No Cloudflare service, Redis instance, broker, object store, or external
scheduler is required. Compose is a single-host availability profile; it is
not a multi-node high-availability design.

The profile declares the capability envelope `Runner-offline-safe` and the
availability limit `Relay-not-HA`. The first is a required certification target,
not evidence that a particular installation has passed certification or is
active in production. The second remains true for this single-node profile.

## Secrets and configuration

Copy `deploy/compose/.env.example` to an ignored `.env` and replace all
placeholder values. Generate each secret independently. Never commit the
resulting file or pass secrets through a `VITE_` variable.

Required values:

- `POSTGRES_PASSWORD`: database password used only inside the installation;
- `OPENTAG_BOOTSTRAP_PAIRING_TOKEN`: initial runner-pairing authority;
- `OPENTAG_FENCING_TOKEN_SECRET`: independent, at least 32-character authority
  used to derive live fencing tokens. PostgreSQL stores only a
  fencing-token digest, never the live token. Outside `local` the server
  refuses to start when this value equals the bootstrap or recovery authority;
- `OPENTAG_LOGIN_THROTTLE_SECRET`: a different, independently generated
  at-least-32-character HMAC authority. Durable throttle rows contain only
  pseudonymous keyed identifiers and are bounded by expiry cleanup;
- `OPENTAG_BOOTSTRAP_ADMIN_EMAIL`, `...NAME`, and `...PASSWORD`: initial owner;
- `OPENTAG_PUBLIC_URL`: the exact browser and Slack webhook origin.

Relay content encryption is deliberately not configured with an inline
environment secret. On the host, set only
`OPENTAG_RELAY_CONTENT_KEK_SOURCE_FILE` to a file containing exactly 32 raw
bytes, 64 hexadecimal characters, or base64 that decodes to 32 bytes. On
native Linux, keep the file in a mode-`0700` directory and make the file mode
`0444`, or otherwise grant read access to container UID/GID `10001` without
exposing the parent directory. Compose implements file-backed secrets as bind
mounts and does not remap ownership, so a mode-`0600` file owned by another
host user is unreadable by the non-root image. Compose mounts the file as the
`opentag_relay_content_kek` Docker secret. The container receives only these
immutable references:

```text
OPENTAG_RELAY_CONTENT_KEK_FILE=/run/secrets/opentag_relay_content_kek
OPENTAG_RELAY_CONTENT_KEY_VERSION=v1
```

Never add an inline `OPENTAG_RELAY_CONTENT_KEK` variable. Compose refuses a
missing source file, and the Control Plane key loader rejects malformed or
placeholder file content and keeps relay readiness closed. A copied example
must not be treated as deployable until every placeholder and the KEK path have
been replaced.

Slack provider credentials follow the same no-inline-secret rule but use two
separate files and purposes. Set only the host-side
`OPENTAG_SLACK_SIGNING_SECRET_SOURCE_FILE` and
`OPENTAG_SLACK_BOT_TOKEN_SOURCE_FILE` paths in `.env`. Compose mounts them as
`/run/secrets/opentag_slack_signing_secret` and
`/run/secrets/opentag_slack_bot_token`. The one-shot `bootstrap-slack` command
verifies that both references are readable and bounded, then persists only the
fixed `file:/run/secrets/...` references. It never writes credential plaintext,
secret-derived diagnostics, or local host paths to PostgreSQL or audit events.

The remaining `OPENTAG_SLACK_*` bootstrap settings are non-secret installation,
binding, target, route, channel, bot, member, operator, approver, and admin
identities. User-ID lists are comma-separated without spaces or duplicates.
Operators and admins must be members; an approver, when present, must be a
member; `pull_request` mode requires one. The route identity must be a fresh,
bounded opaque value. The Project Target may be registered by the paired Runner
after bootstrap, but it must use the exact predeclared ID before source work can
be admitted.

Initial provisioning is deliberately create-or-exact-replay. The generic Source
App installation, generic binding, and Slack projection are committed in one
transaction with a content-free management audit event. Partial state, occupied
provider identity, or changed configuration fails closed. This command is not a
credential rotation, disable/re-enable, uninstall, or repair interface; those
lifecycles remain unsupported until they receive separate generation-fenced
contracts and incident-recovery evidence. Do not replace the mounted credential
files in place.

The server refuses to start while any secret still carries the unchanged
`replace-with-…` placeholder from `.env.example`, so a copied example file can
never run with publicly known authority values.

Recommended values:

- `OPENTAG_RECOVERY_PAIRING_TOKEN`: separate emergency authority used only to
  reprovision a paired runner credential;
- `OPENTAG_RELEASE_SHA`: the immutable 40-character Git commit for staging or
  production. `local` is accepted only in the local environment.

Login throttling is durable and applies independently to normalized email and
optionally to the direct network peer observed by the Node server:

- `OPENTAG_LOGIN_NETWORK_THROTTLE_MODE`: `direct-peer` by default. Set
  `trusted-edge` only when a verified external edge enforces a client-aware
  login rate limit; that mode disables the application network bucket while
  retaining the email bucket;

- `OPENTAG_LOGIN_MAX_FAILURES`: failures allowed per normalized email in the
  accounting window, default `5`;
- `OPENTAG_LOGIN_NETWORK_MAX_FAILURES`: failures allowed per direct network
  peer across all emails, default `50`. The higher default keeps one shared
  egress address (office NAT, VPN) from becoming a collective lockout after a
  few unrelated typos while still bounding single-source password spraying;
- `OPENTAG_LOGIN_WINDOW_MS`: accounting window, default `300000`;
- `OPENTAG_LOGIN_LOCKOUT_MS`: lockout after the limit is reached, default
  `900000`.

Do not trust arbitrary forwarded-address headers as a login principal. The
application ignores them in both modes. A reverse proxy must either preserve
meaningful direct peer addresses or use `trusted-edge` with independently
verified client-aware rate limiting; leaving `direct-peer` enabled behind a
single shared proxy can turn that proxy into a site-wide lockout bucket.

Runtime and API-key tokens are one-time material. Store them in the runner or
operator secret store when issued. A live hosted-claim fencing token is derived
from the deployment secret and the immutable claim tuple. The database retains
only credential hashes and the fencing-token digest, so replay can reconstruct
the same response without making the token recoverable from a database dump.

## TLS and public ingress

Do not expose the plain HTTP Compose port directly to the Internet. Terminate
TLS in a reverse proxy or load balancer and set `OPENTAG_PUBLIC_URL` to that
exact HTTPS origin. Forward the original `Host` and scheme consistently.

Public provider ingress is limited to the configured Slack Events API and
interactivity routes. Keep Slack signing and bot credentials in mounted secret
files, and expose only the route identities issued for active installations.
An accepted Slack request means the source event was durably reserved; it does
not mean execution began or a provider mutation completed.

Cloudflare DNS/CDN/WAF may proxy the origin, but it is optional. Do not cache
Control V1, console API, authentication, or provider-ingress responses.

## Installation and schema reset

Pin a reviewed image digest in production. For the local source profile:

```bash
docker compose --env-file .env build
docker image inspect opentag-control-plane:local --format '{{.Id}}'
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Before starting it, complete and record this secret-free binding checklist:

- Slack installation identity and installation credential **Secret Reference**;
- paired Runner identity, credential generation, and expected relay origin;
- GitHub Project Target binding (owner/repository identity, never a token);
- named ACP executor declaration and its workspace/isolation policy.

Do not paste Slack, Runner, GitHub, or executor credentials into this document,
Compose environment values, command history, or binding records. Store only
secret references where the relevant installation or Runner contract calls for
them.

Startup is ordered by health and completion: PostgreSQL, migration, owner
bootstrap, Slack installation bootstrap, HTTP readiness, then jobs.

The Agent Presence reset intentionally establishes a new database baseline.
It supports a new empty PostgreSQL database only and does not provide an
in-place upgrade from a pre-reset migration ledger. The migration runner checks
the recorded checksum and fails closed rather than interpreting or deleting
old state.

For an existing installation:

1. Stop the old HTTP and jobs roles so the backup is not racing live work.
2. Back up PostgreSQL together with the exact relay-content KEK and key version.
3. Keep that recovery set immutable; do not point the reset release at it.
4. Provision a separate empty database or Compose volume.
5. Start the exact reviewed reset image and let it create the new baseline.
6. Re-bootstrap the owner and Slack installation, then pair the Runner again.
7. Verify `/readyz`, console login, Runner readiness, and a non-destructive
   hosted lifecycle smoke before accepting new work.

OpenTag does not remove or rewrite the old database automatically. Importing
selected historical facts, if ever needed, is a separately reviewed migration
project rather than a compatibility path in this release.

## PostgreSQL sizing and connections

`OPENTAG_DB_POOL_MAX` is per process. The total possible connections are:

```text
(HTTP replica count + jobs replica count) * OPENTAG_DB_POOL_MAX
+ migration/bootstrap headroom
+ operator and monitoring headroom
```

Keep that total below the server or provider connection limit. Start with the
default of 10 only when the installation can afford it; small installations
can use a lower value. Monitor pool wait time, long transactions, locks, job
lease age, database storage, and backup age.

The HTTP process stops accepting new requests on `SIGTERM`/`SIGINT`, drains
the server, and closes the pool. The jobs process aborts its poll loop, releases
resources, and closes the pool. Give both roles a termination grace period
longer than normal request/transaction duration.

## Backup and restore rehearsal

PostgreSQL data, the exact relay-content KEK file, and immutable key version
`v1` are one indivisible recovery set. Losing the database loses canonical
authority and ciphertext state. Losing the KEK makes all retained ciphertext
unrecoverable. A database dump paired with a different KEK or version is not a
recovery. Protect the database dump and KEK backup separately while preserving
their explicit recovery-set association.

Back up PostgreSQL with normal tooling. A custom-format example:

```bash
docker compose --env-file .env exec -T postgres \
  pg_dump -U opentag -d opentag --format=custom > opentag-control-plane.dump
```

Restore into a new database or disposable installation, not over the only
copy:

```bash
createdb opentag_restore
pg_restore --exit-on-error --no-owner --dbname=opentag_restore \
  opentag-control-plane.dump
```

After restore, point the same application image at the restored database and
mount the exact recovery-set KEK at `/run/secrets/opentag_relay_content_kek`
with `OPENTAG_RELAY_CONTENT_KEY_VERSION=v1`. Verify migrations, `/readyz`,
tenant counts, runner registrations, hosted run terminal states, permission
receipts, material-action receipts, retained relay-content decryption, jobs,
and audit records. A backup without a successful restore rehearsal is not
recovery evidence.

Do not rotate or replace the KEK, and do not change its key version, without an
explicit migration that rewraps or migrates every retained encrypted object and
proves crash-safe resume. This reference profile supplies no such rotation
migration; ad hoc replacement makes retained ciphertext unrecoverable.

## Credential recovery and re-pairing

If runtime credential material is lost, call the credential-reprovision route
with the separately stored recovery token. Successful reprovisioning increments
the credential generation, revokes the prior credential, and returns new
material once. Confirm that the old credential receives `401` before relying
on the recovery result.

If the recovery token is unavailable or compromised, rotate installation
secrets under an incident plan and re-pair affected runners. Do not attempt to
recover plaintext credential material from PostgreSQL; it is intentionally not
stored.

## Verification and truthful limits

Before production use, require:

- exact image digest and source revision;
- clean empty-volume installation;
- backup and restore rehearsal;
- runner pair/re-pair and credential revocation;
- concurrent claim/fencing and cancellation race tests;
- permission and material-receipt tests;
- provider signature, replay, and tenant-mismatch negatives;
- graceful shutdown and connection-budget checks.

Only after these checks pass for the exact deployment identity may status report
`Runner-offline-safe` for that installation. It must continue to report
`Relay-not-HA`; neither a successful check nor a healthy process turns this
single-node Compose topology into HA or proves production activation.

The repository proves the local Compose profile only after those checks are
run against the exact image. A managed deployment, multi-replica behavior,
DNS, TLS, provider registration, or production activation requires separate
environment evidence and authorization.
