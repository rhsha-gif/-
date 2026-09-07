---
name: interview
description: "Clarify consequential requirements when the user asks for an interview or unresolved choices prevent useful progress."
---

# Interview

Follow aorch's task and risk judgement. Investigate what the workspace or official documentation can answer before asking the user.

Ask only questions whose answers change scope, acceptance, constraints or a consequential design choice. Use the current host's structured input tool when available, normally one to three concise questions with meaningful options. Explain the observation behind each question. Continue independent work while an optional answer is pending.

Respect the user's request to continue or end the interview. Once the user asks for implementation of an agreed plan, use those decisions and proceed. Do not reopen settled choices, require a minimum number of rounds, or ask for approval already given. Required missing input stays pending; silence is never approval.

Summarize the decisions and unresolved constraints. Create a plan document when requested or when it helps a long task resume. In a headless worker, return blocked with inputRequest instead of calling an interactive question tool.
