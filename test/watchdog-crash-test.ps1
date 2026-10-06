# Closes the one unverified gap: does the watchdog really recover a crashed listener?
# Kills the listener process outright (no stop flag) and watches for the restart.

function ListenerPids {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*listener.js*' } |
        Select-Object -ExpandProperty ProcessId)
}

$before = ListenerPids
Write-Host "listener PIDs before: $($before -join ', ')  (count $($before.Count))"

if ($before.Count -eq 0) {
    Write-Host "Nothing to kill - is the watchdog running? Aborting this test."
    exit 1
}

$before | ForEach-Object {
    Write-Host "killing PID $_ (simulated crash - note: no stop.flag set)"
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 3
$justAfter = ListenerPids
Write-Host "listener PIDs 3s after kill: $($justAfter -join ', ')  (count $($justAfter.Count))"

Write-Host "waiting up to 45s for the watchdog to restart it..."
$recovered = $false
for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 3
    $now = ListenerPids
    if ($now.Count -gt 0) {
        Write-Host "RECOVERED after ~$($i * 3)s - new listener PID $($now -join ', ')"
        $recovered = $true
        break
    }
}

if (-not $recovered) {
    Write-Host "NOT RECOVERED after 45s - the watchdog is not restarting the listener."
    exit 2
}

Start-Sleep -Seconds 12
Write-Host "final listener PIDs: $((ListenerPids) -join ', ')"
Write-Host "watchdog wrappers: $((@(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*service-run.cmd*' })).Count)"
