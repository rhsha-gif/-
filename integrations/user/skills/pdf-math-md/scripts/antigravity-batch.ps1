# pdf-math-md: run the page loop + assemble headlessly in Antigravity, one conversation per slug, sequentially.
#
# Precondition (the human gate): every slug has already had `prepare`, `set-ranges` and `confirm-ranges`
# run by the reviewer. This driver never sets or confirms ranges.
#
#   powershell -ExecutionPolicy Bypass -File antigravity-batch.ps1 -Slugs exam-2020-1,exam-2014-1
#   powershell -ExecutionPolicy Bypass -File antigravity-batch.ps1 -Slugs exam-2020-1 -Model gemini-3.8-flash-high
#
# Logs: <out root>\_dogfood\<slug>.log (agent output), <slug>.agy.log (CLI log incl. tool calls) and batch.log
# (UTF-8). Runs are resumable: re-run the same slug and the agent continues from `next`. One agy process at a
# time: the driver waits for a running agy.exe before starting, kills the one it started when the print
# timeout leaves it behind, and when the individual quota is reached it sleeps until the reset and resumes.
param(
    [Parameter(Mandatory = $true)][string[]]$Slugs,
    [string]$Model = "gemini-3.1-pro-high",
    [string]$Vault = "",
    [string]$Agy = "$env:LOCALAPPDATA\agy\bin\agy.exe",
    [int]$MinutesPerPage = 4,
    [int]$MaxQuotaWaits = 3
)
$ErrorActionPreference = "Stop"
if (-not $Vault) {
    $probe = $PSScriptRoot
    while ($probe -and -not (Test-Path (Join-Path $probe ".agents"))) { $probe = Split-Path -Parent $probe }
    if (-not $probe) { $probe = (Get-Location).Path }  # global skill install: default to the current workspace
    $Vault = $probe
}
if (-not (Test-Path $Agy)) { throw "agy.exe not found at $Agy" }
$runRoot = Join-Path $env:LOCALAPPDATA "pdf2md"
if ($env:PDF2MD_RUN_ROOT) { $runRoot = $env:PDF2MD_RUN_ROOT }
$outRoot = "C:\Users\goyan\OneDrive\문서\수학문제-md"
if ($env:PDF2MD_OUT_ROOT) { $outRoot = $env:PDF2MD_OUT_ROOT }
$logDir = Join-Path $outRoot "_dogfood"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$batchLog = Join-Path $logDir "batch.log"
function Log([string]$line) { $line | Out-File -FilePath $batchLog -Append -Encoding utf8; Write-Host $line }

function Get-AgyProcesses { Get-Process -Name "agy" -ErrorAction SilentlyContinue }

function Wait-ForIdleAgy {
    $waited = 0
    while (Get-AgyProcesses) {
        if ($waited -eq 0) { Log "WAIT  another agy.exe is running; waiting for it to exit" }
        Start-Sleep -Seconds 30
        $waited += 30
    }
}

function Stop-OrphanedAgy([datetime]$since) {
    foreach ($p in Get-AgyProcesses) {
        $started = $null
        try { $started = $p.StartTime } catch {}
        if ($started -and $started -ge $since) {
            Log "KILL  agy pid $($p.Id) started $started is still running after the print timeout"
            try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { Log "KILL  failed: $($_.Exception.Message)" }
        }
    }
}

function Get-QuotaWaitSeconds([string]$logPath) {
    # "Individual quota reached ... Resets in ~1h55m" (model-independent) -> seconds to sleep, or 0.
    if (-not (Test-Path $logPath)) { return 0 }
    $text = Get-Content $logPath -Raw -Encoding UTF8
    if ($text -notmatch "(?i)quota reached") { return 0 }
    $h = 0; $m = 0
    if ($text -match "(?i)resets in\s*~?\s*(\d+)\s*h\s*(\d+)?\s*m?") { $h = [int]$Matches[1]; if ($Matches[2]) { $m = [int]$Matches[2] } }
    elseif ($text -match "(?i)resets in\s*~?\s*(\d+)\s*m") { $m = [int]$Matches[1] }
    else { $h = 1 }
    return ($h * 3600 + $m * 60 + 180)
}

function Get-PendingCount([string]$statePath) {
    $st = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    return @($st.pages.PSObject.Properties | Where-Object { $_.Value.status -in @("pending", "failed") }).Count
}

Set-Location $Vault
foreach ($slug in $Slugs) {
    $state = Join-Path $runRoot "$slug\state.json"
    if (-not (Test-Path $state)) { Log "SKIP $slug (no state; run prepare/set-ranges/confirm-ranges first)"; continue }
    $st = Get-Content $state -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $st.ranges.confirmed) { Log "SKIP $slug (ranges not confirmed)"; continue }
    $stateOutRoot = $st.out_root
    $addOut = if ($stateOutRoot) { $stateOutRoot } else { $outRoot }
    $prompt = "pdf-math-md 스킬을 사용한다. 슬러그 $slug 는 이미 prepare 와 set-ranges, confirm-ranges 가 끝났고 사용자가 구간을 확인했다(status 로 확인만 한다). 스킬 3단계 페이지 루프(next -> prompt --page N -> pages/NNN.png 보기 -> pages/NNN.json 을 파일 도구로 직접 작성 -> check --page N, failed 면 오류 목록을 보고 고쳐 재검사)를 next 가 done 을 낼 때까지 돌린 뒤 5단계 assemble 을 실행한다. 페이지는 반드시 한 장씩 실제 이미지를 보고 전사한다. 검사를 통과시키려고 원문에 없는 값을 넣지 않는다. 마지막에 index.md 요약(문제 수, 해설 매칭 수, 해설에서 만든 문제 수, 검토 권장, 실패·건너뜀 페이지와 이유, 그림 미추출)을 보고한다."
    $log = Join-Path $logDir "$slug.log"
    $agyLog = Join-Path $logDir "$slug.agy.log"
    $quotaWaits = 0
    while ($true) {
        $pending = Get-PendingCount $state
        if ($pending -eq 0) { Log "DONE  $slug nothing pending"; break }
        $timeout = [Math]::Max(20, $pending * $MinutesPerPage)
        Wait-ForIdleAgy
        $start = Get-Date
        Log "START $slug pending=$pending timeout=${timeout}m model=$Model at $start"
        $ErrorActionPreference = "Continue"  # a native stderr line (quota, timeout) must not abort the batch
        & $Agy -p $prompt --model $Model --mode accept-edits --dangerously-skip-permissions --add-dir $Vault --add-dir $runRoot --add-dir $addOut --output-format text --print-timeout "${timeout}m" --log-file $agyLog *> $log
        $code = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
        $elapsed = [int]((Get-Date) - $start).TotalSeconds
        $tail = if (Test-Path $log) { (Get-Content $log -Tail 1 -Encoding UTF8) } else { "" }
        Log "END   $slug exit=$code elapsed=${elapsed}s pending_after=$(Get-PendingCount $state) last=$tail"
        if ($code -ne 0) { Stop-OrphanedAgy $start }
        $wait = Get-QuotaWaitSeconds $log
        if ($wait -gt 0 -and $quotaWaits -lt $MaxQuotaWaits) {
            $quotaWaits += 1
            Log "QUOTA $slug individual quota reached; sleeping ${wait}s (wait $quotaWaits/$MaxQuotaWaits) then resuming"
            Start-Sleep -Seconds $wait
            continue
        }
        break
    }
}
Log "BATCH DONE"
