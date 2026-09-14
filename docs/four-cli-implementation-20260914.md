# Four-CLI implementation checkpoint

## Approved decisions

Support Codex, Claude Code, Antigravity CLI and Grok through shared definitions and bounded dispatch. Quality comes first. For large coding/research jobs the lead owns decomposition, design and synthesis; lower profiles perform independently verifiable bounded work. Use existing subscriptions/login only. Roll out after representative gates to user definitions and registered projects. Weekly evaluation runs Monday 09:00 Asia/Seoul, automatically adjusts ordinary tasks only, and preserves explicit pins and high-risk gates. Notify only on meaningful policy changes, failures or required action.

## Baseline

- Clean starting checkout: ba51419.
- Usage audit since 2026-09-08: at least 32 non-protocol receipt files (31 QuantPilot and worktrees, 1 aorch). These are a lower bound, not a system-wide adoption rate. Receipt modification dates were cross-checked with recent session activity. 30 complete, 1 blocked, 1 partial; completion is not artifact approval.
- AGY 1.2.2: `C:/Users/goyan/AppData/Local/agy/bin/agy.exe`; Grok 1.0.30: `C:/Users/goyan/.grok/bin/grok.exe`. Both were discoverable in persisted Windows user PATH but absent from this process PATH.
- A fresh linked worktree's baseline `npm run check` passed syntax and stopped at 38 out-of-date generated integration files; investigated with definition changes.

## Work ownership

- Lead: configuration, model-family isolation, CLI integration, runtime evidence connection, benchmarks, independent review and rollout.
- Sol worker `cli_adapters`: new adapters, safe executable diagnostics, task runner, role resolution, focused tests.
- Sol worker `definitions`: four-target generation/install/update/inventory and compatibility tests.
- Sol worker `weekly_learning`: local run evidence, weekly policy evaluation and restore, tests.

All writes are in separate linked worktrees. No commits, pushes or publication are authorized by this implementation request. Copy only reviewed, owned changes into the integration checkout and then the original checkout; preserve unrelated work.

## Verification record

- Contract and policy tests include same-family exclusion across CLI boundaries, forced routes, continuation, quality/runtime failures, deduplication, sample floors and policy restore.
- All four CLIs demonstrated instruction discovery and real accepted work. Antigravity app discovery remains a separate observation that this host cannot perform through native UI tools.
- Two bounded coding and two fixed-source research comparisons each passed in direct and split execution. Measurements and integration rework are in `four-cli-validation-20260914.md`.
- Independent Opus reviews led to corrections in telemetry provenance, execution restrictions and retry eligibility.
- The Monday 09:00 Asia/Seoul Codex heartbeat is active. The live weekly trial retained the baseline because it lacked sufficient eligible verified observations.
- Final test counts and backed-up user/registered-project rollout are recorded in the validation report.

New profiles began with `automatic: false`. After the fixed comparisons, Astra, AGY Flash and Grok were enabled only for the validated task kinds, standard complexity and low/standard risk. Grok additionally requires `local-evidence`; AGY Pro remains disabled for automatic selection. Benchmark-specific activation cannot bypass required capabilities or high-risk rules. No unsupported host capability is considered verified from file generation alone.
