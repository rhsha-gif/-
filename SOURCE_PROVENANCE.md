# Source Provenance

## Executable Baseline

- Source baseline: Adaptive Orchestrator v0.6.1
- Declared baseline commit: `e6dacca8515e1854db927eb144489751452d98a8`
- Package version: `0.6.1`
- Baseline verification during original handoff assembly: `npm test` → 268 passed, 0 failed

The baseline executable code has not been pre-implemented toward v0.7.0. Production-code changes are expected to be performed and reviewed by the implementing Codex session.

## First-Principles Review Input

- Original review: `REVIEW20260717design.md`
- Packaged copy: `docs/reviews/REVIEW-2026-07-17-v0.6.2-FIRST-PRINCIPLES.md`
- SHA-256: `3ecf076315a176b25f6553b35fda116279bb0b972f9b07077aba6d5242ce0bed`
- The review targets a v0.6.2 design state; it is not a v0.6.2 source archive.
- Verify every finding against the supplied v0.6.1 baseline before editing.

## v0.7 Subscription-First Inputs

Authoritative implementation inputs added to this handoff:

- `AGENTS.md`
- `CODEX_START_HERE.md`
- `CODEX_PROMPT.md`
- `docs/SUBSCRIPTION-LOCAL.md`
- `docs/official/CLIENT-SUBSCRIPTION-SOURCES.md`
- `config/subscription-local.target.json`
- `docs/superpowers/specs/2026-07-17-v0.7-minimal-sound-core-design.md`
- `docs/superpowers/plans/2026-07-17-v0.7-minimal-sound-core.md`

## User Environment Assumptions

The handoff is optimized for:

```text
OpenAI: Codex in the ChatGPT desktop application, with Codex CLI as the local worker transport
Anthropic: Claude Code CLI on a Claude Pro/Max subscription
API use: exceptional, explicit, and outside the default runtime path
Billing/limits: subscription allowances, no automatic API/PAYG/credit fallback
Execution: local repositories and managed worktrees
```

These are product requirements, not facts inferred from the baseline source.

## Official Product Facts

The sources and verified dates are recorded in `docs/official/CLIENT-SUBSCRIPTION-SOURCES.md`.

One important correction made during this update:

- A previously announced separate monthly Agent SDK credit for `claude -p` was paused.
- As of 2026-07-17, Anthropic states that Agent SDK and `claude -p` still draw from subscription usage limits.
- The target therefore uses one `anthropic-subscription` pool and separate transport labels, not separate quota pools.

## Assembly Changes

The handoff assembly added or updated only documentation, target configuration, validation metadata, and workspace preparation files. It did not implement the v0.7 production runtime.

Added or updated:

- root implementation contract, Codex start prompt, and README handoff banner;
- subscription-local deployment guide;
- official-source record;
- target config marked as not loadable by the v0.6.1 baseline;
- v0.7 design and implementation plan;
- handoff manifest, file index, checksums, and workspace preparation script.
