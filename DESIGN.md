# OpenTag Product Design

## Source of truth

- Status: Draft
- Last refreshed: 2026-07-21
- Primary product surfaces: source-thread interactions, local CLI/status, optional operator console
- Architecture proposal: [Software Factory Control Plane](./docs/software-factory-control-plane.md)
- Evidence reviewed:
  - [README.md](./README.md)
  - [Current architecture baseline](./docs/design.md)
  - [Agent Work Protocol](./docs/agent-work-protocol.md)
  - [Thread Runtime Alignment](./docs/thread-runtime-design.md)
  - `packages/core/src/schema.ts`
  - `packages/dispatcher/src`
  - `packages/runner/src/executor.ts`
  - `packages/store/src/repository.ts`

This document is the durable product and interaction-design contract for the
next OpenTag product direction. It does not claim that every described factory
capability is implemented today. The architecture proposal marks the current
baseline, proposed additions, and rollout gates explicitly.

## Brand

- Personality: calm, precise, trustworthy, open, and operationally serious.
- Trust signals: explicit actor and agent identity, visible policy decisions,
  bounded permissions, stable run IDs, evidence-backed completion, and an
  explainable path from a source request to every material action.
- Avoid:
  - magical autonomy claims;
  - anthropomorphic agent theater;
  - dashboards that resemble a replacement project-management system;
  - raw chain-of-thought, tool-trace, or terminal-stream noise in human threads;
  - vendor-specific language in protocol concepts;
  - declaring work complete because an executor exited successfully.

Canonical category statement:

> OpenTag is the open control plane for governed software factories.

Supporting product statement:

> OpenTag connects the systems where work is defined to the agents and
> environments where work gets done, governing context, permissions,
> execution, evidence, and human oversight without replacing either side.

## Product goals

- Goals:
  - Let teams assemble a governed software factory from the work systems,
    coding agents, source-control hosts, CI systems, and local environments they
    already use.
  - Keep the simplest path as simple as an explicit mention or work-item action.
  - Make every accepted run attributable, bounded, inspectable, stoppable, and
    evidence-producing.
  - Distinguish executor success from accepted work completion.
  - Route scarce human attention to explicit decisions instead of streaming
    routine agent activity.
  - Preserve local/private execution as a first-class deployment mode.
  - Remain executor-neutral and workspace-provider-neutral.
- Non-goals:
  - Become a backlog, roadmap, issue-tracking, or planning system of record.
  - Become an AI IDE, source-code host, CI/CD engine, deployment engine, or
    general-purpose agent runtime.
  - Require teams to move work into a new chat workspace.
  - Store raw repository content, credentials, complete transcripts, or tool
    traces in a hosted control plane by default.
  - Encode one mandatory engineering methodology, issue hierarchy, or factory
    recipe in core.
  - Optimize for maximum autonomous task volume without quality and governance
    constraints.
- Success signals:
  - A real work item can move from explicit admission through local agent
    execution to PR/check/merge evidence and an accepted completion assessment.
  - A user can answer why a run was admitted, where it ran, what authority it
    received, what it changed, and why it is or is not complete.
  - Routine successful work produces little source-thread noise.
  - Missing evidence, ambiguous side effects, and policy violations fail closed
    and result in a clear next action.
  - Teams can change work-system, executor, or runner vendors without replacing
    OpenTag's governance record.

## Personas and jobs

- Primary personas:
  - Engineering lead operating several coding agents across a small or
    medium-sized team.
  - Developer who wants an agent to use the local checkout, tools, and
    credentials without surrendering them to a hosted workspace.
  - Platform or security owner who needs policy, access, audit, and data-residency
    controls around agent execution.
  - Operator responsible for runner readiness, stuck work, exceptions, and
    factory-level performance.
- User jobs:
  - Start governed agent work from the place where the work is already defined.
  - Know whether work was accepted, queued, running, waiting, or actually
    complete.
  - Approve, reject, clarify, stop, retry, or waive a specific decision without
    joining an agent's private execution session.
  - Inspect the evidence behind completion and the receipts behind external
    writes.
  - Compare execution paths by accepted outcomes, not by raw agent activity.
  - Configure organization and repository policies once and apply them across
    work surfaces and executors.
- Key contexts of use:
  - A GitHub, GitLab, Linear, Slack, Lark, or similar source thread.
  - A local terminal running `opentag` and a user-controlled runner.
  - An optional operator console used for policy, runner, decision, audit, and
    metric views—not work planning.

## Information architecture

- Primary navigation:
  - Source-thread actions: invoke, status, stop, respond to a decision, and view
    the final evidence summary.
  - CLI: setup/readiness, active work, run detail, audit timeline, decisions,
    policy explanation, and completion explanation.
  - Optional console: overview, work loops, decisions, runners, policies,
    evidence/audit, and factory metrics.
- Core routes/screens:
  - `Overview`: exceptions and factory health before activity volume.
  - `Work loops`: derived execution/governance state grouped by external work
    reference; never a replacement backlog.
  - `Run detail`: admission, context snapshot, routing, attempts, actions,
    artifacts, evidence, completion assessment, and callbacks.
  - `Escalation inbox`: only unresolved human escalations, deduplicated and
    ordered by urgency and impact.
  - `Runners`: identity, locality, capability, readiness, capacity, and current
    leases.
  - `Policies`: organization/repository policy sources, resolved snapshots, and
    explanation previews.
  - `Metrics`: accepted throughput, time to accepted completion, retry load,
    evidence quality, intervention load, and cost.
- Content hierarchy:
  1. Current outcome or blocking condition.
  2. The next safe action.
  3. Evidence and policy explanation.
  4. Detailed timeline and diagnostic data.

## Design principles

### Existing work remains canonical

External work systems own priority, planning metadata, and business workflow.
OpenTag owns the execution-governance record attached to that work. A durable
`WorkThread` holds only OpenTag-owned cross-run governance state, and the
work-loop view is a projection over that root, external references, runs,
evidence, and escalations—not a shadow ticket.

### Simple invocation, progressive governance

The common case should still begin with one explicit action. Policy, routing,
and evidence machinery should be visible when it changes an outcome or when a
user asks for explanation, not as mandatory ceremony before every run.

### Evidence before narrative

An executor's final summary is useful communication, but not proof. Completion
must resolve configured gates against receipts, artifacts, external checks, and
human decisions and waivers with known assurance levels.

### Human attention is a scarce resource

OpenTag should interrupt people only for decisions that cannot be resolved by
policy or verified evidence. Routine progress belongs in the audit timeline and
pull-based status surfaces.

### Local-first is a trust boundary

Raw code, local credentials, full tool traces, and private workspace state stay
on the runner by default. A managed control plane may receive normalized state,
redacted summaries, hashes, receipts, and evidence metadata according to policy.

### Explain every control decision

Admission, routing, permission, retry, escalation, and completion decisions
must carry stable reason codes plus human-readable explanations.

### Provider-native interaction, protocol-native meaning

Adapters should use native reactions, cards, comments, buttons, and status
updates where available. Their meaning must come from OpenTag semantic
presentation objects rather than provider-specific workflow logic.

### Tradeoffs

- Prefer deterministic eligibility and policy checks over opaque optimization.
- Prefer a quiet source thread over continuous progress visibility.
- Prefer an explicit `needs_human` outcome over a guessed or unsafe action.
- Prefer additive protocol evolution over replacing current run semantics.
- OpenTag as a whole is the control plane; prefer one deep
  `@opentag/governance` module over one package for every factory concept.

## Visual language

- Color:
  - In provider surfaces, inherit provider-native semantics.
  - In a future console, use neutral surfaces with restrained semantic colors:
    green only for accepted completion, amber for waiting/uncertain, red for
    policy or verification failure, and blue for active/informational state.
  - Do not use green for executor success when completion is still pending.
- Typography:
  - Favor high-legibility system or product-native type.
  - Use monospace only for identifiers, commands, reason codes, and compact
    evidence values.
- Spacing/layout rhythm:
  - Use a compact operational density with clear section separation.
  - Keep the primary status and next action above timelines and raw detail.
- Shape/radius/elevation:
  - Use modest radius and minimal elevation. Trust should come from hierarchy
    and evidence, not decorative depth.
- Motion:
  - Motion is optional and functional: state transitions, refreshed evidence,
    and expanding detail. No ambient agent-working animations.
- Imagery/iconography:
  - Use consistent icons for work, run, runner, policy, evidence, decision, and
    completion concepts.
  - Avoid robot avatars as the primary identity system; display stable executor
    and access-profile identities instead.

## Components

- Existing components to reuse:
  - Semantic `OpenTagPresentation` objects and provider renderers.
  - Run-status, action-receipt, doctor-summary, and final-summary projections.
  - CLI status and audit output conventions.
  - Platform capability and liveness strategies.
- New/changed components:
  - `WorkLoopSummary`: external work reference plus derived governance phase.
  - `CompletionAssessment`: overall status, gate results, assurance, and next
    action.
  - `HumanEscalationCard`: one approval, missing-input, configuration,
    verification, reconciliation, or security escalation with the correct
    audience, scope, expiry, and consequence.
  - `RoutingExplanation`: selected runner/executor and rejected candidates with
    stable reasons.
  - `EvidenceList`: artifact, receipt, check, deployment, and human evidence
    grouped by completion gate.
  - `FactoryHealthSummary`: exceptions, queue pressure, completion performance,
    and runner readiness.
- Variants and states:
  - Work: ready, queued, executing, verifying, waiting for human, complete, and
    closed incomplete.
  - Completion: pending, satisfied, unsatisfied, blocked, and waived.
  - Escalation: open, acknowledged, resolved, expired, and superseded.
  - Evidence: verified, reported, and unverifiable.
  - Action: authorized, waiting, denied, reconciled, unknown, and stale.
- Token/component ownership:
  - Core owns semantic state and presentation data.
  - Provider adapters own native rendering only.
  - A future console owns visual tokens and layout primitives.
  - Recipes and policies may configure labels and gates but may not redefine
    protocol state semantics.

## Accessibility

- Target standard: WCAG 2.2 AA for any first-party web console.
- Keyboard/focus behavior:
  - Every decision can be inspected and resolved without a pointer device.
  - Destructive or authority-expanding decisions require a distinct confirmation
    step and clear focus placement.
- Contrast/readability:
  - State is never communicated by color alone.
  - Identifiers and reason codes remain selectable and copyable.
- Screen-reader semantics:
  - Status changes use appropriate live-region behavior without repeatedly
    announcing routine progress.
  - Timelines, gate groups, and decision options use semantic headings and lists.
- Reduced motion and sensory considerations:
  - Respect reduced-motion preferences.
  - Do not use blinking, pulsing, or sound for normal agent activity.

## Responsive behavior

- Supported breakpoints/devices:
  - Source-thread experiences inherit each provider's supported clients.
  - A future console supports current desktop browsers and a narrow mobile view
    for status and decisions.
- Layout adaptations:
  - Desktop may use summary/detail panes.
  - Narrow screens collapse to outcome, next action, evidence, then timeline.
  - Large policy payloads and raw diagnostic records remain scrollable and
    copyable without forcing the whole page wider.
- Touch/hover differences:
  - Critical explanation is never hover-only.
  - Decision targets meet accessible touch-size guidance.

## Interaction states

- Loading:
  - Show which projection is loading and the last known update time.
  - Never imply a run is still alive solely because a view is loading.
- Empty:
  - Prefer actionable empty states such as “No decisions need attention” or “No
    eligible runner is registered for this project.”
- Error:
  - Separate transport failure, policy denial, execution failure, unknown side
    effect, and completion-gate failure.
  - Always provide a stable reason code and the next safe action.
- Success:
  - Reserve “Complete” for a satisfied or explicitly waived completion
    assessment, and make waivers visible.
  - Use “Execution succeeded” when the executor completed but evidence gates are
    still pending.
- Disabled:
  - Explain the missing permission, unsupported capability, stale state, or
    unresolved prerequisite.
- Offline/slow network:
  - Display cached state timestamps.
  - Local runners continue according to their lease and policy; UIs must not
    invent completion while disconnected.

## Content voice

- Tone: concise, factual, calm, and accountable.
- Terminology:
  - “work item” for an external planning object;
  - “work loop” for OpenTag's governed execution projection;
  - “run” for one accepted execution request;
  - “attempt” for one lease-bound runner execution;
  - “execution succeeded” for executor-level success;
  - “complete” only after completion gates pass;
  - “needs your decision” for actionable human attention;
  - “unknown” when a side effect cannot be reconciled.
- Microcopy rules:
  - Lead with outcome, then reason, then next action.
  - Name the actor, target, and scope for material decisions.
  - Do not say “the agent handled it” without artifact or evidence references.
  - Do not expose internal prompts, chain-of-thought, or raw credentials.
  - Provider callbacks stay short and link or point to deeper audit detail.

## Implementation constraints

- Framework/styling system:
  - There is no required first-party web console in the first control-plane
    milestone.
  - Source-thread and CLI surfaces remain primary.
  - If a console is added, it consumes the same control-plane query/projection
    interface as CLI and adapters.
- Design-token constraints:
  - No new cross-platform visual token system is required until a first-party
    web surface exists.
  - Semantic status tokens belong in core; visual tokens belong to the console.
- Performance constraints:
  - Admission and status responses must not depend on fetching complete raw
    transcripts or repository contents.
  - Work-loop views should be event-derived projections that can later be cached
    without changing their interface.
  - Source-thread acknowledgement must remain fast even when routing or evidence
    evaluation continues asynchronously.
- Compatibility constraints:
  - Preserve current `OpenTagRun`, `Attempt`, `ContextPacket`, action receipt,
    and executor-adapter behavior through additive changes.
  - Existing source adapters remain transport/rendering adapters.
  - Existing work systems remain systems of record.
- Test/screenshot expectations:
  - Protocol and control decisions require schema, transition, idempotency, and
    fail-closed tests.
  - Provider renderers require snapshot or structured-output tests for pending,
    failed, needs-human, and complete states.
  - A future console requires keyboard, screen-reader, responsive, and visual
    regression coverage for the critical decision and completion flows.

## Open questions

- [x] The first supported repository profile requires a pull-request artifact,
      provider-verified configured checks for the current head revision, and a
      provider-verified merge. Deployment and human acceptance remain optional
      gates. / Product + engineering / Resolved for Phase 1.
- [ ] Should the first operator surface be CLI-only or include a small read-only
      web console? / Product / Changes presentation scope, not protocol design.
- [ ] Which policy sources are required first: repository file, local config, or
      managed organization policy? / Engineering / Determines policy precedence
      and snapshot provenance.
- [ ] What redacted portion of `ContextPacket` may a managed control plane retain
      by default? / Security + product / Determines hosted data-residency posture.
- [ ] When may policy automatically retry a failed completion gate, and what
      budget ends the loop? / Product + security / Prevents retry amplification.
- [ ] Which external work-system mutations are allowed after completion, and
      which always require explicit intent? / Product / Preserves the no-shadow-
      ticket and narrow-write boundaries.
