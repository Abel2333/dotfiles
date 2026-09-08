---
name: project-documentation
description: Creates, updates, organizes, and audits repository documentation for both human contributors and AI coding agents. Use for README files, documentation architecture, getting-started and how-to guides, references, architecture documents, ADRs, runbooks, contributor guides, project instruction files, and documentation drift reviews.
---

# Project Documentation

Create documentation as a versioned, navigable, and verifiable knowledge system.
Do not treat documentation as prose generated from a superficial repository scan.

## Modes

Infer the mode from the request, or ask when the distinction changes the scope:

- **Create:** establish missing documentation or a documentation structure.
- **Update:** change only documentation affected by the requested behavior or code change.
- **Audit:** report gaps, duplication, stale claims, broken navigation, and unverifiable instructions before proposing focused fixes.

## Core Model

Design for distinct readers without maintaining duplicate sources of truth:

- `README.md` is the human-facing project entrance.
- `AGENTS.md` is a concise agent-facing instruction and routing layer.
- `ARCHITECTURE.md` is a high-level map of boundaries, flows, and invariants when the project needs one.
- `docs/` contains detailed, durable knowledge organized by reader task.
- Agent skills contain reusable, task-specific workflows that should load only when relevant.
- Schemas, type definitions, CLI help, tests, and configuration are machine-checkable contracts.

Documentation guides behavior. Deterministic tooling verifies behavior.

## Workflow

### 1. Establish Scope and Audience

Determine:

- Who must use the document: end users, integrators, contributors, maintainers, operators, or coding agents.
- What task the reader must complete or decision they must make.
- Whether the request is creation, update, or audit.
- Which languages and documentation conventions the repository already uses.
- Whether public behavior, internal architecture, operations, or agent instructions are in scope.

Preserve the repository's existing documentation system unless restructuring is explicitly requested or clearly necessary. Do not add documentation dependencies, site generators, or CI jobs without approval.

### 2. Inspect Before Writing

Inspect relevant evidence, including:

- Existing README files, documentation indexes, contributor guides, architecture documents, ADRs, and runbooks.
- `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, and project-local skills or instruction files.
- Package manifests, lockfiles, tool configuration, task runners, and build files.
- Public entry points, exported APIs, CLI definitions, configuration schemas, and environment-variable handling.
- Tests and examples that demonstrate supported behavior.
- CI workflows that define required validation.
- Generated-file notices and generation commands.

Use the implementation and executable configuration as evidence. Do not infer support, defaults, commands, compatibility, or behavior from filenames alone.

Classify uncertain claims internally as:

- **Verified:** confirmed by code, configuration, a safe command, or an authoritative source.
- **Derived:** strongly implied by implementation but not directly exercised.
- **Unknown:** insufficient evidence; ask, omit, or label it clearly.

Never present a derived or unknown claim as verified fact.

### 3. Choose the Smallest Useful Information Architecture

Adapt to project size rather than imposing every possible document.

A small project may need only:

```text
README.md
AGENTS.md
CONTRIBUTING.md
```

A larger project may benefit from:

```text
README.md
AGENTS.md
ARCHITECTURE.md
CONTRIBUTING.md
CHANGELOG.md
docs/
  index.md
  getting-started/
  how-to/
  reference/
  concepts/
  decisions/
  plans/
  runbooks/
```

Create a directory only when it has a clear audience and expected content. Avoid empty scaffolding and speculative placeholders.

Every durable document must be reachable from `README.md`, `docs/index.md`, or another obvious index. Avoid orphan documents.

### 4. Apply Progressive Disclosure

Organize information by when it is needed:

1. **Entrance:** a short README and concise agent instructions orient the reader.
2. **Map:** an architecture document and documentation index route the reader.
3. **Detail:** focused guides, references, decisions, plans, and runbooks are read on demand.
4. **Implementation:** code and executable contracts remain the final authority for implementation details.

Prefer descriptive links over copied sections. Each fact should have one canonical home.

Do not turn `AGENTS.md` into an encyclopedia. Put only information that an agent should know broadly and cannot reliably infer, such as:

- Exact install, focused test, full test, lint, type-check, build, and regeneration commands.
- Non-obvious repository conventions and architectural constraints.
- Generated files that must not be edited directly.
- Safety, security, migration, and production boundaries.
- Required completion evidence.
- Short routing guidance to deeper documentation.

Exclude generic engineering advice, long tutorials, detailed API references, exhaustive directory listings, temporary task state, and facts duplicated from other documents.

For pi projects, remember that pi discovers context files at startup from the current directory upward. Do not assume that nested context files below the startup directory load dynamically. Use explicit links for deeper guidance, and mention `/reload` when changed context files must be reloaded.

### 5. Choose the Correct Document Type

Use these categories without mixing their goals unnecessarily:

- **Tutorial:** a guided learning path that produces an early successful result.
- **How-to guide:** steps for completing one concrete task.
- **Reference:** precise descriptions of commands, APIs, configuration, schemas, and defaults.
- **Explanation:** concepts, architecture, rationale, trade-offs, and mental models.
- **Runbook:** operational diagnosis, recovery, verification, escalation, and rollback.
- **Decision record:** a durable decision, context, alternatives, consequences, and status.
- **Execution plan:** current state, decisions, acceptance criteria, progress, and remaining work for a complex multi-session task.

Keep transient discussion in the conversation. Preserve conclusions, rejected alternatives that may recur, unresolved questions, and acceptance criteria in durable documents when future sessions need them.

### 6. Write Task-Oriented Content

A procedural document should normally include:

1. Purpose and expected outcome.
2. Intended audience.
3. Prerequisites and supported versions when relevant.
4. Minimal successful steps.
5. Expected observable result.
6. Verification commands or checks.
7. Common failures and recovery steps.
8. Links to related detail.

Put the shortest successful path before advanced options. Make examples complete enough to copy and adapt. Explain placeholders and state whether commands are safe, destructive, local-only, or production-affecting.

For architecture documentation, emphasize:

- System and module boundaries.
- Dependency direction and allowed communication paths.
- Important entry points and data flows.
- Ownership of state and external side effects.
- Security and trust boundaries.
- Architectural invariants and how they are checked.
- Decisions and rationale that code alone cannot reveal.

Do not write file-by-file inventories that immediately drift. Describe stable responsibilities and point to authoritative entry points.

### 7. Prefer Executable Contracts

For precise reference material, prefer existing sources such as:

- OpenAPI or other interface schemas.
- JSON Schema or configuration definitions.
- Protocol definitions and typed interfaces.
- CLI `--help` output generated by the application.
- Package metadata and lockfiles.
- Tests and executable examples.

Generate or link reference material from these sources when the repository already supports it. Do not manually duplicate volatile tables of fields, defaults, or options unless there is no better source.

When prose states a rule that must always hold, look for an existing deterministic check. Recommend a test, linter, type constraint, schema validation, or CI check when appropriate, but do not add such automation unless it is within the approved task scope.

### 8. Prevent Documentation Drift

Treat documentation as code:

- Keep it versioned near the implementation it describes.
- Review documentation changes with behavior changes.
- Update the canonical source rather than copying corrections to several files.
- Mark generated files and document their generation command.
- Preserve decision history by superseding records rather than silently rewriting past rationale.
- Remove or clearly mark obsolete instructions.
- Prefer stable links, headings, terminology, and identifiers.

Do not add `last updated` metadata unless a process will maintain it. A stale freshness label is worse than no label.

During an update, inspect the changed behavior and identify all documentation surfaces it affects. Do not rewrite unrelated prose merely for stylistic consistency.

### 9. Validate

Use existing project tooling first. When safe and relevant:

- Execute documented setup, build, test, or example commands.
- Confirm referenced paths, scripts, options, environment variables, and defaults exist.
- Build the documentation site if the repository already has one.
- Run existing Markdown, spelling, style, link, schema, and documentation tests.
- Check internal links and index reachability.
- Compare generated reference output with its source.
- Verify diagrams from text sources when tooling exists.

Do not claim that a command works if it was not run. State whether it was verified, inspected only, or could not be tested, and explain why.

For an audit, prioritize findings by impact:

1. Unsafe or incorrect instructions.
2. Broken quick-start paths.
3. Public behavior missing from documentation.
4. Contradictory or duplicated sources of truth.
5. Missing architecture, operational, or security constraints.
6. Broken navigation and orphan documents.
7. Style and wording improvements.

### 10. Review From a Fresh Start

Before finishing, ask:

- Can a new reader identify the project's purpose quickly?
- Can they reach a visible first success without undocumented assumptions?
- Can an agent find the authoritative document without loading the entire corpus?
- Are exact commands and completion criteria available where needed?
- Are important constraints explicit but concise?
- Are explanations separated from procedures and reference material?
- Is each volatile fact maintained in only one place?
- Do documentation claims agree with implementation and configuration?
- Would a fresh session understand the current decision state without reading old chat logs?

## Style

- Follow the repository's language, terminology, voice, and Markdown conventions.
- Use descriptive headings and concise paragraphs.
- Prefer direct, active, factual language.
- Use requirement words consistently: `must`, `must not`, `should`, `may`.
- Explain why when it affects a decision, constraint, or recovery action.
- Avoid promotional claims, filler, vague assurances, and generic best practices.
- Keep code examples focused and realistic.
- Use ASCII in code comments unless the repository explicitly requires otherwise.

## Final Report

Report:

- Documents created, updated, or audited.
- The intended audience and structural choices.
- Commands, examples, links, and claims that were verified.
- Checks run and their results.
- Unverified assumptions or remaining documentation gaps.
- Suggested follow-up work separately from completed scope.
