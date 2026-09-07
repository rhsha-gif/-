# Safe Web App Restart

Use the bundled PowerShell helper when a deterministic Windows restart is required.

## Service Contract

Each service object requires `name` and `command`. It may also declare an absolute `cwd`, integer `ports`, and health-check `urls`.

```json
[
  {
    "name": "frontend",
    "cwd": "C:\\path\\app",
    "command": "npm.cmd run dev",
    "ports": [5173],
    "urls": ["http://127.0.0.1:5173/"]
  }
]
```

Write multiline JSON to a temporary file before crossing the native PowerShell process boundary.

```powershell
$servicesPath = Join-Path $env:TEMP "codex-webapp-services.json"
$services | Set-Content -LiteralPath $servicesPath -Encoding UTF8

powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  "$env:USERPROFILE\.agents\skills\local-dev-runbook\scripts\restart-local-webapp.ps1" `
  -ProjectRoot "C:\path\app" `
  -ServicesJson $servicesPath `
  -DryRun
```

Replace `-DryRun` with `-ForcePorts` only after confirming every listed port belongs to the target project. The helper writes logs under `%TEMP%\codex-webapp-restart\<project-id>\` and returns a JSON summary with killed owners, started process IDs, URLs, ports, and failures.

## Validation

After changing the helper, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  "$env:USERPROFILE\.agents\skills\local-dev-runbook\scripts\self-test-restart-local-webapp.ps1"
```

The self-test uses two unoccupied temporary ports, verifies restarted content, and cleans up only the processes it owns.
