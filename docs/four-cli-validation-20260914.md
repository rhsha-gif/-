# Four-CLI validation, 2026-09-14

This record distinguishes measured CLI behavior, integration rework and the separate app observation limitation.

## Acceptance comparison

The same two implementation contracts and two fixed-source research contracts are executed in separate linked worktrees. The lead prepared the task boundary and acceptance commands before dispatch. Each worker may change only its result file. Verification commands run independently after the worker. These are small representative cases, not a model ranking or a broad coding benchmark.

| Case | Route | Profile | Gate passed | Worker ms | Input tokens | Output tokens | Cache-read tokens |
|---|---|---|---|---|---|---|---|
| bars | direct | codex-astra | True | 118537 | — | — | — |
| bars | split | agy-flash | True | 104829 | 90827 | 22257 | 61231 |
| intervals | direct | codex-astra | True | 98560 | 76417 | 728 | 50176 |
| intervals | split | codex-terra-general | True | 202417 | 218528 | 5500 | 186368 |
| evidence | direct | codex-astra | True | 98360 | 103030 | 745 | 76288 |
| evidence | split | grok-general | True | 50268 | 34657 | 2482 | 14080 |
| audit | direct | codex-astra | True | 98256 | 102827 | 685 | 76160 |
| audit | split | claude-sonnet-general | True | 51476 | 12 | 2818 | 263935 |

Reported token fields are provider-native counters. Cache creation is reported separately by Claude; providers count cache/input differently. Missing is not zero. The first Astra bars run predates usage normalization and has no recorded token counters. Parent design/synthesis work in this conversation is not attributed to CLI token counters, so these measurements cannot establish total orchestration savings. Terra passed but took longer than Astra on this one intervals task. Research uses supplied official-source cards; external search quality is not measured.

## Verified boundaries

- Final full-check and rollout counts are recorded in the rollout section below. The single skipped test requires Windows symlink privileges.
- All four CLIs actually read their installed adaptive-orchestrate skill and correctly described lead decomposition/synthesis, source evidence and the prohibition on worker re-delegation. Native probes are separate from the eight accepted benchmark executions.
- Four CLI executable/version probes succeeded. Antigravity/Grok process PATH was stale; installed executable resolution succeeded without altering PATH.
- Native Antigravity and Grok receipt parsing, malformed JSON, timeouts, authentication/quota classification, input continuation, duplicate continuation and scope checks have fixture coverage. All four CLIs also returned real accepted work.
- Astra passed four fixed gates; automatic eligibility is restricted to implementation/research, standard complexity and low/standard risk. AGY Flash is restricted to implementation at the same complexity/risk. Grok is restricted to research with the explicit `local-evidence` tag at the same complexity/risk; its adapter does not offer external web search. AGY Pro remains unvalidated and excluded from automatic selection. These gates are contract-specific evidence, not a broad model ranking.
- Weekly preliminary evaluation made no policy change because existing evidence lacked sufficient independently checked ordinary-task metadata.
- Monday 09:00 Asia/Seoul Codex heartbeat registered as `aorch`. The prompt requires quiet unchanged outcomes and does not synthesize missed runs.
- User and ten existing registered project installations passed conflict preflight. Rollout is recorded separately below.

## Integration rework and independent review

- AGY initially denied shell execution and workspace discovery; explicit workspace access and file-only native profiles resolved this. Native agents require the `finish` tool, and unsupported `code_search` was removed. Missing finish caused an initial timeout. SUCCESS without structured_output is rejected. Parent verification executes commands after the worker.
- Grok requires an inline schema. In 1.0.30 schema-constrained work prematurely returned without tool work, so execution now uses a tool-enabled phase followed by native schema finalization in the same session and sandbox. Work-phase state is retained for a finalizer retry; finalized work is not re-executed. A dedicated finalization time reserve prevents the work phase consuming its entire budget. Native agents and adapter restrictions exclude shell and re-delegation.
- The table reports the final accepted executions. Earlier AGY and Grok integration failures and retries are retained in separate worktree receipts; their time is not included in the table. No claim of first-attempt integration success or overall savings is made.
- The first independent review did not return a receipt before timeout. Concurrent parent-created diagnostic JSON caused the scope guard to flag two unrelated files. Review was relaunched with a bounded scope on an isolated source snapshot; this first result is not counted as reviewer quality failure.
- Two bounded Opus reviews returned structured findings. Fixes cover profile/capability eligibility on forced routes and escalation, fail-soft telemetry, native readonly tools, same-family review exclusions, reviewer-negative scoring and duplicate evidence. High-risk automatic learning remains excluded by the approved plan. Controller evidence and policy consistency protect against copied or edited workspace telemetry; this is a trusted local-user system, not an isolation boundary against a malicious process with the same OS account.
- Antigravity app instruction recognition is not established by CLI file generation or CLI execution. This host has no native app observation surface available for that separate check.

## Sources

- [Antigravity headless interface](https://www.antigravity.google/docs/cli/headless/)
- [Antigravity scoped permissions](https://www.antigravity.google/docs/cli/permissions/)
- [Antigravity app skill paths](https://antigravity.google/docs/skills)
- [Grok developer overview](https://docs.x.ai/build/overview)
- Installed Grok 1.0.30 README and CLI --help; CLI flags were validated against the installed executable.

## Local evidence locations

The integration workspace is `C:/Users/goyan/.codex/worktrees/aorch-four-cli-20260914`. Its `.aorch/final-benchmark-results.json` links the eight final receipts and source worktrees; `.aorch/final-diagnostics.json` records version/model probes. `.aorch-native-probes.json` contains Codex/Claude instruction checks and `.aorch/native-new-cli-probes.json` contains AGY/Grok checks. Independent review receipts are under `C:/Users/goyan/.codex/worktrees/aorch-four-cli-review/.aorch/`. These artifacts are local and contain no copied authentication material.

## Final checks and rollout

- `npm run check` passed in the integration workspace and again in the original checkout after rollout: **385 passed, 0 failed, 1 Windows symlink privilege skip**. The original run took 96.9 seconds. Logs: `.aorch/four-cli-final-check.log` in the original checkout.
- 109 reviewed source files were copied to the original checkout after checking its clean baseline. Previous versions and the added-file manifest are under `.aorch/backups/four-cli-source-1789396657871/`. No commit or push was made.
- Global definitions and all ten previously registered projects were installed with target `all`. Existing configuration choices were retained; missing providers, models and full new-role bindings were added with configuration backups. The initial rollout preflight exposed a missing legacy-role migration case; it was corrected and covered before installations proceeded.
- A real repeat install returned `current` for all eleven destinations. The global `aorch update --check` command then reported ten checked, zero stale and zero failed; `aorch update --user --check` also returned current with no conflicts. Seven temporary probe install registrations were removed from bookkeeping; runtime evidence roots remain available to weekly evaluation.
- Antigravity user installation manages both the CLI flat skill layout and app bundles under `~/.gemini/config/skills/<id>/SKILL.md`, including their original relative assets. App UI recognition is still unobserved; a user observation was requested separately.
- The original checkout's `aorch evaluate --apply` trial succeeded with no policy mutation: zero eligible observations, 86 unscored observations and two duplicate observations. Historic digest-only records are not retroactively promoted. Controller v2 stores normalized evidence, retains negative records independently of project JSONL, and policy reads revalidate observations against that evidence.
- Monday 09:00 KST heartbeat `aorch` is active. An unchanged evaluation stays quiet; meaningful changes, failures and required actions are reported. No operating-system service was added.

Original-checkout artifacts: `.aorch/four-cli-rollout.json`, `.aorch/four-cli-update-check.json`, `.aorch/four-cli-user-check.json`, `.aorch/four-cli-weekly-trial.json`, `.aorch/four-cli-benchmarks.json`, `.aorch/four-cli-diagnostics.json`, `.aorch/four-cli-codex-claude-probes.json` and `.aorch/four-cli-agy-grok-probes.json`.
