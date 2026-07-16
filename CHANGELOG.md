# Changelog

## 0.3.0 - 2026-07-16

### Control-plane hardening

- Reduced `UserPromptSubmit` to a bounded classifier and minimum-policy injector. Inventory discovery, lessons retrieval, decomposition, routing, and provider execution now occur outside the blocking hook.
- Added risk-first provider and capability trust policy with `trusted`, `reviewed`, and `untrusted` tiers; untrusted capability descriptions are withheld from inventory output.
- Added provider adapter maturity (`stable` or `experimental`), explicit opt-in for untrusted providers, and fail-closed critical routing.
- Capability discovery now rejects instruction-like manifest/frontmatter IDs, falls back to safe directory IDs, and fails closed on cross-type ID collisions.
- Read-only questions about high-risk subject matter remain read-only instead of triggering a durable mutation workflow.
- Write workers now require an isolated linked worktree. Low/standard in-place execution requires explicit `allowInPlaceWrite`; high/critical in-place writes fail closed.
- Separated worker receipts from verifier attestations. Worker output is now a claim, not completion evidence.
- Added verifier-only commands, optional sterile Git-worktree replay, real-diff comparison, command/artifact hashes, and persisted failure attestations.
- Completed write claims require Git evidence, and bounded workers are rejected if they change Git `HEAD` to conceal commits.
- Added `aorch verify` for independent replay of an existing worker claim.

### Durable state

- Added atomic JSON writes using fsync and rename.
- Added locked, sequenced, checksummed JSONL journals with legacy-read compatibility.
- Added partial-tail repair and stale-lock recovery through `aorch doctor --repair`.
- Stale-lock recovery checks whether the recorded owner PID is still alive before reclaiming the lock.
- Added active-run pointer validation and repair.
- Migrated observations and lifecycle fallback logging to the durable journal format.

### Learning and progress governance

- Lessons now require scope tags, evidence, confidence, source runs, advisory status, and expiry.
- Expired or malformed lessons are excluded from retrieval; `aorch lessons --lint` reports governance failures.
- The root hook no longer reads or injects lessons. The root skill loads relevant advisory lessons outside the blocking path.
- Progress now reports phase, confidence, blockers, evidence count, last evidence timestamp, and active tasks in addition to an estimated percentage.
- Progress text neutralizes control characters and malformed lesson files produce lint findings instead of crashing retrieval tooling.

### Adaptive evidence and integration integrity

- Model-performance evidence is stratified by provider, profile, model, effort, task kind, role, risk, and complexity so low-risk observations do not silently promote high-risk routes.
- Standard-risk verification now defaults to an isolated Git worktree.
- Codex hook installation works in non-Git projects by falling back to the current directory, and repeated installation remains idempotent.
- Worker, verifier, and installation artifacts use atomic writes.

### Documentation and compatibility

- Documented the thin-gate architecture, verifier plane, supply-chain trust boundary, file-state repair, and proposal-only self-improvement.
- Kept the dependency-free Node.js runtime and file-first state. No daemon, database, dashboard, nested worker scheduler, or autonomous source mutation was added.

## 0.2.0 - 2026-07-16

### Changed

- Reframed the product around prompt interception, task decomposition, and task-specific capability selection.
- Removed the misleading claim that `quality > tokens > latency` is the orchestrator's universal runtime objective.
- Route decision metadata now reports `task-specific-priority-order`, explicit constraints, and per-stage candidate counts.
- Updated both root skills to start and close durable runs.

### Added

- `aorch run` lifecycle actions: `start`, `task`, `finish`, `show`, `reflect`, `feedback`, and `decide`.
- Durable active-run pointer and terminal review state.
- Post-run retrospective storage with revision support.
- User feedback linked to completed runs.
- Approval-gated improvement proposals that never apply code automatically.
- Enforcement that technical debt introduced by the current run must be resolved with evidence before closure.
- Claude `Stop` and `SessionEnd` review hooks.
- Codex `Stop` review hook.
- `post-run-reflection` skill for both CLIs.
- Session retrospective JSON Schema and examples.
- Bounded operational memory for verified error-prevention rules.
- Lifecycle guards for unsafe run IDs, unresolved active runs, incomplete `completed` states, and retrospective outcome mismatches.
- Additive retrospective revisions that preserve prior findings and proposal decisions.
- Task-specific routing priorities and hard quality/token/latency constraints, with fail-closed validation.
- A separate task-complexity axis that constrains eligible model-effort profiles without conflating difficulty with risk.
- Model-catalog validation for cost indices, effort variants, and adaptive evidence controls.
- Path-safe task run IDs for evidence directories.
- Retrospective input may omit `runId` when the target run is already selected; mismatched explicit IDs still fail closed.
- Honest doctor output that distinguishes executable/catalog checks from unprobed account-level model support.

### Safety

- Harness code, prompts, hooks, skills, plugins, policies, dependencies, adapters, and unrelated project debt require explicit user approval before modification.
- Proposal approval records consent only; implementation happens in a separate orchestrated run.
