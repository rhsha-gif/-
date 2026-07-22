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
    public string CreationDate;
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
          string creationDate = null;
          try {
            using (var process = Process.GetProcessById((int)entry.th32ProcessID)) {
              creationDate = process.StartTime.ToUniversalTime().Ticks.ToString();
            }
          } catch {}
          result.Add(new ProcessPair {
            ProcessId = (int)entry.th32ProcessID,
            ParentProcessId = (int)entry.th32ParentProcessID,
            CreationDate = creationDate
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
  if ($null -eq $currentRoot) {
    [pscustomobject]@{
      method = 'cim-snapshot'
      attempted = $true
      completed = $true
      identity = $null
      captured = @()
      survivors = @()
      errors = @()
    } | ConvertTo-Json -Compress -Depth 4
    return
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedCreationDate) -or [string]$currentRoot.CreationDate -ne $ExpectedCreationDate) {
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
    Depth = 0
  })
  while ($queue.Count -gt 0) {
    $item = $queue.Dequeue()
    $process = Find-ProcessRecord $item.ProcessId
    if ($null -ne $process `
        -and [int]$process.ParentProcessId -eq [int]$item.ParentProcessId `
        -and [string]$process.CreationDate -eq [string]$item.CreationDate) {
      $captured.Add([pscustomobject]@{
        pid = [int]$process.ProcessId
        parentPid = [int]$process.ParentProcessId
        creationDate = [string]$process.CreationDate
        depth = [int]$item.Depth
      })
      if ($byParent.ContainsKey([int]$item.ProcessId)) {
        foreach ($child in $byParent[[int]$item.ProcessId]) {
          if (-not [string]::IsNullOrWhiteSpace([string]$child.CreationDate)) {
            $queue.Enqueue([pscustomobject]@{
              ProcessId = [int]$child.ProcessId
              ParentProcessId = [int]$child.ParentProcessId
              CreationDate = [string]$child.CreationDate
              Depth = $item.Depth + 1
            })
          }
        }
      }
    }
  }

  # Force-stop only processes whose PID and creation time still match the snapshot.
  foreach ($entry in @($captured | Sort-Object depth -Descending)) {
    if (((Get-Date) - $startedAt).TotalMilliseconds -ge $TimeoutMs) {
      $errors.Add('cleanup deadline exceeded')
      break
    }
    try {
      $current = Find-ProcessRecord $entry.pid
      if ($null -ne $current -and [string]$current.CreationDate -eq $entry.creationDate) {
        Stop-Process -Id $entry.pid -Force -ErrorAction Stop
      }
    } catch {
      $errors.Add("pid $($entry.pid): $($_.Exception.Message)")
    }
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
    completed = $survivors.Count -eq 0
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
