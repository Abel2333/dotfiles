---
name: delegated-delivery
description: "Orchestrate bounded delegated repository work: pre-plan investigation, planning, approved implementation, and independent review, with risk budgets, generic model routing, parallel review, and explicit exit rules."
---

# Delegated Delivery

Use this skill for non-trivial repository work: broad investigation, planning,
approved implementation, and independent review. Scout and reviewer roles may
start before plan approval; an implementer may start only after the user
approves an implementation plan. Do not turn a simple task into a multi-agent
workflow without a clear isolation, verification, or parallel research benefit.

## Parent Responsibilities

The parent agent owns:

- Requirement clarification and user communication.
- Planning and obtaining approval when approval is required.
- Dispatching bounded work, collecting evidence, resolving conflicting findings,
  and final acceptance.
- Deciding which Finding IDs are accepted for remediation.
- In strict mode, keeping project code writes delegated after a reviewer or
  implementer starts in the current user turn. Plans remain parent-owned;
  reviewer findings go only to a remediation implementer with accepted Finding
  IDs. `/agent-mode direct` is an intentional user escape.

Do not repeat broad exploration or review work that a delegated agent has already
completed. Use the returned evidence, request a targeted follow-up only when a
specific gap remains, and keep the workflow within its approved scope.

## Risk Budget

Classify the task before dispatching work.

| Class | Required budget |
| --- | --- |
| Low | At most one scout, one implementer, and one targeted reviewer. No automatic remediation loop. |
| Medium | At most two scouts, one implementer, two parallel reviewers, and one remediation round. |
| High | A feasibility assessment and an approved plan, one implementer, and two parallel reviewers. One remediation round is the default. A second is allowed only for a new Blocker or Critical introduced by remediation, and the parent must tell the user why before starting it. |
| Full audit | Deliver an audit report only. Any implementation work requires new user approval. |

A budget is a maximum, not a mandate. Omit roles that do not add evidence.

## Model Routing

Every `action=start` task must include an explicit `model` value. It may be the
same as the parent session model; do not omit it to request implicit inheritance.

Choose the value in this order:

1. A model the task explicitly names, passed exactly.
2. A role preference in the optional local agent-directory
   `multi-agent-routing.json` profile:

   ```json
   { "roles": { "reviewer": "..." } }
   ```

3. A legacy model value in the role definition.
4. The parent session model.

These sources help choose the value, but the selected value must still be
passed explicitly in `subagent.model` or each `subagent.tasks[].model`.
Treat a missing, unreadable, malformed, or invalid routing profile as absent.
Never assume a provider or model is installed. Do not encode a model in generic
agent definitions.

## Dispatch Rules

- Give every delegate a specific question, approved scope, constraints, expected
  evidence, and stopping condition.
- A scout stops once the delegated question has sufficient evidence. It does not
  become a repository-wide audit.
- A feasibility delegate returns a verdict, constraints, risks, a minimum viable
  direction, and open questions. It does not design an implementation program.
- Scout and reviewer tasks may run before plan approval to gather evidence for
  the plan; implementer tasks require an approved plan.
- An implementer receives an approved plan for initial work. A remediation task
  receives only the parent-accepted Finding IDs and their required verification.
- Start the two reviewers in parallel when the budget calls for two. Wait for both,
  then deduplicate and adjudicate findings once before remediation.
- Ask reviewers to use `bounded-code-review` with an explicit review mode.
- Do not ask a delegate to invoke another agent.

## Review And Remediation

Use review modes deliberately:

- `requirements` checks approved acceptance criteria, behavioral boundaries, and
  compatibility.
- `maintainability` checks the current diff, direct dependencies, and test design.
- `verification` checks only the accepted Finding IDs and their regression tests.

Only accepted Finding IDs may be sent to the implementer for remediation. New
issues discovered during remediation are reported to the parent; they do not
silently expand the work. Minor, Nit, and general refactoring advice do not block
completion.

## Checkpoints And Exit

After plan approval and after finding adjudication, consider a manual context
checkpoint or compaction when the parent context is becoming unwieldy. This skill
does not claim to trigger compaction or model switching automatically.

Exit when all approved acceptance criteria have evidence, required verification
has run, and there is no unresolved in-scope Blocker or Major. Do not continue
reviewing merely to eliminate every suggestion. Report deferred Minor/Nit items
as backlog context, along with verification and residual risks.
