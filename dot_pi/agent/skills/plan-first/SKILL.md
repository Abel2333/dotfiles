---
name: plan-first
description: Plan complex tasks before executing. Use when the task spans multiple files, involves architectural decisions, modifies database schemas or APIs, introduces new modules, or requires non-trivial design choices. Write a plan file for user approval before making any changes.
---

# Plan-First Workflow

When loaded, follow this workflow for the current task.

## Step 1: Assess Complexity

Ask yourself:
- Does this touch 3 or more files?
- Does it add a new module, package, or service?
- Does it change a database schema, API contract, or data format?
- Does it involve architectural decisions (where code lives, how modules communicate)?
- Would a wrong approach take significant effort to undo?

If **none** of these apply, say "This looks straightforward" and proceed.

If **any** apply, go to Step 2.

## Step 2: Discuss Before Planning

Before writing anything, discuss the task with the user. Ask clarifying questions:
- What are the exact requirements and constraints?
- Which parts are most important vs. nice-to-have?
- Are there preferences for libraries, patterns, or file structure?
- What should explicitly NOT be done?

Goal: reduce guesswork. Do not write the plan until you have enough
information to make decisions confidently.

## Step 3: Write a Plan

Create a plan file in a `plans/` directory:

- For project tasks: `plans/plan.md` in the project root.
  Sub-plans go in the same directory: `plans/plan-phase-1.md`, etc.
- For standalone tasks (no project): `plan.md` in the current directory.

Create the `plans/` directory if it does not exist.

### Plan Format

The top-level plan covers the big picture: goal, scope, high-level approach,
risks. It should be concise enough to review in 1-2 minutes.

Every plan must include a status block near the top:

```markdown
## Status
- State: Draft | Approved | In Progress | Paused | Completed | Abandoned
- Last updated: YYYY-MM-DD
- Note: one short line describing the current situation
```

Use these states consistently:
- `Draft`: the plan was written and is waiting for user approval.
- `Approved`: the user approved the plan, but execution has not started yet.
- `In Progress`: implementation is underway.
- `Paused`: work stopped before completion and may resume later.
- `Completed`: the planned work finished.
- `Abandoned`: the plan is no longer being followed.

```markdown
# Plan: [one-line summary]

## Status
- State: Draft
- Last updated: YYYY-MM-DD
- Note: Waiting for user approval

## Goal
What are we trying to achieve? One paragraph.

## Scope
- Files / modules that will be touched
- Files / modules explicitly out of scope

## Approach
Step-by-step what will be done and in what order.
For each step: what file(s), what change, why.

## Risks / Alternatives Considered
- What could go wrong
- Alternative approaches and why not chosen
```

### When the Task Is Very Large

If the approach section would exceed ~60 lines, decompose into sub-plans:

- The **top-level plan** stays concise: goal, scope, a numbered list of phases
  with 1-2 sentences each, and pointers to sub-plan files.
- Each phase gets its own file: `plan-phase-1.md`, `plan-phase-2.md`, etc.
- Sub-plans use the same format (Goal / Scope / Approach / Risks) but scoped
  to only that phase.

Write all sub-plans upfront before requesting approval. The user reviews the
top-level plan first, then dives into sub-plans as needed.

```markdown
# Plan: [one-line summary]

## Status
- State: Draft
- Last updated: YYYY-MM-DD
- Note: Waiting for user approval

## Goal
...

## Scope
...

## Phases

### Phase 1: [name] ([plan-phase-1.md](plan-phase-1.md))
Status: Not started
...

### Phase 2: [name] ([plan-phase-2.md](plan-phase-2.md))
Status: Not started
...

## Risks
...
```

Update the status whenever the plan meaningfully changes:
- After writing the plan: `Draft`
- After user approval, before execution starts: `Approved` or `In Progress`
- If work stops before completion: `Paused`
- When the task is finished: `Completed`
- If the plan is no longer being followed: `Abandoned`

## Step 4: Wait for Approval

After writing the plan, set its status to `Draft` with a note indicating it is waiting for user approval.

After writing the plan, **stop**. Do not make any code changes. Say:

> "I wrote a plan in `path/to/plan.md`. Please review it. When you are ready, tell me to proceed."

The user may approve, request changes, or reject the approach.

## Step 5: Execute

Once approved, follow the plan. If reality diverges from the plan, pause and update the user.

## Rules

- **Never skip Step 2 or Step 4.** Discuss before planning; wait for approval before touching code.
- Write plan files in the user's preferred language.
- Keep plans concise. A top-level plan should be reviewable in 1-2 minutes.
  If it is growing too large, decompose into sub-plans.
- Update the plan status whenever work meaningfully changes state.
- When pausing or completing work, update the plan status before ending the turn or deleting the plan file.
- Delete plan files only at the very end of the task: after implementation is complete, relevant tests/linters have passed, and the user has been given a completion summary.
- Do not delete plan files if the work is only partially complete, paused, split into later phases, or if the user wants to keep them.
- If unsure whether the plan should remain as project documentation, ask the user before deleting it.
