param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [int]$TimeoutMs = 30000
)

$ErrorActionPreference = 'Stop'
$startedAt = Get-Date
$errors = [System.Collections.Generic.List[string]]::new()

try {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
  $byParent = @{}
  foreach ($process in $all) {
    $key = [int]$process.ParentProcessId
    if (-not $byParent.ContainsKey($key)) {
      $byParent[$key] = [System.Collections.Generic.List[object]]::new()
    }
    $byParent[$key].Add($process)
  }

  $captured = [System.Collections.Generic.List[object]]::new()
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $root = $all | Where-Object { $_.ProcessId -eq $RootPid } | Select-Object -First 1
  if ($null -ne $root) {
    $queue.Enqueue([pscustomobject]@{ Process = $root; Depth = 0 })
  }
  while ($queue.Count -gt 0) {
    $item = $queue.Dequeue()
    $process = $item.Process
    $captured.Add([pscustomobject]@{
      pid = [int]$process.ProcessId
      parentPid = [int]$process.ParentProcessId
      creationDate = [string]$process.CreationDate
      depth = [int]$item.Depth
    })
    if ($byParent.ContainsKey([int]$process.ProcessId)) {
      foreach ($child in $byParent[[int]$process.ProcessId]) {
        $queue.Enqueue([pscustomobject]@{ Process = $child; Depth = $item.Depth + 1 })
      }
    }
  }

  if ($captured.Count -gt 0 -and ((Get-Date) - $startedAt).TotalMilliseconds -lt $TimeoutMs) {
    try {
      & taskkill.exe /PID $RootPid /T /F 2>&1 | Out-Null
    } catch {
      $errors.Add("taskkill: $($_.Exception.Message)")
    }
  }

  # Re-check the original snapshot and force-stop only matching PID/creation pairs.
  foreach ($entry in @($captured | Sort-Object depth -Descending)) {
    if (((Get-Date) - $startedAt).TotalMilliseconds -ge $TimeoutMs) {
      $errors.Add('cleanup deadline exceeded')
      break
    }
    try {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.pid)" -ErrorAction SilentlyContinue
      if ($null -ne $current -and [string]$current.CreationDate -eq $entry.creationDate) {
        Stop-Process -Id $entry.pid -Force -ErrorAction Stop
      }
    } catch {
      $errors.Add("pid $($entry.pid): $($_.Exception.Message)")
    }
  }

  $survivors = [System.Collections.Generic.List[object]]::new()
  foreach ($entry in $captured) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.pid)" -ErrorAction SilentlyContinue
    if ($null -ne $current -and [string]$current.CreationDate -eq $entry.creationDate) {
      $survivors.Add($entry)
    }
  }

  [pscustomobject]@{
    method = 'cim-snapshot'
    attempted = $true
    completed = $survivors.Count -eq 0
    captured = @($captured)
    survivors = @($survivors)
    errors = @($errors)
  } | ConvertTo-Json -Compress -Depth 4
} catch {
  [pscustomobject]@{
    method = 'cim-snapshot'
    attempted = $true
    completed = $false
    captured = @()
    survivors = @()
    errors = @($_.Exception.Message)
  } | ConvertTo-Json -Compress -Depth 4
  exit 1
}
