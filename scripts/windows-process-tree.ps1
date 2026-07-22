param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [ValidateSet('Snapshot', 'Terminate')][string]$Mode = 'Terminate',
  [string]$ExpectedCreationDate,
  [int]$TimeoutMs = 30000
)

$ErrorActionPreference = 'Stop'
$startedAt = Get-Date
$errors = [System.Collections.Generic.List[string]]::new()

if ($Mode -eq 'Snapshot') {
  try {
    $process = Get-Process -Id $RootPid -ErrorAction SilentlyContinue
    $identity = if ($null -eq $process) { $null } else { [pscustomobject]@{
      pid = [int]$process.Id
      creationDate = $process.StartTime.ToUniversalTime().Ticks.ToString()
    }}
    [pscustomobject]@{
      method = 'windows-process-snapshot'
      attempted = $false
      completed = $null -ne $identity
      identity = $identity
      captured = @()
      survivors = @()
      errors = if ($null -eq $identity) { @('root process exited before identity capture') } else { @() }
    } | ConvertTo-Json -Compress -Depth 4
    return
  } catch {
    [pscustomobject]@{
      method = 'windows-process-snapshot'
      attempted = $false
      completed = $false
      identity = $null
      captured = @()
      survivors = @()
      errors = @($_.Exception.Message)
    } | ConvertTo-Json -Compress -Depth 4
    exit 1
  }
}

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class AorchProcessInfo {
  public sealed class ProcessPair {
    public int ProcessId;
    public int ParentProcessId;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  private struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  private const uint TH32CS_SNAPPROCESS = 0x00000002;
  private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }

  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(
    IntPtr processHandle, int processInformationClass,
    ref PROCESS_BASIC_INFORMATION processInformation,
    int processInformationLength, out int returnLength);

  public static int ParentPid(Process process) {
    var info = new PROCESS_BASIC_INFORMATION();
    int returnLength;
    int status = NtQueryInformationProcess(
      process.Handle, 0, ref info, Marshal.SizeOf(info), out returnLength);
    if (status != 0) throw new InvalidOperationException("NtQueryInformationProcess failed: " + status);
    return info.InheritedFromUniqueProcessId.ToInt32();
  }

  public static ProcessPair[] Snapshot() {
    var result = new System.Collections.Generic.List<ProcessPair>();
    var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      var entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(entry);
      if (Process32First(snapshot, ref entry)) {
        do {
          result.Add(new ProcessPair {
            ProcessId = (int)entry.th32ProcessID,
            ParentProcessId = (int)entry.th32ParentProcessID
          });
          entry.dwSize = (uint)Marshal.SizeOf(entry);
        } while (Process32Next(snapshot, ref entry));
      }
    } finally {
      CloseHandle(snapshot);
    }
    return result.ToArray();
  }
}
'@

function Get-ProcessRecord([System.Diagnostics.Process]$Process) {
  try {
    [pscustomobject]@{
      ProcessId = [int]$Process.Id
      ParentProcessId = [AorchProcessInfo]::ParentPid($Process)
      CreationDate = $Process.StartTime.ToUniversalTime().Ticks.ToString()
    }
  } catch {
    $null
  }
}

function Find-ProcessRecord([int]$ProcessId) {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $null }
  Get-ProcessRecord $process
}

try {
  $currentRoot = Find-ProcessRecord $RootPid
  $rootCreationTicks = 0L
  if ($null -ne $currentRoot -and [string]$currentRoot.CreationDate -ne $ExpectedCreationDate) {
    [pscustomobject]@{
      method = 'cim-snapshot'
      attempted = $false
      completed = $false
      identity = [pscustomobject]@{ pid = $RootPid; creationDate = [string]$currentRoot.CreationDate }
      captured = @()
      survivors = @()
      errors = @('root process identity mismatch; refusing to terminate')
    } | ConvertTo-Json -Compress -Depth 4
    exit 1
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedCreationDate) `
      -or -not [long]::TryParse($ExpectedCreationDate, [ref]$rootCreationTicks)) {
    throw 'captured root process identity is invalid'
  }
  if ($null -eq $currentRoot) {
    [pscustomobject]@{
      method = 'cim-snapshot'
      attempted = $false
      completed = $false
      identity = [pscustomobject]@{ pid = $RootPid; creationDate = $ExpectedCreationDate }
      captured = @()
      survivors = @()
      errors = @('root process exited before identity-bound descendant capture')
    } | ConvertTo-Json -Compress -Depth 4
    exit 1
  }

  $snapshotStartedAtTicks = [DateTime]::UtcNow.Ticks
  $all = @([AorchProcessInfo]::Snapshot())
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
  $queue.Enqueue([pscustomobject]@{
    ProcessId = $RootPid
    ParentProcessId = $currentRoot.ParentProcessId
    CreationDate = $ExpectedCreationDate
    ParentCreationDate = $null
    Depth = 0
  })
  while ($queue.Count -gt 0) {
    $item = $queue.Dequeue()
    $process = Find-ProcessRecord $item.ProcessId
    $identityMatches = $null -ne $process `
      -and [int]$process.ParentProcessId -eq [int]$item.ParentProcessId `
      -and (($item.Depth -eq 0 -and [string]$process.CreationDate -eq [string]$item.CreationDate) `
        -or ($item.Depth -gt 0 `
          -and [long]$process.CreationDate -ge [long]$item.ParentCreationDate `
          -and [long]$process.CreationDate -le $snapshotStartedAtTicks))
    if ($identityMatches) {
      $captured.Add([pscustomobject]@{
        pid = [int]$process.ProcessId
        parentPid = [int]$process.ParentProcessId
        creationDate = [string]$process.CreationDate
        depth = [int]$item.Depth
      })
      if ($byParent.ContainsKey([int]$item.ProcessId)) {
        foreach ($child in $byParent[[int]$item.ProcessId]) {
          $queue.Enqueue([pscustomobject]@{
            ProcessId = [int]$child.ProcessId
            ParentProcessId = [int]$child.ParentProcessId
            CreationDate = $null
            ParentCreationDate = [string]$process.CreationDate
            Depth = $item.Depth + 1
          })
        }
      }
    }
  }

  # Stop the verified root first, then deepest descendants. After every round,
  # use the kernel-reported exit time as a generation anchor and discover any
  # children spawned after the preceding snapshot but before their parent died.
  $known = @{}
  foreach ($entry in $captured) { $known["$($entry.pid):$($entry.creationDate)"] = $true }
  $processHandles = @{}
  foreach ($entry in $captured) {
    $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    $record = if ($null -eq $process) { $null } else { Get-ProcessRecord $process }
    if ($null -eq $record `
        -or [string]$record.CreationDate -ne $entry.creationDate `
        -or [int]$record.ParentProcessId -ne [int]$entry.parentPid) {
      $errors.Add("pid $($entry.pid) identity changed before handle capture")
      continue
    }
    # Force the handle open now so it remains bound to this process generation
    # even after the process exits and its numeric PID becomes reusable.
    $null = $process.Handle
    $processHandles["$($entry.pid):$($entry.creationDate)"] = $process
  }
  $pending = @($captured)
  while ($pending.Count -gt 0) {
    if (((Get-Date) - $startedAt).TotalMilliseconds -ge $TimeoutMs) {
      $errors.Add('cleanup deadline exceeded')
      break
    }
    $roots = @($pending | Where-Object { $_.depth -eq 0 })
    $descendants = @($pending | Where-Object { $_.depth -ne 0 } | Sort-Object depth -Descending)
    foreach ($entry in @($roots) + @($descendants)) {
      try {
        $handleKey = "$($entry.pid):$($entry.creationDate)"
        $liveProcess = $processHandles[$handleKey]
        if ($null -eq $liveProcess) {
          $liveProcess = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
          $current = if ($null -eq $liveProcess) { $null } else { Get-ProcessRecord $liveProcess }
          if ($null -eq $current `
              -or [string]$current.CreationDate -ne $entry.creationDate `
              -or [int]$current.ParentProcessId -ne [int]$entry.parentPid) {
            $errors.Add("pid $($entry.pid) identity changed before termination")
            continue
          }
          $null = $liveProcess.Handle
          $processHandles[$handleKey] = $liveProcess
        }
        if (-not $liveProcess.HasExited) {
          try {
            $liveProcess.Kill()
          } catch {
            # The verified process can exit naturally between HasExited and
            # Kill. Accept that race only when this same retained handle now
            # reports that its process generation has exited.
            if (-not $liveProcess.HasExited) { throw }
          }
        }
        # Wait even when HasExited has just become true. On Windows the process
        # signal can be observable before GetProcessTimes exposes a non-zero
        # exit timestamp on the retained handle.
        $remainingMs = [Math]::Max(1, $TimeoutMs - [int]((Get-Date) - $startedAt).TotalMilliseconds)
        if (-not $liveProcess.WaitForExit($remainingMs)) {
          $errors.Add("pid $($entry.pid) did not exit before cleanup deadline")
          continue
        }
        $exitTicks = $liveProcess.ExitTime.ToUniversalTime().Ticks
        if ($exitTicks -lt [long]$entry.creationDate -or $exitTicks -gt [DateTime]::UtcNow.AddSeconds(1).Ticks) {
          throw "pid $($entry.pid) returned an invalid exit timestamp"
        }
        $entry | Add-Member -NotePropertyName exitDate -NotePropertyValue $exitTicks.ToString() -Force
      } catch {
        $errors.Add("pid $($entry.pid): $($_.Exception.Message)")
      }
    }

    $late = [System.Collections.Generic.List[object]]::new()
    $after = @([AorchProcessInfo]::Snapshot())
    $afterByParent = @{}
    foreach ($process in $after) {
      $key = [int]$process.ParentProcessId
      if (-not $afterByParent.ContainsKey($key)) {
        $afterByParent[$key] = [System.Collections.Generic.List[object]]::new()
      }
      $afterByParent[$key].Add($process)
    }
    foreach ($parent in @($captured | Where-Object { $_.PSObject.Properties.Name -contains 'exitDate' })) {
      if (-not $afterByParent.ContainsKey([int]$parent.pid)) { continue }
      foreach ($child in $afterByParent[[int]$parent.pid]) {
        $record = Find-ProcessRecord ([int]$child.ProcessId)
        if ($null -eq $record) { continue }
        $key = "$($record.ProcessId):$($record.CreationDate)"
        if ($known.ContainsKey($key)) { continue }
        if ([int]$record.ParentProcessId -ne [int]$parent.pid `
            -or [long]$record.CreationDate -lt [long]$parent.creationDate `
            -or [long]$record.CreationDate -gt [long]$parent.exitDate) { continue }
        $entry = [pscustomobject]@{
          pid = [int]$record.ProcessId
          parentPid = [int]$record.ParentProcessId
          creationDate = [string]$record.CreationDate
          depth = [int]$parent.depth + 1
        }
        $known[$key] = $true
        $captured.Add($entry)
        $late.Add($entry)
      }
    }
    $pending = @($late)
  }

  $survivors = [System.Collections.Generic.List[object]]::new()
  foreach ($entry in $captured) {
    $current = Find-ProcessRecord $entry.pid
    if ($null -ne $current -and [string]$current.CreationDate -eq $entry.creationDate) {
      $survivors.Add($entry)
    }
  }

  [pscustomobject]@{
    method = 'cim-snapshot'
    attempted = $true
    completed = $survivors.Count -eq 0 -and $errors.Count -eq 0 -and $pending.Count -eq 0
    identity = [pscustomobject]@{ pid = $RootPid; creationDate = $ExpectedCreationDate }
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
