# Adaptive Orchestrator v0.6.0 Review

## Scope

v0.6.0 adds three product capabilities without introducing a daemon, database, dashboard, nested scheduler, or autonomous harness mutation:

1. host-aware `direct`, `bundled`, and `orchestrated` execution lanes;
2. provider/model-specific prompt compilation from versioned official-source profiles;
3. P2 record-only shadow routing and actual model-use trace.

It also fixes the baseline process-tree leak that could keep the test suite alive after a shell worker timed out.

The final release also carries forward the integrity boundaries discussed before v0.6: explicit ignored-file evidence, secret-safe persistence, separate execution/verification budgets, hash-chain journals, and one-time scoped approval for control-plane changes.

## Design findings addressed

### Over-decomposition

Low-risk coherent work no longer requires a router call followed by a separate worker and reviewer by default. Direct lane returns a host execution contract with zero external model calls. Bundled lane limits work to a coherent specialist bundle. Orchestrated lane remains available when risk, ambiguity, state complexity, breadth, external effects, or failure evidence justifies it.

### Host selection ambiguity

The runtime distinguishes the CLI host from delegated workers. Host modes are `preferred`, `pinned`, and `bootstrap-only`. Unknown resolved models remain unknown rather than being inferred from aliases.

### Prompt quality as a routing dependency

A good route can still fail if the delegation prompt is generic or incomplete. v0.6 adds official-source prompt profiles for Anthropic Haiku/Sonnet/Opus and OpenAI Luna/Terra/Sol, deterministic compilation, and lint that rejects missing boundaries, hidden verifier leakage, placeholders, unknown capability IDs, and direct-lane delegation.

### Model drift

Performance evidence is keyed by model revision and task signature. Stale, future, and revision-mismatched observations are excluded and reported as diagnostics.

### P2 without duplicate writes

Shadow routing is record-only. It records an eligible alternative with `execute=false`, never creates a second write worker, and does not become performance evidence without a real independent outcome.

### Operator visibility

Task traces and progress distinguish the host, actual executor, record-only shadow, prompt profile, and verifier result. This answers which model and effort actually influenced each stage.

### Direct-lane safety boundary

Direct execution reduces model calls, not governance. Any write scope that can touch configured control-plane files is forced to the orchestrated lane even when the task explicitly requests `direct`. Ordinary workers cannot mutate protected files, and an approved change is consumed only after the actual change set fits the proposal and independent verification passes.

### Evidence durability

Worker process trees are bounded by timeout and output limits. Git-ignored evidence files are fingerprinted explicitly, persisted evidence is redacted, file receipts are bounded and race-checked, and JSONL journals link records through `previousChecksum`. These controls improve detection and recovery but do not claim OS-level sandboxing, complete DLP, or externally anchored tamper-proof storage.

## Remaining limits

- The Claude `UserPromptSubmit` hook input does not expose the active model; the root agent must pass known host context or preserve it as unknown.
- Prompt profiles encode official guidance but still require project-specific evaluation.
- A record-only shadow is a route counterfactual, not proof that the alternative would have performed better.
- Worktree isolation does not isolate databases, ports, caches, or external accounts.
- The independent verifier cannot prove semantic correctness for every domain.
- Actual Claude and Codex account entitlements require provider-native canary execution in the installation environment.

## Release acceptance criteria

- Direct low-risk work performs zero provider spawns.
- Bundled/orchestrated delegated prompts use an official-source profile when configured.
- Hidden verifier commands never appear in worker prompts.
- Shadow routes always have `execute=false`.
- Host, executor, shadow, prompt, and verifier events survive append-only trace replay.
- Baseline and new test suites terminate cleanly with no child-process leak.
- Clean ZIP and npm tarball reproduce the full check and installation smoke tests.
- Manual and delegated verification use the same total/output/check-count budgets.
- Protected paths cannot execute through direct or bundled lanes.

## Verified release evidence

Fresh verification on the final source tree:

```text
npm run check × 3
253 tests per run
253 passed
0 failed
0 skipped
```

Coverage run:

```text
line:     95.28%
branch:   79.58%
function: 96.05%
```

Clean npm-package smoke verification:

- tarball installed into an empty npm prefix as version `0.6.0`;
- Claude and Codex project integrations installed twice without duplicate hooks;
- both hook commands resolved the project root from a nested monorepo directory without relying on the current Git toplevel;
- direct lane returned zero external model calls and no provider command;
- bundled route selected a concrete primary plus `execute=false` shadow;
- prompt compilation selected an official-source profile and emitted a 64-character prompt digest;
- delegated dry-run produced a bounded provider command without executing the provider.

The build environment did not contain authenticated `claude` or `codex` executables. Account-specific model entitlement, actual provider structured output, and real cross-provider execution therefore remain installation-environment canary checks rather than release claims.
