---
name: local-dev-runbook
description: Inspect, run, safely restart, and smoke-test local applications, including domain, origin, port, API URL, CORS, cookie, auth callback, WebSocket, and environment-variable diagnostics. Use when the user needs exact PowerShell/CMD commands, a verified localhost workflow, a deterministic frontend/backend restart, or help resolving mixed local, preview, and production URLs on Windows or other local development environments.
---

# Local Dev Runbook

## Overview

Use this skill to convert a local codebase into a verified run handoff: exact working directories, commands, services, ports, URLs, and checks. It also owns safe server restarts and local domain/origin hygiene.

## Workflow

1. Inspect local guidance first.
   - Read `AGENTS.md`, README/setup docs, package scripts, backend/frontend folders, env examples, and obvious dev scripts.
   - Identify the stack, entry points, monorepo layout, package manager, virtualenv, and expected ports.
   - Note whether dependencies or build artifacts already exist before suggesting install steps.
   - Note whether the project lives under a synced folder such as OneDrive, Google Drive, Dropbox, or iCloud, especially when dependency declarations, generated types, build artifacts, or virtualenv files are missing unexpectedly.
   - When networking is relevant, record the frontend, API, WebSocket, auth callback, preview, and production origins before editing.

2. Decide whether to run or restart services.
   - If the user asked only for commands, inspect and provide them without starting long-running servers unless a quick smoke check is clearly useful.
   - If the user asked to run or debug the app, start the smallest necessary local process, verify it, then stop background helpers unless the user wants them left running.
   - Restart when server/config/env/dependency changes require it, the process is unhealthy, or the user explicitly asks. Healthy hot reload is enough for ordinary static frontend edits.
   - Request approval for dependency installation, external network access, GUI launch, or writes outside the allowed workspace.

3. Handle synced-folder dependency symptoms when present.
   - Trigger this branch only with evidence: the cwd is inside a synced folder, package extraction appears partial, `.d.ts` or generated client files vanish, lockfile reads fail, `node_modules` or `.venv` behaves inconsistently, or build/typecheck results disagree.
   - Verify before repairing: show cwd, relevant sync environment variables such as `$env:OneDrive`, package manager and lockfiles, specific missing files, and the first real build/typecheck failure.
   - Do not assume every synced-folder project is corrupt. Separate environment issues, dependency issues, and application code issues.
   - When repair is needed, prefer a clean non-synced working copy such as `C:\Users\<user>\codex-workspaces\<project>`, excluding install/build caches like `node_modules`, `.venv`, `dist`, `.next`, `.pytest_cache`, and `__pycache__`.
   - Reinstall from the lockfile or declared requirements in the clean copy, regenerate generated artifacts only when required, then validate there before continuing feature work.
   - Do not delete or move the original synced-folder project unless the user explicitly asks.

4. Audit domains and origins when relevant.
   - Search for loopback hosts, ports, absolute HTTP/WebSocket URLs, and known preview or production domains.
   - Classify each occurrence as central config, docs/example, test fixture, or bug.
   - Prefer one canonical host and centralized environment-backed URLs. Never expose secrets through client-visible variables.
   - For credentialed CORS, cookies, OAuth callbacks, WebSockets, or SSE, verify the environment-specific origin policy rather than applying a wildcard.
   - Read `references/domain-hygiene.md` for the full checklist. Run `scripts/audit_domains.py` for a repeatable scan.

5. Build the command set.
   - Use absolute or clearly rooted paths, especially when the user asks what to paste.
   - On Windows PowerShell, prefer `npm.cmd` when script execution policy blocks `npm.ps1`.
   - For Python services, prefer the project virtualenv when present, such as `.venv\Scripts\python.exe`.
   - Split backend and frontend into separate terminal blocks when both must stay running.
   - Include env-file or API-key caveats only when the project documents or code requires them.
   - Choose an alternate port when the default is already occupied, and state the final URL.

6. Verify the handoff when practical.
   - Run quick script discovery commands such as `npm.cmd run`, package metadata reads, or backend health checks.
   - For local servers, check `/`, `/api/health`, or the documented health endpoint before claiming the URL works.
   - If a dev server keeps running, report its process state and how to stop it.
   - If a command fails, report the first real failure and give the corrected next command instead of a generic retry.

## Safe Restart

- Build an explicit service list with absolute working directories, commands, ports, and health URLs.
- Use `scripts/restart-local-webapp.ps1`; start with `-DryRun` whenever ownership of a listed port is uncertain.
- Use `-ForcePorts` only for confirmed project ports. Never kill broad process names such as all Node or Python processes.
- Read `references/restart-webapp.md` for the service JSON contract, example command, logs, and validation procedure.

## Bundled Helpers

- `scripts/restart-local-webapp.ps1`: restart declared services and emit a JSON summary.
- `scripts/self-test-restart-local-webapp.ps1`: verify the restart helper with temporary HTTP servers.
- `scripts/audit_domains.py`: report hard-coded local, preview, and production URL candidates.

## Output

End with:

- The project root used.
- One or more copy-paste command blocks labeled by terminal.
- The URL or endpoint to open or test.
- Validation commands/results, or a clear note that no command was run.
- Any assumptions, missing dependencies, occupied ports, or environment variables that affect startup.
- When relevant, the canonical domain map, restarted process/log evidence, and remaining CORS/cookie/auth risks.
