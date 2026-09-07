---
name: project-handoff-refresh
description: Use when a user asks to inspect project status, continue unfinished Codex work, refresh AGENTS.md, roadmap, progress, or handoff docs, identify stale assumptions, choose the next implementation slice, or produce exact validation commands after prior sessions.
---

# Project Handoff Refresh

## Overview

Refresh a local project's working truth before another implementation pass. Treat docs, recent sessions, git state, scripts, and ambient suggestions as evidence, then produce a compact next-slice handoff.

## Workflow

1. Read local guidance first.
   - Inspect `AGENTS.md`, README, progress/roadmap docs, package scripts, and obvious task docs.
   - Read only relevant source files needed to verify whether docs match code.
   - Check git status and never overwrite unrelated user work.

2. Reconstruct current state.
   - Identify shipped behavior, unfinished work, broken validation, stale docs, env requirements, and active blockers.
   - Use recent Codex history or ambient suggestions only as leads; confirm important claims in the repo.
   - Note stale assumptions explicitly, especially features still listed as missing after they exist in code.

3. Select the next slice.
   - Prefer one concrete, testable slice that unblocks real use.
   - Preserve existing scope boundaries. Do not broaden into redesign, migrations, auth changes, or infrastructure unless the evidence makes that the next blocker.
   - Name out-of-scope items so the next agent does not re-open them.

4. Produce the handoff.
   - Include current state, recommended next task, exact files/docs to read first, acceptance criteria, verification commands, and known risks.
   - If asked to update docs, edit only stale operational guidance and run the relevant docs/build checks.

## Guardrails

- Do not trust roadmap or AGENTS claims until checked against code.
- Do not create new architecture from a handoff task.
- Do not read secrets such as `.env.local` values; inspect env key names from examples or code.
- For local run, environment, origin, or port handoffs, use `local-dev-runbook`; use Vercel-specific skills for deployment work.
