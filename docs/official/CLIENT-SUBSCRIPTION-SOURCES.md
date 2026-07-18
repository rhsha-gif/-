# Official Client and Subscription Sources

Verified: 2026-07-17
Re-verified: 2026-07-18 (see "2026-07-18 re-verification" below)

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

## 2026-07-18 re-verification

Checked before starting the v0.7.0 implementation. Method is recorded per fact
because this environment routes outbound HTTPS through a proxy and some help
center pages return HTTP 403 here.

### Confirmed against the primary official page

- Claude Code authentication precedence (https://code.claude.com/docs/en/authentication):
  cloud-provider selectors → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` →
  `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → subscription OAuth from `/login`.
  Matches the recorded fact. Additionally confirmed: in non-interactive mode
  (`claude -p`) a present `ANTHROPIC_API_KEY` is always used without an
  interactive approval prompt. This makes credential stripping mandatory, not
  optional, for subscription-local `claude -p` workers.
- `claude auth status` (https://code.claude.com/docs/en/cli-reference): exists;
  JSON by default, `--text` for human-readable output, exit 0 logged in / 1 not
  logged in. Matches the recorded fact.
- Codex hooks (https://developers.openai.com/codex/hooks, read via search
  snapshots; direct fetch returns 403 through this proxy): an official hooks
  framework exists with events `PreToolUse`, `PermissionRequest`, `PostToolUse`,
  `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`,
  `SessionStart`, `SubagentStart`, TOML-based configuration, and a trust model
  (non-managed command hooks require review/trust; managed hooks come from
  system/MDM/cloud/requirements sources). This is an update over the handoff
  record, which treated the Codex hook surface as unverified.

### Still unproven — do not claim

- Codex `PreToolUse` coverage of write-capable tools: public examples and
  openai/codex#19385 (open, no maintainer parity statement as of 2026-07-18)
  only demonstrate `Bash` interception. No official statement was found that
  `apply_patch` or file-edit tools fire `PreToolUse`. Therefore `strict`
  bootstrap-only enforcement on Codex surfaces must not be claimed without an
  authenticated fixture that proves write-tool interception; `advisory` remains
  the honest maximum from documentation alone.
- Whether the ChatGPT desktop app's Codex view executes the same hook set as
  Codex CLI: not confirmed by any primary source reachable from this
  environment.

### Not re-fetchable from this environment (HTTP 403 via proxy)

- https://support.claude.com/en/articles/15036540 (Agent SDK / `claude -p`
  pool): the recorded "change paused; still draws from subscription limits"
  fact is corroborated by multiple 2026-06/07 secondary reports of the pause
  notice; no contrary evidence found. Retained as recorded.
- https://help.openai.com/en/articles/11369540 (Codex with ChatGPT plan):
  retained as recorded 2026-07-17; no contrary evidence found.

Implementation impact: keep one `anthropic-subscription` pool; keep
`strict|advisory|unsupported|unknown` enforcement reporting with fixture
evidence required for `strict`; Codex gate/hook installation may target the
official `UserPromptSubmit`/`PreToolUse` events but must not assume write-tool
coverage.

## Policy for future updates

- Re-check these official sources when a client version, authentication path, model catalog, or subscription policy changes.
- Do not automatically update production routing from a web page.
- Record the new source, date, migration impact, tests, and user approval in a separate harness-change proposal.
