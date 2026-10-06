@echo off
rem Stops the WhatsApp export listener. Other node processes are left alone.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-listener.ps1"
echo.
echo It will start again at next sign-in, or double-click service-run.cmd to start it now.
pause
