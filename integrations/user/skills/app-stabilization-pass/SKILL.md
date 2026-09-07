---
name: app-stabilization-pass
description: Stabilize, optimize, harden, baseline, or clean up an application after feature work, and perform a project-wide health sweep when explicitly requested. Use for post-MVP stabilization, full-project debugging, real-user-flow inspection, bounded technical-debt cleanup, operational AGENTS/docs repair, and final build/test/manual validation without broad redesign or feature expansion.
---

# App Stabilization Pass

## Purpose

Choose the smallest mode that satisfies the request:

- **Focused stabilization**: repair the touched area after a feature burst.
- **Project health sweep**: only when the user explicitly asks for a full-project diagnosis, real-use problem hunt, or technical-debt pass.

Both modes make the current app easier to run, less fragile, and accurately documented without turning the work into a redesign or feature expansion.

## Workflow

1. Read the local instructions first.
   - Inspect `AGENTS.md`, package scripts, README, and any project-specific setup notes.
   - Identify the stack, app entry points, test commands, build commands, and dev launcher.
   - If AGENTS guidance is absent or stale, note that before editing it.

2. Establish the baseline.
   - Check git status and avoid reverting unrelated user changes.
   - Run the fastest existing validation first, usually typecheck, lint, unit tests, or build.
   - Capture the first real failure before changing code.

3. Exercise real user paths in health-sweep mode.
   - Start the app and perform the smallest representative journey through entry, core action, persistence, and revisit.
   - Record console errors, network failures, broken empty/error states, and mobile layout defects.
   - Classify findings by severity before editing. Skip this mode for a narrow stabilization request unless the touched behavior needs a manual check.

4. Fix only stability-relevant issues.
   - Prioritize broken builds, runtime import errors, route/API mismatches, unsafe local startup, stale scripts, missing env guidance, obvious test regressions, and user-facing dead ends.
   - Avoid redesign, feature expansion, dependency churn, or formatting-only sweeps unless required to make validation pass.
   - Preserve existing UI language, domain wording, and product constraints.
   - In health-sweep mode, remove dead code, duplication, unused dependencies, or unsafe type bypasses only when evidence shows they are real debt and behavior can remain unchanged.

5. Update AGENTS/docs only when behavior changed.
   - Keep AGENTS concise and operational: setup commands, validation commands, data/source constraints, and known local caveats.
   - Do not duplicate README content unless AGENTS needs a short agent-facing rule.
   - Remove stale instructions only after confirming the current workflow.

6. Validate from the user's path.
   - Re-run the failing command and any adjacent check needed by the edit.
   - For frontend changes, build and, when practical, open the local app with the Browser skill/plugin to catch obvious layout or runtime failures.
   - For backend/API changes, run focused tests before broad suites.

## Output

End with:

- Files changed.
- What was stabilized.
- Health-sweep findings by severity when that mode was requested.
- Validation commands and results.
- Remaining limitations or checks that could not be run.

Stop when the app builds/tests cleanly for the touched area, startup instructions match reality, and AGENTS/docs no longer contradict the working flow.
