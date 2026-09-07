param(
  [string[]]$Ports = @('5173', '8000'),
  [int]$TimeoutSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-TcpPort {
  param([Parameter(Mandatory = $true)][int]$Port)

  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(500, $false)) {
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

$parsedPorts = @()
foreach ($portValue in $Ports) {
  foreach ($part in ([string]$portValue -split ',')) {
    $trimmed = $part.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
      continue
    }
    $parsedPorts += [int]$trimmed
  }
}
$Ports = @($parsedPorts)

if ($Ports.Count -ne 2) {
  throw 'Self-test expects exactly two ports.'
}

foreach ($port in $Ports) {
  if (Test-TcpPort -Port $port) {
    throw "Port $port is already in use. Stop the service or rerun with unused ports to avoid killing unrelated work."
  }
}

$python = (Get-Command python -ErrorAction Stop).Source
$skillRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$helper = Join-Path -Path $skillRoot -ChildPath 'scripts\restart-local-webapp.ps1'
$testRoot = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ('codex-webapp-restart-self-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

$initialProcesses = @()
try {
  foreach ($port in $Ports) {
    $serviceDir = Join-Path -Path $testRoot -ChildPath "initial-$port"
    New-Item -ItemType Directory -Path $serviceDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path -Path $serviceDir -ChildPath 'index.html') -Value "initial $port" -Encoding UTF8

    $stdout = Join-Path -Path $serviceDir -ChildPath 'stdout.log'
    $stderr = Join-Path -Path $serviceDir -ChildPath 'stderr.log'
    $proc = Start-Process -FilePath $python `
      -ArgumentList @('-m', 'http.server', [string]$port, '--bind', '127.0.0.1') `
      -WorkingDirectory $serviceDir `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr `
      -WindowStyle Hidden `
      -PassThru
    $initialProcesses += $proc
  }

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  foreach ($port in $Ports) {
    do {
      if (Test-TcpPort -Port $port) {
        break
      }
      Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    if (-not (Test-TcpPort -Port $port)) {
      throw "Initial test server did not start on port $port."
    }
  }

  $services = @()
  for ($i = 0; $i -lt $Ports.Count; $i++) {
    $port = $Ports[$i]
    $serviceName = if ($i -eq 0) { 'frontend' } else { 'api' }
    $restartDir = Join-Path -Path $testRoot -ChildPath "restart-$port"
    New-Item -ItemType Directory -Path $restartDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path -Path $restartDir -ChildPath 'index.html') -Value "restarted $port" -Encoding UTF8

    $services += [ordered]@{
      name = $serviceName
      cwd = $restartDir
      command = "& '$python' -m http.server $port --bind 127.0.0.1"
      ports = @($port)
      urls = @("http://127.0.0.1:$port/")
    }
  }

  $servicesPath = Join-Path -Path $testRoot -ChildPath 'services.json'
  $services | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $servicesPath -Encoding UTF8
  $jsonText = & $helper -ProjectRoot $testRoot -ServicesJson $servicesPath -ForcePorts -TimeoutSeconds $TimeoutSeconds
  $summary = $jsonText | ConvertFrom-Json

  if ($summary.status -ne 'ok') {
    $jsonText
    throw "Restart helper self-test failed with status '$($summary.status)'."
  }

  foreach ($port in $Ports) {
    $body = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5).Content
    if ($body -notmatch "restarted $port") {
      throw "Port $port did not serve restarted content."
    }
  }

  [ordered]@{
    status = 'ok'
    ports = $Ports
    helperSummary = $summary
    testRoot = $testRoot
  } | ConvertTo-Json -Depth 12
} finally {
  foreach ($port in $Ports) {
    try {
      if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
          Select-Object -ExpandProperty OwningProcess -Unique)
        foreach ($owner in $owners) {
          if ($owner -and $owner -ne $PID) {
            Stop-Process -Id ([int]$owner) -Force -ErrorAction SilentlyContinue
          }
        }
      }
    } catch {
    }
  }

  foreach ($proc in $initialProcesses) {
    try {
      if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      }
    } catch {
    }
  }
}
