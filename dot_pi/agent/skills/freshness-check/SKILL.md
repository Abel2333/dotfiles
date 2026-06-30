---
name: freshness-check
description: Use when a task may depend on current or recently changed information, including package versions, APIs, docs, product behavior, prices, laws, schedules, release notes, news, model availability, or anything phrased as current/latest/recent. Check current time and verify fresh facts before answering or acting.
---

# Freshness Check

When a request may depend on information that changes over time, verify freshness before relying on memory or model knowledge.

## When To Check

Check freshness for:
- Current/latest/recent/newest information.
- Package, framework, CLI, API, model, or dependency versions.
- Docs, release notes, changelogs, pricing, policies, laws, schedules, or availability.
- User asks what is installed/configured "now" or whether something is "still" true.
- A task involves updating, upgrading, migrating, installing, or comparing current behavior.

Also check when the user does not say "latest" but the answer would be wrong if the ecosystem changed recently.

## How To Check

1. Get the current local time when dates matter:

```bash
date -Is
```

2. For local state, prefer local commands over web knowledge:

```bash
command --version
tool --help
package-manager list
```

3. For upstream state, use an available search or web tool, or fetch official docs/release notes when network access is appropriate.

4. State the concrete date used for the check when it matters.

## Guardrails

- Do not store the current time as long-term memory.
- Do not assume model training knowledge is current for fast-moving tools.
- Prefer official docs, local command output, package registries, or release notes over blog posts.
- If freshness cannot be verified, say what was checked and what remains uncertain.
