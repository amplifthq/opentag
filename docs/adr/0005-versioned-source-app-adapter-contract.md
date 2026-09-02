# Source Apps use one versioned five-port adapter contract

- Status: Accepted; current supported-app scope note added 2026-09-02
- Date: 2026-08-28
- Decision owners: OpenTag maintainers

OpenTag will integrate Slack and every later Source App through one versioned
Adapter contract with five narrow ports: ingress, context, presentation,
delivery, and capabilities. An installable App package may implement all five,
but it cannot own ingress reservation, Admission, Run or Attempt lifecycle,
runner selection, claim/lease/fencing, cancellation, approval policy,
evidence, completion, delivery journaling, retry authority, or terminal
settlement. Source-thread commands such as bind, unbind, status, stop, cancel,
approve, and reject are normalized into one provider-neutral command service
instead of being reimplemented by each App.

For the current self-hosted team profile, Slack is the only supported Source
App and uses signed Events API plus interactivity HTTPS ingress. GitHub is a
Project Target and optional exact-approved publication provider, not a second
source ingress. Later Source Apps remain deferred until they implement this
contract and its conformance evidence; no adapter receives ambient lifecycle,
approval, retry, or provider-action authority.

Adapters are loaded from an explicit registry in the first release and must
pass one shared conformance suite. Capabilities are declared as data;
unsupported behavior produces a typed unsupported or attention outcome rather
than provider-specific branching or silent emulation. Adding a second App must
require only its Adapter, capability declaration, fixtures, transport tests,
and composition wiring; canonical lifecycle code and existing App packages
must remain unchanged.

This chooses a small stable contract over a single catch-all handler, duplicated
provider applications, or an arbitrary dynamic-plugin ABI. It preserves a
simple one-package authoring experience without granting third-party Adapter
code ambient lifecycle, credential, or execution authority.

The first release supports typed Code Adapters only. Configuration is limited
to installation data, Secret References, enabled capabilities, and
source-channel to repository, Runner, and Executor bindings. It does not define
provider signature algorithms, identity or thread mappings, rendering logic,
retry or reconciliation behavior, lifecycle states, or executable transforms.
OpenTag will not add a declarative Adapter manifest, mapping DSL, embedded
scripts, visual Adapter builder, or dynamic plugin loader before at least three
real Source App Adapters have exposed measured, stable, mechanical repetition
that typed helper factories cannot remove more simply.
