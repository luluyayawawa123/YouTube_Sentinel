@echo off
setlocal

set ROOT=%~dp0
set RELEASE_DIR=%ROOT%dist
set FINAL_DIR=%RELEASE_DIR%\YouTube Sentinel
set NO_UPDATE_NOTIFIER=1
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

echo Cleaning release directory...
if exist "%RELEASE_DIR%" rmdir /s /q "%RELEASE_DIR%"
mkdir "%RELEASE_DIR%"

echo Installing dependencies...
call npm.cmd install
if errorlevel 1 goto :fail

echo Building application...
call npm.cmd run build
if errorlevel 1 goto :fail

echo Packaging portable directory...
call npm.cmd run package:dir
if errorlevel 1 goto :fail

if exist "%FINAL_DIR%" rmdir /s /q "%FINAL_DIR%"
if exist "%RELEASE_DIR%\win-unpacked" ren "%RELEASE_DIR%\win-unpacked" "YouTube Sentinel"
if exist "%RELEASE_DIR%\builder-debug.yml" del /f /q "%RELEASE_DIR%\builder-debug.yml"

echo Build completed successfully.
goto :end

:fail
echo Build failed.

:end
pause

