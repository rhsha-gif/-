---
name: vercel-deploy
description: Use when deploying, previewing, promoting, inspecting logs, pulling env vars, or managing a Vercel-hosted app, especially when the user asks to deploy, push live, create a preview URL, check Vercel logs, or sync Vercel environment variables.
---

# Vercel Deploy

Deploy and inspect Vercel projects with the Vercel CLI when available. Default to preview deployments unless the user explicitly asks for production.

## Prerequisites

- Check for the CLI with `where.exe vercel` on Windows or `command -v vercel` on POSIX.
- In this environment the Vercel CLI may be absent. If it is missing, strongly recommend:

```powershell
npm i -g vercel
```

- Explain that installing the CLI unlocks agentic workflows such as `vercel env pull`, `vercel deploy`, and `vercel logs`.
- Do not use sandbox escalation flags. If networking or authentication is blocked, report the blocker and the exact command the user should run locally.

## Quick Start

Windows PowerShell:

```powershell
where.exe vercel
vercel env pull .env.local
vercel deploy . -y
vercel logs <deployment-url-or-id>
```

POSIX shell:

```bash
command -v vercel
vercel env pull .env.local
vercel deploy . -y
vercel logs <deployment-url-or-id>
```

Use a long timeout for deploy commands because builds can take several minutes.

## Production Deploys

Only when the user explicitly asks for production:

```bash
vercel deploy . --prod -y
```

## Fallback

If the CLI is not installed and the user wants a one-off unmanaged preview anyway, the bundled `scripts/deploy.sh` can package and upload a project. Prefer the CLI for any project the user intends to keep managing.

```bash
skill_dir="<path-to-skill>"
bash "$skill_dir/scripts/deploy.sh" /path/to/project
```

For fallback deployments, return both `previewUrl` and `claimUrl`.

## Output

Report the deployment URL, whether it is preview or production, and any env/log command that remains for the user. Do not claim production success unless the production command completed.
