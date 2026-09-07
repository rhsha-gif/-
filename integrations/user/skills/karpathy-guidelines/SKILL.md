---
name: karpathy-guidelines
description: "Keep coding changes small, scoped and verifiable when implementation judgement would benefit from a checklist."
---

# Coding judgement

Use the smallest correct change that meets the agreed acceptance criteria. aorch decides whether planning, delegation or independent review is useful.

- Inspect the affected path and relevant project rules. State consequential assumptions; investigate routine details directly.
- Reuse existing code and native APIs. Add abstractions, options and dependencies only for a present requirement.
- Preserve unrelated changes and project conventions. Remove unused code introduced by this task.
- Verify the changed behavior with a relevant test or concrete check. A reversible wording edit does not need a test that merely repeats its implementation.
- For a bug, identify the failing path before changing it. For a refactor, preserve public behavior unless the user requested a change.
- Inspect the final diff and report the evidence and unresolved limitations. Do not claim a check ran when it did not.

License: MIT
