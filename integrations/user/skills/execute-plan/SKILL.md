---
name: execute-plan
description: "Execute an approved plan or continue interrupted work from current changes and saved evidence."
---

# Execute or resume

Keep the original goal and the user's latest corrections. Read the named plan, the conversation checkpoint and relevant git status/diff to recover completed work, pending work and constraints. Existing changes are evidence to preserve; do not reset or overwrite them.

Use aorch to decide direct execution versus delegation. Independence and context cost determine delegation, not a fixed count of steps. Ask only for consequential missing input that cannot be established from the workspace. Resolve routine details within the approved scope.

Execute remaining work. Run the checks relevant to each changed behavior; update a durable checkpoint after meaningful progress when one exists. Mark completion only from evidence. Do not weaken tests to pass, rerun completed mutations, or repeat an unchanged successful check without a reason.

For an aorch awaiting-input result, relay the question in the current parent conversation, then pass the explicit answers and saved result through dispatch --resume. Keep the original scope and skip the completed prefix.

Finish with changes, evidence and any actual blocker. Do not end by proposing to continue or by requesting an unsolicited commit.
