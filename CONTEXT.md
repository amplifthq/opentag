# OpenTag Governance Context

OpenTag governs agent execution attached to work that remains canonical in external systems. Its language separates execution activity from evidence-backed work completion.

## Language

**Work item**:
An external planning or collaboration object that defines the work and remains owned by its source system.
_Avoid_: OpenTag task, internal ticket

**Work thread**:
The durable OpenTag governance identity connecting an external work item, its conversation anchors, runs, evidence, assessments, and escalations across time.
_Avoid_: Ticket, backlog item

**Run**:
One admitted request for agent execution within a work thread.
_Avoid_: Work item, completed work

**Attempt**:
One lease-bound execution of a run by a runner.
_Avoid_: Run

**Execution success**:
The outcome that an executor finished its bounded run successfully; it is not proof that the work is complete.
_Avoid_: Complete, accepted

**Completion contract**:
An immutable, resolved set of evidence gates that defines what must be true before a work thread can be considered complete.
_Avoid_: Workflow, DAG

**Completion gate**:
One finite requirement within a completion contract, evaluated independently against artifacts, evidence, receipts, or human acceptance.
_Avoid_: Step, task

**Completion assessment**:
An immutable evaluation of a completion contract against the facts known at a specific time.

Every governed assessment binds its delivery gates to one resolved target and resource version for the current work cycle. For the Phase 1 GitHub profile, the pull request artifact, required checks, and merge state must all refer to the same repository, pull request, and head SHA; facts from different targets or older heads cannot be combined into completion.
_Avoid_: Run result

**Verification evidence**:
A typed claim about an artifact or external fact whose assurance states whether it was verified, merely reported, or cannot be verified.
_Avoid_: Agent summary, proof by assertion

**Human escalation**:
A durable, attributable request for human attention when policy or verified evidence cannot safely resolve a blocking condition.
_Avoid_: Approval, notification

**Waiver**:
An attributed human decision that accepts explicitly selected unsatisfied gates without erasing their underlying evidence state.
_Avoid_: Approval, automatic success
