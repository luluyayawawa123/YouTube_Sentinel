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

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$taskName = 'YouTube Sentinel Worker';" ^
  "$exePath = [System.IO.Path]::GetFullPath('%PS_EXE%');" ^
  "$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;" ^
  "if ($task) { try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null } catch {}; Start-Sleep -Milliseconds 500; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null };" ^
  "$workerProcesses = Get-CimInstance Win32_Process -Filter \"Name = 'YouTube Sentinel.exe'\" | Where-Object { $_.ExecutablePath -eq $exePath -and $_.CommandLine -like '*--worker*' };" ^
  "foreach ($process in $workerProcesses) { Invoke-CimMethod -InputObject $process -MethodName Terminate | Out-Null }"
if errorlevel 1 (
  echo Task removal failed.
  echo Press any key to exit...
  pause >nul
  exit /b 1
)

echo Task removal finished.
echo Press any key to exit...
pause >nul

