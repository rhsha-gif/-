---
name: package-recent-workflows
description: Audit recent Codex work history to find repeated manual workflows worth packaging as skills, custom subagents, or automations. Use when the user asks to look back over recent work, identify recurring workflows, avoid duplicate reusable assets, create only high-confidence missing packages, or summarize packaging decisions from Codex sessions, memories, rollout summaries, Chronicle, skills, agents, or automations.
---

# Package Recent Workflows

## Overview

Use this skill to turn recent repeated work into the smallest useful reusable asset. The output should distinguish evidence-backed packages from skipped or uncertain candidates, then create only missing high-confidence items.

## Workflow

1. Set the evidence window.
   - Use the user's requested period; otherwise inspect the last 30 days or all available local history if shorter.
   - Record the actual date range used and any unavailable evidence sources.

2. Gather evidence in priority order.
   - Recent Codex sessions, task summaries, and rollout summaries.
   - Codex memories and ambient/rollout suggestions.
   - Chronicle only when enabled, and only for discovery; confirm important details in the source system when practical.
   - Existing skills, custom agents, and automations, so new work extends or reuses what already exists.
   - For local Codex history, prefer `scripts/summarize_codex_sessions.py` to get a fast first-pass inventory before deeper reading.

3. Inventory existing reusable assets.
   - Read relevant `SKILL.md` files before deciding a workflow is missing.
   - Inspect custom-agent and automation locations if present.
   - For automations, prefer updating an existing matching automation over creating a duplicate.

4. Shortlist candidates.
   - Include repeated workflow, supporting evidence and dates, frequency/confidence, recommended form, and why it is or is not worth packaging.
   - Look across coding, research, writing, planning, communication, operations, analysis, and personal administration.
   - Treat encoding-corrupted titles cautiously; use surrounding summaries, paths, and final reports to infer only when evidence is clear.

5. Apply the packaging threshold.
   - Package only if the workflow occurred at least twice, or is clearly likely to recur and costly to repeat.
   - Require stable inputs, a repeatable procedure, and a clear output or stopping condition.
   - Require a material gain in speed, quality, consistency, or reliability.
   - Skip candidates that are one-off, speculative, sensitive, poorly evidenced, or already adequately covered.

6. Choose the smallest appropriate form.
   - Skill: reusable workflow or playbook.
   - Custom subagent: bounded specialist role or investigation task suitable for delegation.
   - Automation: scheduled check, report, reminder, or monitor.
   - Extend existing: a narrow addition to an existing asset is better than overlap.
   - Skip: insufficient evidence or no stable repeatable process.

7. Create or extend only high-confidence missing items.
   - Use the relevant creation skill or tool for the asset type.
   - Keep new assets narrow, source-aware, and easy to validate.
   - Do not create broad umbrella skills, speculative monitors, or duplicate agents.
   - If installation requires writing outside the workspace, stage locally first and request approval for the install step.

8. Validate created assets.
   - For skills, run the skill validator and inspect frontmatter plus `agents/openai.yaml`.
   - For automations, view or otherwise confirm the saved schedule and prompt.
   - For custom agents, verify the manifest/location expected by the current Codex installation.

## Output

End with:

- Compact shortlist with evidence, confidence, recommendation, and decision reason.
- What was created or extended, with paths or automation names.
- What was deliberately skipped.
- What needs more evidence before packaging.
- Any validation run and any evidence source that was unavailable.
- Preserve any user-requested language, format, or translation requirements.

## Script

Use the bundled summarizer for a repeatable evidence pass:

```powershell
python "$env:USERPROFILE\.agents\skills\package-recent-workflows\scripts\summarize_codex_sessions.py" --since 2026-05-06 --until 2026-07-06 --codex-home "$env:USERPROFILE\.codex"
```

The script reads `session_index.jsonl`, session files, installed skills, and ambient suggestions. Treat the output as a shortlist, then inspect the most relevant source artifacts before creating or changing reusable assets.
