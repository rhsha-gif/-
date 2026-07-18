# Subscription-Local Deployment Profile

## Purpose

This is the default v0.7.0 deployment profile for a single user who primarily works in:

- the ChatGPT desktop app's Codex view;
- Claude Code CLI authenticated with a Claude Pro or Max subscription;
- local repositories and Git worktrees;
- subscription allowances rather than direct API billing.

The profile optimizes for correct model placement without silently crossing from subscription usage into API, paid-credit, gateway, cloud-provider, or cloud-task billing.

## Supported surfaces

| Provider | Host surface | Worker transport | Default authentication | Usage pool |
|---|---|---|---|---|
| OpenAI | Codex view in ChatGPT desktop | local Codex CLI | ChatGPT sign-in | `openai-agentic` |
| Anthropic | Claude Code CLI | permit-bound native subagent | Claude subscription OAuth | `anthropic-subscription` |
| Anthropic cross-host | Codex host or other local host | `claude -p` | Claude subscription OAuth | `anthropic-subscription` |

Codex desktop is not treated as an undocumented programmatic API. The orchestrator calls the supported local CLI when it needs a separate OpenAI worker.

Codex desktop host enforcement is capability-dependent. The release may claim strict bootstrap-only enforcement for the app only after the current official surface and an authenticated app smoke prove that the installed policy hook actually intercepts write-capable tools. Otherwise `aorch doctor --surface codex-app` must report `advisory`, `unsupported`, or `unknown`. A strict workflow can fall back to a Codex CLI host or a separately protected read-only host workspace.

## Default access policy

```text
local execution: allowed
subscription-authenticated client: allowed
API key: denied
custom API base URL: denied
Bedrock/Vertex/Foundry override: denied
PAYG or usage-credit fallback: denied
Codex cloud delegation: denied
automatic credit purchase: denied
```

An occasional API workflow must use an explicit future access profile or a separate run. It must never be an implicit overflow path from subscription-local.

## Authentication checks

### Claude

Before a Claude worker is eligible:

1. `claude auth status` must report an active login when supported by the installed client.
2. The environment must not contain credentials that take precedence over subscription OAuth.
3. The worker environment must not inherit API keys, bearer tokens, custom base URLs, or cloud-provider selectors.
4. Login expiry must be reported as a user-resolvable block, not as a model-quality failure.

Conflict variables include at least:

```text
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_BASE_URL
CLAUDE_CODE_USE_BEDROCK
CLAUDE_CODE_USE_VERTEX
CLAUDE_CODE_USE_FOUNDRY
```

`CLAUDE_CODE_OAUTH_TOKEN` and `apiKeyHelper` also require an explicit policy decision because they are automation credentials rather than the ordinary interactive login path.

### Codex

Before a Codex CLI worker is eligible:

1. The executable and version must be available.
2. A documented auth-status command should be used when the installed client provides one.
3. If machine-readable auth cannot be confirmed, status is `unknown`, not assumed authenticated.
4. API keys, custom base URLs, and third-party provider overrides are denied in subscription-local mode.
5. A critical executor requires a successful opt-in read-only canary or equivalent official entitlement evidence.

The orchestrator does not inspect undocumented Codex app storage to infer login state.

## Model availability

Catalog profiles express desired routing roles. They do not prove account entitlement.

```text
unknown
available
unavailable
temporarily-limited
```

Use:

```bash
aorch models inspect
```

for static client/profile checks without consuming quota.

Use:

```bash
aorch models probe --live
```

only after an explicit warning and confirmation. A live probe is a real provider request and can consume the user's subscription allowance.

## Usage pressure

Subscription products do not expose a uniform machine-readable remaining-token percentage. The orchestrator therefore records only:

```text
unknown | green | yellow | red | exhausted
```

Accepted sources:

- provider-reported usage or limit output;
- an actual limit error;
- a provider last-known snapshot explicitly labeled with age;
- explicit user input from the provider UI.

The router applies usage pressure only after risk, trust, entitlement, and quality eligibility. It must not select a materially lower-quality worker merely because another pool is yellow or red.

## Current Claude `-p` policy

As of 2026-07-17, Anthropic states that a previously announced separate Agent SDK credit change is paused. Claude Agent SDK and `claude -p` continue to draw from subscription usage limits. v0.7.0 therefore uses one `anthropic-subscription` pool and only separates interactive/native/print transports for diagnostics.

If Anthropic later changes this policy, update the official-source record, tests, migration, and user-approved harness proposal before splitting the pool.

## Limit handling

When a provider is exhausted:

```text
same-provider eligible alternative
→ other subscription provider meeting the quality floor
→ block or wait for reset
```

Never automatically:

- switch to an API key;
- enable or purchase usage credits;
- use a custom gateway;
- delegate to Codex cloud;
- claim an exact reset or remaining percentage that the provider did not report.
