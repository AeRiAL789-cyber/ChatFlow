@echo off
rem Unattended runner for the WhatsApp export listener (used by the startup entry).
rem Watchdog: if node exits unexpectedly it is restarted automatically.
rem Stop WhatsApp Export.cmd sets stop.flag, which makes this loop exit instead
rem of fighting the stop.
cd /d "%~dp0"

if exist stop.flag del /q stop.flag

:loop
if exist stop.flag (
  echo [watchdog] stop.flag present - exiting %date% %time%>> service-console.log
  exit /b 0
)

echo [watchdog] starting listener %date% %time%>> service-console.log
node listener.js >> service-console.log 2>&1

if exist stop.flag (
  echo [watchdog] stop.flag present - exiting %date% %time%>> service-console.log
  exit /b 0
)

echo [watchdog] listener exited unexpectedly %date% %time% - restarting in 15s>> service-console.log
ping -n 16 127.0.0.1 >nul
goto loop
