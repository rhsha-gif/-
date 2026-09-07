---
name: plan
description: "Turn agreed requirements into a bounded executable plan when requested or when unresolved design choices need a durable record."
---

# Plan

Planning is a tool under aorch. Do not plan again when the user supplied an executable plan and asked to implement it. Small clear work can proceed directly.

Read the relevant implementation and project verification commands. Record the objective, scope, dependencies, concrete files, acceptance conditions and relevant checks. Include the reasoning behind consequential choices and unresolved risks. Use the requested destination; otherwise use docs/plans/<date>-<topic>.md when a file helps resumption.

Choose task boundaries by independence and verification cost. No minimum task count, fixed roles, required parallel waves or speculative future scaffolding. A multi-task aorch dispatch also needs its validated task-plan JSON; do not confuse prose with the execution contract.

Self-review the plan against actual paths and commands. Return only decisions that still require user input. Continue already-authorized implementation without another approval ceremony. Do not add commit, push or deployment steps unless requested.
