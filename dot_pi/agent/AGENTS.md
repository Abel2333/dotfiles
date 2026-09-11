# Global Instructions

## Communication
- Code comments and this file itself: English, pure ASCII, no emoji.
- Reply in the language used by the user unless the user requests otherwise.
- Replies: detailed but not verbose. Explain the "why" when it matters.

## Scripting
- Prefer Bash for simple scripts (`#!/usr/bin/env bash`).
- Use Python when it is substantially clearer, safer, or more maintainable for
  complex tasks; prior approval is not required.
- Interactive command examples must use nushell syntax.

## Git
- Do not create commits unless the user explicitly requests a commit.
- Commits must remain GPG-signed. Never bypass signing with `--no-gpg-sign`.
- Before the first commit attempt in a session, remind the user that GPG
  authentication may be required and wait for confirmation that signing is
  ready.
- In a terminal-only or TUI environment, do not trigger pinentry from inside
  the agent. Ask the user to unlock or warm up GPG signing in another terminal
  and confirm before proceeding.
- After a recent successful signed commit in the same session, additional
  requested commits may proceed while the GPG credential is expected to remain
  cached.
- If a commit blocks on pinentry or signing fails, stop and return control to
  the user. Never disable signing as a workaround.
- Before staging, inspect the index and working tree. Preserve existing staged
  changes and stage only files belonging to the current task. If ownership is
  unclear, ask first.
- Do not push, create pull requests, or publish releases unless explicitly
  requested.

## After Code Changes
- Run relevant tests and linters automatically after making changes.
- Report failures clearly. Do not modify unrelated code merely to silence
  pre-existing failures.

## Testing & Comments
- New logic ships with tests; a bug fix ships with a regression test that
  fails before the fix and passes after.
- Never delete, weaken, or skip an existing test to make a change pass. If
  the behavior intentionally changed, update the test and explain why.
- Never claim a test result without running it. State which tests were run
  and which were skipped; pre-existing failures are reported, not hidden.
- Tests are deterministic and order-independent: no sleeps, no wall-clock or
  locale dependence, no live network; use fixed seeds and fake clocks.
- Test through public interfaces; do not test trivial getters/setters,
  plain data definitions, framework-guaranteed behavior, or generated code.
- Comments explain why, not what. Never restate code in prose; never leave
  commented-out code.
- Public APIs and exported symbols get contract docstrings (purpose,
  params, returns, raised errors, side effects). Private functions need
  none by default; write one only when name and signature cannot convey
  the intent.
- For the full decision table and examples, follow the
  "testing-and-comments" skill when the task involves test writing or
  code review.

## File Changes
- When the user has not explicitly requested a file modification, do not edit
  files directly. You may ask whether to proceed, but you must not make the
  change without confirmation.
- Preserve the existing style and avoid unrelated changes.
- Ask before writing outside the active project unless the user has clearly
  identified the target path.
- Ask before adding or upgrading project dependencies unless explicitly
  requested.
- Never write to one file from parallel operations. Serialize every write to
  a given path: no concurrent tool calls targeting the same file, and no
  parallel or backgrounded shell writers on it (`cmd &`, `xargs -P`, parallel
  redirections). Wait for one write to finish before starting the next;
  concurrent same-file writes can fail, truncate, corrupt, or silently lose
  data. To apply several changes to one file in a turn, use a single edit call
  with multiple non-overlapping edits instead of multiple calls.

## Environment
- Consult available long-term memory before investigating environment details.
- Treat remembered environment facts as hints rather than authoritative truth.
- When environment details matter, verify them with safe read-only inspection.
- Ask the user only when the information cannot be determined safely or when
  choosing between materially different environments.

## Tooling
- Manage Python dependencies with uv only, in isolated projects under
  ~/Tools/pyenvs/<purpose>/; never install Python packages into the system Python.
- Run such projects with `uv run --project ~/Tools/pyenvs/<project> python <script>`.
- When a uv project under ~/Tools/pyenvs/ is needed but does not exist yet,
  create it automatically (uv init + uv add + uv sync) and tell the user what
  was created; do not ask for permission first, do not create it silently.
- For PDF tasks, use existing tooling first (follow the "pdf-tools"
  skill). Do not hand-implement PDF parsing when a library or CLI already
  covers it; if none fits, or the task itself is about building a parser,
  explain why and ask the user before proceeding.
- Non-Python toolchains: prefer a dedicated mise-managed project directory
  (~/Tools/mise/<purpose>/ with mise.toml, deps via the language's package
  manager inside it); create it automatically on first need, mirroring the
  uv convention above.

## Skills
- In SKILL.md frontmatter, always wrap `description` in double quotes on
  a single line: YAML plain scalars fail to parse when the text contains
  "colon + space".

## Secrets
- Never expose secrets, API keys, tokens, or decrypted credential values in
  replies, logs, diffs, or commits.
- When inspecting sensitive configuration, report only its structure and
  redacted values unless the user explicitly requests otherwise.
- Never commit unencrypted secrets.

## Destructive Operations
- Never discard, overwrite, or revert existing user changes without explicit
  confirmation.
- Preserve existing staged changes and unrelated working-tree modifications.
- Require operation-specific confirmation before destructive Git commands,
  history rewrites, force pushes, or bulk deletion.
- Prefer reversible operations whenever possible.

## External Side Effects
- Read-only network access is allowed. Fetch URLs, clone repositories, and call
  read-only APIs as needed.
- Require explicit confirmation before network operations that mutate remote
  state, or before starting, stopping, or restarting system services.

## Forbidden
- Never touch ~/.ssh or anything under it.
- Never install system-level packages (apt, dnf, brew, etc.).
