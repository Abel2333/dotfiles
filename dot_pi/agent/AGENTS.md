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

## File Changes
- When the user has not explicitly requested a file modification, do not edit
  files directly. You may ask whether to proceed, but you must not make the
  change without confirmation.
- Preserve the existing style and avoid unrelated changes.
- Ask before writing outside the active project unless the user has clearly
  identified the target path.
- Ask before adding or upgrading project dependencies unless explicitly
  requested.

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
- For PDF tasks, use existing tooling before writing custom parsers:
  the pdf-tools uv env (scripts/pdf_extract.py: `render` / `images` subcommands),
  then qpdf, Ghostscript, ImageMagick, ffmpeg.
- If the needed tool is missing, ask the user how to proceed instead of
  silently hand-rolling a replacement.

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
