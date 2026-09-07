$ErrorActionPreference = "Stop"

$npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $npx) {
  $npx = Get-Command npx -ErrorAction SilentlyContinue
}

if (-not $npx) {
  Write-Error "npx is required but was not found on PATH."
  exit 1
}

$hasSessionFlag = $false
foreach ($arg in $args) {
  if ($arg -eq "--session" -or $arg.StartsWith("--session=")) {
    $hasSessionFlag = $true
    break
  }
}

$cmdArgs = @("--yes", "--package", "@playwright/cli", "playwright-cli")
if (-not $hasSessionFlag -and $env:PLAYWRIGHT_CLI_SESSION) {
  $cmdArgs += @("--session", $env:PLAYWRIGHT_CLI_SESSION)
}
$cmdArgs += $args

& $npx.Source @cmdArgs
exit $LASTEXITCODE
