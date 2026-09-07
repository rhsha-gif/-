---
name: adaptive-orchestrate
description: Root workflow for every substantive user prompt, with task decomposition, native context sharing and verified CLI dispatch.
---

# Adaptive Orchestrate — codex lead

Runtime for this installation: `node "{{AORCH_ROOT}}/src/cli.js"`. Use this command in place of `aorch` below when PATH points to another checkout; do not change global npm links to run this project.

Before planning or delegation, read `.aorch/workflow.md` (package source: `{{AORCH_ROOT}}/integrations/shared/workflow.md`). Invoke aorch for every substantive prompt and follow that common workflow. Claude and Codex are equal leads; the original request recipient remains the root lead throughout the task. A single-task plan with decomposed: false is normal.

Codex native spawn_agent accepts message/agent_type (the hook also matches Agent). Classify native recommendations with --providers openai. Custom agent model/model_reasoning_effort pins take precedence; otherwise respect explicit spawn values, agent defaults and parent inheritance. Do not assume host effort support equals CLI/API support.

Native agents are for context-sharing analysis/review and isolated low/standard writes on nonoverlapping paths. The lead owns overall steps and execution paths plus one existing-format CLI plan for the CLI subset. Use sequential aorch dispatch for high/critical writes and cross-provider calls. Native and CLI workers must not spawn workers: no recursive workers.

The lead validates actual native diffs and fresh tests. Native results never masquerade as automatic change-guard/verify observations. Preserve explicit user model overrides, preset models and parent inheritance. Both native spawn hooks are advisory, never deny/retry or input rewriting; hooks do not enforce every path.

CLI contract: `aorch decompose --print-schema`, then `aorch decompose --plan <file>` and `aorch dispatch --plan <file>` (dry-run first). CLI change guard and verification remain required; do not weaken them for native execution. Report phase, confidence and blockers with evidence.

Every worker receipt is a claim: inspect actual diffs and fresh required tests before acceptance. Keep write isolation and change guards intact. Do not commit while a dispatch runs; commits, pushes and merges require explicit user authorization.
