---
name: plan-first
description: "Plan complex tasks before execution by defining risk, numbered acceptance criteria, scope priorities, verification, review budget, and exit conditions for approval."
---

# Plan-First Workflow

Use this workflow for work that spans multiple files, changes an API or persisted
format, adds a module or service, contains meaningful architecture decisions, or
would be costly to undo. Straightforward work may proceed without a formal plan.

## 1. Clarify Before Planning

Before writing a plan, establish:

- Exact requirements, constraints, priorities, and explicit non-goals.
- Existing patterns, ownership boundaries, and relevant tests.
- Whether implementation needs user approval before any files change.
- Which outcomes are required now versus intentionally deferred.

Ask focused questions only when the answer cannot be found safely from the
repository or materially changes the design.

## 2. Write An Approval-Ready Plan

Create `plans/plan.md` for a project task. Put substantial phases in sibling
sub-plans such as `plans/plan-runtime.md`. Keep the top-level plan concise enough
to review quickly and link to sub-plans rather than duplicating implementation
detail.

Every plan includes this status block near the top:

```markdown
## Status
- State: Draft | Approved | In Progress | Paused | Completed | Abandoned
- Last updated: YYYY-MM-DD
- Note: one short line describing the current situation
```

Every non-trivial plan also includes:

- `Risk Class`: Low, Medium, High, or another explicitly defined class.
- `Goal`: the intended outcome.
- Numbered `Acceptance Criteria`, using stable identifiers such as `AC-1`.
- `Must / Should / Deferred`: required work, desired work, and intentionally
  postponed work.
- `Non-goals`: work that must not be included.
- `Scope`: files or modules to touch and important boundaries to preserve.
- `Approach` or phased sub-plans: ordered changes and why they belong there.
- `Verification Commands`: deterministic commands and any resource/discovery
  checks that prove the acceptance criteria.
- `Review Modes`: whether requirements, maintainability, or verification review
  is needed, with the intended scope.
- `Maximum Remediation Rounds`: normally one; define any exception explicitly.
- `Exit Criteria`: evidence required to finish, including unresolved blocking
  findings, verification, rollout, and ownership handoff.
- `Risks / Alternatives Considered`: material tradeoffs and why the selected
  direction is preferable.

For large work, write all sub-plans before requesting approval. Each sub-plan
keeps the same status and evidence discipline while staying within one phase.

## 3. Wait For Approval

Mark a new plan `Draft` and stop before implementation. Tell the user where the
plan is and request approval. After approval, mark it `Approved` or `In Progress`
and follow the approved scope.

If reality materially diverges from the approved plan, pause, explain the gap, and
obtain updated approval before expanding the design.

## 4. Hand Off Delegated Delivery

For approved medium- or high-risk delegated work, load `delegated-delivery`.
That skill owns risk budgets, role/model routing, parallel-review coordination,
remediation limits, and workflow exit rules. Do not copy its full decision tables
into plans or agent prompts.

Use `bounded-code-review` when a review is required. Its finding schema and
blocking policy govern review findings; the plan records only which review modes
and budget apply.

## 5. Maintain Plan State

Update the status when the plan meaningfully changes state. Do not mark it
`Completed` until its explicit exit criteria, including any parent-owned review or
rollout check stated in the plan, have evidence. Keep a paused or partially
executed plan available for the next session rather than deleting it.
