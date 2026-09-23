---
name: bounded-code-review
description: "Perform an explicit bounded requirements, maintainability, or verification review with structured findings and blocking rules."
---

# Bounded Code Review

Use this skill only for an explicitly requested review mode. Review the approved
scope and its direct dependencies, not the entire repository. A full audit is an
exception that must be requested explicitly and produces a report rather than an
automatic implementation task.

## Required Mode

The caller must specify exactly one mode:

- `requirements`: Check approved acceptance criteria, business logic, boundary
  behavior, and compatibility.
- `maintainability`: Check the current diff, directly coupled modules, and test
  design for concrete maintainability risk.
- `verification`: Check only parent-accepted Finding IDs and their regression
  tests. Do not reopen a broad audit or introduce a new review topic.

If the mode or approved scope is missing, stop and ask the caller to provide it.

## Finding Schema

Every reported finding must include all of these fields:

- `ID`: Stable identifier such as `F-001`.
- `Severity`: Critical, Major, Minor, or Nit.
- `Criterion / invariant`: The specific requirement or invariant violated.
- `Evidence`: Concrete file, line, input, or reproducible behavior.
- `Impact`: What can fail and who is affected.
- `Minimum fix`: The smallest scoped correction.
- `Regression test`: The test that proves the correction.
- `Scope expansion`: Yes or no, with a short reason when yes.

Do not report vague concerns, hypothetical rewrites, or duplicated findings.

## Blocking Policy

Only the following can block completion:

- A violated approved acceptance criterion or invariant.
- A reproducible correctness bug.
- A security, data-loss, data-corruption, race, or compatibility risk.
- A regression introduced by the current modification.

Critical and Major findings that meet this policy block. Minor, Nit, and general
refactoring suggestions do not block; record them as backlog context when useful.

For ordinary reviews, report at most five highest-priority findings. An explicitly
requested full audit has no finding count limit, but still does not authorize
implementation work.

## Output And Exit

Start with findings ordered by severity and grounded in file/line evidence. State
clearly when no blocking findings exist. Include test gaps and residual risk after
the findings.

A review is complete when the assigned mode and scope have been covered, every
reported finding follows the schema, and any accepted remediation can be tied to
explicit Finding IDs. Do not expand verification into a new comprehensive review.
