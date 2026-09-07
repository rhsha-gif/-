# Common definitions and provider compatibility

The lead applies `adaptive-orchestrate` and handles small, clear work directly. A plan, delegation or independent review is used when the scope, uncertainty or risk justifies it. The CLI contract remains available for bounded delegated work; it is not mandatory for every user request.

## Sources

| Scope | Canonical manifest | Generated destinations |
|---|---|---|
| aorch common | `integrations/shared/definitions.json` | Project or user `.claude/agents`, `.codex/agents`, `.claude/skills`, `.agents/skills` |
| Personal common | `integrations/user/definitions.json` | Same user directories, using `install --user` |
| Project | `.agents/aorch/definitions.json` | Same directories inside that project |

Project definitions take precedence over same-name common definitions. The common body stays in a Markdown file or a skill directory. Native settings remain in the manifest. Files generated for a product are projections, not editing inputs. Plugin caches are not managed or modified by this mechanism.

```json
{
  "version": 1,
  "agents": [{
    "id": "local-review",
    "description": "Review a bounded local change and return evidence.",
    "instructions": "agents/local-review.md",
    "providers": {
      "anthropic": {"disallowedTools": "Write, Edit, NotebookEdit, Agent"},
      "openai": {"sandbox_mode": "read-only"}
    }
  }],
  "skills": [{
    "id": "local-check",
    "description": "Check the project's local contract.",
    "source": "skills/local-check",
    "providers": ["anthropic", "openai"]
  }]
}
```

Paths must stay in the manifest's scope, including through junctions. Agent settings are a deliberately bounded supported set in `src/definitions.js`; unknown keys fail before writing. This is not a claim that the products support only those settings. Skills may set native overrides in `providerSettings`. Optional `executionProviders` narrows noninteractive execution support without conflating it with native installation.

## Install and update

```powershell
aorch install --project "C:/path/to/project" --target both --check
aorch install --project "C:/path/to/project" --target both
aorch install --user --check
aorch install --user
aorch update --project "C:/path/to/project"
aorch update --user
aorch update --check
```

`install` and `update` generate from current canonical sources. Prompt hooks never start an updater. `--check` is read-only. Unchanged bytes are not rewritten, including generated files and their ownership ledger. Project config and unrelated native hook settings are preserved. The obsolete aorch model-veto hook is detached; other security hooks are retained.

`.aorch/generated-files.json` records project file hashes; `.aorch/generated-user-files.json` owns user definitions. Project and user installations cannot share a root. A separately edited generated file, or a differing unmanaged destination, stops the entire preflight before payload writes. Restore the generated file or move the intended change to its source after reviewing the diff. Initial migration of legacy copies requires reviewed baseline hashes; there is no blanket overwrite flag for definitions.

Each modifying sync saves prior bytes, previous ledger and an existence/after-hash manifest under `.aorch/backups/`. Writes are atomic per file; an OS failure during a batch is not a transactional rollback. Inspect the backup and current hashes before restoring. Archive newly created paths and restore previous bytes/ledger only when later user changes will not be overwritten. An interrupted update leaves its lock visible rather than allowing concurrent writers.

`node scripts/generate-integrations.mjs` refreshes checked-in shared projections. `npm run check` validates those projections as well as syntax and tests.

## Inventory and execution

```powershell
aorch inventory --type agent
aorch inventory --type skill --match "book"
aorch inventory --runtime "current-session-capability-ids.json"
```

Inventory distinguishes disk `installed`, configuration `configuredEnabled`, effective `enabled`, and observed runtime `available`. Unobserved runtime availability is `null`, not proof that a tool can execute. `--runtime` accepts an array of exact IDs observed by the caller in the current session. Origins, provider bindings, canonical source paths and synchronization status explain differences. A cached plugin with no matching enablement entry stays unknown/disabled for routing. Do not treat cache directory count as active plugin count.

Add optional `agentId` to an existing task to select a project or user agent. `agentRole` still supplies the existing task role contract. Omit `agentId` to retain existing role presets. Claude selects its native agent; `codex exec` receives the generated body plus its bounded sandbox. Native preset model/effort values remain interactive defaults; aorch supplies the headless route, as it already does for role presets. Use task `allowedProfileIds` when a particular model is required. Custom read-only presets reject write tasks; neither forced retries nor provider fallback can bypass required provider/agent compatibility or explicit profile pins.

A missing native binding generates a bridge explaining the required provider. Bridges provide discoverability, not execution support. A required Claude-only tool restriction, vault integration or project security workflow must route to Claude before execution. If the required provider or definition is unavailable, stop with the required installation, update or usage-limit action. Do not simulate unavailable tools. Native Codex app agent discovery requires a session that reloads those files; headless tests do not prove an already open app has reloaded them.

## Questions and continuation

A worker may return `status: "blocked"` with optional `inputRequest`:

```json
{"kind":"clarification","questions":[{"id":"target","prompt":"Which existing report should be updated?","options":["Current report","Archived report"]}]}
```

Use `kind: "approval"` only for an actual approval boundary. The parent conversation asks the questions and supplies explicit answers. A waiting result is `awaiting-input`, exit code 2. Change guard still runs first, but waiting does not trigger verification, model-failure observations, escalation or automatic approval. Existing blocked receipts without `inputRequest` remain compatible.

Dispatch automatically saves `plan.json` and `dispatch.json` under its existing run directory. Resume with the unchanged saved plan and an answer file:

```powershell
aorch dispatch --plan "run/plan.json" --resume "run/dispatch.json" --answers "answers.json"
```

```json
{"taskId":"waiting-task","answers":{"target":"Current report"}}
```

Only the waiting task and untouched suffix are resumed. The waiting task receives previous changes, completed receipts and user answers; it reports only its new delta. Answers never expand scope. Repeating the same resume returns saved evidence without replaying work, including a saved failure. To retry a failed dispatch, explicitly resume its newly returned plan/result pair without `--answers`; this skips its completed prefix and continues from the failed task and its evidence. Changed answers or an interrupted/pending continuation require inspection; they are not automatically rerun. If another question is needed, continue from the newly returned plan/result pair with its explicit answers.
