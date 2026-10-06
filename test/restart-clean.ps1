# Test helper: stop every WhatsApp export wrapper and listener, then report.
$killed = 0

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*listener.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }

Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -like '*service-run.cmd*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }

Start-Sleep -Seconds 3

$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*listener.js*' })
$wraps = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -like '*service-run.cmd*' })

Write-Host "killed: $killed"
Write-Host "listener node procs left: $($nodes.Count)"
Write-Host "service-run wrappers left: $($wraps.Count)"
