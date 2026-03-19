@echo off
setlocal

set "ROOT=%~dp0"
set "WORKER_HEALTH_URL=http://127.0.0.1:42777/health"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "NO_UPDATE_NOTIFIER=1"
set "YTS_DEV_SOURCE=1"

cd /d "%ROOT%"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing $env:WORKER_HEALTH_URL -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 exit /b 0

echo Starting worker...
call npx.cmd electron dev-main.cjs --worker
if errorlevel 1 goto :fail

goto :end

:fail
echo Dev worker startup failed.

:end
