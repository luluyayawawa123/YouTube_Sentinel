@echo off
setlocal

schtasks /delete /f /tn "YouTube Sentinel Worker"
echo Task removal finished.
pause

