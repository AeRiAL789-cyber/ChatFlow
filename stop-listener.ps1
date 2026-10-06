# Stops the WhatsApp export listener. Other node processes are left alone.
# Sets stop.flag first so the watchdog loop in service-run.cmd exits rather than
# restarting the listener behind our back.

$flag = Join-Path $PSScriptRoot 'stop.flag'
New-Item -ItemType File -Path $flag -Force | Out-Null

$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*listener.js*' }

if ($procs) {
    $procs | ForEach-Object {
        Write-Host ("Stopping listener PID " + $_.ProcessId)
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
    $left = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*listener.js*' }
    if ($left) { Write-Host "WARNING: listener still running (PID $($left.ProcessId))." }
    else { Write-Host "Listener stopped." }
} else {
    Write-Host "No WhatsApp export listener was running."
}
