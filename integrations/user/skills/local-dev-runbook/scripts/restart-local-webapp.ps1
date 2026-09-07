param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [Parameter(Mandatory = $true)]
  [string]$ServicesJson,

  [switch]$ForcePorts,

  [ValidateRange(1, 600)]
  [int]$TimeoutSeconds = 60,

  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-SafeName {
  param([Parameter(Mandatory = $true)][string]$Value)

  $safe = $Value -replace '[^A-Za-z0-9_.-]', '-'
  $safe = $safe.Trim('-')
  if ([string]::IsNullOrWhiteSpace($safe)) {
    return 'service'
  }
  return $safe
}

function Get-StableHash {
  param([Parameter(Mandatory = $true)][string]$Value)

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($bytes)
  } finally {
    $sha.Dispose()
  }

  return (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 10)
}

function Quote-PowerShellSingle {
  param([Parameter(Mandatory = $true)][string]$Value)
  return "'" + ($Value -replace "'", "''") + "'"
}

function Get-PortOwnerIds {
  param([Parameter(Mandatory = $true)][int]$Port)

  $ids = @()
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    try {
      $ids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -and $_.OwningProcess -ne 0 } |
        Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
      $ids = @()
    }
  }

  if ($ids.Count -eq 0) {
    $lines = @(netstat -ano -p tcp 2>$null | Select-String -Pattern (":$Port\s+.*LISTENING\s+\d+"))
    foreach ($line in $lines) {
      $text = $line.ToString().Trim()
      $parts = @($text -split '\s+')
      if ($parts.Count -gt 0) {
        $pidText = $parts[$parts.Count - 1]
        if ($pidText -match '^\d+$') {
          $ids += [int]$pidText
        }
      }
    }
    $ids = @($ids | Select-Object -Unique)
  }

  return @($ids)
}

function Wait-ForPortFree {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutSeconds = 15
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (@(Get-PortOwnerIds -Port $Port).Count -eq 0) {
      return $true
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)

  return $false
}

function Test-TcpPort {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [string]$HostName = '127.0.0.1'
  )

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $iar = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1000, $false)) {
      return $false
    }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-ForUrl {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][datetime]$Deadline
  )

  $lastError = $null
  do {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
      return @{
        url = $Url
        ok = $true
        statusCode = [int]$response.StatusCode
        message = 'ok'
      }
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $Deadline)

  return @{
    url = $Url
    ok = $false
    statusCode = $null
    message = $lastError
  }
}

function Wait-ForPort {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][datetime]$Deadline
  )

  do {
    if (Test-TcpPort -Port $Port) {
      return @{
        port = $Port
        ok = $true
        message = 'listening'
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $Deadline)

  return @{
    port = $Port
    ok = $false
    message = 'not listening before timeout'
  }
}

function Normalize-Array {
  param($Value)

  if ($null -eq $Value) {
    return @()
  }
  if ($Value -is [array]) {
    return @($Value)
  }
  return @($Value)
}

function Get-ServiceProperty {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [Parameter(Mandatory = $true)][string]$Name,
    $Default = $null
  )

  if ($Service.PSObject.Properties.Name -contains $Name) {
    return $Service.$Name
  }
  return $Default
}

$resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
if (-not (Test-Path -LiteralPath $resolvedProjectRoot)) {
  throw "ProjectRoot does not exist: $resolvedProjectRoot"
}

if (Test-Path -LiteralPath $ServicesJson) {
  $serviceJsonText = Get-Content -LiteralPath $ServicesJson -Raw
} else {
  $serviceJsonText = $ServicesJson
}

$parsedServices = ConvertFrom-Json -InputObject $serviceJsonText
$services = @()
if ($parsedServices -is [System.Array]) {
  foreach ($parsedService in $parsedServices) {
    $services += $parsedService
  }
} else {
  $services += $parsedServices
}
if ($services.Count -eq 0) {
  throw 'ServicesJson must contain at least one service.'
}

$projectLeaf = Split-Path -Path $resolvedProjectRoot -Leaf
if ([string]::IsNullOrWhiteSpace($projectLeaf)) {
  $projectLeaf = 'project'
}
$projectId = (ConvertTo-SafeName -Value $projectLeaf) + '-' + (Get-StableHash -Value $resolvedProjectRoot)
$logRoot = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath "codex-webapp-restart\$projectId"
if (-not $DryRun) {
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
}

$summary = [ordered]@{
  projectRoot = $resolvedProjectRoot
  logRoot = $logRoot
  forcePorts = [bool]$ForcePorts
  dryRun = [bool]$DryRun
  timeoutSeconds = $TimeoutSeconds
  killed = @()
  skippedKills = @()
  started = @()
  urlChecks = @()
  portChecks = @()
  failures = @()
}

foreach ($service in $services) {
  $name = [string](Get-ServiceProperty -Service $service -Name 'name' -Default '')
  if ([string]::IsNullOrWhiteSpace($name)) {
    throw 'Each service must include a non-empty name.'
  }

  $command = [string](Get-ServiceProperty -Service $service -Name 'command' -Default '')
  if ([string]::IsNullOrWhiteSpace($command)) {
    throw "Service '$name' must include a non-empty command."
  }

  $cwdValue = [string](Get-ServiceProperty -Service $service -Name 'cwd' -Default $resolvedProjectRoot)
  if ([string]::IsNullOrWhiteSpace($cwdValue)) {
    $cwdValue = $resolvedProjectRoot
  }
  if (-not [System.IO.Path]::IsPathRooted($cwdValue)) {
    $cwdValue = Join-Path -Path $resolvedProjectRoot -ChildPath $cwdValue
  }
  $cwd = [System.IO.Path]::GetFullPath($cwdValue)
  if (-not (Test-Path -LiteralPath $cwd)) {
    throw "Service '$name' cwd does not exist: $cwd"
  }

  $safeName = ConvertTo-SafeName -Value $name
  $logPath = Join-Path -Path $logRoot -ChildPath "$safeName.log"
  $runnerPath = Join-Path -Path $logRoot -ChildPath "$safeName.runner.ps1"
  $ports = @(Normalize-Array -Value (Get-ServiceProperty -Service $service -Name 'ports') | ForEach-Object { [int]$_ })

  foreach ($port in $ports) {
    $ownerIds = @(Get-PortOwnerIds -Port $port)
    if ($ownerIds.Count -eq 0) {
      continue
    }

    foreach ($ownerId in $ownerIds) {
      $killRecord = [ordered]@{
        service = $name
        port = $port
        pid = [int]$ownerId
      }

      if ($DryRun) {
        $killRecord.action = 'would-kill'
        $summary.killed += $killRecord
        continue
      }

      if (-not $ForcePorts) {
        $killRecord.action = 'skipped'
        $killRecord.reason = 'ForcePorts not supplied'
        $summary.skippedKills += $killRecord
        continue
      }

      if ([int]$ownerId -eq $PID) {
        $killRecord.action = 'skipped'
        $killRecord.reason = 'refusing to stop current PowerShell process'
        $summary.skippedKills += $killRecord
        continue
      }

      try {
        Stop-Process -Id ([int]$ownerId) -Force -ErrorAction Stop
        $killRecord.action = 'killed'
        $summary.killed += $killRecord
      } catch {
        $killRecord.action = 'failed'
        $killRecord.reason = $_.Exception.Message
        $summary.failures += $killRecord
      }
    }

    if (-not $DryRun -and $ForcePorts) {
      if (-not (Wait-ForPortFree -Port $port -TimeoutSeconds 15)) {
        $summary.failures += [ordered]@{
          service = $name
          port = $port
          reason = 'port still occupied after stop attempt'
        }
      }
    }
  }

  $startRecord = [ordered]@{
    service = $name
    cwd = $cwd
    command = $command
    logPath = $logPath
    runnerPath = $runnerPath
  }

  if ($DryRun) {
    $startRecord.action = 'would-start'
    $summary.started += $startRecord
    continue
  }

  $runner = @"
`$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $(Quote-PowerShellSingle -Value $cwd)
& {
$command
} *>> $(Quote-PowerShellSingle -Value $logPath)
if (`$LASTEXITCODE -ne `$null) { exit `$LASTEXITCODE }
"@

  Set-Content -LiteralPath $runnerPath -Value $runner -Encoding UTF8

  try {
    $process = Start-Process -FilePath 'powershell.exe' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runnerPath) `
      -WorkingDirectory $cwd `
      -WindowStyle Hidden `
      -PassThru
    $startRecord.action = 'started'
    $startRecord.pid = [int]$process.Id
    $summary.started += $startRecord
  } catch {
    $startRecord.action = 'failed'
    $startRecord.reason = $_.Exception.Message
    $summary.failures += $startRecord
  }
}

if (-not $DryRun) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  foreach ($service in $services) {
    $name = [string](Get-ServiceProperty -Service $service -Name 'name' -Default '')
    $urls = @(Normalize-Array -Value (Get-ServiceProperty -Service $service -Name 'urls') | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $ports = @(Normalize-Array -Value (Get-ServiceProperty -Service $service -Name 'ports') | ForEach-Object { [int]$_ })

    foreach ($url in $urls) {
      $result = Wait-ForUrl -Url $url -Deadline $deadline
      $result.service = $name
      $summary.urlChecks += $result
      if (-not $result.ok) {
        $summary.failures += [ordered]@{
          service = $name
          url = $url
          reason = $result.message
        }
      }
    }

    if ($urls.Count -eq 0) {
      foreach ($port in $ports) {
        $result = Wait-ForPort -Port $port -Deadline $deadline
        $result.service = $name
        $summary.portChecks += $result
        if (-not $result.ok) {
          $summary.failures += [ordered]@{
            service = $name
            port = $port
            reason = $result.message
          }
        }
      }
    }
  }
}

$summary.status = if ($summary.failures.Count -gt 0) { 'failed' } elseif ($DryRun) { 'dry-run' } else { 'ok' }
$summary | ConvertTo-Json -Depth 12
