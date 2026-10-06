# Health check for the WhatsApp group chat export.
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File status.ps1
# Or double-click  WhatsApp Export Status.cmd

$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }

Write-Host ""
Write-Host "ChatFlow - status" -ForegroundColor Cyan
Write-Host ("=" * 45)

# --- processes -------------------------------------------------------------
# NOTE: kept as plain inline expressions on purpose. Wrapping these pipelines in
# a PowerShell function made them return nothing, so this check silently
# reported "NOT RUNNING" while the listener was healthy. Do not refactor.
$listeners = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*listener.js*' })
$wrappers = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*service-run.cmd*' })

if ($listeners.Count -gt 0) {
    foreach ($l in $listeners) {
        $up = (Get-Date) - $l.CreationDate
        $upStr = "{0:d2}h {1:d2}m" -f [int]$up.TotalHours, $up.Minutes
        Write-Host ("Listener:   RUNNING (PID {0}, up {1})" -f $l.ProcessId, $upStr) -ForegroundColor Green
    }
} else {
    Write-Host "Listener:   NOT RUNNING" -ForegroundColor Red
}

if ($wrappers.Count -gt 0) {
    Write-Host ("Watchdog:   RUNNING (restarts the listener if it dies)") -ForegroundColor Green
} else {
    Write-Host "Watchdog:   not running - the listener will not auto-restart" -ForegroundColor Yellow
}

if ($listeners.Count -gt 1) {
    Write-Host "WARNING: multiple listeners - they will fight over the session" -ForegroundColor Red
}

# --- link ------------------------------------------------------------------
$creds = Join-Path $root 'auth\creds.json'
if (Test-Path $creds) {
    try {
        $me = (Get-Content $creds -Raw | ConvertFrom-Json).me.id
        Write-Host "Linked as:  $me" -ForegroundColor Green
    } catch {
        Write-Host "Linked as:  creds.json unreadable" -ForegroundColor Red
    }
} else {
    Write-Host "Linked as:  NOT LINKED - run Start WhatsApp Export.cmd and scan qr.png" -ForegroundColor Red
}

# --- stored data -----------------------------------------------------------
$store = Join-Path $root 'data\messages.jsonl'
if (Test-Path $store) {
    $lines = (Get-Content $store | Measure-Object -Line).Lines
    $kb = [math]::Round((Get-Item $store).Length / 1KB, 1)
    Write-Host "Captured:   $lines messages ($kb KB)"

    $groups = @{}
    Get-Content $store | ForEach-Object {
        try { $g = ($_ | ConvertFrom-Json).groupName; if ($g) { $groups[$g] = 1 + ($groups[$g] -as [int]) } } catch {}
    }
    foreach ($g in ($groups.Keys | Sort-Object)) {
        Write-Host ("              {0} - {1}" -f $g, $groups[$g])
    }
} else {
    Write-Host "Captured:   no messages stored yet" -ForegroundColor Yellow
}

# --- output folder ---------------------------------------------------------
try {
    $cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
    $out = $cfg.outputDir
    if (Test-Path $out) {
        $files = @(Get-ChildItem -Path $out -Recurse -Filter *.md -ErrorAction SilentlyContinue)
        $latest = $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        Write-Host "Exports:    $($files.Count) markdown files"
        if ($latest) {
            Write-Host ("              last written {0:yyyy-MM-dd HH:mm}" -f $latest.LastWriteTime)
        }
        Write-Host "              $out"
    } else {
        Write-Host "Exports:    output folder not reachable: $out" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Exports:    could not read config.json" -ForegroundColor Yellow
}

# --- last activity ---------------------------------------------------------
$log = Join-Path $root 'listener.log'
if (Test-Path $log) {
    $last = Get-Content $log -Tail 1
    Write-Host ""
    Write-Host "Last log line:"
    Write-Host "  $last" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Controls:  Stop WhatsApp Export.cmd  |  service-run.cmd  |  Render now.cmd"
Write-Host ""
