---
name: post-run-reflection
description: Close a terminal adaptive-orchestrator run by reviewing verified execution evidence, recording errors, inefficiencies, technical debt, user feedback, and approval-gated improvement proposals. Never mutate the harness automatically.
allowed-tools: Read, Grep, Glob, Bash, Write
---

# Post-Run Reflection

Use this skill after `aorch run --action finish` and before claiming terminal completion.

## Evidence to inspect

Read the active run state and only the evidence needed to reconstruct the process:

```bash
aorch run --action show --run active
```

Inspect task receipts, independent verification logs, reviewer verdicts, route overrides, retries, and the final diff. Do not infer an error or success without evidence.

## Reflection categories

Record:

1. `whatWorked`: practices that should be retained.
2. `errors`: actual errors, at least one evidence reference, a concrete prevention rule, concise scope tags, and an optional confidence value. Resulting lessons remain advisory, expire after a bounded period, and cannot become policy without a separately benchmarked and user-approved change.
3. `inefficiencies`: unnecessary context, retries, agent calls, capability loading, or task boundaries that reduced effectiveness.
4. `technicalDebt`:
   - debt introduced by this run must be resolved before completion;
   - unrelated pre-existing debt is recorded without expanding scope.
5. `proposals`: bounded changes that could prevent recurrence or improve the harness.

Operational memory may record verified prevention rules automatically, but it cannot edit source or policy. Malformed, unscoped, unevidenced, or expired lessons are excluded; inspect them with `aorch lessons --lint`. Every proposal starts as `pending`, requires explicit user approval (`requiresUserApproval: true`), and has `applied: false`. Never edit harness source, prompts, hooks, skills, plugins, policies, dependencies, or unrelated project code during reflection.

## Persist the retrospective

Create a JSON file matching `.aorch/schemas/session-retrospective.schema.json`, then run:

```bash
aorch run --action reflect --run active --input <retrospective.json>
```

If proposals exist, present their IDs, evidence, expected benefit, affected files, and risks to the user. Do not apply them until the user explicitly approves one or more proposals.

## User feedback

When the user later provides feedback, append it:

```bash
aorch run --action feedback --run <run-id> --input <feedback.json>
```

Re-open and revise the retrospective when feedback reveals a new error, inefficiency, or debt item. Existing feedback and proposal decisions are preserved across revisions.

## Approval

After explicit user consent, record the decision:

```bash
aorch run --action decide --run <run-id> --proposal <proposal-id> --decision approved --comment "<user decision>"
```

Approval records consent only. It does not apply code. Implement the approved proposal through a new adaptive-orchestrator run with normal task decomposition, testing, review, and verification.
