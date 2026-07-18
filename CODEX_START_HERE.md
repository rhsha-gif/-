# Codex Handoff: Implement Adaptive Orchestrator v0.7.0 Subscription-First

## What This Package Contains

This ZIP is a self-contained implementation handoff:

- complete **v0.6.1 executable source baseline**;
- the v0.6.2 first-principles design review;
- the updated v0.7.0 subscription-first design;
- a detailed implementation plan;
- the user's actual client/subscription deployment profile;
- official-source records for current client and subscription assumptions;
- repository-wide Codex instructions in `AGENTS.md`;
- a workspace bootstrap script and provenance manifest.

## Actual Deployment Target

The implementation is not API-first.

```text
Primary host: Codex in the ChatGPT desktop app
Second host: Claude Code CLI
OpenAI worker: Codex CLI signed in with ChatGPT
Anthropic same-host worker: permit-bound Claude native subagent
Anthropic cross-host worker: claude -p signed in through the Claude subscription
API use: exceptional and explicit only
```

The default runtime must stay inside subscription-authenticated local clients. It must not use API keys, PAYG, usage credits, cloud providers, or Codex cloud as an automatic overflow path.

Codex app host enforcement must be reported honestly. Verify the current official hook/policy surface and run an authenticated fixture before claiming `strict`. If this cannot be proven, report `advisory|unsupported|unknown` and keep a strict Codex CLI-host fallback.

## Important Baseline Note

The supplied executable source is v0.6.1 because the provided v0.6.2 artifact is a design review, not a source release. Verify every review finding against this baseline before patching.

Baseline source commit:

```text
e6dacca8515e1854db927eb144489751452d98a8
```

Baseline result during handoff assembly:

```text
npm test
268 passed
0 failed
```

## Start Here

```bash
unzip adaptive-orchestrator-v0.7.0-subscription-first-codex-handoff.zip
cd adaptive-orchestrator-v0.7.0-subscription-first-codex-handoff
bash scripts/prepare-codex-workspace.sh
```

Read:

1. `AGENTS.md`
2. `docs/SUBSCRIPTION-LOCAL.md`
3. `docs/official/CLIENT-SUBSCRIPTION-SOURCES.md`
4. v0.7 spec and plan
5. first-principles review

## Implementation Priority

1. Subscription-local client/auth/quota plane.
2. Bootstrap-only host and permit-bound Claude native worker.
3. Task/run completion bound to passing attestation.
4. Immutable captured-content verification.
5. Hidden verifier and sanitized environments.
6. Prompt fallback and honest provider-aware naming.
7. Monotonic gate floor and removal of persistent shadow.
8. Conservative attestation-derived reliability.
9. Consolidated hook runtime and local lifecycle operations.
10. Human-bound approvals.
11. Release verification and clean packaging.

## Critical Current Fact

Do not implement separate Claude interactive and Agent SDK quota pools from the previously announced June 2026 plan. Anthropic's current support notice says that change is paused and `claude -p` still draws from subscription limits. Use one `anthropic-subscription` pool and record transport labels separately.

## Expected Final Deliverables

```text
adaptive-orchestrator-v0.7.0.zip
adaptive-orchestrator-0.7.0.tgz
adaptive-orchestrator-v0.7.0.sha256
adaptive-orchestrator-v0.7.0-release.json
docs/REVIEW-0.7.0.md
```

The final report must distinguish:

- locally verified behavior;
- authenticated Codex CLI behavior;
- authenticated Claude Code behavior;
- facts checked only against official docs;
- untested entitlement, limit, and platform paths.
