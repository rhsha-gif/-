# Official Client and Subscription Sources

Verified: 2026-07-17

This file records the official product facts that the v0.7.0 subscription-local design relies on. It is not bundled provider documentation and does not authorize automatic behavior changes when a page changes.

## OpenAI

### Using Codex with a ChatGPT plan

Official source:
- https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan

Facts used:
- Codex can be accessed through the ChatGPT desktop app in Codex mode, Codex CLI, IDE extension, and web.
- These clients sign in with the user's ChatGPT account.
- Usage limits vary by plan.
- Codex and other eligible agentic products can draw from the same agentic usage/credit pool.
- Task usage depends on task size, complexity, model, and where it runs.

### ChatGPT Work and Codex

Official source:
- https://help.openai.com/en/articles/20001275

Facts used:
- Codex is a separate view in the ChatGPT desktop app.
- Codex can work with local folders, repositories, terminals, and developer tools.
- Local chats stay on the computer.

## Anthropic

### Use Claude Code with Pro or Max

Official source:
- https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan

Facts used:
- Claude Code can authenticate with the same Claude.ai subscription credentials.
- Claude and Claude Code share subscription usage limits.
- `ANTHROPIC_API_KEY` can take precedence and cause API billing instead of subscription usage.
- Staying within the plan requires declining API-credit/PAYG continuation.

### Claude Code authentication and CLI reference

Official sources:
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/cli-reference

Facts used:
- Authentication precedence places cloud-provider credentials, auth token, API key, and helper credentials ahead of subscription OAuth.
- `claude auth status` returns JSON and exits 0 when logged in, 1 otherwise; `--text` is the human-readable form.
- Interactive status surfaces can be used to diagnose the active login and expiry.
- API-key and custom-provider environment variables must not be inherited silently in subscription-local mode.

### Claude usage and cost management

Official source:
- https://code.claude.com/docs/en/costs

Facts used:
- `/usage` shows subscription plan usage bars and approximate local attribution.
- Subscriber dollar estimates are not authoritative billing values.
- Separate subagents/teams each maintain context and increase usage.
- Sonnet is recommended for most coding/coordination work, Opus for harder reasoning, and Haiku for simple subagent tasks.

### Agent SDK and `claude -p`

Official source:
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

Current fact used:
- The previously announced separate Agent SDK monthly-credit change was paused.
- For now, Agent SDK, `claude -p`, and third-party Agent SDK app usage still draw from subscription usage limits.

## Policy for future updates

- Re-check these official sources when a client version, authentication path, model catalog, or subscription policy changes.
- Do not automatically update production routing from a web page.
- Record the new source, date, migration impact, tests, and user approval in a separate harness-change proposal.
