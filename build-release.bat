@echo off
setlocal

set "ROOT=%~dp0"
set "DIST_DIR=%ROOT%dist"
set "STAGE_DIR=%DIST_DIR%\win-unpacked"
set "FINAL_DIR=%DIST_DIR%\YouTube Sentinel"
set "NO_UPDATE_NOTIFIER=1"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

echo Cleaning output directory...
call :remove_dir "%DIST_DIR%"
if exist "%DIST_DIR%" (
  echo Failed to clean output directory.
  goto :fail
)
mkdir "%DIST_DIR%"
if errorlevel 1 goto :fail

echo Building application...
call npm.cmd run build
if errorlevel 1 goto :fail

echo Packaging application...
call npm.cmd run package:dir
if errorlevel 1 goto :fail

if not exist "%STAGE_DIR%" (
  echo Packaged directory was not created.
  goto :fail
)

if exist "%FINAL_DIR%" rmdir /s /q "%FINAL_DIR%"
mkdir "%FINAL_DIR%"
if errorlevel 1 goto :fail

echo Preparing final directory...
robocopy "%STAGE_DIR%" "%FINAL_DIR%" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 goto :fail

echo Creating runtime folders...
if not exist "%FINAL_DIR%\config" mkdir "%FINAL_DIR%\config"
if not exist "%FINAL_DIR%\data" mkdir "%FINAL_DIR%\data"
if not exist "%FINAL_DIR%\logs" mkdir "%FINAL_DIR%\logs"
if not exist "%FINAL_DIR%\bin" mkdir "%FINAL_DIR%\bin"

echo Copying runtime files...
if exist "%ROOT%bin\*" xcopy "%ROOT%bin\*" "%FINAL_DIR%\bin\" /e /i /y >nul
copy /y "%ROOT%scripts\register-task.bat" "%FINAL_DIR%\register-task.bat" >nul
if errorlevel 1 goto :fail
copy /y "%ROOT%scripts\unregister-task.bat" "%FINAL_DIR%\unregister-task.bat" >nul
if errorlevel 1 goto :fail

if exist "%DIST_DIR%\builder-debug.yml" del /f /q "%DIST_DIR%\builder-debug.yml"
if exist "%STAGE_DIR%" rmdir /s /q "%STAGE_DIR%" >nul 2>nul

echo Build completed successfully.
goto :end

:fail
echo Build failed.

:end
echo Press any key to exit...
pause >nul

:remove_dir
if not exist "%~1" goto :eof
attrib -r -s -h "%~1" /s /d >nul 2>nul
rmdir /s /q "%~1" >nul 2>nul
if exist "%~1" cmd /c rd /s /q "%~1" >nul 2>nul
goto :eof

