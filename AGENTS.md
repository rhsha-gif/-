# Adaptive Orchestrator v0.7.0 Subscription-First Implementation Contract

This file applies to the entire repository.

## Mission

Implement Adaptive Orchestrator v0.7.0 from the included v0.6.1 source baseline. The target is the **subscription-first minimal sound core** described in the v0.7 design and plan. Make the control, verification, authentication, quota, and lifecycle invariants mechanically true rather than documenting intended behavior only.

## Primary User Environment

Design and verify for this actual environment first:

```text
Host 1: ChatGPT desktop app, Codex view
OpenAI worker transport: Codex CLI signed in with ChatGPT
Host 2: Claude Code CLI signed in with Claude Pro/Max subscription
Anthropic same-host worker: permit-bound Claude native subagent
Anthropic cross-host worker: subscription-authenticated claude -p
Direct API use: exceptional and explicit, never default or fallback
Execution: local repository and managed Git worktree
```

Do not turn the Codex desktop app into an undocumented subprocess or IPC API. Use it as the host UI and use the official Codex CLI for bounded OpenAI worker execution.

Do not claim strict bootstrap-only enforcement in the Codex app unless current official support and an authenticated app fixture prove that the installed policy hook intercepts write-capable tools. Implement an explicit `strict|advisory|unsupported|unknown` enforcement status. If the app surface cannot be strictly controlled, preserve the app workflow but state the limitation and offer Codex CLI host or read-only-host-workspace fallback rather than inventing a hook.

Do not assume `claude -p` has a separate subscription credit pool. The current Anthropic support notice says the announced separation is paused and `claude -p` still draws from subscription limits. Track transport separately but use one Anthropic subscription pool until official policy actually changes.

## Read First, in This Order

1. `CODEX_START_HERE.md`
2. `docs/SUBSCRIPTION-LOCAL.md`
3. `docs/official/CLIENT-SUBSCRIPTION-SOURCES.md`
4. `docs/superpowers/specs/2026-07-17-v0.7-minimal-sound-core-design.md`
5. `docs/superpowers/plans/2026-07-17-v0.7-minimal-sound-core.md`
6. `docs/reviews/REVIEW-2026-07-17-v0.6.2-FIRST-PRINCIPLES.md`
7. Existing `README.md`, `docs/DESIGN.md`, tests, and implementation

If documents conflict, preserve the user environment and invariants in the v0.7 subscription-first design. Use the implementation plan for file-level sequencing. Use the review as rationale and an adversarial checklist, not as permission to add every proposed subsystem.

## Non-Negotiable Product Invariants

- The installed Codex/Claude host is bootstrap-only for substantive work.
- Low-risk coherent work is one delegated worker call, not host-direct implementation and not gratuitous multi-agent decomposition.
- Worker receipts are claims. Only a passing attestation bound to captured content may complete a task.
- Completed runs require valid passing attestations for every non-skipped task.
- Hidden verifier fields must not be exposed to the worker prompt or public worker envelope.
- The regex gate is an escalation floor, not the final multilingual intent classifier.
- Stale prompt guidance warns and falls back; it does not cause a date-triggered fleet outage.
- Non-executed route alternatives are counterfactual explanations, never outcome evidence.
- Automatic observations describe execution reliability, not product quality.
- Harness/control-plane modification remains proposal-driven and human-bound.
- Default access is `subscription-local`.
- API keys, API billing, paid-credit overflow, gateways, cloud providers, and Codex cloud tasks are not automatic fallbacks.
- Provider entitlement and remaining allowance are never invented.
- Codex app enforcement strength is never invented.

## Subscription and Authentication Rules

- Reject or strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, Bedrock, Vertex, Foundry, and equivalent API/custom endpoint overrides from subscription workers.
- Treat `CLAUDE_CODE_OAUTH_TOKEN` and `apiKeyHelper` as separate automation credentials requiring explicit policy, not ordinary interactive subscription login.
- Reject or strip `OPENAI_API_KEY`, custom OpenAI base URLs, and third-party provider overrides from subscription-local Codex workers.
- Never enable credits or switch to PAYG automatically when a subscription limit is reached.
- Never infer Codex app authentication by reading undocumented application state.
- A model profile is `unknown` until client evidence or an opt-in live canary supports availability. Critical executors cannot be unknown.
- API price tables must not be converted into subscription cost estimates.

## Engineering Constraints

- Node.js 20+ ESM.
- Keep runtime dependencies at zero unless the user explicitly approves a change.
- Do not add a daemon, external database, queue, dashboard, nested scheduler, online reinforcement learning, write shadow execution, or automatic production self-modification.
- Preserve file-first durable state and Git-worktree verification unless the v0.7 design explicitly changes a boundary.
- Prefer deleting misleading/dead machinery over preserving compatibility theater.
- Avoid unrelated refactoring. Refactor only where it directly enables a v0.7 invariant or removes duplicated unsafe logic.
- Validate exact paths and schemas before execution. Fail closed at security boundaries.

## Official Documentation Rule

When behavior depends on current Claude Code or Codex details—hook schema, tool matchers, CLI flags, authentication precedence, permission modes, sandbox behavior, structured output, model/effort availability, subscription limits—consult **only current official Anthropic or OpenAI documentation**.

The handoff records the currently verified sources in `docs/official/CLIENT-SUBSCRIPTION-SOURCES.md`. Do not silently replace a recorded fact from memory. Record an official-document-driven deviation in `docs/REVIEW-0.7.0.md` with verification date and implementation impact.

For worker prompt engineering:

- Maintain a provider-neutral canonical task envelope.
- Compile provider/model-strategy-specific prompts from versioned local templates informed by official guidance.
- Keep reference data structurally separate from instructions.
- Do not expose hidden verifier commands, protected scope, approval secrets, credentials, usage snapshots, or parent conversation history.
- Use strict structured output where the client supports it.
- Describe local client behavior, not API SDK behavior, in the default subscription profile.

## Development Process

1. Run `scripts/prepare-codex-workspace.sh` and resolve every subscription-environment warning before live provider smoke tests.
2. Ensure the source is in Git and work on an isolated feature branch/worktree.
3. Run the baseline test suite before editing.
4. Implement the plan task by task with red-green TDD.
5. Each task ends in a coherent, independently testable deliverable and focused commit.
6. Do not split setup, implementation, tests, and documentation into separate model tasks unless a reviewer can meaningfully approve one and reject another.
7. Review actual diff and evidence at natural checkpoints.
8. If the same fix fails three times, reassess the architecture instead of stacking patches.

If Superpowers skills are unavailable, follow the same TDD, isolation, review, and verification requirements manually.

## Required Release Evidence

Before claiming v0.7.0 complete:

- Update package metadata, README, design, changelog, subscription-local guide, and official-source record.
- Add `docs/REVIEW-0.7.0.md` with implemented invariants, deviations, residual risks, and provider-document checks.
- Run focused tests and `npm run check` three times.
- Run coverage and inspect security-critical branches.
- Review the full baseline-to-head diff and fix critical/important findings.
- Pack and clean-install the TGZ.
- Exercise help, subscription doctor, install twice, hooks, route, exec dry-run, worktree, compact preview, and uninstall.
- Export a clean ZIP and rerun the full check after extraction.
- Produce checksums and release manifest.
- Separate local verification, authenticated client smoke, and official-doc-only inference.

## Prohibited Completion Shortcuts

Do not:

- mark tasks complete because a worker says “done”;
- weaken tests, hidden checks, scope, trust, authentication, quota, or approval controls to obtain green output;
- persist a non-executed alternative as performance evidence;
- silently retain dead native agents or duplicate hook runtimes;
- add API/PAYG/cloud fallback because subscription smoke is difficult;
- claim actual client entitlement or usage behavior without authenticated evidence;
- leave TODO/TBD placeholders in the release path.
