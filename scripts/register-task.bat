@echo off
setlocal

net session >nul 2>nul
if errorlevel 1 (
  echo Please run this script as administrator.
  echo Press any key to exit...
  pause >nul
  exit /b 1
)

set "ROOT=%~dp0"
set "EXE=%ROOT%YouTube Sentinel.exe"
set "PS_EXE=%EXE:'=''%"

if not exist "%EXE%" (
  echo Application executable was not found.
  echo Press any key to exit...
  pause >nul
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$taskName = 'YouTube Sentinel Worker';" ^
  "$exePath = [System.IO.Path]::GetFullPath('%PS_EXE%');" ^
  "$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;" ^
  "if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null }" ^
  "$action = New-ScheduledTaskAction -Execute $exePath -Argument '--worker';" ^
  "$trigger = New-ScheduledTaskTrigger -AtStartup;" ^
  "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;" ^
  "Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -User 'SYSTEM' -Force | Out-Null"
if errorlevel 1 (
  echo Task registration failed.
  echo Press any key to exit...
  pause >nul
  exit /b 1
)

echo Task registration finished.
echo Press any key to exit...
pause >nul

