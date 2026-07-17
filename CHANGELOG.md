# Changelog

## 0.6.2 - 2026-07-17

Pre-implementation critical-review hardening release. No new subsystems; this
release closes correctness, safety, and integrity defects found by an
adversarial multi-lens review of 0.6.1. See `docs/REVIEW-0.6.2.md`.

### Correctness (blocking defects)

- Fixed the nested-delegation lint so it no longer rejects every OpenAI-compiled
  worker prompt. The compiler's own "do not create a nested orchestration loop"
  instruction previously tripped the lint, so `aorch exec` threw for all Codex
  routes. The detector is now clause-scoped: it allows negated prohibitions
  (including multi-verb lists) and still catches genuine positive delegation,
  even when a positive clause shares a line with a prohibition.
- Included task `invariants` and `failureModes` on every OpenAI profile that
  receives a task declaring them (previously only the deep "Sol" profile did),
  so safety constraints can no longer be silently dropped from Terra/Luna
  worker prompts.
- Generic provider `promptMode: "argument"` now interpolates the compiled prompt
  through a required `{prompt}` placeholder and fails closed when it is missing,
  instead of launching the worker with no task at all.

### Crash-safety and process hygiene

- Detached workers are now reaped when the orchestrator exits or receives
  SIGINT/SIGTERM/SIGHUP, so killing the orchestrator no longer orphans a live,
  possibly write-capable worker.
- Termination signalling no longer throws from timers or event handlers, so a
  kill error (e.g. `EPERM`) can no longer crash the whole orchestrator.
- Worker success is gated on clean termination, not just `exitCode === 0`: a
  timed-out, aborted, or output-truncated worker that exits 0 is now failed
  rather than laundered into a successful, attested run.

### State and integrity

- Attestation `evidenceDigest` is computed over the redacted, persisted content,
  so an attestation carrying secret-shaped text no longer fails its own
  tamper-evidence check after redaction rewrites the file.
- Route observations and lesson memory are now protected control-plane change
  surfaces; a worker cannot write them without an approved, scoped proposal.
- Enforced the "delegated prompts are compiled from a provider-owned official
  profile" invariant: a claude/codex model configured without `promptProfileIds`
  now fails closed rather than silently using the generic contract while
  `officialSourcesOnly` is true.
- `aorch record` rejects an explicit `reviewed: false` instead of silently
  rewriting it to `true`, so an unreviewed observation cannot be laundered into
  route evidence.
- Control-plane approval is reserved before the workspace snapshot, so a
  control-plane task whose state directory is visible to git no longer fails
  its own claim and protected-change checks.
- `finishRun` refuses to re-finish a terminal run, preventing a silent status
  rewrite and reflection-state regression.
- Hardened stale-lock reclaim (in both the package and the installed journal
  hook) to re-check lock identity before reclaiming and to restore a vacated
  lock without clobbering a newer one; released the lock file if the identity
  stamp cannot be written.
- Observation `complexity` now defaults by risk to match the router, so
  low/high/critical-risk evidence recorded without an explicit complexity is no
  longer discarded during routing.
- Estimated progress can no longer round to 100% while a task is still running.

### Prompt and profile governance

- Prompt-profile freshness now applies the future-skew check to the newest
  source and the staleness check to the oldest, so a single future-dated source
  can no longer hide behind an older one.
- `validatePromptProfile` rejects a malformed `rules.requiredSections` that
  would otherwise crash the linter at execution time.
- Placeholder lint distinguishes unfilled stub markers/templates from prose that
  legitimately mentions TODO/TBD/FIXME, so real tasks are no longer hard-failed.
- Fixed the required-section metacharacter escape so section names containing
  regex metacharacters are matched literally.

### Security

- `redactSecrets` now covers compound secret key names (`access_token`,
  `client_secret`, …) and `--flag=value` forms.
- `redactValue` now redacts the entire value under a sensitive key regardless of
  shape; previously a secret held in an array or nested object under a sensitive
  key (e.g. `{ credentials: { data: "…" } }`) leaked because only non-object
  values were redacted by key.
- `aorch exec` redacts the receipt and attestation printed to stdout, matching
  the already-redacted persisted copies, so a worker secret no longer leaks to
  the terminal and CI logs.
- The thin gate keeps high-risk development work high-risk when a read-only
  negation only scopes one clause (e.g. "fix the auth bypass but do not modify
  config").

### CLI, config, and doctor robustness

- `validateConfig` rejects a non-boolean `enabled`, so `"enabled": "false"` can
  no longer leave a provider or model fully enabled.
- `aorch verify --isolation` rejects an unrecognized value instead of silently
  downgrading to same-workspace verification.
- `--fraction` and `--verification-timeout-ms` reject empty/zero values that
  previously reset progress or disabled the verification watchdog; value flags
  given with no value now report a clear error.
- `aorch doctor` fails a catalog with no enabled providers or models, prunes
  expired lessons under `--repair`, unlinks an invalid active-run pointer under
  the pointer lock, and skips (rather than fails on) non-active prompt profiles.
- `aorch trace` errors on a missing trace file instead of printing an empty
  summary.

### Scope glob and schema

- `**/x` scope patterns now match a top-level `x` as well as nested paths, so
  valid write claims are no longer rejected.
- The published worker-receipt schema requires non-empty strings, matching
  `validateReceipt`, so schema-valid receipts no longer fail late validation.

### Documentation and integrations

- Removed the last "direct lane / execution contract" wording from the installed
  Claude and Codex skills and the `aorch exec`/`prompt` dry-run output.
- Corrected the Codex scout agent to a catalog-supported reasoning effort and
  the README `promptCompilation.maxChars` key; added a test that guards
  integration-agent model/effort against the catalog.

## 0.6.1 - 2026-07-17

Bootstrap-only contract and prompt-boundary hardening release.

### Corrected orchestration semantics

- Removed runtime `direct` and `host-direct` execution. Every substantive task is delegated from a bootstrap-only host to a separate bounded worker.
- Added `single-worker` as the low-risk one-task, one-worker-call lane with no separate router-model call, no LLM reviewer, and no executable shadow.
- Made lane resolution monotonic so explicit task input may strengthen but never weaken the classifier's required safety lane.
- Kept `lanePolicy.direct` only as an in-memory migration alias; task-level `executionLane: direct` now fails with migration guidance.

### Gate and routing safety

- Separated external side-effect detection from local file-edit intent, preventing deploy/push/tag requests from being demoted by “do not modify files” phrasing.
- Removed implicit trusted/stable provider metadata; models referencing undeclared providers are ineligible.
- Clarified trace output with bootstrap-only host mode, actual external model call counts, and `counterfactual-only` shadow status.

### Official prompt compiler hardening

- Bound official prompt sources to provider-owned domains and publishers and added a 120-day freshness policy.
- Resolve the first fresh compatible official profile rather than allowing a stale earlier candidate to block a valid fallback.
- Added prompt-profile health to `aorch doctor` so stale guidance is detected before worker execution.
- Isolated repository/external context as reference data: quoted JSON for OpenAI prompts and policy-wrapped XML data for Anthropic prompts.
- Reject positive nested-delegation instructions in every worker prompt while allowing explicit no-delegation constraints.
- Migrated prompt manifests, examples, and installed Claude/Codex skills to `single-worker | bundled | orchestrated` and delegated-only execution.

### Verification

- Expanded regression coverage for host bootstrap-only normalization, unsafe lane downgrades, external-action classification, undeclared providers, stale/fresh prompt-profile fallback, context injection boundaries, nested delegation lint, schemas, examples, and integration installation.
- Replaced file-per-process `node --check` verification with one `vm.SourceTextModule` parser process, removing dozens of runtime startups from every release check and making repeated verification faster and more bounded.

## 0.6.0 - 2026-07-17

Adaptive lane and provider-aware prompt compilation release.

### Host-aware orchestration

- Added explicit host context: provider, requested/resolved model, requested/effective effort, source, and `preferred`, `pinned`, or `bootstrap-only` selection mode.
- Added `direct`, `bundled`, and `orchestrated` execution lanes. Low-risk coherent work can stay in the current host context with zero external model calls; broad or risky work escalates to a task graph.
- Added compact task signatures for ambiguity, repository/edit breadth, context/tool intensity, state complexity, test coverage, external integration, language, and framework.
- Added lane budgets that discourage splitting file discovery, implementation, focused tests, and diff inspection into separate model calls when one coherent bundle is sufficient.

### Adaptive model routing

- Added model `revision` to separate observations across silent model updates or alias changes.
- Added observation freshness and future-skew limits plus route diagnostics for matched, stale, future, and revision-mismatched evidence.
- Preferred host models now win only inside the final quality-equivalent route tier; pinned hosts fail rather than silently switch.
- Added record-only P2 shadow routing. Shadow alternatives are stored with `execute=false` and never launch a second write worker.

### Official-source prompt compiler

- Added six versioned prompt profiles for Anthropic Haiku/Sonnet/Opus and OpenAI Luna/Terra/Sol.
- Prompt profiles contain official source URLs and verification dates; non-official domains are rejected at load time.
- Added provider-aware prompt compilation: Claude XML-style contracts and Codex sectioned role/objective/scope/verification contracts, with concise Luna and invariant/failure-mode-rich Sol variants.
- Added deterministic prompt lint for required sections, bounded scope, acceptance criteria, output contract, capability IDs, hidden verifier leakage, placeholders, direct-lane delegation, and prompt size.
- Added prompt manifests containing model/revision/effort, profile/source metadata, capability IDs, and prompt SHA-256 without persisting the raw prompt.

### P2 observability

- Added append-only task traces for host, primary route, record-only shadow, prompt profile/hash, executor result, verifier result, review, and escalation events.
- Added `aorch trace` and exposed actual host/executor/shadow model use in task results and 30-minute progress reports.
- Added `aorch lane` and `aorch prompt --action compile|lint`; enhanced `route` and `exec` with host and shadow options.

### Reliability and integration

- Fixed worker process-tree termination so timed-out shell grandchildren cannot keep the orchestrator or test suite alive.
- Added bounded combined stdout/stderr capture, abort support, termination reasons, and SIGTERM-to-SIGKILL escalation.
- Updated Claude and Codex root skills to use lane classification, official-source prompt compilation, record-only shadow routing, and actual model-use reporting.
- Claude hook commands now fall back to an upward project-root search when `CLAUDE_PROJECT_DIR` is unavailable, matching Codex behavior in nested monorepo directories.
- Preserved the dependency-free Node.js runtime, thin blocking hook, file-first state, independent verifier, shallow delegation, and proposal-only harness improvement boundary.

### Evidence and control-plane integrity

- Added separate worker and verifier budgets for timeout, total deadline, output size, receipt size, and verification check count. Manual `aorch verify` uses the same verifier budgets as delegated execution.
- Added exact-path `evidenceFiles` so ignored `.env`, local configuration, and orchestration files participate in before/after evidence and isolated verifier replay without scanning every ignored file.
- Added best-effort secret redaction for persisted worker/verifier artifacts while retaining SHA-256 digests of original commands and outputs.
- Added bounded regular-file receipt reads that reject oversized files, symlinks, hard links, ownership changes, and read-time metadata races.
- Upgraded durable JSONL records to a backward-compatible `previousChecksum` chain and kept repair limited to safe torn-tail recovery.
- Added `orchestration.maxTasksPerRun` as a runtime decomposition ceiling, not a target.
- Added one-time scoped control-plane proposal reservations. Protected-file changes require a critical isolated task, hidden verification, and an approved immutable `affectedFiles` set; approval is consumed only after a passing attestation.
- Prevented explicit direct or bundled lanes from bypassing control-plane approval when their write scope can touch protected files.


## 0.4.0 - 2026-07-16

Critical-review hardening release. Every change below fixes a defect confirmed against the running code (most reproduced empirically) during a full-source review of 0.3.0; see `docs/REVIEW-2026-07-16.md` for the report. Test suite grew from 141 (1 failing) to 172, all passing.

### Correctness and crash fixes

- Handle `EPIPE` on worker stdin: a worker CLI that exits without consuming its prompt no longer crashes the whole orchestrator process.
- Korean gate patterns never matched because JavaScript `\b` has no word boundary next to Hangul; all Korean classification patterns now work.
- Destructive prompts without a development verb (`drop the users table in production`) and destructive prompts padded with display verbs (`... and show me what remains`) now classify high-risk/fail-closed instead of read-only/fail-open.
- Explicit read-only phrasing no longer masks external actions (`deploy ..., do not modify any files`), and Korean negative connectives (`수정하지 말고`) are recognized as explicit read-only intent.
- Bare `order`/`position` no longer escalate everyday prompts (`in order to`, `cursor position`) to critical.
- `--dry-run true` used to silently run a real execution: boolean flags no longer swallow values, unknown options fail loudly, and non-numeric timeouts are rejected instead of disabling the timeout.
- Bounded workers now default to a 60-minute watchdog (explicit `--timeout-ms 0` disables) instead of hanging forever.

### Durable-state hardening

- Stale locks are reclaimed by atomic rename with content verification, closing a race where two reclaimers could both acquire the lock.
- Locks older than a hard ceiling are reclaimable even when the recorded PID appears alive (PID reuse, EPERM); `release()` is retryable after transient unlink failures.
- `doctor --repair` refuses to rewrite a journal when damage precedes valid records; it previously deleted every record after a mid-file corruption.
- Journal payload checksums now hash the JSON round-trip, so `Date`-like values no longer produce permanently unreadable records; appends after a torn tail line start on a fresh line and stay sequence-valid; new journal files fsync their directory entry.
- The hook-side journal counts only parseable records for sequencing, matching `readJournal` semantics.
- Active-run containment checks compare realpaths, so symlinked project aliases are no longer misjudged (and no longer repair-deleted); a pointer to a missing run file blocks the Stop gate instead of silently disabling reflection.
- Task patches are field-whitelisted; a patch can no longer rewrite task `id` or `weight`.

### Routing, trust, and verification

- The router respects `provider.enabled`, uses a locale-independent tie-break, and reports generic ineligibility before the critical challenger gate so an empty candidate set is not misattributed to model maturity.
- `executeTask` reports low confidence when the attestation is inconclusive; capability rejection errors name the actual reason (write vs risk vs opt-in); doctor reports `exit N` when a provider CLI fails silently.
- Removed the unused `saveRun` export, whose blind load-then-save pattern would clobber concurrent updates; all run writes go through the re-reading `mutateRun` path.
- A partial or blocked worker receipt is still compared against actual workspace changes; a lying worker cannot hide in-place mutations behind a non-complete status.
- Attestations report `inconclusive` instead of `pass` when zero checks ran and no change evidence was verified.
- Verifier checks run in a non-login shell so user profiles cannot pollute hashed stdout/stderr evidence.
- Config capability entries no longer receive an implicit `reviewed` trust default, and a user-global artifact colliding with a configured template ID merges with conservative trust instead of inheriting `trusted`.
- Lesson confidence derives idempotently from raw evidence confidence instead of compounding across revisions; an explicit `--limit 0` returns no lessons.
- Empty-task runs report `planning` at 0% instead of `complete` at 100%.

### Install and integration

- Existing settings/hooks JSON is parsed before any file is written, with the file path in parse errors; non-array hook events are rejected with context.
- Codex hooks locate `.aorch/hooks` by upward search, so monorepo package installs work regardless of the git toplevel.
- `schemas/` is installed into `.aorch/schemas/` and skill instructions reference the installed path.
- The shipped review-observation example now uses an effort that the shipped catalog can actually produce.

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
