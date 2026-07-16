# Control Plane Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Harden Adaptive Orchestrator without adding a daemon or database, while preserving prompt-first task decomposition and dynamic provider/model/effort/capability routing.

**Architecture:** Keep the file-first Node.js runtime. Reduce the prompt hook to a bounded classifier/policy gate, move operational memory lookup into the orchestration skill, treat worker receipts as claims, issue separate verifier attestations, enforce trust tiers before routing, and add atomic locked journals with repair support.

**Tech Stack:** Node.js ESM, built-in `node:test`, JSON/JSONL, Git worktree verification when available.

## Global Constraints

- Preserve dependency-free runtime.
- Do not add a daemon, external database, web dashboard, or recursive worker orchestration.
- Harness source and control-plane policy changes remain proposal-only and require explicit user approval.
- Existing v0.2.0 behavior remains compatible unless a security or integrity requirement explicitly tightens it.
- Every behavioral change requires a failing test first and fresh full-suite verification.

---

### Task 1: Thin Root Gate

**Files:**
- Create: `src/gate.js`
- Modify: `integrations/shared/user-prompt-submit.mjs`
- Modify: `integrations/claude/settings.fragment.json`
- Modify: `integrations/codex/hooks.json`
- Test: `test/gate.test.js`
- Test: `test/prompt-hook.test.js`

**Interfaces:**
- Produces: `classifyPrompt(prompt)` and `buildGateContext(classification)`.
- The hook performs no inventory scan, model routing, or lessons retrieval.

- [x] Write tests for bounded classification and no lessons-file reads.
- [x] Implement a fast prompt classifier with `read-only`, `development`, and `high-risk` classes.
- [x] Inject only minimum policy and reduce hook timeout.
- [x] Run focused hook tests.

### Task 2: Capability and Provider Trust Policy

**Files:**
- Modify: `config/aorch.config.json`
- Modify: `src/config.js`
- Modify: `src/inventory.js`
- Modify: `src/capabilities.js`
- Modify: `src/router.js`
- Modify: `src/task.js`
- Modify: `schemas/task.schema.json`
- Test: `test/config.test.js`
- Test: `test/inventory.test.js`
- Test: `test/capabilities.test.js`
- Test: `test/router.test.js`

**Interfaces:**
- Provider/capability `trustTier`: `trusted | reviewed | untrusted`.
- Adapter `maturity`: `stable | experimental`.
- Task `allowUntrustedCapabilities` defaults to false.

- [x] Write tests that critical execution requires trusted stable providers.
- [x] Write tests that project-local discoveries are reviewed and user-global discoveries are untrusted.
- [x] Implement trust validation and route/capability filtering.
- [x] Run focused routing and inventory tests.

### Task 3: Worker Claim and Independent Verifier Attestation

**Files:**
- Create: `src/verifier.js`
- Create: `schemas/verifier-attestation.schema.json`
- Modify: `src/task-runner.js`
- Modify: `src/task.js`
- Modify: `schemas/task.schema.json`
- Modify: `src/cli.js`
- Modify: `src/providers/base.js`
- Test: `test/verifier.test.js`
- Test: `test/task-runner.test.js`
- Test: `test/cli-smoke.test.js`

**Interfaces:**
- Task `verifierCommands` are withheld from the worker prompt.
- `verifyTaskClaim()` issues an immutable attestation with command replay hashes.
- `aorch verify --task <file> --receipt <file>` replays verification independently.

- [x] Write tests proving worker receipts cannot alone produce completion.
- [x] Write tests for hidden verifier commands and separate attestation artifacts.
- [x] Implement claim hashing, command replay, artifact hashing, and attestation persistence.
- [x] Add optional Git sterile-worktree replay with safe fallback.
- [x] Run focused verifier and task-runner tests.

### Task 4: Durable File Store and Repair

**Files:**
- Create: `src/file-store.js`
- Modify: `src/state.js`
- Modify: `src/learning.js`
- Modify: `src/observations.js`
- Modify: `integrations/shared/session-review.mjs`
- Modify: `src/doctor.js`
- Modify: `src/cli.js`
- Test: `test/file-store.test.js`
- Test: `test/state.test.js`
- Test: `test/learning.test.js`
- Test: `test/doctor.test.js`

**Interfaces:**
- Atomic JSON writes use fsync + rename.
- JSONL appends use a lock and checksum envelope.
- `aorch doctor --repair` reports or repairs partial JSONL records and stale locks.

- [x] Write crash/partial-line/stale-lock tests.
- [x] Implement atomic writes, lock acquisition, checksum journal, and repair.
- [x] Migrate state, learning, observation, and lifecycle logging.
- [x] Extend doctor output and CLI repair flag.
- [x] Run focused durability tests.

### Task 5: Lesson and Progress Governance

**Files:**
- Modify: `src/learning.js`
- Modify: `src/progress.js`
- Modify: `integrations/claude/skills/adaptive-orchestrate/SKILL.md`
- Modify: `integrations/codex/skills/adaptive-orchestrate/SKILL.md`
- Modify: `integrations/claude/skills/post-run-reflection/SKILL.md`
- Modify: `integrations/codex/skills/post-run-reflection/SKILL.md`
- Test: `test/learning.test.js`
- Test: `test/progress.test.js`

**Interfaces:**
- Lessons require scope, confidence, type, evidence, expiry, and remain advisory.
- Progress includes phase, confidence, blocker, evidence count, and last evidence timestamp.

- [x] Write tests for expired lessons, missing scope/evidence, and advisory output.
- [x] Implement lesson TTL/governance and linting.
- [x] Implement richer progress status without fabricated ETA.
- [x] Run focused tests.

### Task 6: Documentation, Packaging, and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/DESIGN.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `examples/*`

- [x] Update version to 0.3.0 and document migrations.
- [x] Run `npm run check`.
- [x] Run the full test suite three times.
- [x] Pack npm tarball and install it into a clean temporary project.
- [x] Install both CLI integrations twice and confirm idempotence.
- [x] Create ZIP, TGZ, and SHA-256 artifacts.
