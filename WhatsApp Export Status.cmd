@echo off
rem Health check for the WhatsApp group chat export.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0status.ps1"
pause
