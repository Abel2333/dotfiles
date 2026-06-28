# Global Instructions

## Communication
- Code comments and this file itself: English, pure ASCII, no emoji.
- Replies to the user may follow the user's language preference.
- Replies: detailed but not verbose. Explain the "why" when it matters.

## Scripting
- Default: Bash scripts (`#!/usr/bin/env bash`).
- For complex tasks, ask before switching to Python.
- Interactive command examples: always use nushell syntax (my interactive shell is nushell).

## Git
- Never run `git commit` directly. I use GPG signing with a passphrase, so
  automated commits will hang. Stage changes and tell me what to commit.

## After Code Changes
- Run relevant tests and linters automatically after making changes.

## File Changes
- When the user has not explicitly requested a file modification, do not edit
  files directly. You may ask whether to proceed, but you must not make the
  change without confirmation.

## System
- Make no assumptions about the operating system or architecture.
- When the environment matters, ask.

## Allowed
- Network access is fine. Fetch URLs, clone repos, call APIs as needed.

## Forbidden
- Never touch ~/.ssh or anything under it.
- Never install system-level packages (apt, dnf, brew, etc.).
