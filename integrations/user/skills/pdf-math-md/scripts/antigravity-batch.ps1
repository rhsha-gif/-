# pdf-math-md: run the page loop + assemble headlessly in Antigravity, one conversation per slug, sequentially.
#
# Precondition (the human gate): every slug has already had `prepare`, `set-ranges` and `confirm-ranges`
# run by the reviewer. This driver never sets or confirms ranges.
#
#   powershell -ExecutionPolicy Bypass -File antigravity-batch.ps1 -Slugs exam-2020-1,exam-2014-1
#   powershell -ExecutionPolicy Bypass -File antigravity-batch.ps1 -Slugs exam-2020-1 -Model gemini-3.8-flash-high
#
# Logs: <out root>\_dogfood\<slug>.log and batch.log (UTF-8). Runs are resumable: re-run the same slug and the
# agent continues from `next`. One agy process at a time (each headless session is memory-heavy).
param(
    [Parameter(Mandatory = $true)][string[]]$Slugs,
    [string]$Model = "gemini-3.1-pro-high",
    [string]$Vault = "",
    [string]$Agy = "$env:LOCALAPPDATA\agy\bin\agy.exe",
    [int]$MinutesPerPage = 4
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
Set-Location $Vault
foreach ($slug in $Slugs) {
    $state = Join-Path $runRoot "$slug\state.json"
    if (-not (Test-Path $state)) { Log "SKIP $slug (no state; run prepare/set-ranges/confirm-ranges first)"; continue }
    $st = Get-Content $state -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $st.ranges.confirmed) { Log "SKIP $slug (ranges not confirmed)"; continue }
    $pending = @($st.pages.PSObject.Properties | Where-Object { $_.Value.status -in @("pending", "failed") }).Count
    $timeout = [Math]::Max(20, $pending * $MinutesPerPage)
    $stateOutRoot = $st.out_root
    $addOut = if ($stateOutRoot) { $stateOutRoot } else { $outRoot }
    $prompt = "pdf-math-md 스킬을 사용한다. 슬러그 $slug 는 이미 prepare 와 set-ranges, confirm-ranges 가 끝났고 사용자가 구간을 확인했다(status 로 확인만 한다). 스킬 3단계 페이지 루프(next -> prompt --page N -> pages/NNN.png 보기 -> pages/NNN.json 을 파일 도구로 직접 작성 -> check --page N, failed 면 오류 목록을 보고 고쳐 재검사)를 next 가 done 을 낼 때까지 돌린 뒤 5단계 assemble 을 실행한다. 페이지는 반드시 한 장씩 실제 이미지를 보고 전사한다. 마지막에 index.md 요약(문제 수, 해설 매칭 수, 실패·건너뜀 페이지와 이유, 그림 미추출)을 보고한다."
    $log = Join-Path $logDir "$slug.log"
    $start = Get-Date
    Log "START $slug pending=$pending timeout=${timeout}m model=$Model at $start"
    $ErrorActionPreference = "Continue"  # a native stderr line (quota, timeout) must not abort the batch
    & $Agy -p $prompt --model $Model --mode accept-edits --dangerously-skip-permissions --add-dir $Vault --add-dir $runRoot --add-dir $addOut --output-format text --print-timeout "${timeout}m" *> $log
    $code = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    $elapsed = [int]((Get-Date) - $start).TotalSeconds
    $tail = if (Test-Path $log) { (Get-Content $log -Tail 1 -Encoding UTF8) } else { "" }
    Log "END   $slug exit=$code elapsed=${elapsed}s last=$tail"
}
Log "BATCH DONE"
