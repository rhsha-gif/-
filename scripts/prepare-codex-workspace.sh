#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"

if [[ ! -f package.json ]]; then
  echo "package.json not found at handoff root: $ROOT" >&2
  exit 1
fi

node - <<'NODE'
const fs = require('node:fs');
for (const file of ['HANDOFF_MANIFEST.json', 'config/subscription-local.target.json']) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file.endsWith('subscription-local.target.json') && parsed.access?.profile !== 'subscription-local') {
    throw new Error('subscription-local target profile is missing or invalid');
  }
}
NODE

node -e '
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Node.js 20+ required; found ${process.versions.node}`);
  process.exit(1);
}
'

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

conflicts=(
  ANTHROPIC_API_KEY
  ANTHROPIC_AUTH_TOKEN
  ANTHROPIC_BASE_URL
  CLAUDE_CODE_USE_BEDROCK
  CLAUDE_CODE_USE_VERTEX
  CLAUDE_CODE_USE_FOUNDRY
  OPENAI_API_KEY
  OPENAI_BASE_URL
)

found_conflict=0
for name in "${conflicts[@]}"; do
  if [[ -n "${!name:-}" ]]; then
    echo "subscription-local conflict: $name is set" >&2
    found_conflict=1
  fi
done

if [[ "$found_conflict" -ne 0 ]]; then
  cat >&2 <<'OUT'
Unset API/custom-provider credentials before preparing the subscription-local workspace.
The target runtime must not silently bill API/PAYG or route through a cloud/custom endpoint.
OUT
  exit 1
fi

if command -v claude >/dev/null 2>&1; then
  echo "Claude Code: $(claude --version 2>/dev/null | head -n 1 || echo installed)"
  if claude auth status >/tmp/aorch-claude-auth-status.json 2>/tmp/aorch-claude-auth-status.err; then
    echo "Claude authentication status captured without a model call."
  else
    echo "Warning: Claude auth status could not be confirmed. Run 'claude auth status' or '/status' before live worker probes." >&2
  fi
else
  echo "Warning: Claude Code CLI is not installed in this environment; Anthropic live smoke will remain unverified." >&2
fi

if command -v codex >/dev/null 2>&1; then
  echo "Codex CLI: $(codex --version 2>/dev/null | head -n 1 || echo installed)"
  echo "Codex auth is not inferred from undocumented application files. Confirm ChatGPT sign-in in the supported client before live probes."
else
  echo "Warning: Codex CLI is not installed in this environment; the Codex desktop host alone is not used as an undocumented subprocess API." >&2
fi

if [[ ! -d .git ]]; then
  git init -q
  git config user.name "Adaptive Orchestrator Handoff"
  git config user.email "handoff@local.invalid"
  git add .
  git commit -qm "chore: import v0.6.1 baseline and subscription-first v0.7 brief"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "workspace has uncommitted changes; preserve or commit them before implementation" >&2
  git status --short >&2
  exit 1
fi

if [[ -f package-lock.json ]]; then
  npm ci --ignore-scripts
else
  npm install --ignore-scripts --package-lock=false
fi
npm test

current_branch="$(git branch --show-current)"
if [[ -z "$current_branch" ]]; then
  git switch -c feature/v0.7.0
elif [[ "$current_branch" != "feature/v0.7.0" ]]; then
  if git show-ref --verify --quiet refs/heads/feature/v0.7.0; then
    echo "feature/v0.7.0 already exists; switch to it before implementation" >&2
    exit 1
  else
    git switch -c feature/v0.7.0
  fi
fi

cat <<'OUT'

Workspace prepared for the subscription-local v0.7 implementation.

Next:
  1. Read AGENTS.md and CODEX_START_HERE.md.
  2. Read docs/SUBSCRIPTION-LOCAL.md and the official-source record.
  3. Execute docs/superpowers/plans/2026-07-17-v0.7-minimal-sound-core.md.
  4. Keep API/PAYG/cloud fallback disabled unless the user creates a separate explicit profile.
  5. Use red-green TDD and focused commits.
  6. Do not claim authenticated provider behavior without a consented read-only smoke and evidence.
OUT
