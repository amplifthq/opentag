# ADR 0001: Attribute Accepted Progress from Completion Evidence

- Status: Accepted
- Date: 2026-08-04; current profile clarified 2026-09-04
- Decision owners: OpenTag maintainers

## Context

OpenTag keeps execution outcome separate from accepted work completion. A Run
and its fenced Attempts describe what executed and what it cost. A
`CompletionAssessment` describes whether the external WorkItem's configured
completion gates are satisfied by current authoritative evidence.

The answer to “is this WorkThread accepted?” is different from the answer to
“which Runs produced the evidence that advanced its completion gates?” A latest
Run is not necessarily the producer of the evidence that changed an assessment.
Repository readback, provider observations, artifacts, and human decisions may
also contribute to one assessment.

This ADR defines a derived attribution projection for the second question. It
does not create another completion authority.

## Decision

### CompletionAssessment remains the sole completion authority

Current WorkThread acceptance comes only from the current
`CompletionAssessment`, including its contract identity, cycle, immutable
lineage, gate results, target bindings, waiver attribution, and accepted time.

`triggeredByRunId` records what caused an assessment to be evaluated. It is not
proof that the triggering Run produced every accepted gate result.

### Accepted progress is a derived projection

`AcceptedProgressAttribution` is recomputed from:

- adjacent immutable assessments in the same WorkThread, contract version, and
  cycle;
- gate transitions into an accepted evidence state;
- the accepted assessment's resolved target bindings;
- the referenced completion artifact's durable `sourceRunId` provenance.

The projection is not a `run_acceptances` table. It does not participate in
completion compare-and-swap and cannot make a WorkThread accepted.

Assessment supersession remains continuous at the WorkThread head. Attribution
stops when the predecessor belongs to another contract version or cycle. A
missing predecessor in otherwise required lineage is invalid lineage, not a
harmless unresolved attribution.

An accepted gate advance is a gate whose current result is `passed` and whose
predecessor in the same assessment lineage was absent or was not `passed` for
the same accepted target. Reassessment that preserves an already-passed gate is
not new progress. A new completion cycle is independent.

When a gate names a `targetKey`, attribution follows the accepted assessment's
target binding to its `artifactId`, then follows that artifact's `sourceRunId`.
The Run receives credit only when the chain resolves to exactly one durable Run
in the same WorkThread. No unique provenance means no Run credit.

Artifact producer identity is assigned at the trusted Run-result persistence
boundary. A Runner-supplied `sourceRunId` cannot reassign an artifact to
another Run. Any cross-Run provenance relation needs its own verified authority.

Several Runs may contribute different gate advances to one accepted assessment.
OpenTag retains those contributions independently and does not invent one
completion owner.

### Human and provider authority are not coerced into Run ownership

A waiver, human-acceptance gate, or provider-owned gate without unique artifact
provenance may advance the CompletionAssessment while remaining unattributed to
a Run. The projection records the advance and an explicit unresolved reason. It
does not fall back to the latest Run, assessment trigger, latest successful
Attempt, or last executor.

### Execution usage remains separate

Attempt counts, locality, Runner, executor, and cost units come from fenced
Attempt records. Accepted-progress metrics may be grouped by a Run's terminal
Attempt only after the gate-to-artifact-to-Run provenance chain selects that
Run. Execution usage is never evidence of acceptance by itself.

### Read models use truthful names

Status and aggregate read models distinguish:

- accepted WorkThreads: current CompletionAssessments in a satisfied or valid
  waived state;
- accepted gate advances: derived transitions into accepted evidence states;
- Runs with accepted progress: distinct Runs with at least one uniquely
  attributed accepted gate advance;
- unresolved accepted advances: accepted advances with no unique Run provenance.

The latest-Run `acceptedCompletions` calculation is not a valid attribution
source and must not be reintroduced under another name.

Malformed assessment authority or broken same-authority lineage fails visibly.
The system must not omit the affected WorkThread and return a plausible but
incorrect lower count.

## Consequences

Positive consequences:

- accepted completion and execution remain separate authorities;
- Run credit is explainable down to assessment, gate, target, artifact, and
  source Run;
- multiple contributing Runs are represented without forcing a winner;
- replay and restart recompute the same projection from durable evidence;
- missing provenance remains visible instead of being guessed.

Costs:

- attribution queries load assessment lineage and artifact provenance;
- acceptance-rate language must use gate-advance and contributing-Run terms;
- human/provider-owned acceptance may intentionally have zero attributed Runs;
- historical assessments without artifact provenance may remain unresolved.

## Rejected alternatives

### Credit the latest terminal Run

Rejected because temporal order is not causal provenance.

### Credit `triggeredByRunId`

Rejected because it identifies the reassessment trigger, not the producer of
each accepted gate's evidence.

### Add a durable RunAcceptance entity

Rejected because it would duplicate derivable facts and risk becoming a
competing acceptance authority. A future cache must remain rebuildable from
assessment and artifact evidence.

### Force one Run to own the whole completion

Rejected because one WorkThread can combine evidence from several Runs and
human/provider-owned authority.

## Validation requirements

Implementations must prove:

1. One passed gate with one artifact and one `sourceRunId` credits that Run.
2. An unchanged passed gate produces no new advance.
3. Different gates may credit different Runs in one assessment.
4. Waiver or missing/ambiguous provenance credits no Run and records why.
5. A later unrelated Run cannot inherit accepted progress.
6. Restart and replay derive identical attribution and metrics.
7. WorkThread acceptance remains owned by CompletionAssessment.
8. A new contract version or cycle starts an independent projection.
9. A Runner cannot transfer artifact credit by supplying another Run's ID.
10. Broken lineage fails visibly in the attribution read model.

## Related documents

- [Control Plane runtime architecture](../control-plane-runtime-architecture.md)
- [Source-thread action receipts](../source-thread-action-receipts.md)
- [GitHub Project Target](../platforms/github.en.md)
