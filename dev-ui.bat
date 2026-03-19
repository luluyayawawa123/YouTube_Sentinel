@echo off
setlocal

set "ROOT=%~dp0"
set "VITE_DEV_SERVER_URL=http://127.0.0.1:5173"
set "VITE_LOG=%ROOT%.dev-vite.log"
set "VITE_PID_FILE=%ROOT%.dev-vite.pid"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "NO_UPDATE_NOTIFIER=1"
set "YTS_DEV_SOURCE=1"

cd /d "%ROOT%"

if exist "%VITE_PID_FILE%" (
  for /f "usebackq delims=" %%i in ("%VITE_PID_FILE%") do taskkill /f /pid %%i >nul 2>nul
  del /f /q "%VITE_PID_FILE%" >nul 2>nul
)

if exist "%VITE_LOG%" del /f /q "%VITE_LOG%" >nul 2>nul

echo Starting Vite dev server...
powershell -NoProfile -Command "$root = (Resolve-Path $env:ROOT).Path; $command = 'cd /d ""{0}"" && npm.cmd run dev:renderer > ""{1}"" 2>&1' -f $root, $env:VITE_LOG; $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $command) -WorkingDirectory $root -WindowStyle Hidden -PassThru; Set-Content -Path $env:VITE_PID_FILE -Value $p.Id"
if errorlevel 1 goto :fail

echo Waiting for renderer server...
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(20); do { if (Test-Path $env:VITE_LOG) { $log = Get-Content -Raw -Encoding UTF8 $env:VITE_LOG -ErrorAction SilentlyContinue; if ($log -match 'Local:\s+http://127\.0\.0\.1:5173/' -or $log -match 'ready in') { exit 0 }; if ($log -match 'error when starting dev server' -or $log -match 'failed to load config' -or $log -match 'Error:') { exit 2 } }; try { $conn = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction Stop; if ($conn) { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); exit 1"
if errorlevel 1 (
  echo Renderer server was not ready in time.
  if exist "%VITE_LOG%" (
    echo.
    echo ===== Vite log =====
    type "%VITE_LOG%"
    echo ===== End Vite log =====
  )
  goto :fail
)

echo UI does not start worker automatically.
echo Start dev-worker.bat first if backend is not running.
echo Starting Electron UI...
call npx.cmd electron dev-main.cjs
if errorlevel 1 goto :fail

goto :end

:fail
echo Dev UI startup failed.

:end
if exist "%VITE_PID_FILE%" (
  for /f "usebackq delims=" %%i in ("%VITE_PID_FILE%") do taskkill /f /pid %%i >nul 2>nul
  del /f /q "%VITE_PID_FILE%" >nul 2>nul
)
