# Post-Run Learning Adaptive Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Correct the orchestrator's runtime purpose and add a bounded post-run learning loop that records self-feedback, accepts user feedback, and requires explicit approval before changing the harness or remediating unrelated debt.

**Architecture:** Keep the existing shallow host-orchestrator plus bounded-worker model. Add one small run-lifecycle API, one retrospective store, and two lifecycle hook scripts. The host model performs semantic reflection; Node.js validates and persists evidence, feedback, and pending proposals. No daemon, database, autonomous source mutation, or nested scheduler is introduced.

**Tech Stack:** Node.js 20 ESM, JSON/JSONL state, Claude Code project hooks, Codex project hooks, native `node:test`.

## Global Constraints

- The core purpose is prompt interception, task decomposition, and task-specific selection of provider, model, reasoning effort, skills, hooks, and plugins.
- The source reconstruction process prioritizes implementation quality, then token efficiency, then delivery speed; this is not a hard-coded universal runtime objective.
- Model performance remains evidence-driven and time-decayed.
- New providers and models remain configuration-driven.
- Harness source, prompts, hooks, skills, plugins, policies, and dependencies may not be changed automatically.
- A pending improvement proposal requires explicit user approval before implementation.
- Debt introduced by the current run must be fixed before completion; unrelated pre-existing debt is recorded as a proposal rather than silently expanding scope.

---

### Task 1: Correct runtime purpose and routing language

**Files:**
- Modify: `src/router.js`
- Modify: `integrations/shared/user-prompt-submit.mjs`
- Modify: `integrations/claude/skills/adaptive-orchestrate/SKILL.md`
- Modify: `integrations/codex/skills/adaptive-orchestrate/SKILL.md`
- Modify: `README.md`
- Modify: `docs/DESIGN.md`
- Test: `test/router.test.js`
- Test: `test/prompt-hook.test.js`

**Interfaces:**
- Consumes: existing route candidate quality, token, latency, capability, risk, and performance evidence.
- Produces: a `decision.policy` explanation centered on best task fit, with task-specific priority ordering and explicit quality/token/latency constraints.

- [ ] Update failing tests so they reject the obsolete global `quality >> tokens > latency` directive.
- [x] Replace the accidental universal runtime order with task-specific priorities and explicit hard constraints.
- [ ] Rewrite root instructions around decomposition and capability selection.
- [ ] Run focused tests.

### Task 2: Add durable run lifecycle

**Files:**
- Modify: `src/state.js`
- Modify: `src/cli.js`
- Modify: `src/config.js`
- Test: `test/state.test.js`
- Test: `test/cli-smoke.test.js`

**Interfaces:**
- Produces: `aorch run --action start|task|finish|show` and an `.aorch/active-run.json` pointer.

- [ ] Write failing lifecycle tests.
- [ ] Implement active-run pointer resolution, terminal state, and review status.
- [ ] Expose the single `run` command with bounded actions.
- [ ] Run focused tests.

### Task 3: Add retrospective, user feedback, and approval-gated proposals

**Files:**
- Create: `src/learning.js`
- Create: `schemas/session-retrospective.schema.json`
- Modify: `src/cli.js`
- Test: `test/learning.test.js`

**Interfaces:**
- Produces: `aorch run --action reflect|feedback|decide`.
- Stores: `.aorch/learning/retrospectives/<run-id>.json`.

- [ ] Write failing validation and persistence tests.
- [ ] Implement retrospective validation and revision merging.
- [ ] Preserve user feedback and proposal decisions across revisions.
- [ ] Ensure proposals default to pending and never apply changes.
- [ ] Mark the run reviewed only after a valid retrospective is persisted.
- [ ] Run focused tests.

### Task 4: Add lifecycle hooks and reflection skill

**Files:**
- Create: `integrations/shared/session-review.mjs`
- Create: `integrations/claude/skills/post-run-reflection/SKILL.md`
- Create: `integrations/codex/skills/post-run-reflection/SKILL.md`
- Modify: `integrations/claude/settings.fragment.json`
- Modify: `integrations/codex/hooks.json`
- Modify: `src/install.js`
- Test: `test/session-review-hook.test.js`
- Test: `test/install.test.js`

**Interfaces:**
- Claude: `Stop` requests reflection before a terminal run ends; `SessionEnd` logs an unreviewed-run fallback event.
- Codex: `Stop` requests reflection before a terminal run ends.

- [ ] Write hook behavior tests first.
- [ ] Implement idempotent Stop behavior with `stop_hook_active` protection.
- [ ] Implement non-blocking SessionEnd fallback logging.
- [ ] Install both skills and hooks without duplication.
- [ ] Run focused tests.

### Task 5: Documentation, migration, and full verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `config/aorch.config.json`
- Modify: `README.md`
- Modify: `docs/DESIGN.md`
- Create: `CHANGELOG.md`

- [ ] Bump to `0.2.0`.
- [ ] Document the approval boundary and debt policy.
- [ ] Run `npm run check`.
- [ ] Run the full suite three times.
- [ ] Pack and smoke-test the npm tarball in a clean temporary project.
- [ ] Create ZIP and SHA-256 artifacts.

### Task 6: Harden lifecycle integrity and add bounded operational memory

**Files:**
- Modify: `src/state.js`
- Modify: `src/learning.js`
- Modify: `src/cli.js`
- Modify: `integrations/shared/user-prompt-submit.mjs`
- Modify: `integrations/shared/session-review.mjs`
- Modify: `schemas/session-retrospective.schema.json`
- Test: `test/state.test.js`
- Test: `test/learning.test.js`
- Test: `test/prompt-hook.test.js`
- Test: `test/session-review-hook.test.js`

**Interfaces:**
- Produces: `aorch lessons --query <text> --limit <n>` and `.aorch/learning/lessons.json`.
- Prevents: unsafe run IDs, orphaned active runs, false completed status, outcome mismatch, and loss of prior findings during retrospective revision.

- [x] Write failing tests for lifecycle guards, revision preservation, Stop continuation, and lesson injection.
- [x] Enforce path-safe run IDs and one unresolved active run at a time.
- [x] Require successful task states before `completed`.
- [x] Require retrospective outcome to match run status.
- [x] Preserve prior findings and decisions across revisions.
- [x] Deduplicate verified prevention rules and inject only relevant bounded context.
- [x] Keep improvement proposals approval-gated and source mutation disabled.
