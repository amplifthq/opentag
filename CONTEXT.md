# OpenTag Governance Context

OpenTag governs agent execution attached to work that remains canonical in external systems. Its language separates execution activity from evidence-backed work completion.

## Language

**Work item**:
An external planning or collaboration object that defines the work and remains owned by its source system.
_Avoid_: OpenTag task, internal ticket

**Work thread**:
The durable OpenTag governance identity connecting an external work item, its conversation anchors, runs, evidence, assessments, and escalations across time.
_Avoid_: Ticket, backlog item

**Cross-channel Work Thread link**:
An administrator-authorized, generation-fenced binding of two verified source anchors for the same organization and Project Target to one canonical Work Thread. It changes future execution mutual exclusion but never merges histories, identities, Source Context Envelopes, permissions, or existing nonterminal work.
_Avoid_: Heuristic deduplication, account-email match, cross-channel context merge, implicit broadcast

**Binding unlink drain**:
The fail-closed `pending_unlink` interval in which linked anchors accept no new Runs while their old canonical Work Thread settles every Run, Follow-up, unknown external outcome, and control operation. Only a quiescent coordinator-owned transition may split future Invocation routing.
_Avoid_: Immediate scope split, force unlink, history migration, automatic replay after unlink

**Run Scope**:
The organization, Project Target, and canonical Work Thread tuple within which OpenTag permits at most one active run and orders immutable Follow-up Requests. An unlinked source anchor receives its own canonical Work Thread by default.
_Avoid_: Repository-wide lock, Provider queue, source text similarity

**Run**:
One admitted request for agent execution within a work thread.
_Avoid_: Work item, completed work

**Admission**:
The authoritative decision that a verified request becomes a run under a frozen principal, Project Target, runner affinity, execution policy, and deadline. Admission may succeed while the configured runner is offline and does not grant execution ownership.
_Avoid_: Claim, placement, execution start

**Queue claim deadline**:
The Admission-frozen latest instant at which a queued run may receive Placement without a new Admission. Before it, an eligible affined runner may start automatically after current checks pass; at or after it, an unstarted run settles as timed out and cannot be revived. A run promoted from a follow-up is additionally capped by that follow-up's earlier promotion deadline.
_Avoid_: Attempt timeout, lease expiry, renewable queue TTL

**Ingress reservation**:
Durable, replay-safe custody of an authenticated provider delivery before admission. It proves that OpenTag can recover processing, not that a run exists or that work was accepted.
_Avoid_: Admission, received, queued

**Ingress processing obligation**:
The durable, idempotent responsibility committed atomically with an Ingress Reservation to carry that verified delivery to one terminal Source Resolution after transport acknowledgement. It is recovery work, not a Run, provider retry, user-visible receipt, or execution queue entry.
_Avoid_: Admission, Run, Provider Delivery Intent, webhook retry

**Ingress owner**:
The single generation-fenced component authorized for one provider installation to receive and verify provider deliveries and to exercise its bounded source-thread reply authority. In relay modes this is the selected always-on relay; the matching local listener is not an owner.
_Avoid_: Every configured listener, execution owner, runner

**Local-direct mode**:
The trial deployment mode in which channel ingress and Agent execution share one user-controlled machine and one availability fault domain. It offers no provider-independent offline receipt or durable wait when that machine, network, or OpenTag service is unavailable.
_Avoid_: Offline-safe mode, always-on channel, local relay mode

**Team relay mode**:
The deployment mode in which an always-on relay outside the paired Runner's availability fault domain owns durable ingress and coordination while code and Agent execution remain on the user-controlled Runner. A relay on the same machine as the Runner does not qualify.
_Avoid_: Hosted execution, local background service, same-machine relay

**Runner-offline-safe**:
An exact-deployment capability proving that trusted source requests remain durably receivable, controllable, and queued while the paired Runner is unavailable. It says nothing about relay high availability beyond the separately declared availability envelope.
_Avoid_: Channel always-on, relay high availability, configured relay

**Source App Adapter**:
The versioned integration boundary that translates one collaboration or system-of-record App into OpenTag's provider-neutral source contract. One installable Adapter exposes narrow ingress, context, presentation, delivery, and capability ports while canonical reservation, lifecycle, permission, evidence, completion, retry, and settlement authority remain outside it.
_Avoid_: Lifecycle plugin, Provider state machine, one generic event handler, App-specific core branch

**Ingress ownership generation**:
A monotonically increasing fence for explicit transfer of a provider installation between ingress owners. Activity from a stale or ambiguous generation fails closed and cannot trigger local fallback.
_Avoid_: Credential generation, heartbeat, automatic failover

**Ingress owner transfer**:
A deadline-bounded, generation-fenced handoff in which the current owner drains and relinquishes production receive authority before a verified candidate gains reservation-only custody and then full ownership by compare-and-set. It never permits overlapping production owners, discards an acknowledged reservation, decreases a generation, or acts as automatic failover.
_Avoid_: Dual running, listener restart, relay heartbeat failover, generation rollback

**Reservation custody commit**:
The first Provider acknowledgement or durable offset advance by a transfer candidate that makes the Provider no longer responsible for redelivering the parked event to the old owner. From that point, the transfer cannot return directly to the old generation; candidate custody must survive until ownership advances and the event settles.
_Avoid_: Ingress reservation, owner compare-and-set, best-effort receipt, reversible preflight

**Provider installation revocation**:
An authenticated Provider deauthorization or authorized OpenTag administrator disconnect that atomically revokes one installation and advances both its credential and ingress-owner generations. It fences all prior listeners, callbacks, replies, controls, and unstarted work; reinstall creates new authority and never revives the old installation.
_Avoid_: Transient Provider outage, single unauthorized response, Runner disconnection, credential rotation

**Installation emergency posture**:
The generation-fenced, administrator-controlled safety posture that progressively pauses new Admission, execution, or Provider I/O for one installation during an incident without converting a reversible pause into revocation. It never renews intent, replays expired authority, or transfers ingress ownership.
_Avoid_: Installation lifecycle, runtime health, feature flag, automatic failover

**Adapter offline capability profile**:
The provider-adapter declaration of which channel mechanisms exist, such as in-place status update, private rejection, authenticated interactive controls, bounded attachment custody, authenticated deletion events, and stable source versions. It describes technical support, not whether a particular installation is configured, verified, or healthy.
_Avoid_: Installation certification, runtime health, provider-wide availability claim

**Offline-safe provider instance**:
A specific provider installation, endpoint and mode, ownership generation, credential generation, adapter version, deployed relay head, availability profile, and critical policy digest whose core offline-safe behavior has been verified together. Its certification is unsupported, configured unverified, verified, or stale; configuration or another installation's result cannot confer verified status.
_Avoid_: Provider-wide badge, ingress enabled, webhook configured, local-listener availability

**Release qualification key**:
The Provider type, adapter version, deployed head, region, availability profile, and critical policy digest qualified together through the shared Stage A–D rollout program. A change to any member creates a new release qualification that starts again at Stage A and cannot inherit the prior result.
_Avoid_: Provider installation, adapter family, deployment workflow, mutable environment

**Installation rollout unit**:
One exact Provider installation, endpoint/configuration digest, ingress mode, Ingress Owner generation, and credential generation evaluated under one Release Qualification Key. A local change makes only that unit unverified or stale and requires a new exact-installation canary; it does not reset the shared release program.
_Avoid_: Release qualification, Provider-wide certification, cohort result, runtime health

**Rollout cohort**:
A bounded, explicitly approved group of Installation Rollout Units sharing one Release Qualification Key and observed under one frozen rollout stage and evidence window. Cohort success may qualify that release for broader use but never certifies another installation.
_Avoid_: All customers, automatic percentage rollout, Provider-wide certification

**Provider operational health**:
The current observed health of one provider installation, reported independently as healthy, degraded, unavailable, or unknown. It does not erase certification history, manufacture verified capability, or authorize automatic ingress takeover.
_Avoid_: Offline-safe certification, Runner readiness, automatic fallback

**Declared availability envelope**:
The explicit fault scope within which a relay's SLO, RPO, and RTO apply. The initial Managed Relay envelope is one region across multiple availability zones; it does not claim survival of total regional loss.
_Avoid_: Global availability, absolute always-on, untested deployment topology

**Data residency region**:
The installation-bound region inside which Managed Relay keeps Provider plaintext, Source Context, attachments, execution-coordination content, backups, and the keys that make those records readable. It is immutable for that Installation; changing region requires a new region-migration authority rather than in-place mutation or failover.
_Avoid_: Availability zone, nearest region, automatic disaster recovery target, mutable routing hint

**Regional authority migration**:
An explicit generation-fenced replacement of one quiescent regional Installation by a new Installation in another Data Residency Region. It transfers no nonterminal work or readable source content, requires proof that old authority and ambiguous Provider replay are fenced, and is not an availability failover.
_Avoid_: Ingress Owner transfer, live queue migration, regional failover, local-listener takeover

**Relay custody**:
The disclosed trust boundary in which an always-on relay can observe provider plaintext at ingress and retain the minimum encrypted channel, command, identity, coordination, and reply data required for offline-safe operation, while local code, worktrees, full Context Packets, source-control credentials, and coding-agent credentials remain outside it.
_Avoid_: End-to-end encrypted transport, hosted execution, full workspace custody

**Managed relay key hierarchy**:
The region-pinned envelope-encryption hierarchy in which every Organization has an isolated tenant KEK family, every key purpose has a separate lineage and policy, and every stored secret or content object has its own DEK. Provider credentials, source content, attachments, and audit/replay material cannot unwrap one another's objects.
_Avoid_: Shared deployment key, one tenant-wide raw key, application-configured master secret, cross-region key replica

**Managed decryption grant**:
A short-lived, purpose-bound authorization to decrypt one exact tenant object under an allowed workload identity, Installation, generation, and lifecycle context. Runner grants additionally bind the current Run, Attempt, fencing token, and Project Target and are single-use; a grant never exposes a KEK or long-lived master key.
_Avoid_: Signed download URL, bearer master key, installation-wide read permission, reusable Runner credential

**Break-glass access request**:
A customer-authorized, dual-internal-approved, time-bounded request for a controlled viewer to read the minimum fields of one exact non-secret Managed Relay object for a named support or incident case. It grants no direct KMS key, bulk export, Provider-secret access, execution authority, or lifecycle mutation.
_Avoid_: Operator role, tenant-wide support access, Approval Request, legal demand, emergency-posture override

**Tenant authority context**:
The non-caller-selectable Organization, optional Installation, region, subject, capability, and authority-generation scope derived from a verified Provider installation, authenticated OpenTag session, or controlled workload identity and carried through every database, job, object, and KMS operation.
_Avoid_: Payload organization ID, URL tenant parameter, display-domain lookup, global object ID

**Tenant security mismatch**:
Any disagreement between the current Tenant Authority Context and a record, composite reference, job, delivery target, object encryption context, or KMS purpose. It fails closed without an existence-revealing reply and triggers attributable security response for every safely identified affected Installation.
_Avoid_: Not found, retryable application error, automatic tenant remapping, display-name collision

**Source Context Envelope**:
The immutable, encrypted, provenance-bearing source-thread context frozen for one Invocation at Admission. It contains the trigger plus at most the preceding 20 messages from the same thread and at most 64 KiB of decoded text, records any truncation, and excludes cross-thread history, local workspace context, and attachment bodies.
_Avoid_: Full channel history, live mutable thread, Context Packet

**Source content withdrawal**:
A verified Provider deletion event or protected OpenTag control proving that a specific source message version or captured object is no longer authorized for use. Every nonterminal intent whose immutable Source Context Envelope depends on that content is invalidated as source content deleted; an Envelope is never partially rewritten and then executed.
_Avoid_: Message edit, human Run cancellation, Provider-side status deletion

**Attachment custody**:
An installation- or binding-scoped, explicitly disclosed capability allowing the relay to capture only attachments required by one Invocation before Admission. It is disabled by default and requires bounded size and type policy, content inspection, malware scanning, encrypted versioned storage, and one-time Attempt-bound reads.
_Avoid_: Attachment metadata, ambient channel file access, arbitrary URL fetching

**Relay content retention**:
The lifecycle-bound period during which encrypted command text, Source Context Envelopes, and captured attachment bytes remain readable for execution. Managed Relay retains them while their Run is nonterminal and for seven days after terminal settlement; this is separate from longer content-free audit retention.
_Avoid_: Audit retention, indefinite history, provider-side retention

**Replay tombstone**:
A content-free, tenant-keyed non-reversible identity retained after content deletion to prove prior processing and prevent an old provider delivery from recreating work. The Managed Relay default is 90 days after terminal settlement.
_Avoid_: Recoverable message copy, source event, legal hold

**Invocation**:
An authenticated, recognized request for OpenTag action from a known provider installation and source identity. An invocation may be admitted or rejected and is not itself a run.
_Avoid_: Provider delivery, mention, Run

**Cross-channel handoff token**:
An OpenTag-signed, single-use token bound to an originating Invocation or Run, destination installation and source anchor, actor authority, Project Target, purpose, and short expiry. It is the only initial mechanism that may identify a cross-channel event as an explicit handoff rather than new intent.
_Avoid_: Copied Run ID, matching message text, reusable link, account mapping

**Admission receipt**:
Evidence that admission created or idempotently recovered a canonical run. It is the earliest point at which OpenTag may present a request as received to the source user.
_Avoid_: Transport acknowledgement, ingress reservation

**Source resolution**:
The durable, safe outcome OpenTag intends to present for a trusted invocation, whether accepted, waiting, rejected, misconfigured, invalid, or temporarily unavailable. Provider acceptance of that presentation is tracked separately.
_Avoid_: Transport acknowledgement, Run result, delivery success

**Provider delivery intent**:
An immutable, idempotent obligation to present one current semantic status through an authorized Provider path. It may be superseded by newer canonical truth, but it never owns or changes the Run or Source Resolution it projects.
_Avoid_: Provider message, Run transition, retry attempt, guessed fallback

**Provider delivery deadline**:
The frozen last instant at which OpenTag may automatically attempt a Provider Delivery Intent under its original presentation authority. Passing it abandons the presentation obligation without changing the Run or claiming that the user saw the status.
_Avoid_: Run deadline, retry delay, renewable timeout

**Provider status anchor**:
The durable, recoverable source-side projection for an admitted run. When the provider permits in-place updates, OpenTag maintains one anchor across meaningful lifecycle transitions; reactions and ephemeral messages may assist but cannot be the sole receipt for admitted work. The anchor never owns or determines Run state.
_Avoid_: Heartbeat feed, Run authority, ephemeral-only receipt, status-text command

**Durable admission quota**:
A tenant-scoped, transactionally reserved limit on new trusted execution intent, follow-up depth, Invocation rate, or captured-attachment storage. It is evaluated after provider verification and replay detection, so duplicates do not consume capacity and accepted intent cannot leak or double-count slots across crashes.
_Avoid_: Edge WAF limit, Runner concurrency, Provider outbound rate limit

**Protected control budget**:
Capacity reserved independently from work creation for cancellation, status, deletion, security response, and administrator remediation. Exhausting Admission or storage quota cannot disable these controls.
_Avoid_: Execution-intent quota, billing allowance, Runner capacity

**Run cancellation command**:
An authorized, idempotent human request to the run coordinator to stop a nonterminal run. It is issued by the originating invocation actor or a currently authorized administrator or operator—not by an attempt. Coordinator-owned timeout and invalidation are separate terminal authorities and never impersonate a human cancellation.
_Avoid_: Attempt stop, executor result

**Run invalidation**:
A coordinator-owned terminal decision that an unstarted run can no longer execute under its admitted authority, integrity, target-version, workspace-isolation, or source-content boundary. It settles the run as cancelled with a closed reason such as installation revoked, authorization revoked, binding changed, policy revoked, affinity revoked, target version changed, target identity mismatch, workspace not isolated, source content deleted, or integrity failure and cannot be reversed.
_Avoid_: Temporary placement block, user cancellation, queue timeout

**Placement disposition**:
The closed classification of a failed Placement check as retryable waiting, terminal Run invalidation, or exact-action approval. It determines whether the run remains queued, becomes cancelled, or enters needs approval.
_Avoid_: Unstructured routing error, generic unavailable state

**Approval Request**:
A finite, immutable request created for one exact action by a current fenced Attempt after every non-approval Placement check passes. It binds the Run, Attempt, fencing token digest, originating actor, Project Target and resource version, action and parameter digest, permission ceiling, expected side effects, and a non-renewable deadline.
_Avoid_: Run-wide approval, reusable consent, policy broadening, delivery button

**Approval grant**:
An attributable, one-time coordinator fact approving one still-current Approval Request. It authorizes consumption only by the bound Attempt before the deadline; it is not evidence that the action ran or succeeded and cannot survive an Attempt, action, target, authority, policy, credential, or installation change.
_Avoid_: External action receipt, future Attempt permission, blanket administrator waiver

**Attempt stop observation**:
Fenced evidence from the current runner that an attempt stopped after cancellation or interruption. It does not authorize cancellation or own the run's terminal outcome.
_Avoid_: Run cancellation command, terminal decision

**Follow-up request**:
An immutable, independently attributable invocation queued behind the active run in the same Run Scope. It preserves its own source event, actor, policy snapshots, order, and Source Resolution and never rewrites the active run.
_Avoid_: Run amendment, appended prompt, active Run mutation

**Follow-up promotion**:
The explicit or policy-authorized Admission of a queued, unexpired follow-up as a new run after the prior active run settles. Automatic promotion is permitted only after the prior run succeeds; failure, cancellation, timeout, interruption, or unknown outcome leaves follow-ups paused for the originating actor or an operator with run:promote authority.
_Avoid_: Retry, continuation inside the active Run, automatic promotion after any terminal state

**Follow-up promotion deadline**:
The immutable latest instant at which a follow-up may enter Admission, calculated from its own durable enqueue time using the binding waiting duration. It never resets; expiry is terminal, and any promoted run remains capped by the same instant.
_Avoid_: Retention TTL, renewable pause, new Run waiting window

**Runner affinity**:
An admission-time constraint limiting which runner and executor may later receive placement without asserting that either is currently ready. The first offline-safe profile has exactly one paired runner affinity.
_Avoid_: Assignment, online runner, claim

**Runner device identity**:
An Organization-scoped Runner ID, device public key, credential generation, bounded Project Target/Executor capability ceiling, and lifecycle held by the Runner Directory. Its private key remains in the device's OS secure store, and a replacement device always receives a new identity.
_Avoid_: Runner display name, hostname, local process, reusable pairing token

**Runner pairing challenge**:
A locally initiated, one-time, short-lived proof of possession for a candidate device public key that has no execution authority until a current Organization administrator approves its exact Runner, Project Target, Executor, and capability scope. Provider channel messages cannot create or approve it.
_Avoid_: Login session, channel command, long-lived API token, Runner session

**Runner session capability**:
A short-lived token minted only after the current Runner device key signs a fresh challenge. It binds Organization, Runner, credential generation, Project Target, Executor, protocol version, capability ceiling, and expiry but still requires current readiness and coordinator Placement before any Run can execute.
_Avoid_: Device private key, Attempt lease, readiness receipt, Provider credential

**Project Target policy**:
An administrator-approved, digest-addressed definition of one local execution target: canonical repository identity, allowed remote and base reference, version-resolution mode, workspace and Execution Isolation requirements, Egress Profile, executor and source-control ceilings, approval-eligible boundaries, and minimum secret references. The Runner owns the local path mapping; Provider messages can select only an already authorized Project Target ID and can never supply or override a filesystem path.
_Avoid_: Chat-provided checkout path, ambient current directory, latest branch by convention

**Target version resolution**:
The Admission-frozen rule for choosing the exact base revision of a Run. Provider-backed work pins the authoritative pull-request or merge-request revision when it can be proved at Admission; otherwise the explicit `resolve_at_claim` mode permits the first valid Workspace Attestation to atomically freeze one exact revision for every later Attempt.
_Avoid_: Resolve latest on every retry, mutable branch head, Runner-selected version policy

**Workspace attestation**:
A signed, Attempt-preceding Runner fact binding Organization, Runner, Project Target, canonical repository and remote identity digests, base reference, exact revision, workspace identity and isolation mode, cleanliness and containment results, Target Policy Digest, and Runner credential generation. It proves only the inspected local workspace state and must match current Placement authority before Claim.
_Avoid_: Configured path, heartbeat, executor self-report, hosted knowledge of a local path

**Isolated execution workspace**:
An Attempt-scoped worktree or equivalent safe workspace created from the frozen exact revision and kept separate from the user's interactive checkout. OpenTag never obtains isolation by resetting, cleaning, force-checking-out, implicitly stashing, overwriting uncommitted work, deleting untracked files, or escaping the approved target root.
_Avoid_: User working tree, automatic cleanup, shared mutable checkout

**Execution Isolation Profile**:
The Admission-frozen, versioned maximum execution boundary for one Run. It separately declares filesystem, process, network-egress, Secret Broker, source-control, and external-write authority as `sandboxed_restricted`, `sandboxed_approved_egress`, or truthfully disclosed `unsandboxed_local`; Provider offline-safe certification does not prove or select it.
_Avoid_: Provider availability mode, executor name, configured sandbox flag, implicit host access

**Execution Isolation Attestation**:
A current Runner-signed fact and enforcement-probe digest proving which Execution Isolation Profile the operating system, container, or virtualized runtime can actually enforce for the candidate workspace. A declaration or successful process spawn is insufficient, and the executor cannot run until the post-Claim launch receipt matches it.
_Avoid_: Workspace Attestation, capability advertisement, best-effort shell wrapper

**Egress Profile**:
The immutable network ceiling within an Execution Isolation Profile: default-denied or an allowlist of exact destination classes, schemes, hosts, ports, proxy/TLS expectations, and approval-eligible boundaries. DNS, address, proxy, or capability changes are new authorization decisions, not equivalent endpoints by name.
_Avoid_: General internet access, inherited host proxy, chat-supplied URL, successful DNS lookup

**Attempt Secret Grant**:
A short-lived, single-purpose authorization from the local Secret Broker to expose one approved Secret Reference only to the exact Organization, Run, Attempt, Fencing Token, Project Target, executor, operation, and expiry. It never becomes ambient parent-shell state or grants discovery of Keychain, SSH-agent, environment, or other secret stores.
_Avoid_: Whole environment injection, reusable API token, secret value in Run state, Runner session capability

**External Operation Intent**:
A coordinator-owned, durable, idempotency-addressed authorization recorded before one material external write. It binds the current Attempt and fencing token, exact capability, destination and request digests, expected side effects, and reconciliation policy; recording it does not prove the action started or succeeded.
_Avoid_: Approval Request, tool call log, Provider receipt, execution success

**External Operation Receipt**:
Authoritative result evidence from the external system or a safely reconcilable operation identity, bound to one External Operation Intent. Absence or ambiguity produces `outcome_unknown`; an executor summary is not a receipt.
_Avoid_: Agent assertion, process exit code, Provider delivery receipt, Approval grant

**Publication policy**:
The Admission-frozen maximum for whether a Run may remain `proposal_only` or publish an owned Run Branch and pull request, including repository, remote, base reference and revision, naming/ownership rules, source-control capabilities, and base-drift behavior. It is frozen alongside but remains distinct from the Completion Contract, and execution success cannot broaden either one.
_Avoid_: Agent preference, available Git credential, repository default behavior, merge permission

**Publication candidate**:
The immutable local result offered for a separate Publication decision: Organization, Run, Project Target, frozen base revision, final Workspace Tree Digest, proposed commit metadata digest, verification evidence, and Publication Policy Digest. It is evidence of produced work, not evidence that a remote branch or pull request exists.
_Avoid_: Working directory, executor summary, remote branch, completed work

**Run Branch Ownership Record**:
A coordinator-owned binding of one deterministic, collision-resistant remote branch identity to the exact Organization, Run, Project Target, repository/remote, frozen base revision, Publication Policy Digest, and last authoritative remote head. It never authorizes force-push, deletion, takeover of an unknown branch, or reuse by another Run.
_Avoid_: Branch-name convention, local branch, source-control credential, pull-request ownership

**Publication Intent**:
A Publication-specific External Operation Intent authorizing one exact branch push, pull-request creation, or pull-request update after a Publication Candidate and current Run Branch Ownership Record pass policy. Retry first reconciles the remote identity and head; ambiguity becomes `outcome_unknown` rather than a second publication.
_Avoid_: Execution success, Source-thread delivery intent, Agent tool call, generic push permission

**Publication receipt**:
Authoritative source-control evidence for one Publication Intent, such as exact repository, remote branch resource, branch head SHA, pull-request identity, pull-request head SHA, and accepted operation identity. A URL, local commit, or Agent report alone is not a receipt.
_Avoid_: Artifact link, local Git output, PR presentation, completion assessment

**Base advanced**:
A truthful Publication fact that the target base reference no longer points at the Admission-frozen base revision. Under the default pull-request policy it may permit publication with reduced evidence claims; under strict-base policy it blocks publication as `publication_base_changed`. It never authorizes automatic rebase, merge, or force-push.
_Avoid_: Target version changed before execution, stale test success, automatic conflict resolution

**Placement**:
The fenced assignment of an admitted run to a currently eligible runner and executor, creating an attempt only after current authority, readiness, target, Workspace and Execution Isolation Attestations, exact version, isolation, capability, and capacity checks pass.
_Avoid_: Admission, queueing

**Attempt**:
One lease-bound execution of a run by a runner.
_Avoid_: Run

**Execution success**:
The outcome that an executor finished its bounded run successfully and produced its declared local evidence; it is not proof that a Publication Candidate was accepted, a branch or pull request exists, checks passed, a merge occurred, or the work is complete.
_Avoid_: Published, pull request opened, checks passed, merged, complete, accepted

**Completion contract**:
The Admission-frozen, coordinator-owned definition of which exact evidence gates must pass before a Run may succeed: `proposal_ready`, `pull_request_ready`, `review_accepted`, or Provider-observed `merged`. The default is proposal readiness for proposal-only Runs and exact-head pull-request readiness for pull-request Runs; v1 never auto-merges.
_Avoid_: Agent success claim, workflow, DAG, mutable repository default, merge permission

**Completion gate**:
One finite requirement within a Completion Contract, evaluated independently against immutable local artifacts, authoritative Publication Receipts, exact-head Provider checks, current-head review, or Provider-observed merge. Evidence from another Candidate, repository, pull request, or head cannot satisfy it.
_Avoid_: Step, task, latest available check, branch-wide approval

**Completion assessment**:
An immutable coordinator evaluation of one frozen Completion Contract against the facts known for one exact Candidate or repository, pull request, and head. A later head or Provider-state change creates a superseding assessment and current Work Thread projection; it never rewrites the historical Run terminal fact.

Every governed assessment binds its delivery gates to one resolved target and resource version for the current work cycle. For the Phase 1 GitHub profile, the pull request artifact, required checks, and merge state must all refer to the same repository, pull request, and head SHA; facts from different targets or older heads cannot be combined into completion.
_Avoid_: Run result, mutable checklist, Provider status text, retroactive terminal rewrite

**Completion gate waiver**:
An attributable, expiring, one-use exception for one explicitly waiver-eligible gate, bound to the exact Completion Contract, Run, Candidate or pull-request head, authorizing principal, and reason. It cannot waive an unknown external outcome, cross a head change, or broaden Publication or merge authority.
_Avoid_: Blanket approval, repository setting, reusable override, Agent request

**Post-completion drift**:
A current Work Thread fact that an external pull request changed, closed unmerged, or became unverifiable after an immutable Completion Assessment had already settled the Run. It supersedes the current presentation without falsifying or rewriting the historical exact-head assessment.
_Avoid_: Run rollback, hidden status regression, historical evidence mutation

**Verification evidence**:
A typed claim about an artifact or external fact whose assurance states whether it was verified, merely reported, or cannot be verified.
_Avoid_: Agent summary, proof by assertion

**Human escalation**:
A durable, attributable request for human attention when policy or verified evidence cannot safely resolve a blocking condition.
_Avoid_: Approval, notification

**Waiver**:
An attributed human decision that accepts explicitly selected unsatisfied gates without erasing their underlying evidence state.
_Avoid_: Approval, automatic success
