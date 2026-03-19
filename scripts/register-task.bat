@echo off
setlocal

set ROOT=%~dp0
set EXE=%ROOT%YouTube Sentinel.exe

if not exist "%EXE%" (
  echo Application executable was not found.
  pause
  exit /b 1
)

schtasks /create /f /tn "YouTube Sentinel Worker" /sc onstart /rl highest /ru SYSTEM /tr "\"%EXE%\" --worker"
echo Task registration finished.
pause

