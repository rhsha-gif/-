# Harness simplification decisions — 2026-09-08

The implementation follows the approved aorch consolidation plan. Official product support is weighted above engineering examples, which are weighted above a developer's personal practice. Tests against the installed products distinguish a recommendation from actual local support. This is a small file-based migration, not a new synchronization service or evaluation platform.

## Evidence and applicability

| Weight | Source | Application and limits |
|---|---|---|
| 1: product | [OpenAI best practices](https://learn.chatgpt.com/guides/best-practices), [Claude Code best practices](https://code.claude.com/docs/en/best-practices) | Keep persistent instructions concise and load task-specific context when needed. These guides do not require a fixed worker count or a planning artifact for every task. |
| 1: product | [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Claude subagents](https://code.claude.com/docs/en/sub-agents), [Claude skills](https://code.claude.com/docs/en/skills) | Preserve name, purpose and body while generating product-native configuration. Native app agent configuration and headless CLI selection differ; support is verified separately. |
| 1: product | [OpenAI Claude-plugin conversion](https://developers.openai.com/plugins/guides/submit-claude-plugin) | Plugin format compatibility does not prove every Claude hook or native agent setting works in every Codex surface. Keep unsupported behavior explicit and route before execution. |
| 2: engineering | [OpenAI harness engineering](https://openai.com/index/harness-engineering/), [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | A short entry point and selective retrieval inform this design. Their complete architectures are not adopted as mandatory procedures. |
| 3: developer | [Simon Willison: subagents](https://simonwillison.net/guides/agentic-engineering-patterns/subagents/) | Separate context can be useful for bounded independent work. It does not justify additional handoffs where the lead already has enough context. |

## Decisions tied to existing definitions

| Existing source / conflict | Decision and canonical owner | Expected effect / retained condition |
|---|---|---|
| aorch root skill included development, books, investment, research and model-upgrade pipelines | Short common entry at `integrations/shared/skills/adaptive-orchestrate`; six conditional references | Smaller persistent body; optional example pipelines. Preserve write isolation, scope/diff checks, required project QA and evidence. |
| Prompt hook launched background updates; model-veto hook forced a rejected spawn to retry | Remove prompt-time mutation and detach only the aorch veto hook | No updater or forced respawn per prompt. Explicit install/update retains freshness and detects edits. |
| Native Claude/Codex aorch agent bodies could diverge | `integrations/shared/agents` plus manifest provider settings | One body per purpose, generated native files, hash ledger and conflict reporting. |
| Global plan agent, plan/execute/resume skills and Superpowers competed over decomposition | Short personal definitions under `integrations/user`; aorch decides when to invoke them; disable active Superpowers configuration | No minimum task count, obligatory wave, duplicate plan or unsolicited commit. Keep planning/review when useful. Vendor cache remains untouched. |
| Global interview hook forced repeated question batches | Keep an explicitly invoked/needed interview skill, detach the user interview hook | Resolve material ambiguity without a mandatory interview during approved execution. Existing permission boundaries remain. |
| Same-name dependency-audit and paper-lookup definitions differed | One common dependency check and general scholarly entry; detailed API reference remains conditional | Removes ambiguous source selection. No automatic dependency addition; no fabricated bibliography. |
| Seven global book workflows duplicated project packages | Thin global entry skills point to the book repository's `.agents/aorch/skills`; project generates both native skill trees | Single project authority. Preserve schema, rights, source, digest, CJK and human acceptance gates. |
| Global invest-judge demanded several workers for each perspective | Retain three evidence perspectives and independent review of consequential judgment; aorch decides work division | Lower repeated context. Immutable decision records, source quality and vault requirements survive. |
| invest-resolve and ship | Retain append-only decision updates and project security gates; ship and vault-dependent judgment have Claude bridges | No relaxation of investment authority or automatic commit. A file bridge never grants execution support. |
| Remaining global development utilities (stabilization, local dev, packaging recent workflows, Playwright, handoff refresh, screenshots, Vercel deploy, health check) | Preserve concrete utilities and assets; correct installed paths to common skill location | Keep useful functions; no removal merely because a skill is rarely installed. |
| QuantPilot 16 native Claude agents / 11 skills | Project-owned manifest, 8 common agents and 8 Claude-required agents; 10 common skills and vault-consult bridge | Preserve shell deny lists and security metadata. Vault MCP is not verified/configured on the inspected Codex host. Required Fable availability is separate from file compatibility. |
| QuantPilot mandatory workboard, scorecard and cross-provider role on every substantial task | aorch adapter; workboard/lease protocol applies when a board or parallel ownership is actually used | Keep existing active board leases and evidence; no auto-commit. Trading safety and required verification commands stay intact. |
| Plugins present on disk but configured with old marketplace IDs | Inventory reports exact source IDs, settings and observed availability separately | No false claim that cached means active. Retain useful domain plugins unless actual workflow conflict is identified. |

## Validation interpretation

Tests cover unchanged update timestamps, conflicts before writes, junction/path escape, unknown file preservation, generated body/settings parity, Claude-only routing, strict Codex receipts, input wait ordering, denial forwarding and continuation replay protection. The original Windows PATH-shim failure was repaired by respecting the last case-insensitive PATH override.

Live probes use installed Codex CLI 0.153.4 and Claude Code 2.1.260. Representative development, book, research and investment examples use fixed synthetic data and are deliberately small. Recorded usage is actual provider output where available; source characters are not labeled as tokens. A synthetic clarification/denial test is not user approval. Changes to native configuration cannot prove an already open app session has reloaded it; configuration, CLI execution and observed app exposure are reported separately.

Exact rollout paths, backup location, checks and live results are recorded in the accompanying local rollout receipt. No commit, push, deployment or broker write is part of this migration.
