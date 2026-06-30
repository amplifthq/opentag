# Source-Thread Action Receipts

## Status

Draft design, 2026-06-30.

This document defines the user-facing receipt pattern for OpenTag suggested
actions in Slack and GitHub. It narrows the broader Agent Work Protocol into an
interaction model that makes protocolized mutations easy to understand, approve,
reject, and audit from the source thread.

For the long-horizon protocol model, see
[Agent Work Protocol](./agent-work-protocol.md). For the runtime architecture,
see [Thread Runtime Alignment](./thread-runtime-design.md).

## Recommendation

Keep this design in the public repository.

The interaction governs public product behavior, platform adapters, and tests,
so it should be reviewable next to the code. Competitive research, launch
strategy, and private screenshots should stay outside the public repo. The
public design should describe OpenTag's own product language and constraints
without naming or imitating other systems.

## Problem

OpenTag can already turn a source-thread mention into a local executor run and
return suggested actions. The risk is that the approval moment still feels like
raw protocol output:

- humans see internal identifiers instead of decisions;
- Slack and GitHub render the same intent with different clarity;
- `Apply`, `Approve only`, and `Reject` are easy to confuse;
- long executor summaries compete with the actual decision;
- the audit trail is strong, but the human-facing surface can feel noisy.

The product goal is not to build a custom workspace UI. The goal is to make the
native source thread feel like a clear control surface for a bounded external
write.

## Product Thesis

OpenTag should render each suggested action as an **action receipt**.

An action receipt is a compact, human-readable record that says:

```text
What OpenTag proposes to change.
Where the change will be applied.
Why the action is safe or blocked.
Which explicit decision the human can make now.
Where the durable audit record lives.
```

This keeps the system protocol-first while making the approval moment legible in
Slack, GitHub, and future adapters.

## Design Principles

### Native, Not Custom

Use Slack Block Kit buttons and GitHub Markdown comments. Do not introduce a
separate OpenTag web console as the default approval surface.

### Receipt, Not Transcript

Show the proposed action and decision controls. Keep full executor reasoning,
raw proposal identifiers, and long internal context in audit unless the user
explicitly asks for it.

### Action Before Metadata

The primary line should describe the action in human language:

```text
Create a pull request for branch opentag/run_123.
```

Internal concepts such as proposal IDs, intent IDs, apply plan IDs, and run IDs
are audit metadata. They should not lead the human-facing surface.

### Differentiate Decisions

`Apply`, `Approve only`, and `Reject` are not synonyms:

| Decision | Meaning |
| --- | --- |
| `Apply` | Approve and execute the selected action against the system of record now. |
| `Approve only` | Record approval, but do not execute the external write yet. |
| `Reject` | Mark the selected action as rejected and do not execute it. |
| `Continue` | Start a follow-up run using the proposal context, usually when direct apply is unavailable or more work is needed. |

The UI should use these labels consistently. In a ready-to-apply state, make
`Apply` and `Reject` the visible decisions. `Approve only` remains a supported
typed command, but it should not compete with the primary happy path.

### Quiet By Default

The source thread should receive:

- a lightweight source receipt when OpenTag accepts the request;
- one final result;
- action receipts when a human decision is needed;
- blockers when the human must intervene.

Routine progress, raw logs, internal plans, and repeated "working" messages
belong in audit.

### Protocol Truth Under UI Clarity

The visible card can be simple, but every button or command must resolve to the
same protocol path:

```text
SuggestedChangesSnapshot -> ApprovalDecision -> ApplyPlan -> per-intent outcome
```

The UI must never create a hidden side path that bypasses proposal lineage,
authority checks, or adapter preflight.

## Interaction Model

### 1. Source Receipt

When OpenTag accepts a mention, the source surface should acknowledge it without
adding conversational clutter.

Slack default:

- add an `eyes` reaction to the triggering message;
- do not post a separate "I picked this up" reply unless reaction delivery
  fails or the run is blocked before it starts.

GitHub default:

- post one short acknowledgement when useful for latency or webhook clarity;
- avoid repeated progress comments.

The receipt means only "OpenTag received the request." It does not imply that
the task will succeed, that a runner has claimed it, or that any write is
authorized.

### 2. Final Result

The final result should answer three questions in order:

1. What happened?
2. What was verified?
3. What decision is now available?

Preferred shape:

```text
Finished: success.

Changed README.md by adding one short sentence about Slack-triggered local
Claude Code.

Verified: edit applied cleanly.

Ready to apply:
1. Create a pull request for branch opentag/run_123.
```

Avoid leading with run IDs, proposal IDs, or executor implementation details.

### 3. Action Receipt

Each suggested action should render as a compact receipt.

Human-facing fields:

| Field | Purpose |
| --- | --- |
| Action | The proposed mutation in one sentence. |
| Target | The system of record or artifact that will change. |
| Evidence | Minimal verification, changed files, or preconditions. |
| Risk | Only material risks, stale state, or permission blockers. |
| Controls | Native buttons or typed commands. |
| Audit link or hint | Where full lineage can be inspected, when available. |

Audit-only fields:

- proposal ID;
- intent ID;
- approval decision ID;
- apply plan ID;
- child run ID unless the user needs it to continue work;
- full executor prompt or log;
- raw adapter payloads.

### 4. Decision Feedback

After a human decision, the reply should be short and state the consequence.

Apply success:

```text
Applied: Create a pull request.
Result: https://github.com/org/repo/pull/123
```

Apply blocked:

```text
Could not apply: GitHub write credentials are not configured.
Next: connect a GitHub token with pull request creation scope, then apply again.
```

Apply replay:

```text
Already applied: Create a pull request.
No external write was repeated.
```

Approve only:

```text
Approved only. No external write was performed.
Next: use Apply when this should be written to GitHub.
```

Reject:

```text
Rejected. OpenTag will not apply this action.
```

Do not paste the full carried-forward context into Slack unless the action falls
back to a child run and the user needs a concise reason.

## Slack Rendering

Slack should optimize for scanning and low thread noise.

Recommended Block Kit structure:

1. One section for the final result summary.
2. One optional context line for verification.
3. One section per action receipt.
4. One actions block per action with available decisions.

Decision labels:

| Button | Style | When shown |
| --- | --- | --- |
| `Apply` or `Apply 1` | primary | The adapter can execute the action now. |
| `Reject` | danger | The action can be explicitly rejected. |
| `Approve only` | typed command | The approval can be recorded separately from execution. |
| `Continue` | default | Direct apply is unavailable or follow-up work is the intended path. |

Slack copy guidelines:

- use `Ready to apply` instead of `Suggested actions` only when every visible
  action is marked executable by dispatcher capability and preflight context;
- use `Some actions need setup` or `Needs review` for mixed-state receipts;
- use `Needs approval` when execution is blocked on human authority;
- use `Needs setup` when adapter credentials or scopes are missing;
- hide `Apply` unless the dispatcher has confirmed a direct adapter path for
  that action;
- show at most the first few high-value details in the thread;
- keep proposal and intent identifiers out of visible copy.

Typed commands remain supported for portability:

```text
apply 1
approve 1
reject 1
continue 1
```

Buttons and typed commands must produce equivalent `submitThreadAction`
requests.

## GitHub Rendering

GitHub should optimize for reviewability and durable context.

Recommended Markdown structure:

```markdown
### Ready to apply

OpenTag prepared a source-thread action. Choose one command in this thread.

#### 1. Create a pull request for branch `opentag/run_123`

| Field | Value |
| --- | --- |
| Target | GitHub pull request |
| Branch | `opentag/run_123` -> `main` |
| Changed files | `README.md` |
| Verification | Edit applied cleanly |

| Decision | Comment command |
| --- | --- |
| Apply now | `apply 1` |
| Reject | `reject 1` |
```

GitHub can show more detail than Slack, but should still avoid exposing raw
protocol IDs by default. If audit identifiers are needed, place them in a
collapsed details section or an audit link rather than the main action body.

## State Language

Adapters should use a small shared vocabulary:

| State | Human copy |
| --- | --- |
| `received` | OpenTag received the request. |
| `running` | OpenTag is working. Usually audit-only. |
| `needs_approval` | A human decision is required. |
| `ready_to_apply` | The action can be applied now. |
| `applying` | OpenTag is executing the approved action. Usually audit-only unless slow. |
| `applied` | The external write succeeded. |
| `approved_only` | Approval was recorded without execution. |
| `rejected` | The human rejected the action. |
| `blocked` | OpenTag cannot proceed without setup or permission. |
| `stale` | The proposal no longer matches the current system-of-record state. |

This vocabulary should guide both visible copy and test fixtures.

## Accessibility And Trust

Action receipts should be usable without relying on color, emoji, or animation.

Requirements:

- buttons must have explicit text labels;
- destructive actions use both label and Slack `danger` style;
- every button path has an equivalent text command;
- failure messages state whether anything was written;
- final callbacks distinguish local file edits, branch creation, PR creation,
  and external system mutation;
- stale or unsupported actions should not look visually equivalent to ready
  actions.

## Implementation Direction

### Minimal Near-Term Changes

- Rename visible Slack/GitHub headings from generic `Suggested actions` to
  state-specific headings such as `Ready to apply`, `Needs approval`, or
  `Needs setup`.
- Drive those headings and visible decisions from a shared action receipt model
  instead of provider-local action-name heuristics.
- Show `Apply` only when dispatcher capability and preflight context says the
  action can be written to the system of record now.
- Keep `Approve only` as a typed command unless a state specifically calls for
  approval without execution.
- Keep `Apply` as the primary action only when an adapter can execute now.
- Hide proposal and intent IDs from primary GitHub comments, or move them into
  optional audit detail.
- Normalize apply/approve/reject result messages across Slack and GitHub.
- Add regression tests for the decision labels and hidden metadata rules.

### Later Enhancements

- Add an audit URL or local audit command hint to each action receipt.
- Render stale/conflicted proposals with explicit disabled controls where the
  provider supports it.
- Add adapter-provided preflight summaries before showing `Apply`.
- Add a compact receipt renderer shared by Slack and GitHub, with provider
  formatters layered on top.

## Non-Goals

- Do not build a custom approval dashboard for v0.x.
- Do not turn Slack into a full run log.
- Do not make every executor thought visible to humans.
- Do not hard-code provider-specific labels into the core protocol.
- Do not use external product language, names, screenshots, or visual motifs
  in public docs or UI copy.

## Success Criteria

The design is working when:

- a first-time user can tell what will happen before clicking `Apply`;
- `Apply`, `Approve only`, and `Reject` are not confused in user testing;
- Slack live e2e shows one lightweight receipt, one final result, and one clear
  decision surface;
- GitHub comments are reviewable without reading internal IDs;
- every visible decision can be traced to an `ApprovalDecision` and `ApplyPlan`;
- noisy details remain available in audit but do not flood the source thread.

## Open Questions

- Should GitHub expose audit identifiers in a collapsed details block, or only
  through local CLI/audit commands?
- Should `Apply all` be visible by default, or reserved for typed commands after
  users understand individual action receipts?
- What is the minimum audit-link story for local-first deployments without a
  hosted console?
